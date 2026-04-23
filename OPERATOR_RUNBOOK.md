# Nuren Media Sales Agent — Operator Runbook

## Production URL

<https://nuren-api-production.up.railway.app>

## First login

- **URL**: <https://nuren-api-production.up.railway.app/app>
- **Username**: `admin`
- **One-time password**: see Railway logs (search for `FIRST-RUN: superadmin created`). Current initial password from first deploy is on file; you MUST change it via Settings → Change Password on first login.

## Railway project

- **Project**: `nuren-media-sales-agent`
- **Service**: `nuren-api`
- **Workspace**: EIAAW SOLUTIONS's Projects
- **Volume**: `/app/data` (50 GB quota) holds:
  - `/app/data/agent.db` — SQLite DB (leads, campaigns, messages, pipeline, KB chunks, vectors, etc.)
  - `/app/data/knowledge-base/` — uploaded PPTX sources
- **Redeploy**: from project root, `railway up --detach`
- **Logs**: `railway logs` (add `--build` for build-time logs)

## Environment variables (already set)

| Key | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Draft engine, Vision ingest, enrichment, reply classification |
| `ENCRYPTION_KEY` | AES-256-GCM at-rest encryption for API keys + connector credentials |
| `FROM_EMAIL` | `Nuren Media <sales@nurengroup.com>` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Gmail SMTP (via `eiaawsolutions@gmail.com` app password) — active until Resend is configured |
| `PUBLIC_BASE_URL` | `https://nuren-api-production.up.railway.app` (tracking pixels, Meet landing) |
| `ALLOWED_ORIGINS` | CORS allowlist |
| `DATA_DIR` | `/app/data` — points the SQLite DB + KB uploads into the persistent volume |
| `PORT` / `NODE_ENV` / `SCHEDULER_CRON` | Runtime basics |

### Keys NOT set (by design — add via Settings UI when ready)

- `VOYAGE_API_KEY` (embedding provider). **Without it, RAG uses hash pseudo-embeddings — retrieval quality is degraded and unsuitable for production drafting.** Add via Settings → `voyage_api_key` as soon as you have a key.
- `RESEND_API_KEY`. Without it, email sends via Gmail SMTP (which works but deliverability + domain reputation are worse). Add via Settings → `resend_api_key` to switch.

## Day-one TODO (in order)

### 1. Change the admin password

Log in at `/app`, go to Settings, `POST /api/auth/change-password`. Do this before anything else.

### 2. Add a Voyage API key for real embeddings

1. Create a Voyage account (voyageai.com), get an API key
2. Settings → paste into `voyage_api_key` field → Save
3. Re-ingest any PPTX you already uploaded (`/api/knowledge/reingest/:id` or via the UI) — existing hash-pseudo-embeddings are discarded and replaced with real vectors

### 3. Verify your sending domain

Email will send TODAY via Gmail SMTP (from `eiaawsolutions@gmail.com` with "Nuren Media" display name). To use `sales@nurengroup.com` properly, do ONE of:

**A. Add `nurengroup.com` to Resend** (recommended — best deliverability)
1. resend.com → Domains → Add `nurengroup.com`
2. Add the three DNS records Resend provides (SPF, DKIM, MX)
3. Wait for "verified" status
4. Create an API key → Settings → paste into `resend_api_key` field
5. Verify `FROM_EMAIL=Nuren Media <sales@nurengroup.com>` is still set (it is)
6. Test send: go to any lead with an email, click "Draft Day 1 email" then Send — should send via Resend

**B. Route Gmail through Google Workspace + Send-As**
1. Set up `sales@nurengroup.com` as a Workspace mailbox
2. In Gmail → Settings → Accounts → Send mail as → add `sales@nurengroup.com`
3. Swap `SMTP_USER` to `sales@nurengroup.com` and generate a fresh app password → update `SMTP_PASS`
4. `railway up --detach` to redeploy

Until one of A or B is done, emails go out as `Nuren Media <sales@nurengroup.com>` on headers but via the Gmail server — **some recipients' spam filters may flag this as "suspicious from address"**. Plan the domain verification in the first 48 hours.

### 4. Configure the Resend inbound webhook (once Resend is wired)

Reply handling auto-classifies inbound email (positive / objection / not_now / unsubscribe / noise) and pauses the sequence accordingly.

