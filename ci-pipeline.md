# Artifacts-to-Worker CI Pipeline

## Overview

```
Artifacts (source) → wrangler deploy (Worker = the live app) → GitHub (vanity / square)
```

Artifacts is git. It does not serve alfred.report, run voice, or hold sessions.

The Worker is the operator: routes, Google, D1, KV, TTS, MCP, A2A.

R2 on this Worker is for product files (voice samples, mission blobs). A tarball of `dist/` is not a second source of truth — skip it.

GitHub is the public square. Not backup. Not deploy source.

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

### Stage 5 — GitHub Mirror (public, after Artifacts)

Public repo: `https://github.com/OpenRoyleAl/Alfred.report`

```bash
git push origin v0.3
```

Never push secrets, vault files, or Siri shortcuts. Artifacts first. GitHub second.

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
```

## Pipeline Summary

| Stage | Tool | Cloudflare-native? |
|-------|------|-------------------|
| Source storage | CF Artifacts | ✅ |
| CI trigger | Webhook Worker or GitHub Actions | ✅ (Worker) / ⚠️ (Actions) |
| Build | Vite / static build | ✅ |
| Deploy | `wrangler deploy` | ✅ |
| Mirror | `git push` to GitHub | vanity |