# UNSPSC Spend Categorizer

**Auto-categorise procurement spend into 8-digit UNSPSC commodity codes.** Supplier enrichment
plus LLM classification, **parent/subsidiary mapping** with code inheritance, a human review loop,
a **live supplier sync**, and **CSV/PDF reporting** with roll-up by parent company.

Built to run entirely on **free tiers**: Neon Postgres, Render (worker), Vercel (frontend + API)
and Groq (LLM). No paid dependency is required.

```
Supplier CSV ──▶ upsert (dedupe on normalised name)
                      │
                      ▼
              enrichment (CompanyEnrich / Context.dev, cached)
                      │
                      ▼
              parent detection ──▶ parent_id / is_parent  (self-referencing FK)
                      │
                      ▼
   ┌──────────────────┴───────────────────┐
   │  classify PARENTS first (Groq)       │   one request per corporate family
   └──────────────────┬───────────────────┘
                      ▼
        propagate code to SUBSIDIARIES (inherited_from_parent = true)
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  review queue (< 0.7)        corrections ──▶ few-shot examples for future prompts
        │                           │
        └─────────────┬─────────────┘
                      ▼
        CSV / PDF reports (filters + parent roll-up)
```

**Why this exists.** Classifying spend against UNSPSC is normally a manual, consultant-led
exercise: someone reads a supplier list and assigns codes by hand. This does it as a pipeline —
enrich each supplier from the web, work out who owns whom, classify the **parent** once, inherit
the code to its subsidiaries, flag the uncertain ones for a human, and feed every correction back
into the next classification. The hierarchy handling is the part most tools skip, and it is where
most of the cost saving is: one model call covers a whole corporate family instead of one per
supplier.

**Keywords:** UNSPSC classification · spend categorization · procurement analytics · supplier
classification · commodity code classification · parent/subsidiary mapping · corporate family
resolution · LLM classification · Llama 3.3 · Groq · supplier enrichment · NAICS · SIC · Next.js ·
Drizzle ORM · Neon Postgres · CSV / PDF reporting.

---

## Table of contents

