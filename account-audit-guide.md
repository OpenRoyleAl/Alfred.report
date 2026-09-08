# Account Audit Guide — Iceberg Media

## Dashboard Links

| Resource | Dashboard URL |
|----------|--------------|
| Workers & Pages (all) | https://dash.cloudflare.com/0870b0bdbc14bcd31f43fe5e82c3ee8e/workers-and-pages |
| KV Namespaces | https://dash.cloudflare.com/0870b0bdbc14bcd31f43fe5e82c3ee8e/workers/kv/namespaces |
| R2 Buckets | https://dash.cloudflare.com/0870b0bdbc14bcd31f43fe5e82c3ee8e/r2/overview |
| D1 Databases | https://dash.cloudflare.com/0870b0bdbc14bcd31f43fe5e82c3ee8e/workers/d1/databases |
| Pages Projects | https://dash.cloudflare.com/0870b0bdbc14bcd31f43fe5e82c3ee8e/pages |

## Audit Checklist

### 1. Workers — Active vs Abandoned
- [ ] Worker name
- [ ] Last deployed date
- [ ] Bindings (KV, R2, D1, env vars, DOs, Queues, AI, etc.)
- [ ] Routes / Custom domains attached
- [ ] Trigger type (HTTP, Cron, Queue, etc.)

**Known active Workers:**
- `agent-alfred` — ORAL operator (created Aug 26)
- `alfred-report` — Board (created Aug 27)

**Action:** Any Worker not in the list above and not recently deployed
should be flagged as abandoned. Delete to clean up the account.

### 2. KV Namespaces
- [ ] Namespace name
- [ ] Namespace ID
- [ ] Which Workers bind to it

**Known namespace:** `alfred-command` — CF Artifacts source storage

### 3. R2 Buckets
- [ ] Bucket name
- [ ] Jurisdiction (default / EU / FedRAMP)
- [ ] Public access status
- [ ] Which Workers bind to it

### 4. D1 Databases
- [ ] Database name
- [ ] Database ID
- [ ] Which Workers bind to it

### 5. Pages Projects
- [ ] Project name
- [ ] Framework preset
- [ ] Build command / output directory
- [ ] Custom domains
- [ ] Environment variables
- [ ] Functions usage
- [ ] Git connection
- [ ] Web Analytics enabled?

**Known Pages project:** `command-os-review` — bare-bones static upload

## Recommended Cleanup

1. **Delete abandoned Workers** — not deployed in last 30 days
2. **Delete orphaned KV namespaces** — not bound to any active Worker
3. **Delete orphaned R2 buckets** — not referenced by any active Worker
4. **Delete orphaned D1 databases** — not bound to any active Worker
5. **Consolidate** — keep only `agent-alfred`, `alfred-report`, `command-os-review`