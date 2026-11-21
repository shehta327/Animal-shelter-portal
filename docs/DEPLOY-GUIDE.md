# Deployment guide: every step, what it does and why

This guide takes the team from four empty folders to the whole portal running on
Floci (the local AWS emulator from Lab 7), tested, and published on GitHub.
**You run every command yourself.** Each step says what it does, why we do it,
and how to check it worked.

| Repo | Owner | What it deploys |
|---|---|---|
| `Animal-shelter-portal` (this repo, shared) | whole team | website + shared platform: Cognito, API Gateway, EventBridge bus, S3 website, Resend secret placeholder |
| `shelter-animals-service` | Abdelrahman Magdy | Lambda + DynamoDB + S3 (photos) + EventBridge + CloudWatch |
| `shelter-applications-service` | Mohamed Tibah | Lambda + Secrets Manager + EventBridge + CloudWatch, Neon Postgres, Resend |
| `shelter-visits-service` | Abdelrahman Shehta | Lambda + DynamoDB + EventBridge Scheduler + EventBridge + Secrets Manager + CloudWatch, Resend |

Order matters: **platform first**, then the three services (any order), then the website.

---

## 0. Prerequisites (once per PC)

| Tool | Check | Why |
|---|---|---|
| Docker Desktop | `docker version` | runs Floci, and the tool container if you have no AWS CLI |
| Node.js 24 | `node -v` | builds the Lambda zips and runs the tests |
| Git | `git --version` | each member commits from their own account |
| AWS CLI v2 *(optional)* | `aws --version` | with it you run `bash infra/x.sh`; without it use `.\infra\run.ps1 x.sh` |

**Two ways to run every infra script.** They do the same thing:

```powershell
# A) No AWS CLI (PowerShell, inside the repo folder). Builds a small Node+AWS CLI image the first time.
.\infra\run.ps1 platform.sh
```
```bash
# B) Git Bash with the AWS CLI and the Lab 7 "floci" profile
bash infra/platform.sh
```

> Why a container? `run.ps1` starts `shelter-tools` (Node 24 + AWS CLI v2) with the
> repo folder mounted and `AWS_ENDPOINT_URL=http://host.docker.internal:4566`, so every
> `aws` command goes to Floci on your PC, never to real AWS. The fake keys `test/test`
> are what Floci expects; they are not secrets.

## 1. Start Floci

```powershell
docker ps --filter name=floci          # already running?
docker start floci                     # if it exists but is stopped
```
If you have no Floci container yet, use the Lab 7 compose file (it keeps data on disk):
`docker compose -f infra/floci/docker-compose.yml up -d` from the Lab 7 project.

Check: open <http://localhost:4566/_floci/ui>. Everything below shows up there.

> Floci keeps state in memory unless started with storage. If you restart a memory-only
> container, run steps 3 to 7 again; all scripts are safe to re-run (they reuse what exists).

## 2. Get the code and make the first commits (each member)

Each member owns their own repo, so each pushes from their own GitHub account:

1. On GitHub, the owner creates the empty repo (`shelter-visits-service` for Shehta, and so on). Make it **public** only after step 9 (secret scan) passes.
2. In the folder: `git init` (skip for `Animal-shelter-portal`, it already is one), then
   `git remote add origin https://github.com/<you>/<repo>.git`.
3. Commit in small pieces as you go, with real messages, e.g. `feat(visits): booking with atomic capacity check`.
   `git status` before every commit: `.env`, `node_modules/`, `*.zip` and `infra/out/` must never appear (the `.gitignore` blocks them).
4. `git push -u origin main`.

The shared repo `Animal-shelter-portal` is the only one all three commit to. Use a branch
per change (`feature/web-staff-dashboard`) and merge with a pull request reviewed by
another member, so the history shows who did what.

## 3. Shared platform (shared repo, run once by any member)

```powershell
cd F:\Animal-shelter-portal
.\infra\run.ps1 platform.sh
```

What each numbered step in the output does:

