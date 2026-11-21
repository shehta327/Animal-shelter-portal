#!/usr/bin/env bash
# Publishes the frontend to the S3 website bucket with the real API and Cognito IDs.
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
POOL=$(pool_id); CLIENT=$(client_id "$POOL"); API=$(api_id)
none "$POOL" && { echo "Run infra/platform.sh first"; exit 1; }
rm -rf infra/out/web && mkdir -p infra/out/web && cp -r frontend/. infra/out/web/
sed -i "s#__API_BASE_URL__#http://$API.execute-api.localhost.floci.io:4566#; s#__COGNITO_ENDPOINT__#$PUBLIC_FLOCI/#; s#__COGNITO_CLIENT_ID__#$CLIENT#" infra/out/web/js/config.js
aws s3 sync infra/out/web s3://shelter-web --delete --exclude "js/*" --exclude "css/*" > /dev/null
aws s3 cp infra/out/web/css s3://shelter-web/css --recursive --content-type text/css > /dev/null
aws s3 cp infra/out/web/js s3://shelter-web/js --recursive --content-type text/javascript > /dev/null
aws s3 ls s3://shelter-web --recursive | awk '{print "   " $4}'
say "Website: $PUBLIC_FLOCI/shelter-web/index.html"
