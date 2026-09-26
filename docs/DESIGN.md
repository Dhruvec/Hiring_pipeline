# Mini Hiring Pipeline — Product & Technical Design

This document records the design of the Mini Hiring Pipeline implementation: the
data model, the stage semantics, the audit-trail strategy, the natural-language
search engine, and the architecture decisions (with rationale and trade-offs).

---

## 1. Product overview

A recruiter manages candidates on a single pipeline screen:

```
Applied → Screening → Interview → Offer → Hired
   └──────────┴───────────┴────────┴──► Rejected   (from any pre-final stage)
```

Two surfaces:

1. **Pipeline board** — one column per stage (Applied, Screening, Interview,
   Offer, Hired, Rejected). Each card shows the candidate's name, role, and
   time-in-stage. A `+ Add candidate` action creates a candidate in `Applied`.
2. **Candidate detail drawer** — opened from a card. Shows current stage, time in
   stage (e.g. `6 days 4 hours`), the allowed next actions, and the **full audit
   trail** (every stage transition with its entry/exit timestamps).

A single **search box** sits in the header and supports natural-language queries.

---

## 2. Data model

Two logical tables, mirrored by [`src/db.js`](src/db.js:19).

### `candidates` (current state — optimized for the board view)

| Field | Meaning |
| --- | --- |
| `id` | Integer primary key (monotonic). |
| `name`, `email`, `phone`, `role`, `source`, `notes` | Candidate profile. |
| `current_stage` | One of `Applied, Screening, Interview, Offer, Hired, Rejected`. |
| `created_at` | Timestamp of creation (== first history event). |
| `updated_at` | Timestamp of the most recent transition. |

### `history` (append-only audit trail)

| Field | Meaning |
| --- | --- |
| `id` | Integer primary key (monotonic). |
| `candidate_id` | Foreign key → `candidates.id`. |
| `stage` | The stage the candidate **entered** at `entered_at`. |
| `entered_at` | When the candidate entered `stage`. |
| `exited_at` | **Derived on read** (see §4). Stored as `null` and never mutated. |
| `reason` | Free-text reason for the transition. |
| `created_by` | Actor (`recruiter`). |

The persistence layer is deliberately thin: the `Database` class exposes a small
relational-style API (`insertCandidate`, `historyForCandidate`, …) so the backing
store could be swapped for SQLite/Postgres without touching [`src/service.js`](src/service.js:27).

---

## 3. Stage semantics

All rules live in [`src/stages.js`](src/stages.js:17) — a framework-free module
that is the **single source of truth**. [`validateTransition(from, to)`](src/stages.js:50)
returns `{ ok, code, message, allowed }` with these codes:

| Code | Situation |
| --- | --- |
| `UNKNOWN_CURRENT_STAGE` / `UNKNOWN_TARGET_STAGE` | Stage string is not recognized. |
| `SAME_STAGE` | Target equals current. |
| `TERMINAL_STAGE` | Current stage is `Hired`/`Rejected` — no further movement. |
| `REVERSE_TRANSITION` | Target is earlier in the pipeline than current. |
| `SKIPPED_STAGE` | Target is more than one step ahead. |
| `OK` | Legal move. |

Rules encoded:

- A normal transition advances **exactly one** stage.
- `Rejected` is allowed from **any** pre-final stage.
- `Hired` and `Rejected` are **terminal** — no reverse or change is permitted.
- `allowedNextStages(from)` powers the UI (which buttons to show) *and* the error
  payload (`allowed_next_stages`), so the frontend and backend never disagree.

**Why a module and not inline checks?** Centralizing the finite state machine
means the same rules drive the board UI, the API validator, the CLI, and the
tests. There is exactly one place to change the pipeline.

---

## 4. Immutable audit trail (the core invariant)

> *Every valid transition appends a new history event. Existing history is never edited.*

The implementation enforces this literally, and it is verified by a test.

### The subtlety: who owns `exited_at`?

The naive model stores `exited_at` on the event and **mutates** it when the
candidate later leaves that stage. That is a *write to an existing row*, which
violates append-only history. It also means the audit trail is not reproducible:
reading the same event twice can yield different data.

### The chosen model: derive `exited_at` at read time

- [`moveStage()`](src/service.js:146) only **inserts** a new event with
  `entered_at = now` and `exited_at = null`.
- [`getHistory()`](src/service.js:100) reconstructs the timeline: event `i`'s
  `exited_at` is **event `i+1`'s `entered_at`** (and `null` for the open event).
- [`openEvent()`](src/db.js) returns the last event by time — it does **not** scan
  for a magic `exited_at === null` marker.

Consequences:

- Stored rows are immutable; the only operation on history is `INSERT`.
- Time-in-stage is a pure function of `entered_at` and "now" — trivially testable
  with an injected clock.
- The trail can be replayed/rebuilt at any time with identical results.

The test [`test/service.test.js`](test/service.test.js) snapshots the **raw**
`db.historyForCandidate()` records before and after a transition and asserts the
prior records are byte-for-byte unchanged. This is the test that caught the
original mutating design — see [`docs/AI_COLLABORATION.md`](docs/AI_COLLABORATION.md).

---

## 5. Time-in-stage

[`src/timeInStage.js`](src/timeInStage.js:18):