1. Resend → Webhooks → Add endpoint
2. URL: `https://nuren-api-production.up.railway.app/api/tracking/webhook/resend`
3. Events: `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`
4. (Note: Resend signs webhooks with svix signatures. TODO: add svix verification before high-volume use — the receiver currently accepts any POST.)

### 5. Upload the Nuren knowledge base (one-time)

Your 27 PPTX decks live at `C:\Users\User\Documents\EIAAW Solutions\Nuren Media ai sales agent\drive-download-20260422T222210Z-3-001`.

**Two paths to ingest:**

**A. Upload via UI (slow but interactive)**: Knowledge Base → Upload+Ingest, one file at a time. Progress shown per slide. Best for the first 1–2 decks so you can watch Vision work.

**B. Upload via CLI (fast for batch)**:

```bash
# On your Windows laptop:
cd "c:/laragon/www/Nuren-Media ai sales agent"
# Ingest runs against LOCAL data/ dir. Then we rsync the SQLite to prod.
# Easier alternative: use the /api/knowledge/ingest-dir endpoint with a file path
# ON the Railway container — but that requires the PPTX to be on the container.
# So for batch, do:
#   (1) zip the 27 PPTX folder
#   (2) POST /api/knowledge/upload repeatedly via curl with your auth token
#   OR
#   (3) run the Vision pass locally (your dev has the files), then copy data/agent.db up
```

**Cost reality**: Full 27-deck Vision ingest estimated at **USD $50–100** on the production Anthropic key, one-time. The cost is dominated by rate-card slides where we enforce structured JSON extraction with uncertainty tracking (zero-hallucination contract).

**My recommendation**: Upload 1 rate-card deck first via UI, inspect the `vision_rates_json` field on a few slides (via `/api/knowledge/search?q=package A`), confirm the numbers match the deck, then run the batch. Gives you a sanity gate before the full spend.

## Day-to-day operator loop

1. **Upload leads** — Leads tab → Upload CSV (toggle "AI-enrich" to run web search + verification gate per row)
2. **Inspect leads** — table filters by status, heat, persona, search
3. **Create a campaign** — Campaigns → New campaign → pick objective + industry + budget tier → Activate
4. **Enroll leads** — Campaign detail → multi-select leads → Enroll
5. **Let the scheduler work** — cron runs every minute; drafts + sends Day 1 immediately, Day 3 after 2 days, Day 6 after 5, Day 10 after 9
6. **Review drafts needing attention** — Drafts tab shows any draft flagged `needs_review` (low confidence or no citations). Send or discard.
7. **Classify replies** — when Resend webhook is configured, reply classification is automatic. Until then, forward replies manually via `POST /api/inbound/mark-reply`.
8. **Advance pipeline** — Pipeline kanban → drag cards across stages. Closing to `closed_won` requires `deal_value_myr`.
9. **Book meetings** — Appointments → Book + send invite. Auto Meet link + ICS calendar attachment + branded `/call/:token` landing.
10. **Check analytics daily** — Dashboard shows "today at a glance". Analytics tab shows full funnel + per-segment + A/B winners + top messages + 14-day chart.

## Hybrid-model rule (non-negotiable)

The scheduler stops at Day 10 (step 4 of 4). If the prospect hasn't replied, enrollment → `completed`. Human picks up from there. There is no step 5, ever. This is baked into `HYBRID_STOP_AFTER_LAST_STEP = true` in `src/services/scheduler.js` and shouldn't be changed without explicit product decision.

## Lead Gen Contract (non-negotiable)

Every lead — whether manual, CSV, AI-enriched, or from a connector — must pass the verification gate:

- ≥1 `verification_sources` URL (LinkedIn, company site, verified social, etc.)
- EITHER `linkedin_url` OR `company_website` present and valid
- `confidence_score` not `low`
- Hot leads must have a `buying_signal`
- No email guessing (patterns like `first.last@company.com` are rejected)

Rejected leads are logged to `leads_rejected` with reasons. Inspect via Leads tab → "View rejected".

## Lead generation

Nuren has **three ways** leads enter the system:

