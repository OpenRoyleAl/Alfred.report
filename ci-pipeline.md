# Artifacts-to-Worker CI Pipeline

## Overview

```
┌─────────────────┐     ┌─────────────┐     ┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────┐
│  CF Artifacts    │────▶│  CI Workflow │────▶│  Build   │────▶│  Deploy to   │────▶│  R2 Snapshot │────▶│  GitHub   │
│  (alfred-command │     │  (Wrangler)  │     │  (Vite)  │     │  Worker      │     │  (backup)    │     │  (mirror)│
│   namespace)    │     │             │     │          │     │  (wrangler   │     │              │     │  optional│
│                  │     │             │     │          │     │   deploy)    │     │              │     │          │
└─────────────────┘     └─────────────┘     └──────────┘     └──────────────┘     └──────────────┘     └──────────┘
```

**Key:** Uses `wrangler deploy` (not `wrangler pages deploy`) because
command-os-review is a Worker with static assets.

## Pipeline Stages

### Stage 1 — Source in CF Artifacts
- Source code lives in CF Artifacts repos under `alfred-command` namespace
- Git-compatible: standard `git clone` / `git push` works
- No GitHub dependency for the primary workflow

### Stage 2 — CI Workflow Trigger
**Option A: Cloudflare Workers CI (recommended)**
- Worker as CI runner: listens for push events, clones, builds, deploys, snapshots

**Option B: GitHub Actions**

### Stage 3 — Build
```bash
npm ci
npm run build
# Output → ./dist (matches wrangler.jsonc assets.directory)
```

### Stage 4 — Deploy to Worker
```bash
npx wrangler deploy
npx wrangler deploy --dry-run  # validate first
```

### Stage 5 — R2 Snapshot
```bash
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
tar -czf /tmp/snapshot-${TIMESTAMP}.tar.gz -C ./dist .
npx wrangler r2 object put alfred-snapshots/command-os-review/${TIMESTAMP}.tar.gz \
  --file /tmp/snapshot-${TIMESTAMP}.tar.gz
```

### Stage 6 — GitHub Mirror (optional)
```bash
git remote add github https://github.com/<org>/command-os-review.git
git push github main --force
```

## GitHub Actions Workflow (Option B)

```yaml
name: Deploy command-os-review
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout from CF Artifacts
        run: git clone https://<artifacts-clone-url> .
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Wrangler
        run: npm install -g wrangler@latest
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Deploy Worker
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: 0870b0bdbc14bcd31f43fe5e82c3ee8e
      - name: R2 Snapshot
        run: |
          TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
          tar -czf /tmp/snapshot-${TIMESTAMP}.tar.gz -C ./dist .
          npx wrangler r2 object put \
            alfred-snapshots/command-os-review/${TIMESTAMP}.tar.gz \
            --file /tmp/snapshot-${TIMESTAMP}.tar.gz
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: 0870b0bdbc14bcd31f43fe5e82c3ee8e
```

## Pipeline Summary

| Stage | Tool | Cloudflare-native? |
|-------|------|-------------------|
| Source storage | CF Artifacts | ✅ |
| CI trigger | Webhook Worker or GitHub Actions | ✅ (Worker) / ⚠️ (Actions) |
| Build | Vite / static build | ✅ |
| Deploy | `wrangler deploy` | ✅ |
| Snapshot | R2 via `wrangler r2 object put` | ✅ |
| Mirror | `git push` to GitHub | ❌ (optional) |