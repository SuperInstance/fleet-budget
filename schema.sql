-- fleet-budget schema
-- The conservation law γ + η ≤ C is enforced at the database level.
-- You literally cannot commit a budget violation.

PRAGMA journal_mode = WAL;

----------------------------------------------------------------------------
-- Budget Periods
--
-- A period is the temporal container for a conservation envelope. C_limit
-- is the total capacity budget. gamma_committed and eta_committed are
-- running totals kept in sync by the application layer via transactions.
--
-- The CHECK constraint (gamma_committed + eta_committed <= C_limit) is
-- the database-level enforcement of the conservation law. Any transaction
-- that would violate it is rejected by SQLite itself.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_periods (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    period_start    TEXT NOT NULL DEFAULT (datetime('now')),
    period_end      TEXT,
    C_limit         REAL NOT NULL CHECK (C_limit >= 0),
    gamma_committed REAL NOT NULL DEFAULT 0 CHECK (gamma_committed >= 0),
    eta_committed   REAL NOT NULL DEFAULT 0 CHECK (eta_committed >= 0),
    status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'closed')),
    -- THE CONSERVATION LAW: γ + η ≤ C
    -- This single constraint is the theorem. Everything else is accounting.
    CHECK (gamma_committed + eta_committed <= C_limit)
);

----------------------------------------------------------------------------
-- Reservations
--
-- A reservation is an intent to consume budget. It transitions through
-- pending → committed → released. Only 'committed' state consumes budget.
-- 'released' returns budget to the pool.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    period_id  TEXT NOT NULL REFERENCES budget_periods(id),
    agent_id   TEXT NOT NULL,
    amount     REAL NOT NULL CHECK (amount > 0),
    type       TEXT NOT NULL CHECK (type IN ('gamma', 'eta')),
    status     TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'committed', 'released')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reservations_period ON reservations(period_id);
CREATE INDEX IF NOT EXISTS idx_reservations_agent  ON reservations(agent_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);

----------------------------------------------------------------------------
-- Commit Log (Event-Sourced Audit Trail)
--
-- Every state-changing operation appends to this log. The log is the
-- source of truth — the running balances in budget_periods are a
-- materialised view derived from replaying this log.
--
-- balance_after records the (gamma, eta) pair after the action was applied,
-- providing a verifiable audit trail for conservation law compliance.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id TEXT REFERENCES reservations(id),
    period_id      TEXT NOT NULL REFERENCES budget_periods(id),
    action         TEXT NOT NULL
                       CHECK (action IN ('reserve', 'commit', 'release', 'reject')),
    agent_id       TEXT,
    amount         REAL NOT NULL DEFAULT 0,
    type           TEXT CHECK (type IN ('gamma', 'eta')),
    gamma_after    REAL NOT NULL,
    eta_after      REAL NOT NULL,
    C_limit        REAL NOT NULL,
    timestamp      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commit_log_period    ON commit_log(period_id);
CREATE INDEX IF NOT EXISTS idx_commit_log_timestamp ON commit_log(timestamp);

----------------------------------------------------------------------------
-- Fleet Instances
--
-- Registered fleet instances that consume budget. current_gamma and
-- current_eta track their active resource usage.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fleet_instances (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name            TEXT NOT NULL UNIQUE,
    endpoint        TEXT,
    current_gamma   REAL NOT NULL DEFAULT 0 CHECK (current_gamma >= 0),
    current_eta     REAL NOT NULL DEFAULT 0 CHECK (current_eta >= 0),
    last_heartbeat  TEXT
);

----------------------------------------------------------------------------
-- Budget Violations
--
-- When a commit is rejected because it would violate γ + η ≤ C, the
-- attempted operation is recorded here. This table is the rejection
-- log — proof that the conservation law was enforced.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_violations (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    period_id       TEXT REFERENCES budget_periods(id),
    agent_id        TEXT,
    attempted_amount REAL NOT NULL,
    gamma_after     REAL NOT NULL,
    eta_after       REAL NOT NULL,
    C_limit         REAL NOT NULL,
    reason          TEXT NOT NULL,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_violations_period   ON budget_violations(period_id);
CREATE INDEX IF NOT EXISTS idx_violations_timestamp ON budget_violations(timestamp);