- [Feature checklist](#feature-checklist)
- [Architecture](#architecture)
- [Quick start (5 minutes)](#quick-start-5-minutes)
- [Environment variables](#environment-variables)
- [Authentication](#authentication)
- [Public read-only demo](#public-read-only-demo)
- [Project layout](#project-layout)
- [How the pipeline works](#how-the-pipeline-works)
- [The live supplier sync](#the-live-supplier-sync)
- [Enrichment with Bright Data](#enrichment-with-bright-data)
- [Reporting](#reporting)
- [API reference](#api-reference)
- [Free-tier budget management](#free-tier-budget-management)
- [Deployment runbook: GitHub → Neon → Groq → Vercel → Render](#deployment-runbook)
- [Local development with Docker](#local-development-with-docker)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Branding](#branding)
- [Licence](#licence)
- [SEO and metadata](#seo-and-metadata)

---

## Feature checklist

| # | Requirement | Where |
|---|---|---|
| 1 | CSV upload of suppliers (name, optional amount, date) | `app/upload/page.tsx`, `app/api/upload/route.ts`, `lib/csv.ts` |
| 2 | Deduplicate suppliers by name; upsert on conflict | `services/suppliers.ts` (`bulkUpsertSuppliers`, `canonicalizeEntityName`) |
| 3 | Enrich via web API: domain, industry, NAICS, SIC, description, parent | `services/enrichment.ts` |
| 4 | Automatic parent/child detection (API first, LLM fallback) | `services/enrichment.ts`, `services/prompts.ts` |
| 5 | Parent-first 8-digit UNSPSC classification with few-shot prompt | `services/classification.ts`, `services/prompts.ts` |
| 6 | Store confidence, reasoning, inheritance flag | `db/schema.ts` (`classifications`) |
| 7 | Dashboard with hierarchy view | `app/page.tsx`, `app/hierarchy/page.tsx` |
| 8 | Manual review queue for confidence < 0.7 / uncertain parents | `app/review/page.tsx`, `services/classification.ts` (`getReviewQueue`) |
| 9 | Feedback loop: corrections become few-shot examples | `services/classification.ts` (`recentCorrectionExamples`) |
| 10 | Export as CSV or PDF, with roll-up by parent | `app/api/export/route.ts`, `services/reporting/*` |
| 11 | Admin settings: thresholds, models, parent toggle, sync schedule | `app/settings/page.tsx`, `services/settings.ts` |
| 12 | Audit log for enrichment, classification and corrections | `services/audit.ts`, `app/audit/page.tsx` |
| 13 | Scheduled re-enrichment, stale detection, reclassification trigger | `services/sync.ts`, `worker/*` |
| 14 | Weekly PDF report stored in Neon | `worker/scheduler.ts`, `services/reporting/store.ts` |

**Accuracy levers implemented** (section 14 of the brief):

1. **Candidate-code injection** — the top ~20 UNSPSC codes whose commodity/class/family text
   matches the supplier's industry and description are retrieved from the seeded taxonomy and
   added to the prompt (`services/classification.ts` → `findCandidateCodes`).
2. **Confidence threshold** — `< CLASSIFY_CONFIDENCE_THRESHOLD` (default 0.7) routes a supplier
   to the review queue.
3. **Correction feedback** — every human correction is stored in `corrections` and replayed as a
   few-shot example ahead of the defaults.
4. **Model tiering** — `llama-3.3-70b-versatile` for parents, high-spend suppliers and
   independents; `llama-3.1-8b-instant` for the long tail of subsidiaries.
5. **Taxonomy validation** — a returned code that is not in `unspsc_codes` is walked up to its
   real class/family/segment and its confidence is capped at 0.4, so an invented code can never
   be stored as a confident answer.

> **Note on the seed examples.** The codes quoted in the original prompt (`43211500`,
> `43232400`, `40141600`, `51151500`, `78102200`) are 8-digit *class* prefixes and do **not**
> exist as commodities in UNSPSC v26 — commodities are more specific. `services/prompts.ts`
> therefore ships verified v26 commodity codes (`43211507` Desktop computer, `43232401`
> Configuration management software, `40141602` Needle valves, `51201604` Diphtheria vaccine,
> `78102204` Worldwide letter and parcel delivery), and
> `loadVerifiedFewShotExamples()` re-checks every example against the live taxonomy at
> classification time, repairing anything that drifts. Without this, every classification would
> have been hit with the 0.4 "unverifiable code" penalty.

---

## Architecture

```
┌──────────────────────────────── Vercel (Hobby) ────────────────────────────────┐
│  Next.js 14 App Router · TypeScript · Tailwind · shadcn/ui                     │
│                                                                                │
│  Pages            /  /hierarchy  /review  /reports  /audit  /settings  /upload │
│  Route handlers   /api/upload   /api/enrich   /api/classify   /api/sync        │
│                   /api/suppliers /api/classifications /api/export              │
│                   /api/reports  /api/audit   /api/settings   /api/health       │
│                   /api/hierarchy /api/metrics                                  │
└───────────────┬───────────────────────────────────────────┬────────────────────┘
                │ postgres.js (pooled, prepare:false)       │ HTTPS (JSON mode)
                ▼                                           ▼
     ┌────────────────────┐                    ┌──────────────────────────┐
     │  Neon Postgres     │                    │  Groq                    │
     │  · suppliers       │◀───────────────────│  · llama-3.3-70b (1k/day)│
     │  · unspsc_codes    │   shared services  │  · llama-3.1-8b  (14.4k) │
     │  · classifications │◀──────────┐        └──────────────────────────┘
     │  · corrections     │           │        ┌──────────────────────────┐
     │  · enrichment_cache│           └────────│  CompanyEnrich /         │
     │  · audit_log       │                    │  Context.dev (500 credits)│
     │  · reports (bytea) │                    └──────────────────────────┘
     │  · app_settings    │
     │  · llm_usage       │
     └─────────┬──────────┘
               │
               ▼
   ┌─────────────────────── Render (free Web Service) ────────────────────────┐
   │  worker/index.ts                                                         │
   │   · /health   ← cron-job.org ping every 5 min (defeats 15-min spin-down) │
   │   · /status   · /ready   · POST /run?job=sync|report                     │
   │   · scheduler: daily sync (CRON_SYNC) + weekly PDF (CRON_REPORT)          │
   │   · catch-up on wake-up so a sleeping dyno never skips a scheduled run    │
   └──────────────────────────────────────────────────────────────────────────┘
```

**Shared code strategy.** The route handlers and the worker import the *same* `services/*` and
`lib/*` modules — there is one implementation of the classification pipeline, one hierarchy
implementation and one report renderer. The worker runs TypeScript directly through `tsx`, which
resolves the `@/*` path aliases, so there is no second build artefact to keep in sync.

---

## Quick start (5 minutes)

```bash
git clone https://github.com/olenny-coder/unspsc-mapper.git
cd unspsc-mapper
npm install

# 1. Database (docker compose, or paste a Neon URL instead)
docker compose up -d
echo 'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/unspsc"' > .env.local

# 2. Credentials (optional to start: the app runs without them in "LLM-only"/"name-only" modes)
echo 'GROQ_API_KEY="gsk_..."' >> .env.local
echo 'ENRICH_PROVIDER="none"' >> .env.local

# 3. Schema + taxonomy
npm run db:migrate
npm run db:seed            # loads 149,849 UNSPSC v26 codes
npm run db:seed:sample     # loads samples/suppliers.csv and runs the pipeline
npm run db:seed:demo       # optional: illustrative classifications, so the dashboard
                           # chart and review queue are populated without a Groq key

# 4. Run
npm run dev                # http://localhost:3000
```

Then open <http://localhost:3000>, upload `samples/suppliers.csv`, and export a PDF from the
dashboard.

### Useful scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run lint` | ESLint (`next lint --max-warnings=0`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests (213 tests) |
| `npx tsx scripts/smoke-offline.ts` | Offline pipeline smoke test (CSV → dedupe → hierarchy → plan → prompt → roll-up) |
| `npm run db:check` | Read-only readiness report: connectivity, all 9 tables, taxonomy count, storage vs the Neon free tier. Use instead of `psql` |
| `npm run db:migrate` | Apply `db/migrations/*.sql` to `DATABASE_URL` |
| `npm run db:seed` | Seed the UNSPSC taxonomy (`-- --limit=5000` for a quick run) |
| `npm run db:seed:sample` | Seed `samples/suppliers.csv` and run enrich → link → classify → report |
| `npm run db:seed:demo` | Write illustrative classifications offline (no Groq key needed) so every screen has data; `-- --clean` removes them |
| `npm run assets:generate` | Regenerate the favicon, PWA icons and social card from the brand geometry |
| `npm run db:studio` | Drizzle Studio |
| `npm run worker:dev` | Run the worker locally with watch |
| `npm run worker:start` | Run the worker as Render does (`node --import tsx worker/index.ts`) |
| `npm run worker:once` | One-shot sync without starting the HTTP server |
| `npm run worker:ping -- <url>` | Keep-alive ping for the Render free tier |
| `node scripts/visual-check.mjs <url> <secret>` | Headless audit: overflow, contrast, tap targets, themes, screenshots |
| `npm run check:all` | lint → typecheck → test → build |

---

## Environment variables

`.env.example` contains every variable with sane defaults. **Only three are required** to unlock
the full pipeline; everything else has a working default.

### Required for full functionality

| Variable | Required | Example | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | `postgresql://user:pass@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require` | Neon **pooled** connection string. The app throws a clear error if it is missing. |
| `GROQ_API_KEY` | for classification | `gsk_...` | <https://console.groq.com/keys>. Without it, suppliers are stored and enriched but not classified. **This is where your Groq key goes** — `.env.local` locally, and the Vercel + Render environment variables for deployments. |
| `DASHBOARD_SECRET` | **in production** | long random string | Protects the dashboard and every mutating endpoint. Falls back to `WORKER_SECRET`. |
| `WORKER_SECRET` | **in production** | long random string | Protects `POST /api/sync` and worker-only operations. |

### Where to put your Groq API key

| Environment | Where | How to verify |
|---|---|---|
| Local (`npm run dev`) | `.env.local` → `GROQ_API_KEY="gsk_..."`, then restart `npm run dev` | `curl localhost:3000/api/health` → `checks[name=groq].ok === true` |
| Vercel (frontend + API) | Project → Settings → Environment Variables → add `GROQ_API_KEY` for **Production and Preview**, then redeploy | Same health check on your Vercel URL |
| Render (worker) | The `unspsc-spend-worker` service → Environment → add `GROQ_API_KEY` | `curl https://<worker>.onrender.com/health`, then `POST /run?job=sync` |

Both locations are needed: the Vercel deployment classifies on upload/from the dashboard, and the
Render worker classifies during the scheduled sync. `/settings` shows whether each side can see
the key (`Groq → configured`), and `/api/health` reports it per service.

---

## Theming and responsive layout

### Light / dark / system

Three preferences, not two: **Light**, **Dark**, and **System** (follow the device). A phone set to
dark and a desktop set to light is the common case, so a binary toggle would fight the OS. The
switcher sits in the header at every width.

| Concern | Implementation |
|---|---|
| No white flash on load | `THEME_INIT_SCRIPT` (`lib/theme.ts`) runs in `<head>` **before first paint** and sets `.dark` on `<html>`, `color-scheme` and `<meta name="theme-color">` |
| Single source of truth | Components use semantic tokens (`bg-background`, `text-foreground`, `border-border`, …); dark mode is a token swap in `globals.css`, not a second set of classes per component |
| Meaningful colour still themes | Status variants (`success`/`warning`/`info` badges and alerts) declare explicit `dark:` treatments — translucent tinted background with light text |
| Charts follow the theme | Chart colours are CSS-variable tokens (`--chart-1…5`); a `MutationObserver` on `<html>` re-reads them on switch so the SVG repaints |
| No transition storm | A guard class disables CSS transitions for one frame during the switch |
| Survives hydration | `suppressHydrationWarning` on `<html>`; the provider reads the real value in an effect so server and client markup match |
| Reduced motion | `prefers-reduced-motion` disables animations |

The boot script and the React provider share one resolution rule (`resolveTheme`), and a unit test
executes the real script against a stub DOM to prove the two cannot drift.

### Responsive behaviour

Verified at **320, 390, 768 and 1440 px**:

- **Navigation** collapses below `lg` into a hamburger panel with full-width rows, sign-out and a
  body-scroll lock while open. The theme toggle stays reachable at every width.
- **Tables** stay tabular rather than being re-implemented as cards: each scrolls horizontally with
  touch momentum, a sticky first column and an edge fade. The critical detail is
  `width: max-content` on the table — a `min-width` alone lets the table's intrinsic width escape
  the scroll container and widen the entire page (that caused 332px of page overflow before it was
  found and fixed).
- **Filter bar, card headers, dialogs and forms** stack to full width on small screens. The export
  dialog never exceeds the viewport (`calc(100vw - 1.5rem)`, `max-h-[calc(100dvh-2rem)]`).
- **Charts** reclaim axis-label space on narrow screens and resize their container.
- **Buttons** are 40px tall on mobile and 36px from `sm` up; icon buttons are 36px square; checkboxes
  and switches extend their hit area so every non-inline control clears 32×32 (WCAG 2.5.8 asks for
  24×24).

### Automated UI audit

`scripts/visual-check.mjs` drives Edge over the Chrome DevTools Protocol and, per viewport and
theme, measures:

- horizontal page overflow, excluding intentional scroll containers
- **real WCAG contrast ratios** from every visible text node's *rendered* colours against its nearest
  opaque background — contrast cannot be judged from class names
- effective tap-target size, including pseudo-element hit areas
- theme state, header height, mobile-nav presence

```bash
node scripts/visual-check.mjs http://localhost:3000 "$DASHBOARD_SECRET" ./screenshots
```

Current result: no overflow at any viewport; all sampled text ≥ 4.5:1 in both themes (minimum 4.7
light / 6.86 dark); every non-inline control ≥ 32×32; screenshots written for visual review.

---

## Authentication

The dashboard and **every** mutating endpoint require a credential. There are two ways in:

```bash
# 1. Bearer token (scripts, curl, cron)
curl -H "Authorization: Bearer $DASHBOARD_SECRET" https://your-app.vercel.app/api/metrics

# 2. Browser session (signed HttpOnly cookie, 7 days)
open https://your-app.vercel.app/login   # paste the same secret
```

| Rule | Behaviour |
|---|---|
| Public paths | `/login`, `/api/auth/login`, `/api/auth/session`, `/api/health` (so an uptime monitor can ping it) |
| Page request without a session | `307` redirect to `/login?next=<original path>` |
| API request without a session | `401` JSON error |
| Wrong secret | `401` (never `400`, so credential failures are distinguishable from malformed requests) |
| Production with no secret configured | `503` — endpoints are **disabled**, not silently open |
| Development with no secret configured | Open, unless `ALLOW_UNAUTHENTICATED_DEV=false` |

Enforcement happens twice: `middleware.ts` (Edge) denies by default for every matched route, and
each route handler calls `requireAuth()` so protection does not depend on middleware alone. The
session token is `expiry.HMAC-SHA256(expiry)` — tampering with the expiry invalidates it, and
failed logins are written to the audit log with the source IP.

> **Deploy note:** set `DASHBOARD_SECRET` in Vercel *and* Render. If you skip it in production,
> the API returns 503 rather than exposing your data — the failure is loud, not silent.

### Quick local test

```bash
docker compose up -d postgres
cat >> .env.local <<'EOF'
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/unspsc"
DASHBOARD_SECRET="local-dev-secret"
GROQ_API_KEY=""
ENRICH_PROVIDER="none"
EOF
npm run db:migrate && npm run db:seed && npm run db:seed:sample
npm run dev          # -> http://localhost:3000/login  (secret: local-dev-secret)
```

### Provider and tuning

| Variable | Default | Notes |
|---|---|---|
| `ENRICH_PROVIDER` | `companyenrich` | `companyenrich` \| `contextdev` \| `brightdata` \| `none`. `none` runs the pipeline offline with name-derived heuristics. |
| `ENRICH_API_KEY` | — | 500 free credits on companyenrich/contextdev. Bright Data is paid per record. Results are cached in Postgres, so repeat runs cost 0 credits. |
| `ENRICH_BASE_URL` | provider default | Override for a proxy or a self-hosted gateway. |
| `ENRICH_DATASET_ID` | — | **Bright Data only**, and required with it: the Scraper API is keyed by dataset. See [Enrichment with Bright Data](#enrichment-with-bright-data). |
| `ENRICH_INPUT_URL_TEMPLATE` | — | Bright Data only. Placeholders `{domain}` `{slug}` `{name}` for datasets whose input URL is not the company's own site. |
| `ENRICH_MONTHLY_CREDIT_LIMIT` | `500` | Surfaced on `/api/health` and `/settings`. |
| `ENRICH_CONCURRENCY` | `3` | Parallel enrichment lookups. |
| `GROQ_MODEL_ACCURATE` | `llama-3.3-70b-versatile` | 1,000 req/day free. |
| `GROQ_MODEL_BULK` | `llama-3.1-8b-instant` | 14,400 req/day free. |
| `CLASSIFY_CONFIDENCE_THRESHOLD` | `0.7` | Below this (and unreviewed) → review queue. |
| `CLASSIFY_MODEL_STRATEGY` | `tiered` | `tiered` \| `accurate` \| `bulk`. |
| `LLM_BATCH_SIZE` | `10` | Suppliers per Groq request (max 10). |
| `LLM_MAX_REQUESTS_PER_MINUTE` | `25` | Local token-bucket guard against Groq 429s. |
| `LLM_MAX_REQUESTS_PER_DAY_70B` | `1000` | Durable daily budget in `llm_usage`. |
| `LLM_MAX_REQUESTS_PER_DAY_8B` | `14400` | Same, for the bulk model. |
| `LLM_DAILY_BUDGET_RESERVE` | `50` | Requests held back for interactive dashboard actions. |
| `SYNC_STALE_DAYS` | `30` | Re-enrich anything older than this. |
| `SYNC_BATCH_SIZE` | `25` | Suppliers per sync batch. |
| `SYNC_MAX_BATCHES_PER_RUN` | `12` | Upper bound on work per run (keeps a run inside a request budget). |
| `CRON_SYNC` | `0 3 * * *` | Daily sync, UTC. |
| `CRON_REPORT` | `0 6 * * 1` | Weekly PDF, Mondays 06:00 UTC. |
| `WEEKLY_REPORT_ENABLED` | `true` | Toggle the weekly job. |
| `CRON_SECRET` | — | Secret for the worker's own `/run` endpoint (falls back to `WORKER_SECRET`). |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | Printed on report title pages. |
| `APP_ACTOR` | `dashboard` | Default `actor` recorded in the audit log. |
| `DEMO_MODE` | `false` | Serve the read-only demo to anonymous visitors. See [Public read-only demo](#public-read-only-demo). |
| `ADMIN_EMAILS` | — | Reserved for multi-tenant deployments. |
| `PORT` | `10000` | The worker's HTTP port on Render. |
| `UNSPSC_SEED_CSV` | — | Path to an authoritative taxonomy CSV for `db:seed` (columns: `code,segment,family,class,commodity,description`). |
| `UNSPSC_VERSION` | `v26.0801` | Stored on every seeded code. |

---

## Public read-only demo

Set `DEMO_MODE=true` and anyone can browse the whole application without signing in — every page,
with realistic sample data — but nothing they do changes anything and no real data is served.

This exists so the app can be shown to a colleague, a reviewer or a prospect without handing over the
dashboard secret, and without the risk of a stranger uploading a file or burning the Groq quota.

### How the isolation actually works

The enforcement is **structural**, not a per-route check that someone has to remember to add:

* `jsonHandler` in `lib/api.ts` is the single wrapper every API route in the app goes through. When a
  request is a demo request it is answered from `lib/demo/responses.ts` and the route's own handler
  **never runs** — so no query executes and no provider is called. Adding a new endpoint therefore
  cannot accidentally expose it: an unlisted path is refused, not inherited.
* Non-GET verbs are refused before that lookup even happens, which is what makes the demo read-only
  regardless of what any individual route decides.
* The dataset in `lib/demo/dataset.ts` is pure static data with a single type-only import. There is
  no database client, no fetch and no service in its dependency graph to reach for.
* Only `/api/health` bypasses `jsonHandler` (it is a public path with its own handler), so it reduces
  its real row counts to plain reachability for a demo visitor.

The test suite enforces this rather than trusting it: `tests/demo.test.ts` mocks `getDb()` to **throw**,
then exercises every demo read endpoint. If any demo path ever reaches the database, those tests fail
instead of quietly leaking a row.

### Who counts as a demo visitor

Only a request carrying **no credential at all**.

A failed or expired credential is *not* treated as a demo visitor — it gets the normal 401 and the
sign-in flow. That distinction is deliberate: silently answering an expired session from the sample
dataset would show fabricated suppliers and amounts to someone who believes they are looking at their
real deployment, which is a worse outcome than an extra sign-in prompt.

### What a visitor sees

* A permanent amber banner: sample data, and that changes are disabled.
* All seven pages fully populated — dashboard charts, hierarchy tree, review queue, audit trail,
  reports, upload template, settings.
* Mutating controls visibly disabled: upload, enrich, classify, sync, linking parents, saving
  corrections, changing settings, generating or downloading reports.
* "Sign in" in place of "Sign out" in the header, and an *Explore the demo* button on `/login`.

If a disabled control is somehow reached anyway, the server answers `403` with
`code: "demo_read_only"` and a message the UI displays.

### Turning it on and off

```bash
DEMO_MODE="true"     # in .env.local, or the Vercel/Render environment
```

Nothing else is required — the dataset ships with the app. Set it back to `"false"` (the default) and
the deployment is locked down exactly as before. Because the demo path never reads your database, you
can leave it on after loading real suppliers: they simply are not served to anonymous visitors.

Pair it with `ALLOW_INDEXING="true"` only if you actually want the demo indexed by search engines.

---

## Project layout

```
├── app/
│   ├── api/                        # Route handlers (Node runtime, force-dynamic)
│   │   ├── audit/                  #   GET  audit log + summary
│   │   ├── classifications/[id]/    #   PATCH correction · DELETE clear
│   │   ├── classifications/        #   GET  list / review queue / segments
│   │   ├── classify/               #   POST classify · GET plan / code search
│   │   ├── enrich/                 #   POST enrich batch · GET pending
│   │   ├── export/                 #   GET  csv|pdf|rollup|hierarchy · POST preview
│   │   ├── health/                 #   GET  dependency + budget status
│   │   ├── hierarchy/              #   GET tree · POST link · DELETE unlink
│   │   ├── metrics/                #   GET  one-shot dashboard payload
│   │   ├── reports/[id]/download/  #   GET  stored report bytes
│   │   ├── reports/                #   GET list · POST generate · DELETE
│   │   ├── settings/               #   GET / PATCH settings
│   │   ├── suppliers/[id]/         #   GET supplier detail + history
│   │   ├── suppliers/               #   GET list with filters / meta
│   │   ├── sync/                   #   POST worker sync · GET last run
│   │   └── upload/                 #   POST CSV · GET template
│   ├── audit/page.tsx
│   ├── hierarchy/page.tsx
│   ├── reports/page.tsx
│   ├── review/page.tsx
│   ├── settings/page.tsx
│   ├── upload/page.tsx
│   ├── page.tsx                    # dashboard
│   ├── layout.tsx
│   └── globals.css
├── components/
│   ├── ui/                         # shadcn/ui primitives
│   ├── confidence-badge.tsx
│   ├── export-dialog.tsx           # format toggle + filter preview
│   ├── filter-bar.tsx
│   └── nav-links.tsx
├── db/
│   ├── schema.ts                   # Drizzle schema (single source of truth)
│   ├── client.ts                   # postgres.js pool + Drizzle
│   └── migrations/                 # 0000_init.sql + drizzle meta
├── lib/
│   ├── api.ts                      # route helpers, worker auth, error envelope
│   ├── client.ts                   # typed browser API client
│   ├── csv.ts                      # delimiter detection + parsing
│   ├── demo/
│   │   ├── dataset.ts              # bundled sample data for demo mode (pure data, no imports at runtime)
│   │   └── responses.ts            # the only thing that answers an anonymous demo request
│   ├── env.ts                      # validated environment
│   ├── errors.ts                   # typed error hierarchy
│   ├── format.ts                   # display formatting
│   ├── normalize.ts                # name/domain/date/amount normalisation
│   ├── rate-limit.ts               # token bucket + daily budget
│   ├── retry.ts                    # backoff, Retry-After, mapLimit
│   ├── unspsc-seed.ts              # taxonomy CSV → row mapping
│   ├── upload-template.ts          # CSV template + accepted columns (shared by the route and the demo)
│   ├── utils.ts                    # cn()
│   ├── validation.ts               # Zod contracts with explicit interfaces
│   └── vercel-origin.mjs           # build-time repair of Vercel origin vars (plain .mjs: next.config.mjs imports it)
├── services/
│   ├── audit.ts                    # audit writes + queries
│   ├── classification.ts           # plan, classify, propagate, correct, review queue
│   ├── enrichment.ts               # providers, cache, parent detection
│   ├── groq.ts                     # Groq client, JSON extraction, usage accounting
│   ├── hierarchy.ts               # pure hierarchy/cluster/rollup logic
│   ├── llm-usage.ts                # durable daily budget counters
│   ├── prompts.ts                  # system/user prompts + response validation
│   ├── reporting/
│   │   ├── aggregate.ts            # summary, segments, rollups, low-confidence
│   │   ├── csv.ts                  # CSV sections
│   │   ├── pdf.ts                  # pdf-lib layout engine + report document
│   │   └── store.ts                # generate, persist, list, prune
│   ├── settings.ts                 # settings singleton + masking
│   ├── suppliers.ts                # queries, upsert/merge, filters
│   └── sync.ts                     # stale detection + sync orchestration
├── worker/
│   ├── cron.ts                     # dependency-free cron matcher + catch-up
│   ├── http.ts                     # /health /status /ready /run
│   ├── index.ts                    # entry point
│   └── scheduler.ts                # croner scheduler + persisted last-run
├── scripts/
│   ├── migrate.ts
│   ├── seed-unspsc.ts
│   ├── seed-sample-suppliers.ts
│   └── ping-worker.mjs
├── samples/
│   ├── suppliers.csv               # 120+ suppliers incl. parents & subsidiaries
│   ├── transactions.csv            # transaction-level shape (amounts aggregated)
│   └── unspsc-v26-en.csv.gz        # 149,849 UNSPSC v26 codes (3.8 MB gz)
├── tests/                          # 345 Vitest tests
├── .github/workflows/ci.yml
├── docker-compose.yml
├── Dockerfile.worker
├── render.yaml
├── drizzle.config.ts
├── next.config.mjs
├── tailwind.config.ts
├── vitest.config.ts
└── tsconfig.json
```

---

## How the pipeline works

### 1. Upload and deduplicate

`POST /api/upload` accepts `multipart/form-data` (`file`), a raw `text/csv` body, or
`{ "csv": "..." }` / `{ "suppliers": [...] }` JSON. It detects the delimiter (`,` `;` `\t` `|`),
maps flexible headers (`name`/`supplier`/`vendor`/`company`, `amount`/`spend`/`total`, ...), and
folds duplicates **inside the file** by summing amounts.

Deduplication key = `canonicalizeEntityName(name).key`:

```
"Dell Technologies, Inc."  → dell technologies
"Dell Technologies Inc"    → dell technologies   (same supplier)
"ACME  CO., LTD"           → acme
"Acme Co"                  → acme                (same supplier)
"Barnes & Noble"           → barnes and noble
"Barnes and Noble, Inc."   → barnes and noble    (same supplier)
```

Two rules keep this safe: a name of two or more tokens always keeps at least one token
(so `Siemens AG` → `siemens` but `Limited` stays `limited`), and interior words are never
dropped (so `Acme Industrial` and `Acme Healthcare` stay distinct).

### 2. Enrichment

For each supplier: cache lookup (`enrichment_cache`, keyed by provider + normalised name) →
provider call (`GET /v1/company/enrich?website=` then `?name=`) → non-destructive merge.

**Non-destructive merge** (`mergeEnrichmentFields`) is what makes refreshes safe:

- `null`/empty incoming values never erase existing data;
- a richer description replaces a shorter one, never the reverse;
- `enriched_at` only moves forward;
- transaction counts accumulate.

Any change to `industry`, `naics`, `sic`, `description`, `domain` or `parentName` marks the
supplier as needing reclassification and clears its stale flag.

### 3. Parent detection and linking

1. The provider's ownership fields (`parent`, `parent_company`, `ultimate_parent`) are read first.
2. If nothing is returned and `parent_detection_enabled` is on, the LLM parent detector
   (`llama-3.3-70b-versatile`, batched up to 10 suppliers per prompt) is asked for the ultimate
   parent, with the supplier's own name filtered out as a self-reference artefact.
3. `resolveParentLinks` then creates a parent row when needed (`ensureParentSupplier`) and sets
   `parent_id`, `is_parent`, `parent_source` and `parent_confidence` — refusing any link that
   would create a cycle.

### 4. Parent-first classification

`planClassification` groups suppliers into **corporate families**:

| Case | Behaviour |
|---|---|
| Parent + subsidiaries | One representative per family is sent to the LLM; the code propagates to every subsidiary with `inherited_from_parent = true` and confidence `× 0.9`. |
| External parent (`parent_name`, no `parent_id`) | A *virtual* cluster is formed and grouped by parent name; one member represents the family. This is why grouping works even before the parent exists as a supplier row. |
| Independent supplier | Classified directly. |
| Dangling `parent_id` | Reported as an orphan, treated as independent — never silently attached to a family. |

Each family is one Groq request instead of one per supplier, which is what makes 1,000 requests/day
enough for a real spend file. Chain hierarchies (`A → B → C`) are collapsed to one cluster rooted
at the top company, with member depth preserved for display.

### 5. Review and feedback

`< threshold` and unreviewed → `/review`. A correction:

- writes a new `classifications` row with `reviewed = true`, `llm_model = 'human'`,
  `corrected_code` and `corrected_by`, superseding the previous row (history is preserved);
- records a `corrections` row, including `affected_supplier_ids` when propagation is on;
- optionally propagates to every descendant;
- becomes a few-shot example for subsequent prompts (`recentCorrectionExamples`).

---

## The live supplier sync

The database stays current in four ways.

**1. Incremental upsert** — every upload and UI action merges on `normalized_name`. Repeated
amounts accumulate; enrichment fields are only replaced by better data.

**2. Scheduled re-enrichment** — the worker runs `CRON_SYNC` (default daily 03:00 UTC) and
re-enriches suppliers whose `enriched_at` is older than `SYNC_STALE_DAYS` (30). Cache hits cost
zero provider credits, so a refresh of unchanged suppliers is free.

**3. Stale detection** — `findStaleSuppliers` classifies each candidate as `never_enriched`,
`enrichment_old`, `previous_failure` or `flagged_stale`, and orders by spend so the most
important suppliers refresh first. The dashboard shows a `stale` badge with the reason and age.

**4. Reclassification trigger** — when enrichment changes a material field, the supplier (and,
via `triggerReclassification`, its subsidiaries) is re-queued for classification.

**Audit** — every enrichment, classification, correction, link, sync and report writes an
`audit_log` row with the actor, so `/audit` can explain any number.

### Free-tier resilience

Render free web services sleep after 15 minutes idle, so a naive `setInterval` scheduler would
miss most runs. The worker instead:

1. evaluates the cron expression every 30 s while awake;
2. on start-up (and therefore on every wake-up) checks `didMissSchedule` against the last
   successful run recorded in `audit_log` and runs the missed job exactly once;
3. persists last-run state in the database, so restarts never double-run;
4. exposes a deliberately cheap `GET /health` (no DB round-trip) that cron-job.org pings every
   5 minutes to keep the service warm.

---

## Enrichment with Bright Data

Bright Data works differently from CompanyEnrich and Context.dev, and the differences *are* the
integration. It is a **Scraper API dataset**: you choose a dataset from their marketplace, and the
shape of each record is defined by that dataset. Three consequences:

1. **It needs a `dataset_id`.** There is no generic "look up this company" call. Find the id on the
   dataset's page in the Bright Data Control Panel. Without it the app reports enrichment as *not
   configured* and falls back to heuristics, rather than firing requests that cannot succeed.
2. **Its input is a URL, not a company name.** By default the app sends `https://<domain>`. If your
   dataset keys on a different site — a LinkedIn company dataset wants
   `https://www.linkedin.com/company/dell` and rejects `https://dell.com` with a 400 — set
   `ENRICH_INPUT_URL_TEMPLATE`:

   ```
   ENRICH_INPUT_URL_TEMPLATE="https://www.linkedin.com/company/{slug}"
   ```

   | Placeholder | Meaning | `dell.com` gives |
   |---|---|---|
   | `{domain}` | host, without `www.` | `dell.com` |
   | `{slug}` | registrable name, without TLD | `dell` |
   | `{name}` | supplier name as written | `Dell Technologies` |

   A supplier with no domain cannot be enriched by a URL-keyed dataset. That is reported as
   `no_domain` on those rows rather than as a provider outage, so the affected suppliers are
   obvious in the run summary.
3. **It is billed per record.** One credit per delivered record, and **records that fail because the
   input was wrong are still billed** — the request consumed resources. 5,000 credits are free every
   month (see [the cost picture](#bright-data-and-the-free-tier-story)), which covers 5,000 records;
   beyond that, pay-as-you-go is around **$1.50 per 1,000 records**. Set
   `ENRICH_MONTHLY_CREDIT_LIMIT` to a number you actually mean — the default of `500` is inherited
   from the other providers and is not a statement about your budget. Results are cached in Postgres,
   so re-running enrichment costs nothing.

### Where to get the dataset ID

A dataset ID looks like `gd_l1viktl72bvl7bjuj0`. Two places to find it:

- **The browser URL** when a scraper is open in the Control Panel — it contains `/cp/scrapers/gd_...`.
- **The Code examples panel** on the scraper's *Configuration* tab, pre-filled in the generated cURL.

Browse the available scrapers at <https://brightdata.com/cp/scrapers/browse>. Watch for the prefix:
an id starting with **`sd_`** is a *snapshot* id — the data from one request — not a dataset id, and
using it will fail.

For company firmographics the useful one is the LinkedIn companies scraper:

| Dataset | ID | Input URL |
|---|---|---|
| LinkedIn companies | `gd_l1vikfnt1wgvvqz95w` | `linkedin.com/company/{slug}` |

**Be aware of a real limitation here.** A LinkedIn dataset wants a LinkedIn company URL, and the
profile slug is *not* reliably derived from the domain — `hp.com` is `hewlett-packard`, `ibm.com` is
`ibm`. So `ENRICH_INPUT_URL_TEMPLATE="https://www.linkedin.com/company/{slug}"` works for
straightforward cases like `dell.com` → `dell`, and 404s for others. Those show up as `not_found`
rather than as wrong data, but a dataset keyed on the company's *own* website avoids the problem
entirely and works directly with the domains in your spend file. Check what input your chosen dataset
expects before committing to it — the probe reports a 400 with Bright Data's own explanation if the
shape is wrong.

### Configure it

```bash
ENRICH_PROVIDER="brightdata"
ENRICH_API_KEY="<your API key>"          # https://brightdata.com/cp/setting/users
ENRICH_DATASET_ID="<dataset id>"         # from the dataset's page in the Control Panel
ENRICH_MONTHLY_CREDIT_LIMIT="5000"       # set this deliberately
```

### Verify the field mapping before enriching a batch

Every dataset defines its own record shape, so the mapping cannot be assumed from documentation. The
probe makes it observable: it calls the API for one company and prints the URL sent, the HTTP status,
every key the record contains, and which mapped fields came back empty.

```bash
npm run brightdata:probe -- --domain dell.com --name "Dell Technologies"
npm run brightdata:probe -- --first 3        # three suppliers from the database
```

It writes nothing — no cache rows, no supplier updates. If a mapped field shows `— not found`, add
that dataset's key name to the alias list in `normalizeBrightDataPayload`
(`services/enrichment.ts`); the probe prints the key names to copy.

A field that matches nothing stays `null` rather than being guessed, which is deliberate: a missing
`industry` is visible on screen and simply leaves the classifier working from the supplier name,
whereas a wrong one would quietly produce wrong UNSPSC codes.

### How a lookup behaves

| Situation | Result |
|---|---|
| Records returned | First record mapped; 1 credit; cached in Postgres, so re-runs cost 0 |
| Empty array | `not_found` — the API's documented "these inputs produced no records" |
| A record carrying `error`/`error_code` | Failure, **not** a company whose every field is null |
| HTTP 400 | `invalid_input`, with Bright Data's own message naming the offending field |
| HTTP 401/403 | Reported as a key problem, and the run stops rather than degrading quietly |
| HTTP 202 | The job exceeded the one-minute synchronous limit; the app follows `progress` → `snapshot` and still returns the data |
| Supplier has no domain | `no_domain`, and no API call is made |

### Bright Data and the free-tier story

The Scraper API fits the free-tier theme better than it first appears: **every Bright Data account gets
5,000 free credits a month, no credit card required**, and the Scraper API charges **one credit per
record**. That is 5,000 enriched suppliers a month at no cost, renewing on the first — more generous
than the 500 credits CompanyEnrich and Context.dev give once.

Beyond that it is metered: around **$1.50 per 1,000 records** pay-as-you-go, or $1.30 on the Scale
plan (rates as published in September 2026 — check your account). Two things to keep in mind:

- **Failed records are still billed** when the input was wrong, so a misconfigured dataset can spend
  credits producing nothing. Run `npm run brightdata:probe` first.
- Other Bright Data products are a different story: the pre-collected **Datasets** and Company feeds
  start around **$250 per 100k records**, and the **Company Search API** is contact-sales. The Scraper
  API path used here is the cheapest self-serve option.

With 5,000 free records a month, the honest guidance is: try it, and set
`ENRICH_MONTHLY_CREDIT_LIMIT="5000"` so a runaway sync cannot exceed the free allowance.

To evaluate the pipeline without touching Bright Data at all, leave `ENRICH_PROVIDER=none` and use the
Groq free tier. Enrichment falls back to name-derived heuristics, and classification is largely
unaffected because it works from the supplier name, industry and description.

---

## Reporting

`GET /api/export?format=csv|pdf&<filters>` streams the file. `format=rollup` and
`format=hierarchy` return focused CSVs for the roll-up and the parent/subsidiary edge list.

### CSV

`supplier_id, supplier_name, domain, industry, naics, sic, country, unspsc_code, segment, family,
class, commodity, confidence, inherited_from_parent, reviewed, llm_model, reasoning, parent_id,
parent_name, is_parent, subsidiary_count, parent_source, total_amount, currency,
transaction_count, enriched_at, stale, stale_reason, created_at, updated_at`

followed by a `# Segment breakdown` section, a `# Parent roll-up` section (when applicable) and a
`# Low-confidence review appendix`, with a `#`-prefixed metadata preamble recording the exact
filters. A UTF-8 BOM is prepended so Excel opens accented names correctly.

### PDF

1. **Title page** — report name, date range, generated by/at, taxonomy version, roll-up mode and
   the active filters.
2. **Summary** — KPI cards (suppliers, spend, % classified, % low-confidence, parents,
   subsidiaries, inherited codes, stale) and the **top 10 parents by spend**.
3. **UNSPSC segment breakdown** — table plus a horizontal bar chart.
4. **Parent/subsidiary hierarchy table** — parents and their subsidiaries with codes, spend and
   stale counts.
5. **Low-confidence review appendix.**

Rendered with `pdf-lib` (pure JS, no native deps). Standard PDF fonts are WinAnsi, so text is
sanitised (`services/reporting/pdf.ts` → `sanitizePdfText`) before drawing — a supplier named
`Café “Dell’s” — Ltd` will not crash the renderer.

### Scheduled reports

The worker's `CRON_REPORT` (default Monday 06:00 UTC) generates a PDF with `rollup=parent`,
stores the bytes in `reports.blob`, and prunes the oldest rows (`pruneOldReports(30)`) so the
Neon free tier is never exhausted. Individual reports are capped at 4 MB; the current usage is
reported by `GET /api/reports?view=budget`.

---

## API reference

All JSON responses use the envelope `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { message, code, status, details } }`.

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/upload` | — | Parse CSV, upsert suppliers, optionally enrich + classify. |
| `GET` | `/api/upload` | — | Return the accepted column mapping and a template. |
| `POST` | `/api/enrich` | — | Enrich a batch (`supplierIds`, `pending`, `olderThanDays`, `force`). |
| `GET` | `/api/enrich` | — | Preview the batch that would be processed. |
| `POST` | `/api/classify` | — | Classify parent-first (`supplierIds`, `force`, `modelStrategy`). |
| `GET` | `/api/classify?plan=true` | — | Work plan + estimated Groq request count. |
| `GET` | `/api/classify?q=dell` | — | Search the seeded taxonomy (autocomplete). |
| `POST` | `/api/sync` | worker secret | Re-enrich stale, re-link, reclassify. `mode=report` generates the weekly PDF. |
| `GET` | `/api/sync` | worker secret | Last sync summary + health. |
| `GET` | `/api/suppliers` | — | Paginated list; `?meta=true` returns filter options; `rollup=parent` returns the roll-up. |
| `GET` | `/api/suppliers/:id` | — | Detail: parent, subsidiaries, classification history, corrections, audits. |
| `GET` | `/api/classifications` | — | List; `?view=queue` for the review queue, `?view=segments` for the breakdown. |
| `PATCH` | `/api/classifications/:id` | — | Correct a classification (`:id` = supplier id); optionally propagate. |
| `DELETE` | `/api/classifications/:id` | — | Clear a correction. |
| `GET` | `/api/export` | — | Stream `csv` \| `pdf` \| `rollup` \| `hierarchy` with filters. |
| `POST` | `/api/export` | — | Preview summary/segments for the export dialog. |
| `GET` | `/api/hierarchy` | — | Parent clusters with members. |
| `POST` | `/api/hierarchy` | — | Link a subsidiary to a parent (`parentId` or `parentName`). |
| `DELETE` | `/api/hierarchy` | worker secret | Unlink a subsidiary. |
| `GET` | `/api/reports` | — | Stored reports (`?view=budget` for storage usage). |
| `POST` | `/api/reports` | worker secret when `store=true` | Generate (and optionally store) a report. |
| `DELETE` | `/api/reports?id=` | worker secret | Delete a stored report. |
| `GET` | `/api/reports/:id/download` | — | Download stored bytes (regenerates if pruned). |
| `GET` | `/api/audit` | — | Audit log (`?view=summary` for counts). |
| `GET` | `/api/metrics` | — | One-shot dashboard payload (summary, segments, rollup, usage, last sync). |
| `GET` | `/api/settings` | — | Settings, effective values, masked secrets, usage history. |
| `PATCH` | `/api/settings` | — | Update thresholds, models, cron, parent detection. |
| `GET` | `/api/health` | — | Dependency + free-tier budget status. Never throws. |

### Filter parameters

`minConfidence`, `maxConfidence`, `confidenceState=all|low|reviewed|unreviewed|unclassified`,
`segment` (e.g. `43`), `unspscPrefix`, `parent`, `parentId`, `onlyParents`, `onlySubsidiaries`,
`onlyStale`, `from`, `to`, `industry`, `country`, `search`, `supplierIds`, `rollup=supplier|parent`.

Example:

```bash
# Low-confidence suppliers in segment 43, rolled up by parent, as PDF
curl -L "http://localhost:3000/api/export?format=pdf&segment=43&confidenceState=low&rollup=parent" \
  -o low-confidence-43.pdf
```

---

## Free-tier budget management

| Service | Limit | How this app stays inside it |
|---|---|---|
| Groq 70B | 1,000 req/day | Parents first (one request per family), 10 suppliers per batch, `llm_usage` daily counter with a configurable reserve, worker stops when the budget is gone. |
| Groq 8B | 14,400 req/day | Tiered routing sends the long tail of subsidiaries here. |
| Groq rate | requests/minute | Sliding-window token bucket (`RateLimiter`) shared per process. |
| Neon | 0.5 GB, 100 CU-h | Taxonomy trimmed to 89 MB by measurement (see below); blobs capped at 4 MB with 30-report retention; single-read report aggregation; connection pooling with `max: 1` on Vercel. |
| Render | 15-min spin-down | Cheap `/health` + cron-job.org ping, and cron catch-up on wake-up. |
| CompanyEnrich / Context.dev | 500 credits | Durable Postgres cache; a repeat enrichment of an unchanged supplier costs 0 credits. |
| Vercel | 100 GB bandwidth | Reports stream; no images; client components fetch only what they render. |

`GET /api/health` reports today's Groq usage per model and the enrichment credits used this
month, and `/settings` renders the same numbers as progress bars.

### Storage footprint

Measured, not estimated — `npm run db:check` reports it, and it is worth knowing before you fill
the 0.5 GB Neon free tier:

| Object | Before | After | What changed |
|---|---|---|---|
| `unspsc_codes` heap | 148 MB | 80 MB | dropped the denormalised `search_text` column |
| `unspsc_codes` indexes | 34 MB | 9 MB | dropped two indexes that measured **0 scans** |
| **Whole database** | **191 MB** | **98 MB** | 38% → 19% of the free tier |

Two of the removed indexes could never have been used, which is the kind of thing that is easy to
add speculatively and never measure:

- a **GIN `tsvector`** index on `search_text` — candidate retrieval issues `LIKE '%keyword%'`, which
  a tsvector index cannot serve;
- a **B-tree** on `commodity` — a leading-wildcard `LIKE` cannot use a B-tree either.

If candidate retrieval ever becomes a measured bottleneck, the correct index is a **trigram** one
(`CREATE EXTENSION pg_trgm; CREATE INDEX … USING gin (commodity gin_trgm_ops)`), which *can* serve
leading-wildcard `LIKE`. The schema and migration comments record this so nobody re-adds the wrong
index.

At 98 MB you have room for roughly **750k more suppliers** inside the free tier.


---

## Deployment runbook

### Step 1 — GitHub

```bash
git init
git add .
git commit -m "feat: UNSPSC spend categorizer"
git branch -M main
git remote add origin https://github.com/olenny-coder/unspsc-mapper.git
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs on every push and PR: lint, typecheck, unit tests, build,
plus a job that spins up a real Postgres, applies the migrations, seeds 2,000 taxonomy codes and
asserts the schema. Enable the optional deploy hook by adding a `DEPLOY_HOOK_URL` repository
secret. Protect `main` in Settings → Branches so CI must pass.

### Step 2 — Neon (database)

1. Create a project named `unspsc-spend` at <https://console.neon.tech> (free tier).
2. Copy the **pooled** connection string (`...-pooler...?sslmode=require`).
3. Apply the schema and seed the taxonomy from your machine:

```bash
export DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require"
npm run db:migrate
npm run db:seed              # 149,849 codes, ~30-60 s
```

   Optional: keep a direct URL for migrations in `DATABASE_URL_UNPOOLED` so DDL does not go
   through PgBouncer.

4. Verify:

```bash
npm run db:check
```

```
Database readiness

 ok   connection                 PostgreSQL 17
 ok   schema (9 tables)          all present
 ok   settings singleton         row id=1 present
 ok   UNSPSC taxonomy            149,849 codes across 58 segments (v26.0801)
 ok   known code lookup          43211507 = Desktop computer
 ok   content (optional)         empty — upload a CSV, or run `npm run db:seed:sample`
 ok   storage                    96.0 MB used (18.8% of the 0.5 GB Neon free tier)

All checks passed. This database is ready for the app and the worker.
```

`db:check` is read-only (safe against production) and exits non-zero when a check fails, so it can
gate a deploy step. It exists because `psql` is not installed by default on Windows or macOS —
you do **not** need the Postgres client to verify a Neon database.

> On macOS or Linux with `psql` available, `psql "$DATABASE_URL" -c "select count(*) from unspsc_codes;"`
> works equally well and should return `149849`.

### Step 3 — Groq (LLM)

1. Sign up at <https://console.groq.com>, create an API key.
2. **Test the bulk model first** (it has 14× the daily quota):

```bash
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"llama-3.1-8b-instant","response_format":{"type":"json_object"},
       "messages":[{"role":"user","content":"Return {\"ok\":true}"}]}'
```

3. Then try `llama-3.3-70b-versatile` with the real prompt from `services/prompts.ts`.

### Step 4 — Enrichment provider (optional but recommended)

Sign up for CompanyEnrich or Context.dev (500 free credits), copy the key, and set
`ENRICH_API_KEY` plus `ENRICH_PROVIDER`. Without it, set `ENRICH_PROVIDER=none`: the pipeline
still works using name-derived heuristics and the LLM parent detector.

Bright Data is also supported and gives the strongest firmographics, but it is **paid** and keyed by
dataset — see [Enrichment with Bright Data](#enrichment-with-bright-data).

### Step 5 — Vercel (frontend + API)

1. <https://vercel.com/new> → import the GitHub repository (framework auto-detected as Next.js).
2. Environment variables (Production **and** Preview):

```
DATABASE_URL        = <Neon pooled connection string>
GROQ_API_KEY        = gsk_...
ENRICH_PROVIDER     = companyenrich
ENRICH_API_KEY      = ...
NEXT_PUBLIC_APP_URL = https://<your-app>.vercel.app
WORKER_SECRET       = <long random string>
```

3. Deploy, then smoke-test:

```bash
curl -s https://<your-app>.vercel.app/api/health | jq
```

   Expect `checks[0].name == "database"` with `ok: true` and `freeTierBudget` populated.

### Step 6 — Render (worker)

Option A — Blueprint: **New → Blueprint**, pick the repo; `render.yaml` creates
`unspsc-spend-worker` as a free Web Service with `startCommand: npm run worker:start` and
`healthCheckPath: /health`. Fill in the `sync: false` secrets in the dashboard.

Option B — manual: **New → Web Service**, runtime Node, build
`npm ci --omit=dev --no-audit --no-fund`, start `npm run worker:start`, health check `/health`,
and set `DATABASE_URL`, `GROQ_API_KEY`, `ENRICH_API_KEY`, `WORKER_SECRET`, `CRON_SECRET`,
`PORT=10000`.

Verify:

```bash
curl -s https://<worker>.onrender.com/health | jq
CRON_SECRET=... curl -s -X POST "https://<worker>.onrender.com/run?job=sync" | jq
```

### Step 7 — Keep-alive + cron

Render's free tier spins a service down after 15 minutes without traffic, and a sleeping worker
cannot fire its own schedule — so this step is what makes the daily sync actually run.

**The required job: keep the worker awake.**

1. Create a free account at <https://cron-job.org> and confirm your email address (they verify
   before jobs will run).
2. **Create cronjob**, then:

   | Field | Value |
   |---|---|
   | Title | `unspsc-worker keep-alive` |
   | URL | `https://<worker>.onrender.com/health` |
   | Schedule | Every **5 minutes** (`*/5 * * * *`) |
   | Request method | `GET` (the default) |
   | Enable job | **on** |

3. Leave authentication empty. `/health` is deliberately public and does no database work, so the
   ping is fast and never holds a Neon connection open.
4. Enable **failure notifications** so a dead worker reaches you by email.

Two quirks of the service are worth knowing before you read its history:

* **The timeout is a fixed 30 seconds and cannot be changed.** A cold start can take 30–60 s, so the
  very first ping after a long idle period may be recorded as a timeout. That is harmless — the
  request still woke the service, and the next ping five minutes later succeeds in milliseconds.
  This is why the interval matters more than the timeout: 5 minutes is well inside Render's 15-minute
  spin-down window, so after the first ping the service stays warm.
* **A job is disabled automatically after 25 consecutive failures.** With a 5-minute interval that is
  over two hours of continuous failure, so it indicates a genuinely broken URL rather than a cold
  start. If the job ever goes quiet, check that it has not been disabled.

**Verify it — don't trust the dashboard's green tick alone.** cron-job.org keeps the last 50
executions with response headers and bodies for 2 days, so you can read the actual JSON it received.
Better still, the service reports its own uptime, which proves it never slept:

```bash
curl -s https://<worker>.onrender.com/health | grep uptimeSeconds
```

`uptimeSeconds` should climb past 3600 and keep growing. If it keeps resetting to a small number,
the pings are not reaching the service.

**The optional second job: an explicit sync trigger.**

The worker runs its own scheduler (`CRON_SYNC`, default `0 3 * * *`) and re-runs a window it slept
through on boot. This job is only insurance against the worker being down at 03:00 for longer than
the catch-up covers.

| Field | Value |
|---|---|
| URL | `https://<worker>.onrender.com/run?job=sync` |
| Schedule | Daily at 03:15 UTC (`15 3 * * *`), after the built-in 03:00 run |
| Request method | **POST** — a GET returns 404 by design |
| Header | `Authorization: Bearer <CRON_SECRET>` |

Credentials are read from `Authorization: Bearer <CRON_SECRET>`, an `x-cron-secret` header, or
`?secret=`. Prefer the header: a query string ends up in logs and request history. The secret is
`CRON_SECRET` when set, otherwise `WORKER_SECRET`. If you would rather not store a secret in a
third-party dashboard, skip this job — the keep-alive above is the part that matters, and the
built-in scheduler plus catch-up already covers the daily run.

Or trigger it yourself from any machine, which is also what CI uses:

```bash
WORKER_URL=https://<worker>.onrender.com CRON_SECRET=... node scripts/ping-worker.mjs $WORKER_URL --sync --strict
```

**Free alternatives**, if you would rather not use cron-job.org: anything that can hit a URL on a
schedule works — UptimeRobot's free plan (5-minute checks) or Better Stack. A GitHub Actions
`scheduled` workflow is a poor fit here: the minimum interval is 5 minutes and GitHub disables
schedules on repositories with no recent activity, which describes a deployment repo exactly.

On a paid Render plan, drop the ping entirely and uncomment the native `worker` service at the
bottom of `render.yaml`, which gives a real cron schedule.

### Step 8 — Smoke test the whole system

1. `/upload` → upload `samples/suppliers.csv`.
2. Confirm: created count, enrichment count, parent links > 0.
3. `/hierarchy` → Dell Technologies should have EMC and VMware; Siemens AG should have
   Siemens Healthineers and Mentor Graphics.
4. `/dashboard` → verify the segment chart, that inherited codes exist, and export CSV + PDF.
5. `/review` → correct one code with "propagate to subsidiaries" and confirm the subsidiaries
   update.
6. `/audit` → confirm `enriched`, `classified`, `inherited`, `linked`, `corrected`, `synced`
   rows.
7. `POST /api/sync` with the worker secret → confirm the summary reports work done.
8. `/reports` → generate + store a PDF, then download it.

### Step 9 — Post-deploy checklist

- [ ] `/api/health` shows `database: ok` and a taxonomy count > 100,000
- [ ] Groq usage bars on `/settings` are below the daily limits
- [ ] `WORKER_SECRET` protects `POST /api/sync` (`curl` without the header → 401)
- [ ] cron-job.org reports successful pings
- [ ] A weekly PDF exists in `/reports` after the first `CRON_REPORT` window
- [ ] `main` is protected and CI is green

---

## Local development with Docker

```bash
docker compose up -d                     # Postgres only
docker compose --profile worker up       # Postgres + the worker
docker compose logs -f worker
docker compose down -v                   # wipe the volume
```

The worker image (`Dockerfile.worker`) runs as the unprivileged `node` user with `tini` as PID 1
and has its own `HEALTHCHECK` against `/health`.

---

## Testing

```bash
npm test              # 213 tests, ~4 s
npm run test:watch
npx tsx scripts/smoke-offline.ts   # end-to-end pipeline check without a database
```

| File | Covers |
|---|---|
| `tests/normalize.test.ts` | Name/domain/date/amount normalisation, dedupe keys, code coercion |
| `tests/retry.test.ts` | Backoff growth + jitter, `Retry-After`, retryability, `mapLimit` concurrency, timeouts |
| `tests/rate-limit.test.ts` | Token bucket, `RateLimitError`, daily budget + reserve |
| `tests/hierarchy.test.ts` | **Parent propagation**: clustering, cycles, chains, virtual parents, orphans, roll-up, plan selection |
| `tests/suppliers.test.ts` | **Upsert/sync merge logic**: non-destructive merge, reclassification triggers, fingerprints, CSV mapping, **stale detection** |
| `tests/classification.test.ts` | Prompt construction, few-shot merging, candidate injection, JSON repair, payload validation, keyword extraction |
| `tests/reporting.test.ts` | Filter parsing, summary maths, segment breakdown, low-confidence selection, CSV sections, PDF text sanitising |
| `tests/worker.test.ts` | Cron parsing/matching, missed-window catch-up, next-run calculation |
| `tests/upload.test.ts` | Delimiter detection, CSV parsing, sample-file integrity, taxonomy seed mapping |
| `tests/auth.test.ts` | Session-token signing/expiry/tamper resistance, credential extraction, public-path allowlist, fail-closed rules |
| `tests/theme.test.ts` | Theme resolution parity between the pre-paint boot script and the React provider, token sanity, script syntax |
| `tests/env.test.ts` | **Environment policy**: an unusable tuning value falls back to its default without disturbing the rest of the configuration, `0` is rejected where the minimum is 1, `/api/health` can report what was ignored, and missing credentials still throw; scheme-less URLs; placeholder handling |
| `tests/vercel-origin.test.ts` | The Vercel origin guard: bare host kept, full URL narrowed to its host, unusable value dropped, variables Next.js owns |
| `tests/demo.test.ts` | **Demo isolation**: every read endpoint with `getDb()` mocked to throw, every mutating verb refused without invoking the handler, a valid credential still reaching the real handler, `DEMO_MODE=false` diverting nobody, unlisted paths refused, and fixture consistency (unique ids, resolvable parents, `DEMO:`-prefixed reasoning) |

Nothing in the suite needs network access or a database: the hierarchy, merge, prompt, cron and
reporting layers are pure functions, which is exactly why they are testable.

`scripts/smoke-offline.ts` goes one step further and runs the real `samples/suppliers.csv`
through parsing, dedupe, hierarchy construction, parent-first planning, prompt building and
report roll-up, asserting that (for example) the Dell family resolves to Dell + EMC + VMware and
that grouping reduces 111 suppliers to ~10 Groq requests. It is the check to run after touching
the pipeline. `scripts/seed-sample-suppliers.ts` is the same exercise against a live database,
including PDF/CSV rendering.

### Verified end-to-end

The following was executed against a real Postgres 16 instance with the full 149,849-code
taxonomy seeded:

| Step | Result |
|---|---|
| `db:migrate` | all 9 tables created from `0000_init.sql` |
| `db:seed` | 149,849 codes across 58 segments, 0 malformed |
| `db:seed:sample` | 111 suppliers, 23 parent links, 18 corporate families, hierarchy correct |
| CSV export | 317 lines, metadata preamble + segment + roll-up + appendix sections, UTF-8 BOM |
| PDF export | 8 pages, 44 KB, valid per `PDFDocument.load()` |
| All 18 API routes | 200 on success paths; 400/401 exactly where expected |
| Worker `/health`, `/ready`, `/status`, `/run?job=sync`, `/run?job=report` | 200 (401 without the secret) |
| Cron catch-up | after the last sync was aged past the schedule, a worker restart logged `catching up missed sync run` and executed it once |

---

## Troubleshooting

### If the Vercel build fails with no useful message

This class of failure is now prevented at the source, so a bad environment value can no longer
fail a build — but the history is worth keeping, because it explains the warnings you may see.

`Failed to collect page data for /_not-found` means the root layout threw while its metadata was
evaluated — before any page rendered. `app/layout.tsx` resolves the public origin at module scope,
so a bad environment value aborted the whole deploy with a message that named nothing. The route in
the message is arbitrary: it is whichever page reaches the root layout first, so one
misconfiguration can report `/_not-found`, `/login` or `/`.

Two guards now stop that:

* `lib/env.ts` never throws on an unusable *tuning* value. It substitutes that variable's default,
  leaves every other setting alone, and names what it ignored in one log line:
  `[env] Ignoring 1 unusable environment variable: SYNC_STALE_DAYS (expected 1..3650, received 0).`
* `lib/vercel-origin.mjs` repairs or drops a malformed `VERCEL_PROJECT_PRODUCTION_URL`,
  `VERCEL_URL` or `VERCEL_BRANCH_URL` before Next.js reads them (`next.config.mjs` runs it).

A **blank** variable counts as unset, not as an empty value. This matters more than it sounds:
zod's `.default()` applies only to `undefined`, so before this was handled a variable that existed
but had been left empty produced `''` rather than its default. A blank `GROQ_MODEL_ACCURATE` became
an empty model name (which Groq rejects, breaking all classification), and blank numeric fields
became `0` — silently disabling the daily budget reserve and the enrichment credit limit. Blank
fields are now pruned before parsing, so every default applies as expected.

**So: read the `[env]` line, or `GET /api/health`, and delete that variable.** Only `DATABASE_URL` is
required:

```
Keep:    DATABASE_URL, DASHBOARD_SECRET, WORKER_SECRET, GROQ_API_KEY
Delete:  everything else
```

`CLASSIFY_CONFIDENCE_THRESHOLD`, `SYNC_STALE_DAYS`, `LLM_BATCH_SIZE`, `ENRICH_PROVIDER`,
`CLASSIFY_MODEL_STRATEGY`, `SITE_URL` and `APP_ORIGIN` all have working defaults and are safe to
remove entirely. The app stays up either way, which is why the misconfiguration is reported rather
than thrown — check `/api/health`, whose `configuration` check names every value that was ignored.

Or reproduce locally, which prints a pass/fail matrix for twenty input shapes:

```bash
npx tsx scripts/diagnose-build.ts
```

Do **not** re-push to fix an environment *value*. The value lives in the Vercel dashboard, not the
repo — and environment variables are read at build time, so changing one does not retroactively fix
an existing deployment. Use **Deployments → ⋯ → Redeploy** after saving. (The guards above are code,
so they do need the usual one push before they take effect.)

### If the whole deployment returns 500 and nothing works

`MIDDLEWARE_INVOCATION_FAILED` on every route except `/login` and static assets means the **Edge
middleware** threw. It is the first thing to run, so nothing else gets a chance to report anything —
and because `lib/auth.ts` imports `lib/env.ts`, an invalid environment value used to reach it and
kill every gated route at once. This is what nine numeric variables left at `0` did to a live
deployment.

Two changes make that impossible to hit blind:

* `lib/env.ts` degrades instead of throwing, so the middleware no longer has anything to propagate;
* `middleware.ts` catches anything unexpected anyway and fails closed with a 503 that states the
  reason and points at `/api/health`, rather than letting the platform return a bare crash.

Diagnose from outside with the health endpoint, which names the offending variables:

```bash
curl -s https://your-app.vercel.app/api/health | jq '.checks[] | select(.name=="configuration")'
```

The nine values that caused this are every numeric setting whose minimum is `1`. Deleting them is
always the right move — each has a working default:

| Variable | If present, must be | Delete to get |
|---|---|---|
| `ENRICH_CONCURRENCY` | 1–20 | 3 |
| `SYNC_STALE_DAYS` | 1–3650 | 30 |
| `SYNC_BATCH_SIZE` | 1–500 | 25 |
| `SYNC_MAX_BATCHES_PER_RUN` | 1–1000 | 12 |
| `LLM_BATCH_SIZE` | 1–10 | 10 |
| `LLM_MAX_REQUESTS_PER_MINUTE` | 1–1000 | 25 |
| `LLM_MAX_REQUESTS_PER_DAY_70B` | 1–100000 | 1000 |
| `LLM_MAX_REQUESTS_PER_DAY_8B` | 1–1000000 | 14400 |
| `PORT` | 1–65535 | 10000 |

`PORT` matters only to the Render worker's HTTP server, which is why `render.yaml` sets it to
`10000`. On Vercel nothing reads it, so delete it there. These are also the settings that arrived as
`0` when a dashboard was filled in from a defaults list — hence the note above about blank values.

List them again at any time without signing in, since `/api/health` is a public path:

```bash
curl -s https://your-app.vercel.app/api/health \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).checks.find(c=>c.name==='configuration').detail))"
```

The same policy protects the Render worker, which reads the same module — so a `0` in a Render
environment variable degrades there too rather than stopping the scheduler.

| Symptom | Cause | Fix |
|---|---|---|
| Dev server serves 500 with `Unexpected token 'div'. Expected jsx identifier` for a file that builds fine | Corrupt webpack cache in `.next/` (common after a killed process), not a code error | Stop the server, delete `.next`, restart. If `npm run build` and `npm run typecheck` both pass, the source is fine. |
| Visual audit reports a mobile viewport as ~720px | `window.innerWidth` disagrees with the CSS viewport in headless Chromium | The harness measures `document.documentElement.clientWidth` and asserts it, so a wrong width fails loudly rather than silently testing desktop layout. |
| **Vercel: `Failed to collect page data for /_not-found`** | An environment variable aborted the build (now prevented — see above). The route named is whichever reached the root layout first | Read the `[env]` warning in the build log and delete the variable it names; reproduce locally with `npx tsx scripts/diagnose-build.ts` |
| `Invalid environment configuration: X: expected 0..1, received "70"` | `CLASSIFY_CONFIDENCE_THRESHOLD` is a probability, not a percentage | Set `0.7`, or delete the variable (it defaults to `0.7`) |
| `Invalid environment configuration: X: expected an integer, received "30 days"` | A numeric variable carries a unit suffix | Use `30`, not `30 days` |
| ~36 × `TypeError: Invalid URL` during the Vercel build, exit 1 | **Next.js itself**, not this app: Next reads `VERCEL_PROJECT_PRODUCTION_URL` directly for `metadataBase`, with no `try`/`catch`, and does so even when the app supplies its own `metadataBase` | Fixed: `lib/vercel-origin.mjs` repairs a full URL to its host or drops an unusable value before Next reads it, and `next.config.mjs` runs that before prerender workers are forked |
| `Dynamic Code Evaluation ... not allowed in Edge Runtime` | Something in the middleware graph reached for `eval`/`require` | Fixed: env-file loading now lives in `lib/env-node.ts`, which middleware never imports |
| `DATABASE_URL is not configured` | Missing env var | Add it to `.env.local` (dev) or the Vercel/Render dashboard. |
| `/api/health` shows `database: ok: false` | Wrong connection string, or Neon suspended | Use the **pooled** string with `?sslmode=require`; open the Neon console to wake the project. |
| Classification returns "GROQ_API_KEY is not set" | Key missing in that environment | Set it in Vercel **and** Render — the worker classifies independently of the UI. |
| `/api/health` shows `groq: configured ( / )` with blank model names, or `reserve: 0` | `GROQ_MODEL_ACCURATE` / `GROQ_MODEL_BULK` / `LLM_DAILY_BUDGET_RESERVE` exist but are blank. zod's `.default()` covers only `undefined`, so a blank field became `''` or `0` instead of its default — an empty model name is rejected by Groq, so classification silently fails | Fixed: blank values are treated as unset. Nothing to do beyond redeploying — or delete the variables and let the defaults apply |
| Uploaded suppliers never appear, `database: ok` reports `0 suppliers` | The taxonomy was seeded but no supplier data was uploaded to *that* database | Upload `samples/suppliers.csv` at `/upload`, or run `npm run db:seed:sample` against the same database |
| Everything is `unclassified` | `npm run db:seed` never ran | Run it; candidate injection and code validation both need the taxonomy. |
| Codes look generic (`43210000`) or confidence is capped at 0.40 | The model returned a code that is not in the seeded taxonomy | Re-run `npm run db:seed`; verify with `select count(*) from unspsc_codes`. |
| Groq 429 / "rate limit hit" | Free-tier quota | The worker pauses automatically; check `/settings` or `/api/health`, and prefer the 8B model for bulk work. |
| `daily budget exhausted` | The day's 70B quota was consumed | Raise `LLM_MAX_REQUESTS_PER_DAY_70B` only if your plan allows; otherwise wait for the UTC reset or switch to `bulk`. |
| Unknown column errors after pulling | Migration not applied | `npm run db:migrate`. |
| Worker `/health` times out | Render is cold-starting | Retry after ~30 s, or confirm cron-job.org is pinging every 5 minutes. |
| Weekly PDF never appears | The worker slept through `CRON_REPORT`, or `WEEKLY_REPORT_ENABLED=false` | Trigger it manually (`?job=report`); confirm the catch-up ran in `/status`; check the cron expression. |
| `Report is X MB, which exceeds the 4 MB storage limit` | Export too large | Narrow the filters, or download without storing. |
| `Refusing to link ... already a subsidiary of it` | Cycle protection | Unlink the existing relationship first. |
| Suppliers mistakenly merged | Over-aggressive normalisation | Both names normalise to the same key; rename one row or link it as a subsidiary of the other. |
| Upload says "No usable rows found" | Missing/renamed name column | Check the header; accepted names are `name`, `supplier`, `supplier_name`, `vendor`, `company`. |
| Excel shows garbled characters | CSV opened without UTF-8 | The export includes a UTF-8 BOM; use Data → From Text/CSV in Excel if needed. |
| `next lint` throws about `next.config.ts` | Next 14 requires `.mjs`/`.js` config | Already handled: the repo ships `next.config.mjs`. |
| **CI is red within seconds and no jobs appear at all** | The workflow file was rejected when GitHub loaded it, not a job failing. The message says `Invalid workflow file ... #L1` and blames line 1 | A context is used where it is not available — almost always `secrets` inside a step-level `if`. See [If CI fails with "Invalid workflow file"](#if-ci-fails-with-invalid-workflow-file) |

### If CI fails with "Invalid workflow file"

```
Invalid workflow file: .github/workflows/ci.yml#L1
(Line: 139, Col: 13): Unrecognized named-value: 'secrets'
```

GitHub **refuses to load the whole file** and blames line 1, so the run fails before a single job
starts and nothing else in the file gets reported. The cause is a context used where it is not
available — most often `secrets` inside a step-level `if`:

| Key | Contexts allowed |
|---|---|
| `jobs.<job_id>.steps.if` | `env`, `github`, `inputs`, `job`, `matrix`, `needs`, `runner`, `steps`, `strategy`, `vars` — **no `secrets`** |
| `jobs.<job_id>.env` | `github`, `inputs`, `matrix`, `needs`, **`secrets`**, `strategy`, `vars` |

The fix is to resolve the secret once into a job-level `env`, then gate the steps on `env`:

```yaml
jobs:
  deploy:
    env:
      DEPLOY_HOOK_URL: ${{ secrets.DEPLOY_HOOK_URL }}
    steps:
      - if: ${{ env.DEPLOY_HOOK_URL != '' }}
        run: curl --fail -X POST "$DEPLOY_HOOK_URL"
```

Reading it from `env` also keeps the value out of the generated script text.

**A broken workflow cannot be caught by a job inside itself**, because GitHub never loads it. That is
why the check has to be local:

```bash
npm run workflow:check     # uses actionlint; a no-op with install instructions if absent
```

`actionlint` encodes GitHub's own context-availability rules and reports the same error GitHub does,
so a clean result means the file will load.

---

## Design decisions and trade-offs

**Parents are classified, subsidiaries inherit.** One Groq request per corporate family instead
of one per supplier — the difference between 1,000 requests covering 1,000 suppliers or tens of
thousands. The subsidiary's confidence is the parent's × 0.9 and its reasoning names the parent,
so the inheritance is always visible in the UI and the audit log.

**Virtual parent clusters.** Enrichment frequently discovers a parent that is not itself a
tracked supplier. Rather than dropping the relationship, suppliers sharing a parent name are
grouped and one member represents the family. When the parent later appears as a real supplier
row, `resolveParentLinks` links it and the cluster becomes a normal one.

**Non-destructive merge instead of `ON CONFLICT DO UPDATE`.** Upsert semantics depend on the
*existing* row's contents ("only replace a description if the new one is richer"), which SQL
cannot express simply. The merge therefore happens in application code, at the cost of one extra
read per supplier on upload — acceptable for files in the thousands of rows.

**Confidence is a number we reduce, never inflate.** An unverifiable code is capped at 0.40,
inherited codes are capped at parent × 0.9, and reviewed rows are excluded from the
low-confidence count. The review queue therefore stays meaningful.

**Two-level hierarchy, chain-safe.** The schema allows arbitrary depth via `parent_id`, but
planning flattens each connected component to one root plus members. Depth is preserved for
display; cycles are detected and broken rather than crashing the page.

**Filters live in one Zod contract.** The dashboard, the export endpoint, the report generator
and `/api/metrics` all parse the same schema, so "what you see is what you export" is structural
rather than a convention.

**Explicit interfaces instead of `z.infer`.** Zod's inference through `preprocess` + `partial()`
produces unusable types, so every schema's output type is declared as a plain interface. Callers
get readable types and the schemas stay runtime-identical.

**One `services/` implementation for API and worker.** The worker executes the same TypeScript
through `tsx`, so there is no second build output that can drift.

**Audit everything, including failures.** `enrich_failed`, `stale_marked` and sync summaries are
rows in `audit_log`. Free-tier operations fail regularly (quota, cold starts, provider 404s), and
a run that silently did nothing is worse than one that reports why.

---

## Branding

The mark is a rounded container holding **three ascending rounded bars** — spend rolled up and
classified. The geometry exists once, in `public/icon.svg` (a 64×64 coordinate space), and
everything else derives from it.

| Asset | Purpose |
|---|---|
| `public/icon.svg` | Vector master; `components/logo-mark.tsx` inlines the same paths so the header mark inherits the theme with no network request |
| `public/favicon.ico` | 16/32/48 multi-size ICO for browser tabs and legacy clients |
| `public/icon-192.png`, `public/icon-512.png` | PWA / Android home screen |
| `public/apple-touch-icon.png` | 180×180, **opaque** and inset into the safe zone — iOS composites transparency on white, and masks the icon to a squircle |
| `public/icon-maskable.svg` | Maskable variant with the mark inside the 80% safe zone |
| `public/opengraph-image.png` | 1200×630 social card (**PNG**, not SVG — most scrapers will not render an SVG `og:image` and fall back to a blank card) |
| `public/opengraph-image.svg` | Editable source for the same card |

Rasters are not hand-drawn. `scripts/generate-icons.mjs` rasterises the geometry with 4×
supersampling and encodes PNG (with `zlib`) and the ICO container **without any image dependency**,
so the assets are reproducible and reviewable rather than binary blobs of unknown origin:

```bash
npm run assets:generate
```

**Chart bars are fully rounded.** Recharts emits a `path` with arc commands for a `radius`, so the
dashboard bars use `radius={[6,6,6,6]}` — clamped to half the bar thickness, giving stadium-shaped
bars. `scripts/probe-chart.mjs` asserts this in the real DOM (`bar <path>` count and arc commands
per bar), because a `radius` prop that is silently ignored looks identical in the source.

**PDF reports carry the mark too** — drawn with SVG path commands (`drawSvgPath`), since PDF has no
erase operation and pdf-lib has no rounded-rectangle primitive, so the geometry has to be correct
rather than patched up with corner overlays.

---

## Licence

**The code is MIT.** See [`LICENSE`](LICENSE).

**The bundled UNSPSC taxonomy is not.** `samples/unspsc-v26-en.csv.gz` is third-party data with
its own terms, and the MIT licence does not cover it. Full attribution and obligations are in
[`NOTICE`](NOTICE); the short version:

| Component | Licence | What you must do |
|---|---|---|
| Application source code | **MIT** | Include the copyright notice. |
| `samples/unspsc-v26-en.csv.gz` — UNSPSC v26.0801 English codeset, © UNDP | UNDP/UNSPSC terms, **not** MIT | Attribute UNDP where codes are shown; UNSPSC® is a registered trademark, so don't imply endorsement. **Verify current terms with UNDP before commercial redistribution.** |
| `samples/suppliers.csv`, `samples/transactions.csv` | **MIT** | Synthetic demo data; the spend figures are invented and represent no real organisation. |
| Dependencies | Their own (all permissive) | See the table in `NOTICE`. |
| Classification via Groq-hosted Llama | Meta Llama licence + Groq ToS | Supplier data is transmitted to Groq when classification runs — check that against your data-protection obligations. |

**Sourcing the taxonomy yourself.** You are not locked into the bundled extract. Point the seed
script at your own UNSPSC file obtained directly from UNDP:

```bash
npm run db:seed -- --file=/path/to/your/unspsc.csv
# or: UNSPSC_SEED_CSV=/path/to/your/unspsc.csv npm run db:seed
```

Expected columns: `code,segment,family,class,commodity,description`.

**Not affiliated.** This project is independent and is not endorsed by, affiliated with, or
sponsored by UNDP, GS1, or any supplier named in the sample data.

---

## SEO and metadata

Because this app renders supplier names, spend totals and corporate structure, **it is not
indexable by default** — that default is a data-protection decision, not an oversight.

| Concern | Implementation |
|---|---|
| Crawler policy | `robots: { index: false, follow: false }` in `lib/seo.ts`, plus `app/robots.ts` returning `Disallow: /` while `ALLOW_INDEXING` is false |
| Empty sitemap | `app/sitemap.ts` returns `[]` when not indexable — advertising URLs that only redirect to a login form wastes crawl budget and invites indexing of redirects |
| Public demo opt-in | `ALLOW_INDEXING=true` opens the landing surface only; `/api/`, `/audit`, `/reports`, `/review`, `/settings`, `/hierarchy`, `/upload` and `/login` stay blocked |
| Titles and descriptions | `metadataBase` + a `%s · UNSPSC Spend Categorizer` template; one description per page via `pageMetadata()` |
| Canonical URLs | Absolute, from `SITE_URL` → `VERCEL_PROJECT_PRODUCTION_URL` → `NEXT_PUBLIC_APP_URL` |
| Open Graph / Twitter | `summary_large_image` with a 1200×630 SVG card (`public/opengraph-image.svg`) — these are emitted even under `noindex` because they control how the link renders in Slack, Teams and email |
| Structured data | JSON-LD `SoftwareApplication` + `WebSite` in `<head>`, with an explicit `featureList`. Deliberately **no** `aggregateRating` or `offers` — inventing those is misleading structured data and gets penalised |
| PWA | `app/manifest.ts` with maskable icons, so analysts can install the dashboard |

Set `ALLOW_INDEXING=true` and `SITE_URL=https://your-domain` for a public demo. The SEO behaviour
is covered by 26 unit tests, including the safe-default assertion.

### Repository metadata

Description and topics are versioned in
[`.github/repo-metadata.yml`](.github/repo-metadata.yml) so they can be applied reproducibly
rather than typed into the UI once and forgotten.

**Topics:** `unspsc` · `spend-analysis` · `spend-categorization` · `procurement` ·
`procurement-analytics` · `supplier-classification` · `commodity-classification` ·
`parent-subsidiary` · `corporate-hierarchy` · `llm` · `llama` · `groq` · `nextjs` · `typescript` ·
`drizzle-orm` · `postgres` · `neon` · `vercel` · `render` · `tailwindcss`

