# Visit Scheduling service

Owner: **Abdelrahman Shehta**. Part of the Animal Shelter Adoption Portal (shared repo: `Animal-shelter-portal`).

Meet-and-greet visits between an adopter and an animal before staff may approve an
adoption: staff open time slots, adopters with an application book them, staff record
the outcome, and the outcome unlocks approval in the Applications service.

**AWS services:** Lambda · DynamoDB (`ShelterVisits`, single table + 2 GSIs) · EventBridge Scheduler (reminders) · EventBridge · Secrets Manager (`shelter/resend`) · CloudWatch · IAM. **External:** Resend (booking, cancellation and reminder emails).

## API
| Method & path | Who | Success | Errors |
|---|---|---|---|
| `GET /api/visits/slots?animalId[&includePast]` | anyone (counts: staff) | 200 | 400 |
| `POST /api/visits/slots` `{animalId, startsAt, durationMinutes 30/60, capacity 1-4}` | staff, admin | **201** + Location | 400, 401, 403, 404, 409 overlap / not available |
| `DELETE /api/visits/slots/{id}` (cancels its bookings, emails adopters) | staff, admin | 200 + summary | 403, 404, 409 |
| `POST /api/visits/bookings` `{slotId}` | adopter | **201** + Location | 400, 403, 404, 409 (full, closed, no application, already booked) |
| `GET /api/visits/bookings?status&animalId` | adopter: own · staff: all | 200 | 400, 401 |
| `GET /api/visits/bookings/{id}` | owner or staff | 200 | **404 for others' ids** |
| `PATCH /api/visits/bookings/{id}` `{status: cancelled / completed / no_show, note?}` | see rules | 200 | 403, 404, 409 |
| `GET /api/health/visits` | anyone | 200 | |

## Business rules
* Slots are 30 or 60 minutes, on :00/:30, from 1 hour to 60 days ahead. They never overlap another open slot of the same animal, and only for an animal the **Animals service** says is available.
* Only an adopter with an active application for that animal can book (checked with the **Applications service**, using the adopter's own token), and not after their visit is already done.
* **Capacity and "one active booking per adopter per animal" are enforced atomically** in one DynamoDB transaction: slot counter + booking + guard item. Two people cannot take the last place.
* Booking closes 1 hour before. Adopters may cancel online up to 24 hours before; staff may cancel until the start.
* Only staff record the outcome, and only after the visit has started. `completed` / `no_show` is published as `VisitCompleted`.
* When an animal is adopted, archived or put on hold (`AnimalStatusChanged`), all its future slots and bookings are cancelled and the adopters are emailed.
* A reminder is scheduled with EventBridge Scheduler for 24 h before each booking (a one-time `at(...)` schedule that deletes itself), and removed when the booking is cancelled.

Demo setting: `VISIT_LEAD_MINUTES=2 SLOT_STEP_MINUTES=1` lets you record an outcome a few minutes after booking (production defaults 60 / 30).

## Data model (DynamoDB single table)
| Item | pk / sk | gsi1 | gsi2 |
|---|---|---|---|
| Slot | `SLOT#id` / `META` | `ANIMAL#animalId` + startsAt | |
| Booking | `BOOKING#id` / `META` | `SLOT#slotId` + startsAt | `ADOPTER#sub` + startsAt |
| Guard | `ACTIVE#adopter#animal` / `META` | | |

## Code map
| File | What it does |
|---|---|
| `backend/controllers/visitsController.js` | validation, every rule above, calls to Animals/Applications, emails, events |
| `backend/services/visitStore.js` | DynamoDB: queries on the GSIs, the booking transaction, conditional close/cancel |
| `backend/services/reminders.js` | EventBridge Scheduler create/delete |
| `backend/consumers/handler.js` | reminder emails; cancelling visits after `AnimalStatusChanged` |
| `backend/routes/visits.js` | role check per route |
| `infra/deploy.sh`, `infra/policy.json`, `infra/scheduler-*.json` | AWS deployment; function role + a scheduler role that can only invoke this function |

## Run / deploy
* PC: `cd backend && cp .env.example .env && npm install && npm run dev` (port 3003)
* Floci: `.\infra\run.ps1 deploy.sh` (demo: `$env:VISIT_LEAD_MINUTES="2"; $env:SLOT_STEP_MINUTES="1"` first)
