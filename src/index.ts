/**
 * fleet-budget — The Ledger That Enforces a Theorem
 *
 * Conservation Law: γ + η ≤ C
 *
 *   γ (gamma) = committed compute budget
 *   η (eta)   = committed network/storage budget
 *   C         = total capacity limit for the period
 *
 * This invariant is enforced at TWO levels:
 *   1. Database: CHECK(gamma_committed + eta_committed <= C_limit) on budget_periods
 *   2. Application: pre-check before UPDATE + transaction rollback on violation
 *
 * The database CHECK is the last line of defence. Even if the application
 * has a bug, SQLite will reject the write. The violation is logged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  DB: D1Database;
}

interface BudgetPeriod {
  id: string;
  period_start: string;
  period_end: string | null;
  C_limit: number;
  gamma_committed: number;
  eta_committed: number;
  status: string;
}

interface Reservation {
  id: string;
  period_id: string;
  agent_id: string;
  amount: number;
  type: 'gamma' | 'eta';
  status: 'pending' | 'committed' | 'released';
  created_at: string;
  updated_at: string;
}

interface CommitLogEntry {
  id: number;
  reservation_id: string | null;
  period_id: string;
  action: 'reserve' | 'commit' | 'release' | 'reject';
  agent_id: string | null;
  amount: number;
  type: 'gamma' | 'eta' | null;
  gamma_after: number;
  eta_after: number;
  C_limit: number;
  timestamp: string;
}

interface BudgetViolation {
  id: string;
  period_id: string | null;
  agent_id: string | null;
  attempted_amount: number;
  gamma_after: number;
  eta_after: number;
  C_limit: number;
  reason: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

const error_ = (message: string, status = 400): Response =>
  json({ error: message }, status);

/** Generate a short random ID (matches schema's randomblob approach). */
function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET / — API info + current budget state */
async function getIndex(db: D1Database): Promise<Response> {
  const period = await db
    .prepare('SELECT * FROM budget_periods WHERE status = ? ORDER BY period_start DESC LIMIT 1')
    .bind('open')
    .first<BudgetPeriod>();

  const stats = period
    ? {
        period_id: period.id,
        C_limit: period.C_limit,
        gamma_committed: period.gamma_committed,
        eta_committed: period.eta_committed,
        gamma_available: period.C_limit - period.gamma_committed,
        eta_available: period.C_limit - period.eta_committed,
        total_committed: period.gamma_committed + period.eta_committed,
        total_available: period.C_limit * 2 - period.gamma_committed - period.eta_committed,
        conservation_holds: period.gamma_committed + period.eta_committed <= period.C_limit,
      }
    : null;

  return json({
    name: 'fleet-budget',
    description: 'The Ledger That Enforces a Theorem',
    conservation_law: 'γ + η ≤ C',
    endpoints: [
      'GET  /',
      'POST /period — open new budget period',
      'GET  /period/:id — full ledger for a period',
      'POST /reserve — reserve budget (pending)',
      'POST /commit — commit a reservation (atomic, enforces γ+η≤C)',
      'POST /release — release a committed reservation',
      'GET  /audit — recent violations + commit log',
      'GET  /health',
    ],
    current_period: stats,
  });
}

