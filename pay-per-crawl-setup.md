# Pay Per Crawl Setup — Monetize AI Crawler Access

## Overview

Pay Per Crawl is a feature of Cloudflare AI Crawl Control. Site owners set a
price per zone; AI crawlers pay per crawl or receive HTTP 402. Cloudflare is
the Merchant of Record.

Reference: https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/what-is-pay-per-crawl/

**Status:** Closed beta. Signup: https://www.cloudflare.com/paypercrawl-signup/

## Setup for alfred.report (and 145+ domains)

### Step 1: Enable in Account Settings
1. Go to AI Crawl Control
2. Enable Pay Per Crawl for the zone

### Step 2: Set Price
```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/0870b0bdbc14bcd31f43fe5e82c3ee8e/ai-crawl-control/pay-per-crawl" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"price_per_crawl_usd": 0.005, "currency": "USD"}'
```

### Step 3: Select Crawlers to Charge
For each AI crawler, choose: **Charge** / **Allow** / **Block**

Recommended policy for alfred.report:
- Search engine crawlers (Google, Bing): **Allow** (SEO benefit)
- AI training crawlers (GPTBot, ClaudeBot): **Charge** ($0.005/crawl)
- Scraping bots without identification: **Block**

### Step 4: Monitor Activity
Dashboard: AI Crawl Control > Monitor Activity
- Successful content deliveries (HTTP 200 with payment)
- 402 Payment Required responses
- Revenue per crawler

### Step 5: Manage Payouts
Cloudflare acts as Merchant of Record. Payouts via Stripe.

## How It Works

```
AI Crawler requests content
  v
Cloudflare edge checks: is crawler on "charge" list?
  +-- Yes + payment intent header? → HTTP 200 + content (payment processed)
  +-- Yes + no payment header? → HTTP 402 Payment Required + pricing JSON
  +-- No (allowed) → HTTP 200 + content (free)
  +-- Blocked → HTTP 403
```

## Important Notes

- WAF and Bot Management rules **override** Pay Per Crawl "charge"
- Pay Per Crawl is per-zone, not per-page
- Cloudflare handles payment processing, verification, and settlement
- Minimum price: $0.001 USD per crawl

## Bot Preference Sync (complementary)

Bot Preference Sync automatically aligns robots.txt with AI bot policies:
1. Go to AI Crawl Control > Bot Preference Sync
2. Declare preferences for Search, Agent, and Training categories
3. Cloudflare auto-generates and maintains robots.txt

No static robots.txt file to maintain — declare once, sync everywhere.

## BotBase Registration

Register Alfred in Cloudflare's BotBase directory:
1. Go to BotBase
2. Submit Alfred as a bot/agent
3. Declare behavior model: content usage, data retention, identification
4. Track submission status in dashboard

This makes Alfred discoverable to other Cloudflare users and establishes
Alfred's operational behavior model publicly.