- `msUntilEntered(enteredAt, now)` — clamped to `≥ 0`.
- `formatDuration(ms)` — human output: `6 days 4 hours`, `3 weeks`, `2 hrs 15 mins`.
- `parseDurationToMs(text)` — parses `a week`, `7 days`, `more than a month`,
  `24 hrs`, with word-number support.
- `parseComparator(text)` — detects `>`, `>=`, `<`, `<=` phrasing
  (`more than`, `over`, `at least`, `less than`).

"Now" is always injectable, so tests never depend on wall-clock time.

---

## 6. Natural-language search

Entry point: [`search(rawQuery, service, opts)`](src/search.js:415).

The engine has four phases:

1. **Parse** — [`parseQuery()`](src/search.js:135) detects intents:
   * current-stage filter, a *transition/event* filter (with destination stage),
     time-in-stage + comparator, date range (`today`, `yesterday`, `this week`,
     `last week`, `since Monday`), exclusion (`except`/`excluding`), and
     "reached X but not hired".
2. **Resolve names** — [`resolveName()`](src/search.js:233) runs the query against
   the candidate list with the fuzzy matcher and records both the raw `nameText`
   and the resolved name.
3. **Evaluate** — [`evaluateCandidate()`](src/search.js:284) applies every detected
   condition with logical **AND** and collects human-readable `reasons` (the "why").
4. **Explain** — [`describePlan()`](src/search.js:387) produces the interpretation
   string; on an empty result it always appends guidance, and unsupported queries
   return the supported-query examples rather than an empty list.

### Fuzzy name matching

[`src/fuzzy.js`](src/fuzzy.js) normalizes case/diacritics, computes Levenshtein
distance, and returns a normalized score. [`scoreName()`](src/fuzzy.js) ranks
`exact (1.0) > contains (0.95) > all-tokens (0.9) > fuzzy (≥0.8 / ≥0.6)`, so
`"priya shrama"` resolves to **Priya Sharma** while still reporting the score.

### Ranking & transparency

Results carry a `score` and a `reasons` array. The API returns the parsed plan
(via `serializePlan`), so the UI can show *what the system thought you meant* —
e.g. `interpretation: "candidates currently in Screening for more than 7 days"`.

### Why not a SQL `LIKE` or an external search engine?

The assignment's queries are varied *intents*, not just substrings. A parser +
condition model expresses them without infrastructure, and — crucially — lets us
**explain** results and gracefully explain *missing* results, which a blind filter
cannot do.

---

## 7. Testing strategy

`npm test` runs Node's built-in runner over `test/*.test.js`.

| File | Focus |
| --- | --- |
| [`test/stages.test.js`](test/stages.test.js) | Every transition code: forward, skip, reverse, terminal, reject-from-any-stage. |
| [`test/service.test.js`](test/service.test.js) | Creation, time-in-stage with a fixed clock, **append-only audit trail immutability**. |
| [`test/fuzzy.test.js`](test/fuzzy.test.js) | Exact/contains/typo matching and scoring. |
| [`test/search.test.js`](test/search.test.js) | Each of the six example queries, combined conditions, and invalid/unsupported queries. |
| [`test/api.test.js`](test/api.test.js) | End-to-end HTTP: board, create, transition (incl. `409` rejection), history, search. |

Determinism: [`test/helpers.js`](test/helpers.js) pins "now" to a fixed instant
(`2026-01-15T12:00Z`, a Thursday, so "since Monday" is well-defined) and builds a
fixed fixture. Duration and date assertions are therefore stable.

---

## 8. Architecture decisions (with rationale)

| Decision | Rationale | Trade-off accepted |
| --- | --- | --- |
| **Zero dependencies** | Reviewer can run it with `node` alone; no supply-chain or install friction. | Re-implementing HTTP routing and a store by hand. |
| **File-backed JSON store** | Adequate for the scope; makes state inspectable and resettable. | Not concurrent-safe at high write volume; atomic write (temp file + rename) mitigates partial writes. |
| **Strict stage machine in a module** | One source of truth across UI, API, CLI, tests. | Slightly more indirection than inline `if`s. |
| **Derived `exited_at`** | Preserves true append-only history; reproducible trail. | Read path does a small amount of reconstruction work. |
| **Backend validation** | Security/correctness cannot depend on the client. | Frontend must surface `409` errors (it does, via toast). |
| **Parser-based NL search** | Explains results and handles unsupported queries. | Less powerful than a full-text engine; scoped to the assignment's intents. |
| **Injectable clock** | Deterministic tests for time-sensitive logic. | Every time-sensitive call takes an optional `now`. |

---

## 9. Future improvements

- **Persistence**: swap [`src/db.js`](src/db.js) for SQLite (same service API),
  add transactions and indexes on `history(candidate_id, entered_at)`.
- **Rejection reasons & RBAC**: structured rejection reasons; per-actor permissions.
- **Search**: pluggable parser registry; synonyms; saved searches; ranked snippets
  using a real inverted index for large datasets.
- **Concurrency**: optimistic locking via `updated_at` to prevent lost updates.
- **Notifications**: SLA alerts when a candidate exceeds a stage's expected time.
- **Backfill/repair tooling**: since history is append-only and derived, a repair
  command can rebuild `candidates.current_stage` from history at any time.
