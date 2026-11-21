#!/usr/bin/env bash
# Stores the Resend key in Secrets Manager. The key is typed (hidden), never written to a file.
# Usage: .\infra\run.ps1 set-resend-key.sh   (or: bash infra/set-resend-key.sh with the AWS CLI)
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
read -r -s -p "Resend API key (re_...): " KEY; echo
read -r -p "Deliver all demo emails to (your Resend account email): " TO
case "$KEY" in re_*) ;; *) echo "That does not look like a Resend key."; exit 1 ;; esac
VALUE=$(printf '{"apiKey":"%s","from":"Shelter Portal <onboarding@resend.dev>","testRecipient":"%s"}' "$KEY" "$TO")
aws secretsmanager put-secret-value --secret-id shelter/resend --secret-string "$VALUE" > /dev/null && echo "Saved (value not shown)."
unset KEY VALUE
