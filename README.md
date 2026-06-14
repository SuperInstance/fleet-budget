# The Ledger That Enforces a Theorem

> Most ledgers track what happened. This one prevents what shouldn't.

---

## The Idea

Every distributed system has a budget — compute, memory, network, storage.
Left unchecked, agents will consume more than the system can provide.
The result is the same every time: degradation, thrashing, cascading failure.

The traditional approach is to monitor usage and alert when things get bad.
That's like installing a smoke detector after the fire.

**fleet-budget** takes a different approach. It enforces a conservation law at
the database level. The law is simple:

```
γ + η ≤ C
```

Where:
- **γ (gamma)** = committed compute budget across all agents
- **η (eta)** = committed network/storage budget across all agents
- **C** = total capacity limit for the current budget period

This is not a guideline. It is not a recommendation. It is a **CHECK constraint
on the `budget_periods` table**. SQLite itself will reject any write that would
violate it. You literally cannot commit a budget violation.

---

## How It Works

### Two-Layer Enforcement

The conservation law is enforced at two layers:

**Layer 1 — Application:** Before committing a reservation, the Worker computes
the projected state: `new_gamma + new_eta`. If this exceeds `C_limit`, the
commit is rejected with a 409 response and the violation is logged.

**Layer 2 — Database:** The `budget_periods` table has:

```sql
CHECK (gamma_committed + eta_committed <= C_limit)
```

