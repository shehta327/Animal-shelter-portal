#!/usr/bin/env bash
# Stores the Neon connection string (app_api role) in Secrets Manager. Typed hidden, never saved to a file.
# Usage: .\infra\run.ps1 set-db-secret.sh   (or: bash infra/set-db-secret.sh with the AWS CLI)
set -e
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
read -r -s -p "Neon connection string for app_api (postgresql://...): " URL; echo
VALUE=$(printf '%s' "$URL" | node -e '
  const fs = require("fs");
  const value = fs.readFileSync(0, "utf8");
  try {
    const parsed = new (require("url").URL)(value);
    if (!["postgresql:", "postgres:"].includes(parsed.protocol) ||
        decodeURIComponent(parsed.username) !== "app_api" ||
        !parsed.password || !parsed.hostname) process.exit(1);
    process.stdout.write(JSON.stringify({url: value}));
  } catch (_) { process.exit(1); }
') || { echo "Use a valid Neon connection string for the app_api role."; exit 1; }
unset URL
if aws secretsmanager describe-secret --secret-id shelter/applications-db > /dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id shelter/applications-db --secret-string "$VALUE" > /dev/null 2>&1 || { echo "Could not update the Floci database secret."; exit 1; }
else
  aws secretsmanager create-secret --name shelter/applications-db --description "Neon URL for the Applications service (app_api role)" --secret-string "$VALUE" > /dev/null 2>&1 || { echo "Could not create the Floci database secret."; exit 1; }
fi
unset VALUE
echo "Saved (value not shown)."
