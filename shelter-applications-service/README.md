# Adoption Applications service

Owner: **Mohamed Tibah**. Part of the Animal Shelter Adoption Portal (shared repo: `Animal-shelter-portal`).

The adoption workflow: adopters apply for an animal, staff review, and the status moves
through a fixed workflow that drives the rest of the system.

**AWS services:** Lambda · Secrets Manager (`shelter/applications-db`, `shelter/resend`) · EventBridge · CloudWatch · IAM. **External:** Neon Postgres (database) · Resend (status emails).

## API
| Method & path | Who | Success | Errors |
|---|---|---|---|
| `POST /api/applications` | adopter | **201** + Location | 400, 401, 403, 404 animal, 409 (not available / duplicate / >3 active) |
| `GET /api/applications?status&animalId` | adopter: own · staff: all | 200 | 400, 401 |
| `GET /api/applications/{id}` (+ history) | owner or staff | 200 | 401, **404 for others' ids** |
| `PATCH /api/applications/{id}/status` `{status, note?}` | depends on transition | 200 | 400, 403, 404, 409 |
| `POST /api/applications/{id}/notes` | staff, admin | **201** | 400, 403, 404 |
| `GET /api/applications/eligibility?animalId` | adopter (used by Visits) | 200 | 400, 401 |
| `GET /api/health/applications` | anyone | 200 | |

## Workflow (who may do each step)
```
submitted --staff--> under_review --staff--> approved --staff--> completed
    |                    |                      |
    +--staff: rejected   +--staff: rejected     +--staff: rejected
    +--owner: withdrawn  +--owner: withdrawn    +--owner: withdrawn
```
* Apply only for an animal the **Animals service** reports as available. One active application per animal, at most 3 active per adopter (partial unique index + count).
* **Approve only after a completed visit** (`VisitCompleted` from Visits) and while the animal is available. Only one approval per animal (unique partial index, so two staff approving at once cannot both win).
* Completing an adoption **auto-rejects** every other open application for the animal, in the same SQL statement, and emails those adopters.
* Approve, complete and release-of-an-approval publish events, so the Animals service reserves, adopts or releases the animal.

## Data model (Neon)
`applications` (1) to (N) `application_events` (status changes, staff notes, visit records: an audit trail). See `backend/db/schema.sql`.
The Lambda logs in as `app_api` (SELECT/INSERT/UPDATE only, `backend/db/roles.sql`). Its connection string is only in Secrets Manager.

## Code map
| File | What it does |
|---|---|
| `backend/controllers/applicationsController.js` | validation, workflow table, calls to Animals, events, emails |
| `backend/services/applicationStore.js` | parameterised SQL (no string building with user input); each workflow step is one atomic statement |
| `backend/db/index.js` | gets the Neon URL from Secrets Manager (or `.env` on a PC), cached |
| `backend/db/schema.sql`, `roles.sql`, `migrate.js` | schema, least-privilege role, migration runner |
| `backend/consumers/handler.js` | `VisitCompleted` to `recordVisit` |
| `backend/lib/email.js` | Resend call; key read from Secrets Manager, never logged; best effort |
| `infra/deploy.sh`, `infra/policy.json`, `infra/set-db-secret.sh` | AWS deployment, least-privilege IAM, storing the DB secret |

## Run / deploy
* PC: `cd backend && cp .env.example .env` (put `DATABASE_URL` there, git-ignored), then `npm install && npm run migrate && npm run dev`
* Floci: `.\infra\run.ps1 set-db-secret.sh` then `.\infra\run.ps1 deploy.sh`
