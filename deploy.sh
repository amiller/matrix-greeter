#!/bin/bash
# Deploy matrix-greeter to hermes-staging CVM via tee-daemon API
set -euo pipefail

CVM="https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
DAEMON_TOKEN="${DAEMON_TOKEN:-$(grep TEE_DAEMON_TOKEN "$HOME/projects/hermes-agent/deploy-notes/.env.staging" | cut -d= -f2)}"

[ ! -f "$ENV_FILE" ] && { echo "ERROR: $ENV_FILE not found. Copy .env.example to .env."; exit 1; }

declare -A SECRETS
while IFS='=' read -r key val; do
  [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
  SECRETS[$key]="$val"
done < "$ENV_FILE"

echo "Loaded ${#SECRETS[@]} credentials"

# Git push if ahead
if git status --porcelain -b 2>/dev/null | grep -q "##.*\[ahead"; then
  git push
else
  echo "Git up to date."
fi

ENV_JSON=$(
  for key in "${!SECRETS[@]}"; do
    val="${SECRETS[$key]}"
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    printf '"%s":"%s"\n' "$key" "$val"
  done | paste -sd ',' -
)

MANIFEST="{\"name\":\"greeter\",\"runtime\":\"deno\",\"entry\":\"server.ts\",\"attested\":false,\"listen\":{\"port\":8080,\"protocol\":\"http\"},\"env\":{$ENV_JSON},\"source\":\"https://github.com/amiller/matrix-greeter\",\"ref\":\"main\"}"

FORCE="${1:-}"
if [ "$FORCE" = "--force" ]; then
  echo "Deleting existing greeter project..."
  curl -sf -X DELETE -H "Authorization: Bearer $DAEMON_TOKEN" "$CVM/_api/projects/greeter" || echo "(not found, ok)"
fi

echo "Deploying greeter..."
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer $DAEMON_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$MANIFEST" \
  "$CVM/_api/projects")
echo "Deployed: $RESPONSE"

echo "Waiting 25s..."
sleep 25
curl -sf "$CVM/greeter/status" 2>/dev/null && echo || echo "(not ready yet)"
echo "Done."
