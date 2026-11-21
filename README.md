# Animal Shelter Adoption Portal: shared repo

Cloud Computing & Cloud Security (26CSCN29H), Group A-1 / Team 01.

This is the **only shared repository**: the website and the shared platform (sign-in,
API Gateway, event bus). Each backend service lives in its **owner's own repo**:

| Service | Owner | Repo | AWS services in the component |
|---|---|---|---|
| Animal Listings | Abdelrahman Magdy | `shelter-animals-service` | Lambda, DynamoDB, S3, EventBridge, CloudWatch, IAM |
| Adoption Applications | Mohamed Tibah | `shelter-applications-service` | Lambda, Secrets Manager, EventBridge, CloudWatch, IAM + Neon + Resend |
| Visit Scheduling | Abdelrahman Shehta | `shelter-visits-service` | Lambda, DynamoDB, EventBridge Scheduler, EventBridge, Secrets Manager, CloudWatch, IAM + Resend |
| Shared platform | whole team | this repo | Cognito, API Gateway, EventBridge bus, S3 website |

* Architecture, events and the role matrix: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
* Deploying, step by step, with the reason for each step: [docs/DEPLOY-GUIDE.md](docs/DEPLOY-GUIDE.md)
* Tests: `tests/run-tests.mjs` (integration + security), `tests/cloud-checks.sh`, `tests/secret-scan.mjs`, `tests/attack-burst.mjs`

## Layout
```
frontend/            website (vanilla HTML/CSS/JS modules, strict CSP, no innerHTML with data)
  js/config.js       API URL + Cognito client id (filled in at deploy, no secrets)
  js/auth.js         Cognito sign-up / sign-in, token in sessionStorage
  js/api.js          every API call; presigned S3 upload
  js/ui.js           DOM helpers (textContent only), header, two-click confirm buttons
  index/animal/login/my/staff .js   one script per page
infra/
  platform.sh        Cognito + PreSignUp Lambda + groups + seed users, bus, API, website bucket, secret placeholder
  deploy-web.sh      publish frontend to S3 with real IDs
  set-resend-key.sh  put the Resend key in Secrets Manager (typed hidden)
  common.sh          helpers shared by every repo's scripts
  run.ps1            run any script through Docker if you have no AWS CLI
tests/               see above
```

## Local development (no cloud)
Each service runs on a PC with `npm run dev` (ports 3001 to 3003). Serve the frontend with any static server on
port 8080 and point `js/config.js` at the service you are working on.
