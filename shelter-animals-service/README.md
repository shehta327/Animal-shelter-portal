# Animal Listings service

Owner: **Abdelrahman Magdy**. Part of the Animal Shelter Adoption Portal (shared repo: `Animal-shelter-portal`).

The shelter's catalogue of animals: what an adopter can browse, what staff manage,
and the animal status that follows the adoption workflow.

**AWS services:** Lambda · DynamoDB (`ShelterAnimals` + `status-createdAt-index`) · S3 (private `shelter-animal-photos`) · EventBridge · CloudWatch · IAM (behind the shared API Gateway, sign-in via the shared Cognito).

## API
| Method & path | Who | Success | Errors |
|---|---|---|---|
| `GET /api/animals?species&size&sex&minAgeMonths&maxAgeMonths&temperament&q&page&limit[&status]` | anyone (status filter: staff only) | 200 | 400 |
| `GET /api/animals/{id}` | anyone (hidden statuses: staff) | 200 | 404 |
| `POST /api/animals` | staff, admin | **201** + Location | 400, 401, 403 |
| `PATCH /api/animals/{id}` (details, or `status` available/on_hold) | staff, admin | 200 | 400, 401, 403, 404, 409 |
| `DELETE /api/animals/{id}` (archive, soft delete) | staff, admin | **204** | 401, 403, 404, 409 |
| `POST /api/animals/{id}/photos` `{contentType}` | staff, admin | **201** + presigned PUT | 400, 409 limit |
| `PATCH /api/animals/{id}/photos/{photoId}` `{status:"ready"}` | staff, admin | 200 | 400, 404, 409 |
| `DELETE /api/animals/{id}/photos/{photoId}` | staff, admin | **204** | 404 |
| `GET /api/health/animals` | anyone | 200 | |

Errors are always `{"error":{"code","message","details?"}}`.

## Business rules (not just CRUD)
* The public sees only `available` animals in lists (and reserved/adopted by direct link).
* `reserved` and `adopted` are set **only by events** from Applications. Staff can only hold, release or archive.
* A reserved animal cannot be held or archived. Adopted and archived animals are read-only.
* At most 5 photos (jpeg/png/webp, 5 MB or less). A photo counts only after the service checks S3 itself (HeadObject: size and type).

## Events
Consumes `ApplicationApproved` (available → reserved), `ApplicationCompleted` (reserved → adopted) and `ApplicationReleased` (reserved → available). Each change is a conditional update pinned to the application id. Publishes `AnimalStatusChanged`.

## Code map
| File | What it does |
|---|---|
| `backend/app.js` | Express app: request log, CORS allow-list, security headers, JSON-only, 20 kB limit, routes, error handler |
| `backend/lambda.js` | Lambda entry: API Gateway requests go to Express, EventBridge events go to `consumers/handler.js` |
| `backend/server.js` | same app on your PC (`npm run dev`, port 3001) |
| `backend/routes/animals.js` | URL to middleware to controller; the role check per route |
| `backend/controllers/animalsController.js` | validation + business rules + response shape |
| `backend/services/animalStore.js` | DynamoDB calls; every status change is a **conditional** update (no lost updates) |
| `backend/services/photoStore.js` | presigned S3 URLs (PUT 5 min, GET 15 min), head, delete |
| `backend/consumers/handler.js` | adoption events to status changes |
| `backend/lib/*` | team-shared: `auth.js` (Cognito JWT verify + roles), `http.js` (errors), `validate.js`, `middleware.js`, `logger.js`, `events.js` |
| `infra/deploy.sh`, `infra/policy.json` | everything in AWS for this service; least-privilege IAM |

## Run / deploy
* PC: `cd backend && cp .env.example .env && npm install && npm run dev`
* Floci: `.\infra\run.ps1 deploy.sh` (see `docs/DEPLOY-GUIDE.md` in the shared repo for every step explained)

## Security controls in this service
Backend JWT verification on every write · role check per route · input validation with an allow-list of fields (mass-assignment guard) · conditional writes · private bucket + short-lived presigned URLs + server-side upload verification · IAM limited to one table/index, `animals/*` objects, own event source, own logs · AUTH_DENIED logs + metric filter + alarm · no secrets used.