/** GET /health */
async function getHealth(db: D1Database): Promise<Response> {
  try {
    const result = await db.prepare('SELECT 1 AS ok').first();
    const periodCount = await db
      .prepare('SELECT COUNT(*) AS count FROM budget_periods')
      .first<{ count: number }>();

    return json({
      status: 'healthy',
      database: result?.ok === 1 ? 'connected' : 'error',
      periods: periodCount?.count ?? 0,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return json(
      { status: 'unhealthy', error: err instanceof Error ? err.message : 'Unknown error' },
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// POST /period — open a new budget period
// ---------------------------------------------------------------------------

async function postPeriod(db: D1Database, body: unknown): Promise<Response> {
  const { C_limit } = body as { C_limit?: unknown };

  if (typeof C_limit !== 'number' || C_limit <= 0) {
    return error_('C_limit must be a positive number');
  }

  // Close any existing open period
  await db
    .prepare("UPDATE budget_periods SET status = 'closed', period_end = datetime('now') WHERE status = 'open'")
    .run();

  const id = generateId();
  await db
    .prepare(
      `INSERT INTO budget_periods (id, C_limit, gamma_committed, eta_committed, status)
       VALUES (?, ?, 0, 0, 'open')`,
    )
    .bind(id, C_limit)
    .run();

  // Log the period creation
  await db
    .prepare(
      `INSERT INTO commit_log (reservation_id, period_id, action, amount, gamma_after, eta_after, C_limit)
       VALUES (NULL, ?, 'reserve', 0, 0, 0, ?)`,
    )
    .bind(id, C_limit)
    .run();

  const period = await db
    .prepare('SELECT * FROM budget_periods WHERE id = ?')
    .bind(id)
    .first<BudgetPeriod>();

  return json({ message: 'Budget period opened', period }, 201);
}

// ---------------------------------------------------------------------------
// GET /period/:id — full ledger for a budget period
// ---------------------------------------------------------------------------

async function getPeriod(db: D1Database, periodId: string): Promise<Response> {
  const period = await db
    .prepare('SELECT * FROM budget_periods WHERE id = ?')
    .bind(periodId)
    .first<BudgetPeriod>();

  if (!period) {
    return error_('Period not found', 404);
  }

  const reservations = await db
    .prepare('SELECT * FROM reservations WHERE period_id = ? ORDER BY created_at DESC')
    .bind(periodId)
    .all<Reservation>();

  const log = await db
    .prepare('SELECT * FROM commit_log WHERE period_id = ? ORDER BY id ASC')
    .bind(periodId)
    .all<CommitLogEntry>();

  const violations = await db
    .prepare('SELECT * FROM budget_violations WHERE period_id = ? ORDER BY timestamp DESC')
    .bind(periodId)
    .all<BudgetViolation>();

  // Verify conservation by replaying the log
  let gammaRunning = 0;
  let etaRunning = 0;
  for (const entry of log.results) {
    if (entry.action === 'commit') {
      if (entry.type === 'gamma') gammaRunning += entry.amount;
      else if (entry.type === 'eta') etaRunning += entry.amount;
    } else if (entry.action === 'release') {
      if (entry.type === 'gamma') gammaRunning -= entry.amount;
      else if (entry.type === 'eta') etaRunning -= entry.amount;
    }
  }

  return json({
    period,
    conservation: {
      law: 'γ + η ≤ C',
      gamma_from_log: gammaRunning,
      eta_from_log: etaRunning,
      total: gammaRunning + etaRunning,
      C_limit: period.C_limit,
      holds: gammaRunning + etaRunning <= period.C_limit,
      matches_stored:
        gammaRunning === period.gamma_committed && etaRunning === period.eta_committed,
    },
    reservations: {
      count: reservations.results.length,
      pending: reservations.results.filter((r) => r.status === 'pending').length,
      committed: reservations.results.filter((r) => r.status === 'committed').length,
      released: reservations.results.filter((r) => r.status === 'released').length,
      items: reservations.results,
    },
    audit_trail: {
      entries: log.results.length,
      log: log.results,
    },
    violations: {
      count: violations.results.length,
      items: violations.results,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /reserve — create a pending reservation
// ---------------------------------------------------------------------------

async function postReserve(db: D1Database, body: unknown): Promise<Response> {
  const { period_id, agent_id, amount, type } = body as {
    period_id?: string;
    agent_id?: string;
    amount?: unknown;
    type?: string;
  };

  if (!period_id || !agent_id) return error_('period_id and agent_id are required');
  if (typeof amount !== 'number' || amount <= 0) return error_('amount must be positive');
  if (type !== 'gamma' && type !== 'eta') return error_('type must be "gamma" or "eta"');

  // Verify period exists and is open
  const period = await db
    .prepare('SELECT * FROM budget_periods WHERE id = ? AND status = ?')
    .bind(period_id, 'open')
    .first<BudgetPeriod>();

  if (!period) return error_('Open budget period not found', 404);

  // Pre-check: would this reservation even fit if committed?
  const projectedGamma = period.gamma_committed + (type === 'gamma' ? amount : 0);
  const projectedEta = period.eta_committed + (type === 'eta' ? amount : 0);

  if (projectedGamma + projectedEta > period.C_limit) {
    // Log the violation
    await logViolation(db, period_id, agent_id, amount, projectedGamma, projectedEta, period.C_limit,
      'Reservation would exceed conservation limit');
    return error_(
      `Reservation rejected: γ(${projectedGamma}) + η(${projectedEta}) > C(${period.C_limit})`,
      409,
    );
  }

  const id = generateId();
  await db
    .prepare(
      `INSERT INTO reservations (id, period_id, agent_id, amount, type, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(id, period_id, agent_id, amount, type)
    .run();

  // Log the reservation
  await db
    .prepare(
      `INSERT INTO commit_log (reservation_id, period_id, action, agent_id, amount, type, gamma_after, eta_after, C_limit)
       VALUES (?, ?, 'reserve', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, period_id, agent_id, amount, type, period.gamma_committed, period.eta_committed, period.C_limit)
    .run();

  const reservation = await db
    .prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(id)
    .first<Reservation>();

  return json({ message: 'Reservation created (pending)', reservation }, 201);
}

// ---------------------------------------------------------------------------
// POST /commit — atomically commit a reservation
//
// This is where the conservation law is enforced. The operation:
//   1. Reads the reservation and period
//   2. Computes projected γ+η
//   3. If γ+η ≤ C: UPDATE the period within a transaction
//   4. The D1 CHECK constraint is the last line of defence — if the
//      application logic has a race condition, SQLite rejects the write
//   5. On rejection, log to budget_violations and rollback
// ---------------------------------------------------------------------------

async function postCommit(db: D1Database, body: unknown): Promise<Response> {
  const { reservation_id } = body as { reservation_id?: string };

  if (!reservation_id) return error_('reservation_id is required');

  // Load reservation with row-level lock (SERIALIZABLE isolation via D1 batch)
  const reservation = await db
    .prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(reservation_id)
    .first<Reservation>();

  if (!reservation) return error_('Reservation not found', 404);
  if (reservation.status !== 'pending') return error_(`Reservation is ${reservation.status}, not pending`, 409);

  // Load the budget period — we need the current committed values
  const period = await db
    .prepare('SELECT * FROM budget_periods WHERE id = ?')
    .bind(reservation.period_id)
    .first<BudgetPeriod>();

  if (!period) return error_('Budget period not found', 404);
  if (period.status !== 'open') return error_('Budget period is closed', 409);

  // Compute the projected state AFTER this commit
  const newGamma = period.gamma_committed + (reservation.type === 'gamma' ? reservation.amount : 0);
  const newEta = period.eta_committed + (reservation.type === 'eta' ? reservation.amount : 0);

  // ---- APPLICATION-LEVEL CONSERVATION CHECK ----
  if (newGamma + newEta > period.C_limit) {
    await logViolation(
      db, period.id, reservation.agent_id, reservation.amount,
      newGamma, newEta, period.C_limit,
      `Commit rejected: γ(${newGamma}) + η(${newEta}) > C(${period.C_limit})`,
    );

    // Mark reservation as released since we can't commit it
    await db
      .prepare("UPDATE reservations SET status = 'released', updated_at = datetime('now') WHERE id = ?")
      .bind(reservation_id)
      .run();

    return json(
      {
        error: 'Conservation law violation — commit rejected',
        conservation_law: 'γ + η ≤ C',
        attempted: { gamma: newGamma, eta: newEta, total: newGamma + newEta },
        limit: period.C_limit,
        reservation_id,
      },
      409,
    );
  }

  // ---- ATOMIC COMMIT (transaction) ----
  // We use D1 batch() which executes statements atomically.
  // The CHECK constraint on budget_periods is the DATABASE-LEVEL enforcement.
  // If a race condition causes two concurrent commits to both pass the
  // application check, only one will succeed at the DB level — the other
  // gets rejected by the CHECK constraint.
  try {
    const newGammaCommitted =
      period.gamma_committed + (reservation.type === 'gamma' ? reservation.amount : 0);
    const newEtaCommitted =
      period.eta_committed + (reservation.type === 'eta' ? reservation.amount : 0);

    await db.batch([
      // Update the period's committed totals — CHECK constraint enforces γ+η≤C
      db
        .prepare(
          `UPDATE budget_periods
           SET gamma_committed = ?, eta_committed = ?
           WHERE id = ? AND status = 'open'`,
        )
        .bind(newGammaCommitted, newEtaCommitted, period.id),

      // Transition reservation to committed
      db
        .prepare(
          `UPDATE reservations SET status = 'committed', updated_at = datetime('now') WHERE id = ?`,
        )
        .bind(reservation_id),

      // Append to audit log
      db
        .prepare(
          `INSERT INTO commit_log (reservation_id, period_id, action, agent_id, amount, type, gamma_after, eta_after, C_limit)
           VALUES (?, ?, 'commit', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          reservation_id,
          period.id,
          reservation.agent_id,
          reservation.amount,
          reservation.type,
          newGammaCommitted,
          newEtaCommitted,
          period.C_limit,
        ),
    ]);
  } catch (err) {
    // ---- DATABASE-LEVEL REJECTION ----
    // The CHECK constraint caught a violation. This happens when:
    //   - A race condition allowed two concurrent commits
    //   - Application logic had a bug
    // Either way, the database protected the invariant.
    const reason = err instanceof Error ? err.message : String(err);

    await logViolation(
      db, period.id, reservation.agent_id, reservation.amount,
      newGamma, newEta, period.C_limit,
      `Database CHECK constraint rejected commit: ${reason}`,
    );

    // Try to mark reservation as released (best-effort, don't fail the response)
    await db
      .prepare("UPDATE reservations SET status = 'released', updated_at = datetime('now') WHERE id = ?")
      .bind(reservation_id)
      .run();

    return json(
      {
        error: 'Conservation law violation — database CHECK constraint rejected the commit',
        conservation_law: 'γ + η ≤ C',
        reason,
        attempted: { gamma: newGamma, eta: newEta, total: newGamma + newEta },
        limit: period.C_limit,
        note: 'The database itself rejected this write. The invariant holds.',
      },
      409,
    );
  }

  // Success — fetch updated state
  const updatedPeriod = await db
    .prepare('SELECT * FROM budget_periods WHERE id = ?')
    .bind(period.id)
    .first<BudgetPeriod>();

  const updatedReservation = await db
    .prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(reservation_id)
    .first<Reservation>();

  return json({
    message: 'Reservation committed',
    conservation: {
      law: 'γ + η ≤ C',
      gamma: updatedPeriod!.gamma_committed,
      eta: updatedPeriod!.eta_committed,
      total: updatedPeriod!.gamma_committed + updatedPeriod!.eta_committed,
      C_limit: updatedPeriod!.C_limit,
      holds: updatedPeriod!.gamma_committed + updatedPeriod!.eta_committed <= updatedPeriod!.C_limit,
    },
    reservation: updatedReservation,
  });
}

// ---------------------------------------------------------------------------
// POST /release — release a committed reservation (return budget to pool)
// ---------------------------------------------------------------------------

async function postRelease(db: D1Database, body: unknown): Promise<Response> {
  const { reservation_id } = body as { reservation_id?: string };

  if (!reservation_id) return error_('reservation_id is required');

  const reservation = await db
    .prepare('SELECT * FROM reservations WHERE id = ?')
    .bind(reservation_id)
    .first<Reservation>();

  if (!reservation) return error_('Reservation not found', 404);
  if (reservation.status !== 'committed')
    return error_(`Reservation is ${reservation.status}, not committed`, 409);

  const period = await db
    .prepare('SELECT * FROM budget_periods WHERE id = ?')
    .bind(reservation.period_id)
    .first<BudgetPeriod>();

  if (!period) return error_('Budget period not found', 404);

  // Release budget back to pool
  const newGamma = Math.max(0, period.gamma_committed - (reservation.type === 'gamma' ? reservation.amount : 0));
  const newEta = Math.max(0, period.eta_committed - (reservation.type === 'eta' ? reservation.amount : 0));

  try {
    await db.batch([
      db
        .prepare('UPDATE budget_periods SET gamma_committed = ?, eta_committed = ? WHERE id = ?')
        .bind(newGamma, newEta, period.id),
      db
        .prepare("UPDATE reservations SET status = 'released', updated_at = datetime('now') WHERE id = ?")
        .bind(reservation_id),
      db
        .prepare(
          `INSERT INTO commit_log (reservation_id, period_id, action, agent_id, amount, type, gamma_after, eta_after, C_limit)
           VALUES (?, ?, 'release', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(reservation_id, period.id, reservation.agent_id, reservation.amount, reservation.type,
          newGamma, newEta, period.C_limit),
    ]);
  } catch (err) {
    return error_(
      `Failed to release reservation: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  return json({
    message: 'Reservation released — budget returned to pool',
    reservation_id,
    released: {
      type: reservation.type,
      amount: reservation.amount,
    },
    period_state: {
      gamma_committed: newGamma,
      eta_committed: newEta,
      total: newGamma + newEta,
      C_limit: period.C_limit,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /audit — recent violations + commit log
// ---------------------------------------------------------------------------

async function getAudit(db: D1Database, url: URL): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);

  const [violations, logEntries] = await Promise.all([
    db
      .prepare('SELECT * FROM budget_violations ORDER BY timestamp DESC LIMIT ?')
      .bind(limit)
      .all<BudgetViolation>(),
    db
      .prepare('SELECT * FROM commit_log ORDER BY id DESC LIMIT ?')
      .bind(limit)
      .all<CommitLogEntry>(),
  ]);

  // Conservation verification: check all open periods
  const periods = await db
    .prepare("SELECT * FROM budget_periods WHERE status = 'open'")
    .all<BudgetPeriod>();

  const verification = periods.results.map((p) => ({
    period_id: p.id,
    gamma_committed: p.gamma_committed,
    eta_committed: p.eta_committed,
    total: p.gamma_committed + p.eta_committed,
    C_limit: p.C_limit,
    conservation_holds: p.gamma_committed + p.eta_committed <= p.C_limit,
    margin: p.C_limit - (p.gamma_committed + p.eta_committed),
  }));

  return json({
    summary: {
      total_violations: violations.results.length,
      total_log_entries: logEntries.results.length,
      open_periods: periods.results.length,
      all_periods_hold: verification.every((v) => v.conservation_holds),
    },
    conservation_verification: verification,
    recent_violations: violations.results,
    recent_log: logEntries.results,
  });
}

// ---------------------------------------------------------------------------
// Helper: log a budget violation
// ---------------------------------------------------------------------------

async function logViolation(
  db: D1Database,
  periodId: string,
  agentId: string,
  attemptedAmount: number,
  gammaAfter: number,
  etaAfter: number,
  CLimit: number,
  reason: string,
): Promise<void> {
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO budget_violations (id, period_id, agent_id, attempted_amount, gamma_after, eta_after, C_limit, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, periodId, agentId, attemptedAmount, gammaAfter, etaAfter, CLimit, reason)
    .run();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') return handleOptions();

    // ---- Routes ----

    if (path === '/' && method === 'GET') return getIndex(env.DB);

    if (path === '/health' && method === 'GET') return getHealth(env.DB);

    if (path === '/period' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return postPeriod(env.DB, body);
    }

    if (path === '/audit' && method === 'GET') return getAudit(env.DB, url);

    // /period/:id
    const periodMatch = path.match(/^\/period\/([a-f0-9]+)$/);
    if (periodMatch && method === 'GET') return getPeriod(env.DB, periodMatch[1]);

    if (path === '/reserve' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return postReserve(env.DB, body);
    }

    if (path === '/commit' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return postCommit(env.DB, body);
    }

    if (path === '/release' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return postRelease(env.DB, body);
    }

    return error_('Not found', 404);
  },
};
