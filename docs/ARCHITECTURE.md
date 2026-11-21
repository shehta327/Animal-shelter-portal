# Architecture

```mermaid
flowchart LR
  B["Browser<br/>HTML/CSS/JS on S3 website<br/>localhost:4566/shelter-web"]
  C["Amazon Cognito<br/>pool shelter-users<br/>groups Admin, Staff"]
  G["API Gateway HTTP API<br/>shelter-http-api<br/>throttling 20 rps"]
  subgraph Animals["Animal Listings (Magdy)"]
    LA["Lambda shelter-animals-api"] --> DA[("DynamoDB ShelterAnimals")]
    LA --> S3P[("S3 shelter-animal-photos<br/>private, presigned URLs")]
  end
  subgraph Apps["Adoption Applications (Tibah)"]
    LP["Lambda shelter-applications-api"] --> N[("Neon Postgres<br/>applications, application_events")]
    LP --> SM1["Secrets Manager<br/>shelter/applications-db"]
  end
  subgraph Visits["Visit Scheduling (Shehta)"]
    LV["Lambda shelter-visits-api"] --> DV[("DynamoDB ShelterVisits")]
    LV --> SCH["EventBridge Scheduler<br/>visit reminders"]
    SCH --> LV
  end
  EB{{"EventBridge bus shelter-bus"}}
  SM2["Secrets Manager shelter/resend"]
  R["Resend email API (external)"]
  CW["CloudWatch Logs + metric filters + alarms"]

  B -- "sign up / sign in" --> C
  B -- "HTTPS JSON + Bearer ID token" --> G
  B -- "presigned PUT/GET" --> S3P
  G --> LA & LP & LV
  LA & LP & LV -. "verify JWT (JWKS)" .-> C
  LP -- "GET /api/animals/:id" --> G
  LV -- "GET /api/animals/:id<br/>GET /api/applications/eligibility" --> G
  LP -- "ApplicationApproved / Completed / Released" --> EB
  LA -- "AnimalStatusChanged" --> EB
  LV -- "VisitCompleted" --> EB
  EB --> LA & LP & LV
  LP & LV --> SM2
  LP & LV -- "status / booking emails" --> R
  LA & LP & LV --> CW
```

## How the layers talk
* **Browser to Cognito**: `InitiateAuth` / `SignUp` (same origin as the website). The ID token is kept in `sessionStorage`.
* **Browser to API Gateway to Lambda**: REST + JSON. Every service verifies the token itself: RS256 signature against Cognito JWKS, plus issuer, audience, expiry and `token_use`. The role comes from `cognito:groups`.
* **Service to service, synchronous**: through the same API Gateway, forwarding the user's own token, so the called service applies its own rules. Nobody reads another service's database.
* **Service to service, asynchronous**: EventBridge events on `shelter-bus`. Each IAM role may only publish with its own `source`.

## Events
| Event | Source | Consumer | Effect |
|---|---|---|---|
| ApplicationApproved | shelter.applications | Animals | available → reserved (pinned to the application) |
| ApplicationCompleted | shelter.applications | Animals | reserved → adopted |
| ApplicationReleased | shelter.applications | Animals | reserved → available |
| AnimalStatusChanged (adopted/archived/on_hold) | shelter.animals | Visits | cancel future slots and bookings, email adopters |
| VisitCompleted | shelter.visits | Applications | record visit; submitted → under_review; unlocks approval |
| VisitReminder (Scheduler) | scheduler | Visits | reminder email 24 h before |

## Role / permission matrix (enforced in the backend)
| Action | Visitor | Adopter | Staff | Admin | Where enforced |
|---|---|---|---|---|---|
| Browse available animals, open slots | ✓ | ✓ | ✓ | ✓ | Animals `list` (status forced to available for non-staff), Visits `listSlots` |
| See on-hold/archived animals, internal fields | | | ✓ | ✓ | Animals `isStaff` in `list`/`present` |
| Create / edit / hold / archive animal, photos | | | ✓ | ✓ | `requireRole(staff,admin)` in animals routes |
| Submit application (max 3 active) | | ✓ | | | `requireRole(adopter)` + `countActive` |
| Read application | | own only | all | all | SQL `WHERE adopter_id = $sub` (404 otherwise) |
| Withdraw application | | own only | | | `TRANSITIONS` owner rule |
| Review / approve / reject / complete, notes | | | ✓ | ✓ | `TRANSITIONS` staff rule, `requireRole` on notes |
| Open / cancel visit slots | | | ✓ | ✓ | `requireRole` in visits routes |
| Book visit | | with active application | | | `requireRole(adopter)` + eligibility call |
| Cancel booking | | own, ≥24 h before | any, before start | any | `updateBooking` |
| Record visit outcome | | | ✓ | ✓ | `updateBooking` (403 for adopters) |
| Grant Staff/Admin | | | | Cognito admin only | groups are never self-assigned (PreSignUp adds none) |
