#!/usr/bin/env bash
# One-time setup of a managed .report instance in the CUSTOMER'S OWN Cloudflare account,
# using the cf CLI (https://developers.cloudflare.com - `cf auth login` first, as the customer).
# Idempotent-ish: every step prints what it will do; nothing runs without --apply.
#   scripts/setup.sh                 # dry run: show plan
#   scripts/setup.sh --apply         # create gateway, Secrets Store, Agent Memory ns, render config
# Secrets are read from the environment (never argv, never files in the repo) and written
# straight to Secrets Store. Status: written for the template, NOT yet run against an account.
set -euo pipefail
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
cfg() { node scripts/config-cli.mjs get "$1"; }
run() { echo "+ $*" | sed -E 's/("value": ?")[^"]*/\1***/g'; [[ $APPLY == 1 ]] && "$@" || true; }

command -v cf >/dev/null || { echo "cf CLI not found (npm i -g cf)"; exit 1; }
[[ -f alfred.config.json ]] || { echo "copy alfred.config.example.json -> alfred.config.json and fill it"; exit 1; }
ACCOUNT=$(cfg CLOUDFLARE_ACCOUNT_ID); GATEWAY=$(cfg CLOUDFLARE_GATEWAY_ID); MEMNS=$(cfg AGENT_MEMORY_NAMESPACE)
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"
echo "account=$ACCOUNT gateway=$GATEWAY memory=$MEMNS apply=$APPLY"

# 1. AI Gateway (logs on: the end-of-mission review reads them; authenticated gateway).
cf ai-gateway gateways get "$GATEWAY" >/dev/null 2>&1 \
  || run cf ai-gateway gateways create --body "{\"id\":\"$GATEWAY\",\"collect_logs\":true,\"authentication\":true,\"cache_ttl\":0,\"cache_invalidate_on_update\":true,\"rate_limiting_interval\":0,\"rate_limiting_limit\":0}"

# 2. Agent Memory namespace.
cf agent-memory get-namespace "$MEMNS" >/dev/null 2>&1 || run cf agent-memory create-namespace --name "$MEMNS"

# 3. Secrets Store (one per account) + secrets from env.
STORE=$(cfg SECRETS_STORE_ID)
if [[ -z "$STORE" ]]; then
  STORE=$(cf secrets-store stores list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=j.result??j;process.stdout.write(a[0]?.id??"")}catch{}})')
  [[ -n "$STORE" ]] || run cf secrets-store stores create --body '{"name":"default_secrets_store"}'
  echo "set SECRETS_STORE_ID=$STORE in alfred.config.json"
fi
# Secret names come from config/schema.ts; binding name = secret name (docs/CONFIG.md).
for name in $(node scripts/config-cli.mjs secrets); do
  val=${!name:-}
  if [[ -z "$val" ]]; then echo "skip $name (export $name to set)"; continue; fi
  [[ -n "$STORE" ]] && run cf secrets-store secrets create "$STORE" --body "[{\"name\":\"$name\",\"value\":\"$val\",\"scopes\":[\"workers\"]}]"
done

# 4. Validate the per-account cf config (no API calls; IDs left empty => cf deploy provisions them).
run npm run deploy:check

cat <<MSG
Manual (needs the customer's dashboard/identity, not scriptable safely here):
  - Zero Trust > Access: self-hosted app for \$DOMAIN/mcp* and /api/alfred/*; copy its AUD to ACCESS_AUD.
  - AI Gateway '$GATEWAY' > Provider Keys: optional Exa key (alias -> EXA_KEY_ALIAS) and any LLM BYOK keys.
  - Email Routing on \$DOMAIN: route ${BRAND_LOCAL:-al}@\$DOMAIN to the web Worker (owner forwards become missions).
  - Owner memory seed (optional, from a private dir outside git): ALFRED_PRIVATE_DIR=... node scripts/seed-memory.mjs --apply
  - Workers Builds: connect repo; build = "npm run install:all && npm run gate", deploy = "npm run deploy" (cf deploy).
MSG