This is the last line of defence. Even if the application has a race condition
(and SQLite's SERIALIZABLE isolation makes that extremely unlikely), the
database itself will reject the write. The transaction rolls back. The
violation is logged. The invariant holds.

### Event-Sourced Audit Trail

Every state-changing operation — reserve, commit, release, reject — appends an
entry to the `commit_log` table. Each entry records:

- The action taken
- The amount and type (gamma or eta)
- The resulting balance (`gamma_after`, `eta_after`)
- The capacity limit at the time

This means you can **replay the log from any point** and verify that the
conservation law held at every step. The audit trail is not just a record of
what happened — it's a mathematical proof that the invariant was maintained.

The `/period/:id` endpoint includes a `conservation` section that replays the
log independently and verifies it matches the stored running totals.

### Reservation Lifecycle

```
pending → committed → released
   │         │
   │         └── if γ+η > C: REJECTED (violation logged)
   │
   └── if γ+η > C at reserve time: REJECTED (violation logged)
```

1. **Reserve** (`POST /reserve`): Create a pending reservation. Pre-checks
   whether the amount would fit within the conservation limit. If not, the
   reservation is rejected before it's even created.

2. **Commit** (`POST /commit`): Atomically transition a reservation from
   pending to committed. This is the critical path — the conservation law is
   checked at both the application and database level. If the CHECK constraint
   rejects the write, the transaction rolls back and the violation is logged.

3. **Release** (`POST /release`): Return a committed reservation's budget to
   the pool. The period's committed totals decrease.

---

## API Reference

### `GET /`

Returns API metadata and the current budget state for the open period.

```json
{
  "name": "fleet-budget",
  "conservation_law": "γ + η ≤ C",
  "current_period": {
    "C_limit": 1000,
    "gamma_committed": 350,
    "eta_committed": 200,
    "total_committed": 550,
    "total_available": 1450,
    "conservation_holds": true
  }
}
```

### `POST /period`

Open a new budget period. Closes any existing open period.

```json
// Request
{ "C_limit": 1000 }

// Response (201)
{ "message": "Budget period opened", "period": { "id": "...", "C_limit": 1000, ... } }
```

### `GET /period/:id`

Returns the full ledger for a budget period — including an independent
conservation verification by replaying the commit log.

```json
{
  "period": { ... },
  "conservation": {
    "gamma_from_log": 350,
    "eta_from_log": 200,
    "total": 550,
    "C_limit": 1000,
    "holds": true,
    "matches_stored": true
  },
  "reservations": { "count": 12, "committed": 5, ... },
  "audit_trail": { "entries": 27, "log": [...] },
  "violations": { "count": 1, "items": [...] }
}
```

### `POST /reserve`

Create a pending reservation. Pre-checks conservation.

```json
// Request
{ "period_id": "abc123", "agent_id": "fleet-worker-1", "amount": 100, "type": "gamma" }

// Response (201)
{ "message": "Reservation created (pending)", "reservation": { ... } }

// Response (409) — would violate conservation
{ "error": "Reservation rejected: γ(800) + η(300) > C(1000)" }
```

### `POST /commit`

Atomically commit a reservation. **This is where the conservation law bites.**

```json
// Request
{ "reservation_id": "xyz789" }

// Response (200)
{
  "message": "Reservation committed",
  "conservation": {
    "gamma": 450, "eta": 200, "total": 650,
    "C_limit": 1000, "holds": true
  }
}

// Response (409) — conservation law violation
{
  "error": "Conservation law violation — commit rejected",
  "attempted": { "gamma": 800, "eta": 300, "total": 1100 },
  "limit": 1000,
  "note": "The database itself rejected this write. The invariant holds."
}
```

### `POST /release`

Release a committed reservation. Returns budget to the pool.

```json
// Request
{ "reservation_id": "xyz789" }

// Response (200)
{
  "message": "Reservation released — budget returned to pool",
  "period_state": { "gamma_committed": 350, "eta_committed": 200, ... }
}
```

### `GET /audit`

Returns recent violations, the commit log, and a conservation verification
across all open periods.

```json
{
  "summary": {
    "total_violations": 3,
    "total_log_entries": 147,
    "open_periods": 1,
    "all_periods_hold": true
  },
  "conservation_verification": [ ... ],
  "recent_violations": [ ... ],
  "recent_log": [ ... ]
}
```

### `GET /health`

Database connectivity check.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              fleet-budget Worker              │
│                                              │
│   POST /reserve ─┐                           │
│   POST /commit ──┼──► Application Check      │
│   POST /release ─┘    (γ+η ≤ C?)             │
│                            │                 │
│                            ▼                 │
│                    D1 Transaction            │
│                    (batch atomic)            │
│                            │                 │
│                            ▼                 │
│              ┌──────────────────────┐        │
│              │  budget_periods      │        │
│              │  CHECK(γ+η ≤ C)      │◄── THE INVARIANT
│              └──────────────────────┘        │
│                            │                 │
│                    ┌───────┴───────┐         │
│                    ▼               ▼         │
│              commit_log      budget_violations│
│              (audit trail)    (rejection log) │
└──────────────────────────────────────────────┘
```

### Why D1?

Cloudflare D1 is SQLite at the edge. SQLite provides:

- **SERIALIZABLE isolation** — concurrent transactions appear to execute
  sequentially. No phantom reads, no dirty reads.
- **CHECK constraints** — enforced on every write, no exceptions. Cannot be
  bypassed by application code.
- **Atomic batch execution** — `db.batch()` runs multiple statements as a
  single transaction. Either all succeed or all roll back.

This means the conservation law isn't just "checked" — it's **mathematically
guaranteed by the storage engine**. The database cannot enter a state where
γ + η > C.

### Race Condition Handling

Two agents commit simultaneously. Both pass the application-level check.
What happens?

1. Both compute `new_gamma + new_eta ≤ C` → both pass
2. Both attempt `UPDATE budget_periods SET ...`
3. D1's SERIALIZABLE isolation means one transaction completes first
4. The second transaction sees the updated state — the CHECK constraint fails
5. The second transaction rolls back
6. The violation is logged to `budget_violations`
7. The invariant holds

The CHECK constraint is the unmoved mover. It doesn't care about timing,
caching, or application logic. It is a fact about the data.

---

## Database Schema

Five tables, one invariant:

| Table | Purpose |
|---|---|
| `budget_periods` | Temporal container for a conservation envelope. **Has the CHECK constraint.** |
| `reservations` | Intent to consume budget (pending → committed → released) |
| `commit_log` | Event-sourced audit trail — every mutation is recorded |
| `fleet_instances` | Registered fleet instances consuming budget |
| `budget_violations` | Rejection log — proof the conservation law was enforced |

---

## Setup

```bash
# Install dependencies
npm install

# Create the D1 database
npx wrangler d1 create fleet-budget
# → Copy the database_id into wrangler.toml

# Initialize the schema (local)
npm run db:init

# Initialize the schema (remote)
npm run db:init:remote

# Run locally
npm run dev

# Deploy
npm run deploy
```

---

## The Point

This isn't a budget tracker. It's a **budget enforcer**.

The difference matters. A tracker tells you that you overspent. An enforcer
makes overspending impossible.

The conservation law γ + η ≤ C is not a policy that can be overridden, a
config that can be changed, or a check that can be disabled. It is a property
of the database schema. To violate it, you would need to ALTER the table and
drop the CHECK constraint — which requires direct database access and is
auditable.

Every rejected attempt is logged. Every successful commit is audited. The
invariant is verifiable by replaying the log. This is what it means to enforce
a theorem at the ledger.

---

*fleet-budget — deliverable B1 from the strategic plan.*
*The conservation law is enforced at the ledger. A commit that would push
γ+η > C is rejected.*