1. **Cognito user pool `shelter-users`.** One sign-in for all three services (the TA's point: auth belongs to the team, not one member). Email is the username, and the password policy is at least 8 characters with upper, lower and a number.
2. **PreSignUp Lambda `shelter-presignup`.** Floci cannot send verification emails, so this trigger confirms new accounts. It **never adds a group**, so a self-registered user is always an adopter. Its IAM role can only write its own logs.
3. **App client `shelter-web`.** A public client with no secret, because a browser can't keep one. It allows `USER_PASSWORD_AUTH`, hides "user does not exist" errors (no account enumeration), and the ID token lives 60 minutes.
4. **Groups `Admin` and `Staff`.** The role is the group inside the **signed** token (`cognito:groups`). Every backend reads it after verifying the signature, so changing it in the browser gives a 401.
5. **Seed accounts.** These are `admin@`, `staff@`, `adopter1@` and `adopter2@shelter.test`. Their random passwords are written to `infra/out/seed-users.txt`, which is git-ignored. To choose your own, set `$env:SEED_PASSWORD="Something123"` before running.
6. **EventBridge bus `shelter-bus`.** The services tell each other what happened (approved, adopted, visit done) without sharing databases.
7. **API Gateway `shelter-http-api`.** The single front door. Stage `$default` auto-deploys and throttles to 20 requests/second with a burst of 50 (rate limiting). Each service adds its own routes in its own deploy.
8. **S3 bucket `shelter-web`.** Holds the website.
9. **Secret `shelter/resend`.** Created with a **placeholder** only. The real key is added in step 4.

Check: `infra/out/platform.env` now lists the pool, client and API IDs. These are not secrets.

## 4. Real email with Resend (optional but needed for the "external API" mark)

1. Sign up at resend.com, go to **API Keys**, then **Create**, and copy the key (`re_...`).
2. `.\infra\run.ps1 set-resend-key.sh`, paste the key (it is hidden) and give your own Resend account email as the recipient.
   The free sender `onboarding@resend.dev` can only deliver to the account owner, so every demo email goes to you.
3. The key goes **only** into Secrets Manager. It is not in any file, environment variable or commit. The services read it at runtime with `secretsmanager:GetSecretValue` on that one secret.

Rotate: create a new key in Resend, run the script again, then delete the old key.

## 5. Neon database (Applications owner, Tibah)

1. Neon console, then the project, then **SQL Editor**: run `backend/db/schema.sql` (tables, checks, the unique indexes that enforce "one active application" and "one approval per animal").
2. Still in the SQL Editor, create the API's own login with a long random password, then run `backend/db/roles.sql`:
   ```sql
   CREATE ROLE app_api WITH LOGIN PASSWORD '<generate 24+ random characters>';
   ```
   `app_api` may SELECT, INSERT and UPDATE. It **cannot** DELETE, DROP, ALTER or TRUNCATE (least privilege). The owner login is never given to the Lambda.
3. **Connect**, then pick role `app_api` and the pooled connection, and copy the string.
4. `.\infra\run.ps1 set-db-secret.sh` and paste it (hidden). It goes into Secrets Manager as `shelter/applications-db`.
5. For local `npm run dev` only, put it in `backend/.env` as `DATABASE_URL=...`. That file is git-ignored.

## 6. Deploy each service (each owner deploys their own)

```powershell
cd F:\shelter-visits-service          # or shelter-animals-service / shelter-applications-service
.\infra\run.ps1 deploy.sh
```
Every `deploy.sh` follows the same steps (read it alongside this list):

1. **Data store.** Animals and Visits create a DynamoDB table (pay-per-request, point-in-time recovery on). Applications checks its Neon secret exists.
2. **Extra resources.** Animals creates the private photo bucket: public access blocked, CORS only for the website origin, encrypted at rest. Visits creates the Scheduler group.
3. **IAM role with `infra/policy.json`.** Open the file: every statement names exact actions on exact resources. There are no wildcards, and each service may publish events **only with its own source** (`events:source` condition), so one service cannot fake another's events.
4. **Build + Lambda.** `npm install --omit=dev` then `npm run zip` builds `lambda.zip` from code and dependencies only (no `.env`). The function is created or updated with settings that are IDs and names only. Logs are kept for 14 days.
5. **Routes.** The service adds `GET /api/health/<svc>`, `ANY /api/<svc>` and `ANY /api/<svc>/{proxy+}` to the shared API, plus permission for API Gateway to invoke it.
6. **Event subscription.** An EventBridge rule on `shelter-bus` sends the events this service consumes to its Lambda:
   - Animals ← ApplicationApproved / Completed / Released
   - Applications ← VisitCompleted
   - Visits ← AnimalStatusChanged (adopted, archived, on_hold)
7. **Monitoring.** Two CloudWatch metric filters on the function's logs (`AuthDenied` counts 401/403 lines, `ServerErrors` counts error lines) and two alarms (10+ denials in 5 minutes, or any server error).

Check: `http://<API_ID>.execute-api.localhost.floci.io:4566/api/health/visits` returns `{"status":"ok",...}`.

**Live-demo setting (Visits only).** In production a slot starts at least 60 minutes ahead on a :00 or :30 boundary, and an outcome can be recorded only after the start. For the demo video and the tests, deploy with:
```powershell
$env:VISIT_LEAD_MINUTES="2"; $env:SLOT_STEP_MINUTES="1"; .\infra\run.ps1 deploy.sh
```

## 7. Publish the website (shared repo)

```powershell
cd F:\Animal-shelter-portal
.\infra\run.ps1 deploy-web.sh
```
This copies `frontend/` to `infra/out/web`, writes the API URL and Cognito client ID into `js/config.js` (IDs, not secrets), and uploads it to S3 with the right content types.
Open **<http://localhost:4566/shelter-web/index.html>**. It is served from the same origin as Cognito, which is why the browser may call Cognito directly.

## 8. Test everything

```powershell
cd F:\Animal-shelter-portal
node tests\run-tests.mjs                 # 3 health + 23 security + 27 integration checks, through the real API
.\infra\run.ps1 ../tests/cloud-checks.sh # IAM wildcards, secrets in Lambda settings, bucket, log retention, alarms
node tests\secret-scan.mjs . ..\shelter-animals-service ..\shelter-applications-service ..\shelter-visits-service
```
`tests/out/results.md` is the table for report section 12/13. Screenshot the console too.

**Monitoring evidence (report section 11).**
1. Run the "suspicious activity" burst: `node tests\attack-burst.mjs`. It sends 15 requests with a forged token.
2. Floci UI, then **CloudWatch Logs** `/aws/lambda/shelter-animals-api`: see the `AUTH_DENIED` lines (request id, path, reason, but never the token).
3. **CloudWatch, then Alarms**: `shelter-animals-api-auth-denied-spike` goes to ALARM. Screenshot both.

## 9. Before making repos public

1. `node tests\secret-scan.mjs <repo>` must say **No secrets found**. It checks the files and the **whole commit history**.
2. On GitHub, turn on **Settings, then Code security, then Secret scanning + Push protection**.
3. If a secret was ever committed: rotate it first (new Neon password or new Resend key), then remove it from history. Deleting the file in a new commit is not enough.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `The shared platform is missing` | run step 3 first (Floci restarted without storage?) |
| 503 `DEPENDENCY_UNAVAILABLE` from Applications/Visits | the other service is not deployed yet, or `API_CONNECT_URL` is wrong. Check its health URL |
| 401 on every call after a while | the ID token expired (60 minutes): sign in again |
| Emails not arriving | the key is still the placeholder (logs say `email skipped`), or the recipient is not your Resend account email |
| `docker: ... not a TTY` | the `set-*.sh` scripts need an interactive PowerShell window, not a background terminal |
| Lambda create fails on runtime | set `$env:LAMBDA_RUNTIME="nodejs22.x"` and re-run |
| `npm error code EALLOWSCRIPTS` | a global `npm_config_allow_scripts` variable on this PC: run `Remove-Item Env:npm_config_allow_scripts` in that window, then `npm install` again |