| Method | How | When to use |
|---|---|---|
| **AI Generate** (primary) | Campaigns tab → "AI Generate" button on a row OR open a campaign → "AI lead generation" card → set count → click button | Daily use. Claude runs live web searches against the campaign's ICP and returns verified B2B leads with LinkedIn URLs and verification sources. |
| **CSV upload** | Leads tab → Upload CSV | When you already have a list (conference attendee export, BD's personal rolodex, exported Sales Nav search). Optional AI enrichment per row. |
| **Manual add** | Leads tab → "Add lead" | One-off. For leads the salesperson met offline or at an event. |

### AI Generate — the primary lead-gen surface

1. Go to **Campaigns** → open (or create) a campaign with rich ICP fields filled in: `target_industry`, `target_persona`, `target_budget_tier`, `pitch_angle`, `notes`. The richer the ICP fields, the better the AI's output — a blank campaign will get generic leads.
2. On the campaign detail page, find the **AI lead generation** card (near the top). Set **count** (1–15) and click **AI Generate Leads**.
3. Wait 30–90 seconds. Claude runs 4–8 live web searches (LinkedIn, company sites, directories, news) and returns JSON.
4. Every returned lead is run through Nuren's server-side verification gate — any lead with `confidence=low`, no verification URL, or `hot` without a buying signal is discarded automatically.
5. Accepted leads appear in the **Leads** tab with `source=ai_generated`, attached to the campaign via `campaign_leads`.

**Cost**: ~$0.05–$0.20 per click (depends on how many web searches Claude needs). Tracked in `ai_cost_log` with `task_type='lead_generation'`. Per-campaign budget cap: set `budget_limit` when creating the campaign — if cumulative spend hits it, AI Generate throws with a clear error.

**Hard cap**: 15 leads per click. Claude's web_search quality degrades above that (starts recycling results). For more, click again — each click is a fresh search pass.

**If you see**: `"Your credit balance is too low to access the Anthropic API"` → top up at https://console.anthropic.com/settings/billing. Nuren's cost-logger only fires on successful Anthropic responses, so failed calls charge nothing.

### Why no scrapers / connectors

The earlier connector panel (LinkedHelper webhook, Meta Ad Library, Shopee, Lazada, Event List) was removed 2026-04-23. Scrapers carry ToS risk, require a desktop app running on someone's laptop, and need manual campaign setup that's easy to misconfigure (the PETRONAS-engineers mistake). The AI Generate flow achieves the same outcome (verified B2B leads landing in Nuren) with zero desktop dependency and built-in ICP matching. If you ever need CSV import from an external scraper (Wiza, Apollo, Phantombuster), use the CSV upload flow — all leads still pass the verification gate.

## Monitoring

- `/api/health` — returns `{status:"ok", vec:true}` when sqlite-vec loaded and DB responsive
- Analytics Dashboard → AI cost this month (watch for unexpected spikes; set per-campaign `budget_limit` to hard-cap)
- Railway metrics for CPU / memory / restarts

## Incident response

- **Scheduler stuck**: `railway logs` will show the failing enrollment id + error. Enrollments that fail stay in `failed` status with the full error in `paused_reason`. Fix root cause, then `UPDATE sequence_enrollments SET status='running' WHERE status='failed' AND paused_reason LIKE '%...%'` to retry.
- **Volume fills up**: 50 GB quota. `railway volume list` shows usage. Large PPTXs live in `/app/data/knowledge-base/` — delete ingested files you don't plan to re-ingest.
- **Gmail rate-limit**: Gmail SMTP has low daily quota (~500/day for personal, 2000/day for Workspace). Switch to Resend before scaling past that.
- **Anthropic spend spike**: check per-campaign cost in Campaigns tab, or `GET /api/analytics/ai-cost`. Pause campaigns via UI; they stop drafting immediately.

## Where to find source

- `c:/laragon/www/Nuren-Media ai sales agent/` (local dev)
- Memory index: `C:\Users\User\.claude\projects\c--laragon-www-Nuren-Media-ai-sales-agent\memory\MEMORY.md`

## Helpful commands

```bash
# Redeploy
cd "c:/laragon/www/Nuren-Media ai sales agent" && railway up --detach

# Tail live logs
cd "c:/laragon/www/Nuren-Media ai sales agent" && railway logs

# List / update env vars
cd "c:/laragon/www/Nuren-Media ai sales agent" && railway variables --kv
cd "c:/laragon/www/Nuren-Media ai sales agent" && railway variables --set "FOO=bar"

# Local dev (without cron firing)
cd "c:/laragon/www/Nuren-Media ai sales agent" && SCHEDULER_DISABLED=1 npm run dev

# Quick RAG smoke test locally (after ingesting at least 1 PPTX locally)
cd "c:/laragon/www/Nuren-Media ai sales agent" && npm run smoke:rag -- "MMY KOL rate for FMCG baby"
```
