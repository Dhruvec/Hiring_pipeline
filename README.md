# Mini Hiring Pipeline

A recruiter-focused hiring pipeline where candidates move through a **controlled**
stage machine (`Applied → Screening → Interview → Offer → Hired`), every change is
recorded in an **immutable, append-only audit trail**, and everything is queryable
through a **single natural-language search box**.

> Built as a zero-dependency Node.js application. There is **no `npm install` step** —
> the HTTP server, the test runner, and the persistence layer all use Node built-ins.

---

## Highlights

| Principle | How it is honored |
| --- | --- |
| **Controlled stage progression** | A normal transition advances **exactly one** stage. `Hired` / `Rejected` are terminal. `Rejected` is reachable from any pre-final stage. |
| **Append-only history** | Transitions only ever `INSERT` a new history event. Prior events are never edited; exit timestamps are *derived at read time*. |
| **Backend validation** | Stage rules live in [`src/stages.js`](src/stages.js:50) and are enforced in [`src/service.js`](src/service.js:146). The UI can request anything; the server rejects invalid moves with `409`. |
| **Natural-language search** | One box understands names, current stage, time-in-stage, transition events, exclusions, and "reached X but not hired" intents. |
| **Explainable results** | Every search response includes the parsed plan and a per-candidate "why". Unsupported queries return *guidance*, never a silent empty list. |
| **Clear recruiter workflow** | Kanban board, candidate detail drawer with time-in-stage and full history, and a guarded stage-advance control. |

---

## Quick start

Requires **Node.js ≥ 18** (developed on v24).

```bash
# 1. Start the server (seeds sample data on first boot)
npm start
#   → http://127.0.0.1:3000
```

Optional:

```bash
npm run seed     # seed only if the database is empty
npm run reset    # wipe and reseed with the 8 sample candidates
npm test         # run the full automated suite (41 tests)
```

There are **no third-party dependencies**, so `npm install` is not required.

### Command-line interface (handy for demos / CI smoke tests)

```bash
node src/cli.js board
node src/cli.js search "Stuck in Screening for more than a week"
node src/cli.js show 1
```

---

## Project structure

```
.
├── package.json
├── data/
│   └── db.json                 # file-backed store (auto-created, git-ignored in spirit)
├── src/
│   ├── stages.js               # strict stage machine (single source of truth)
│   ├── db.js                   # tiny file-backed store w/ atomic writes
│   ├── service.js              # domain service: validation + append-only writes
│   ├── timeInStage.js          # duration math ("6 days 4 hours") + phrase parsing
│   ├── fuzzy.js                # Levenshtein fuzzy name matching
│   ├── search.js               # natural-language query engine
│   ├── seed.js                 # deterministic sample data
│   ├── server.js               # node:http REST API + static file server
│   └── cli.js                  # board / search / show
├── public/
│   ├── index.html              # app shell
│   ├── styles.css              # board + drawer + search panel styling
│   └── app.js                  # vanilla JS frontend
├── test/
│   ├── helpers.js              # deterministic clock + fixture
│   ├── stages.test.js          # stage machine rules
│   ├── service.test.js         # transitions + append-only audit trail
│   ├── fuzzy.test.js           # fuzzy matching
│   ├── search.test.js          # NL query parsing + combination + invalid queries
│   └── api.test.js             # end-to-end HTTP behavior
└── docs/
    ├── DESIGN.md               # product & technical design
    └── AI_COLLABORATION.md     # AI chat logs + developer disagreement example
```

---

## REST API

Base URL: `http://127.0.0.1:3000`

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/meta` | Stages, pipeline order, final stages, search examples. |
| `GET` | `/api/board` | Kanban payload: columns + per-candidate time-in-stage. |
| `GET` | `/api/candidates?stage=Interview` | List candidates (optionally filtered by stage). |
| `POST` | `/api/candidates` | Create a candidate (creation is itself the first audited event). |
| `GET` | `/api/candidates/:id` | Single candidate with derived `time_in_stage` + `allowed_next_stages`. |
| `GET` | `/api/candidates/:id/history` | Immutable audit trail (with derived `exited_at`). |
| `POST` | `/api/candidates/:id/transition` | Advance a stage. Body: `{ "to": "Screening", "reason": "..." }`. |
| `GET` | `/api/search?q=...` | Natural-language search. |

### Example: a rejected transition

```http
POST /api/candidates/1/transition
Content-Type: application/json

{ "to": "Offer" }
```

```json
{
  "error": "Cannot skip stages (Interview -> Offer). A normal transition advances exactly one stage.",
  "code": "SKIPPED_STAGE",
  "details": {
    "from": "Interview",
    "to": "Offer",
    "allowed_next_stages": ["Offer", "Rejected"]
  }
}
```

Status: `409 Conflict`. The rule is enforced on the server, so bypassing the UI
does not bypass the pipeline.

---

## Search examples

These exact queries are wired into the UI as quick-try chips and into the tests:

| Query | Intent understood |
| --- | --- |
| `Find Priya Sharma` | Fuzzy name match (`"priya shrama"` also works). |
| `Who's in Interview right now?` | Current stage filter. |
| `Stuck in Screening for more than a week` | Current stage **and** time-in-stage > 7 days. |
| `Moved to Interview since Monday` | Transition **event** whose destination is Interview, within a date range. |
| `Reached Offer but didn't get hired` | Candidate **ever reached** Offer but is not `Hired`. |
| `Everyone except rejected candidates` | Exclusion filter. |

An unsupported query (e.g. `"show me the weather"`) returns an explanation of what
*was* understood plus the supported examples — it never silently returns nothing.

---

## Testing

```bash
npm test
```

The suite covers the assignment's required areas: stage progression, final
outcomes, audit-trail immutability, time-in-stage, fuzzy matching, combined
search conditions, and invalid-query handling. Reference time is injected via a
deterministic clock so duration assertions are stable.

---

## Documentation

- **[`docs/DESIGN.md`](docs/DESIGN.md)** — product & technical design: data model,
  stage semantics, audit-trail derivation, search engine internals, and architecture
  decisions with rationale.
- **[`docs/AI_COLLABORATION.md`](docs/AI_COLLABORATION.md)** — the actual AI chat
  logs from this build, plus one concrete example where the developer **disagreed**
  with an AI suggestion and why a different approach was chosen.
