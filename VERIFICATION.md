# Verification log

Executed against a real Postgres 16 instance (Docker) with the complete UNSPSC v26 taxonomy
seeded. Recorded here so a reviewer can reproduce each step.

## Static checks

| Command | Result |
|---|---|
| `npm run lint` (`next lint --max-warnings=0`) | ✔ No ESLint warnings or errors |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm test` (Vitest) | 16 files, **333 tests passed** |
| `npm run build` (`next build`) | compiled successfully; 18 dynamic API routes, 14 prerendered routes (7 pages + robots.txt, sitemap.xml, webmanifest), `ƒ Middleware 44 kB` |
| `npx tsx scripts/smoke-offline.ts` | SMOKE TEST PASSED |

## Deployment build resilience

`next build` was run with `VERCEL=1 CI=1 NODE_ENV=production` against deliberately hostile
configuration, because a build that fails on a mistyped dashboard field is a build nobody can debug
from a truncated log. Every row below is a real invocation, not a projection.

| Input | Before | After |
|---|---|---|
| `CLASSIFY_CONFIDENCE_THRESHOLD=70` | exit 1 — `Failed to collect page data for /login` | exit 0, warns `CLASSIFY_CONFIDENCE_THRESHOLD (expected 0..1, received "70")` |
| `SYNC_STALE_DAYS=30 days` | exit 1 | exit 0, warns with the variable named |
| `VERCEL_PROJECT_PRODUCTION_URL=":"` | exit 1 — 36 × `TypeError: Invalid URL`, no variable named | exit 0 — `[next.config] Ignoring malformed ... falling back to the default origin` |
| `VERCEL_PROJECT_PRODUCTION_URL=https://unspsc-mapper.vercel.app` | exit 0 (accepted, though not a bare host) | exit 0 — narrowed to `unspsc-mapper.vercel.app` |
| `SITE_URL` / `APP_ORIGIN` with no scheme | exit 0 after the `urlFromString` tolerance fix | exit 0 |
| `DATABASE_URL` empty, or not a URL | exit 0, runtime error on first request | exit 0, same |
| All of the above at once | exit 1 | exit 0 — 33 routes generated, 0 `Invalid URL`, 0 page-data failures |

The guards are covered by `tests/env.test.ts` and `tests/vercel-origin.test.ts`, so the build cannot
silently regress to failing on configuration.

### Runtime, with the live deployment's exact environment

The production server was then started with the nine numeric variables that broke the Vercel
deployment set to `0`, to confirm the failure is gone end to end rather than only at build time.
Every row is a real request against `next start`.

| Request | On the live deployment | After |
|---|---|---|
| `GET /` | 500 `MIDDLEWARE_INVOCATION_FAILED` | 307 → `/login` |
| `GET /upload` | 500 `MIDDLEWARE_INVOCATION_FAILED` | 307 → `/login?next=%2Fupload` |
| `GET /api/health` | 500, empty body | **200**, `ok: true`, `configuration` check lists all eight ignored variables, `degraded: true` |
| `GET /api/auth/session` | 500 with the `ConfigError` envelope | 200 |
| `GET /api/audit` | 500 | 401 with the standard JSON envelope |
| `GET /` , `/upload`, `/settings`, `/audit`, `/reports` with a bearer secret | 500 | **200** — 43–60 kB of rendered HTML |
| `GET /nonexistent-xyz` with a bearer secret | 500 | 404, custom page |

The application stays fully usable, and the misconfiguration is still reported rather than hidden.

### Render worker readiness

The worker entry point was run exactly as Render runs it (`npm run worker:start`), against the same
database:

```
[worker] starting UNSPSC spend categorizer worker { "environment": "production", "cronSync": "0 3 * * *", ... }
[worker] database connection verified
[worker] health server listening on port 3200
[worker] job sync scheduled   { "cron": "0 3 * * *",   "next": "2026-09-21T03:00:00.000Z" }
[worker] job report scheduled { "cron": "0 6 * * 1",   "next": "2026-09-21T06:00:00.000Z" }
[worker] no previous run recorded; skipping catch-up (first deployment)
```

| Endpoint | Result |
|---|---|
| `GET /health` (Render's `healthCheckPath`) | 200 — service up, both jobs scheduled with their next run time |
| `GET /ready` | 200 — `database: reachable` |
| `GET /status` without credentials | 401 |
| `GET /status` with `WORKER_SECRET` | 200 — full scheduler state |
| `GET /run` | 404 — POST-only, as intended |

`render.yaml` runs `npm ci --omit=dev`, so `tsx` (which executes the TypeScript worker directly) and
`dotenv` must be **production** dependencies. Verified: `tsx@4.23.13` and `dotenv@16.6.1` both
resolve under `npm ls --omit=dev`.

## Demo mode isolation

`DEMO_MODE=true` lets an anonymous visitor browse the whole application against a bundled sample
dataset. The claim to verify is not "the demo looks right" but "a demo request cannot reach real
data". Two independent checks were run.

### 1. Unit level — the database is made to throw

`tests/demo.test.ts` mocks `getDb()` to throw, then drives every demo read endpoint. Any demo path
that reached a query would fail loudly instead of quietly returning a row. 35 tests pass, covering:

| Assertion | Result |
|---|---|
| Every demo read (`metrics`, `suppliers`, `suppliers?meta`, `classifications` ×2, `hierarchy`, `audit` ×2, `reports` ×2, `settings`, `classify`, `upload`, `auth/session`) | 200, `ok: true`, with `getDb` throwing |
| Every mutating verb (`POST`/`PUT`/`PATCH`/`DELETE`) | 403 `demo_read_only`, and the real handler is **never invoked** (spy) |
| Identical request with a valid credential on the same deployment | the real handler **is** invoked, normally |
| `DEMO_MODE=false` | no diversion at all; the route's own `requireAuth` is reached, as before |
| An endpoint the demo does not list | 404, not inherited — so a newly added route is private by default |
| `/api/export` (a read the demo deliberately refuses) | 403 |
| A wrong bearer token or a tampered session cookie | `denied`, i.e. 401 and the sign-in flow — **not** demo data |

That last row is the subtle one: only a request carrying *no* credential is a demo visitor. An
expired session must not be answered from the sample set, because that would show fabricated
suppliers and amounts to someone who believes they are looking at their real deployment.

### 2. Transport level — with Postgres stopped entirely

A production server (`next start`) was run with `DEMO_MODE=true`, and the local Postgres container
was stopped mid-verification. That turned out to be the strongest available test:

| Request | Result |
|---|---|
| Anonymous `GET /api/metrics` | **200** — 50 suppliers, 43 classified / 7 unclassified, spend 115,155,000, 15 segments, 31 rollup clusters, 14 review rows, 6 inherited, 4 stale |
| Authenticated `GET /api/metrics` | **500** — a real database error, proving the owner's path is routed to the database and not to the fixture |
| All seven pages (`/`, `/upload`, `/settings`, `/hierarchy`, `/audit`, `/reports`, `/review`) anonymously | 200 |
| `/api/hierarchy`, `/api/classifications?view=queue`, `/api/audit`, `/api/reports` anonymously | 200 — 31 clusters, 14 queue rows, 32 audit entries, 6 reports |
| `POST /api/upload`, `PATCH /api/settings`, `DELETE /api/hierarchy` anonymously | 403 `demo_read_only` |
| `GET /api/export?format=csv`, and an unlisted `/api/some-future-endpoint` | 403 and 404 |
| `/api/health` anonymously | 200, database row counts reduced to `reachable` |
| `/api/auth/session` anonymously | `demo: true`, so the UI shows the banner and a Sign in link |

A complete dashboard was served **with no database reachable at all**, which is only possible because
the demo path has no database dependency.

## Bright Data provider

Bright Data is a Scraper API *dataset* rather than a company-lookup API, which changes the shape of
the integration: the request is keyed by `dataset_id`, the input is a URL rather than a name, and the
record returned is defined by whichever dataset was chosen. The behaviour that follows is pinned by
26 tests in `tests/brightdata.test.ts`; the parts that cannot be verified from documentation (the
record's field names) are made observable instead of assumed.

| Case | Verified behaviour |
|---|---|
| Request construction | `POST /datasets/v3/scrape` with `dataset_id`, **`format=json`** (the endpoint defaults to `ndjson`), `include_errors=true`, bearer auth, and one input carrying `url` + `supplier_name` |
| Records returned | First record mapped, 1 credit charged |
| Empty array | `not_found` with 0 credits — the API documents an empty array as "these inputs produced no records", so treating it as a successful empty enrichment would silently mark suppliers stale |
| Record containing `error` / `error_code` | Reported as a failure rather than normalised into a company whose every field is null, which would look like a successful lookup that found nothing |
| HTTP 400 | Surfaced verbatim as `invalid_input`; Bright Data names the offending field and reason, which is the fastest route to discovering a dataset wants a different input URL |
| HTTP 401/403 | `unauthorized`, which the caller turns into a key error rather than a data error |
| HTTP 202 | Followed through `GET /datasets/v3/progress/{id}` then `/datasets/v3/snapshot/{id}`. The synchronous endpoint has a **one-minute timeout** and answers 202 beyond it; without this path every slow lookup would silently degrade to the heuristic fallback |
| Supplier without a domain | `no_domain`, and **no HTTP request is made** — asserted, not assumed |

Field mapping (`normalizeBrightDataPayload`), verified against flat LinkedIn-style records, nested
Crunchbase-style records, list-valued fields (`industries: [...]`), dot-paths (`about.description`),
and a string-valued parent:

| Property | Why it is asserted |
|---|---|
| An unrecognised record yields **nulls, never a guess** | A missing `industry` is visible and leaves the classifier working from the name; a wrong one produces wrong UNSPSC codes silently. This is the failure mode a new dataset would otherwise introduce |
| The raw record is retained on the result | It is stored in the cache, so an unmapped field can be remapped from stored data without paying to re-fetch |
| NAICS/SIC keep only digits | Matches how the rest of the app stores and matches them |
| A non-object payload does not throw | A dataset configured wrongly must not take the worker down |

`npm run brightdata:probe -- --domain dell.com` exists because the field names are dataset-specific
and cannot be settled from docs: it calls the API once and prints the URL sent, the status, every
record key, the mapped result, and the fields that came back empty — writing nothing. That is the
step to run before spending money on a batch.

### Two bugs found by checking the mapping against a real record

The LinkedIn Companies response is the one dataset shape Bright Data documents in full, so it was
used as a real fixture rather than an imagined one. It exposed two defects that would have corrupted
data silently in production:

| Defect | What it would have done | Fix |
|---|---|---|
| `country_code` from that dataset is a **comma-separated list of every country the company operates in** — forty-odd ISO codes for Microsoft | Written verbatim into the `country` column, then truncated to 100 characters | A list of ISO codes is reduced to its first entry, which is the primary country. Anything else containing a comma is left `null`, so `"Redmond, Washington, United States"` cannot become `"Redmond"` |
| The record's `url` is the **LinkedIn profile**, not the company's site | `extractDomain` would yield `linkedin.com` and overwrite the supplier's real domain, after which every re-classification would reason about LinkedIn | Directory and social hosts (LinkedIn, Crunchbase, Owler, ZoomInfo, Glassdoor, …) are rejected as a company domain, so the supplier keeps the domain it already had. A near-miss like `notlinkedin.com` is unaffected |

Both are covered by tests using the documented record, including the `website`-absent case where the
directory URL is the only candidate.

## SEO surfaces

Verified against a production build (`next start`) with `ALLOW_INDEXING` at its default of false:

```
/robots.txt            200  text/plain             "User-Agent: *" + "Disallow: /" (no sitemap advertised)
/sitemap.xml           200  application/xml        empty <urlset> — nothing advertised while not indexable
/manifest.webmanifest  200  application/manifest+json
/icon.svg              200  image/svg+xml
/opengraph-image.svg   200  image/svg+xml          1200x630 social card
/login                 200  text/html              title, description, canonical, og:*, twitter:*, JSON-LD
```

Rendered `<head>` on `/login`:

```
<title>Sign in · UNSPSC Spend Categorizer</title>
<meta name="description" content="UNSPSC Spend Categorizer — AI spend classification with …">
<meta name="robots" content="noindex, nofollow, nocache">
<link rel="canonical" href="http://localhost:3000/login">
<meta property="og:title|og:description|og:url|og:type">
<meta name="twitter:card" content="summary_large_image"> plus twitter:title/description/image
<meta name="theme-color" media="(prefers-color-scheme: light|dark)">   (duplicate plain tag removed)
<link rel="icon" href="/icon.svg" type="image/svg+xml">                (missing favicon.ico reference removed)
<script type="application/ld+json">SoftwareApplication + WebSite</script>
  SoftwareApplication.featureList: 9 entries
  aggregateRating: absent    offers: absent
```

26 unit tests cover the policy: indexing is **off by default**, a private page stays `noindex`
even when global indexing is enabled, the sitemap is empty when not indexable, canonical URLs are
absolute and correctly ordered (`SITE_URL` → Vercel host → `NEXT_PUBLIC_APP_URL`), and the
structured data invents no ratings or prices.


## Theme and responsive audit (`scripts/visual-check.mjs`)

Driven through the Chrome DevTools Protocol against Microsoft Edge, 10 viewport/theme combinations,
measuring rendered colours and geometry rather than inspecting class names.

```
desktop-light-         theme=light viewport=1440 overflow=no  contrastMin=4.7  fails=0  targets=78  below24=0 tableScroll=2
desktop-light-review   theme=light viewport=1440 overflow=no  contrastMin=4.7  fails=0  targets=14  below24=0 tableScroll=1
desktop-dark-          theme=dark  viewport=1440 overflow=no  contrastMin=6.86 fails=0  targets=78  below24=0 tableScroll=2
desktop-dark-settings  theme=dark  viewport=1440 overflow=no  contrastMin=6.86 fails=0  targets=23  below24=0 tableScroll=0
mobile-light-          theme=light viewport=390  overflow=no  contrastMin=4.7  fails=0  targets=70  below24=0 tableScroll=2
mobile-light-review    theme=light viewport=390  overflow=no  contrastMin=4.7  fails=0  targets=6   below24=0 tableScroll=1
mobile-dark-           theme=dark  viewport=390  overflow=no  contrastMin=6.86 fails=0  targets=70  below24=0 tableScroll=2
mobile-dark-hierarchy  theme=dark  viewport=390  overflow=no  contrastMin=6.86 fails=0  targets=406 below24=0 tableScroll=0
tablet-                theme=light viewport=768  overflow=no  contrastMin=4.7  fails=0  targets=70  below24=0 tableScroll=2
small-phone-           theme=light viewport=320  overflow=no  contrastMin=4.7  fails=0  targets=70  below24=0 tableScroll=2

No unexpected horizontal overflow at any tested viewport.
All sampled text meets WCAG AA contrast in both themes.
Every non-inline control meets the 24x24 minimum (WCAG 2.5.8).
controls below the 32px comfort target: 0
themes observed: light, dark
```

Screenshots written per combination for human review. Note the harness itself needed fixing twice
before it could be trusted — see the bug table.

## Authentication

Deny-by-default middleware plus a per-route `requireAuth()` check. Verified against the running
dev server with `DASHBOARD_SECRET` configured:

```
unauthenticated  GET  /                     -> 307  Location: /login
unauthenticated  GET  /review               -> 307  Location: /login?next=%2Freview
unauthenticated  GET  /api/suppliers        -> 401
unauthenticated  GET  /login                -> 200   (public)
unauthenticated  GET  /api/health           -> 200   (public, for uptime monitors)
unauthenticated  GET  /api/auth/session     -> 200   (public)

bearer token     GET  /api/metrics          -> 200   (28.8 KB)
bearer token     GET  /api/suppliers        -> 200
bearer token     GET  /api/settings         -> 200
bearer token     GET  /api/audit            -> 200
bearer token     GET  /api/hierarchy        -> 200
wrong secret     GET  /api/metrics          -> 401

login (cookie)   POST /api/auth/login       -> 200, Set-Cookie: unspsc_session
cookie session   GET  /                     -> 200   (32.5 KB, dashboard rendered)
cookie session   GET  /hierarchy /review /reports /audit /settings /upload -> 200
cookie session   GET  /api/metrics          -> 200   suppliers=110 parents=18 spend=15103500
wrong secret     POST /api/auth/login       -> 401 "That secret is not correct."
```

Unit coverage for the scheme (25 tests): signature bound to the secret, tampered expiry rejected
as `bad_signature`, expiry enforced, forged cookie rejected, bearer/header/cookie precedence,
public-path allowlist, `WORKER_SECRET` fallback, fail-closed with no secret configured, and the
dev bypass not applying in production.

## Database

```bash
docker compose up -d postgres
npm run db:migrate      # -> Migrations applied successfully.
                        #    Tables: app_settings, audit_log, classifications, corrections,
                        #            enrichment_cache, llm_usage, reports, suppliers, unspsc_codes
npm run db:seed         # -> Read 149849 rows, 0 skipped. 149,849 codes across 58 segments.
npm run db:seed:sample  # -> 110 created, 21 linked, 18 families, hierarchy printed
                        #    artifacts: sample-seed-report.csv (27.6 KB), sample-seed-report.pdf (43.4 KB)
```

## Pipeline

```
Upsert:       110 created, 0 updated, 0 unchanged, 1 duplicate row(s) folded, 1 error(s)
Enrichment:   skipped (ENRICH_PROVIDER=none) — heuristic mode exercised separately
Parent links: 21 linked, 0 parent row(s) created, 0 skipped
Resulting dataset:
  suppliers        110        parents          18
  total spend      15,103,500 subsidiaries     21
  classified       0 (no GROQ_API_KEY)  stale  110
Hierarchy (89 clusters) — verified families:
  Dell Technologies      -> EMC Corporation, VMware
  Microsoft              -> LinkedIn, Microsoft Azure
  Siemens AG             -> Mentor Graphics, Siemens Healthineers
  Grainger               -> W.W. Grainger Canada, W.W. Grainger Mexico
  Alphabet               -> Google Cloud
  Amazon.com             -> Amazon Web Services
  Cintas                 -> Cintas Facility Services
  Cisco Systems          -> Splunk
  Salesforce             -> Slack Technologies
  FedEx                  -> FedEx Freight
  Honeywell              -> Honeywell Building Solutions
  Linde                  -> Praxair
  Merck KGaA             -> Sigma-Aldrich
  Nestle                 -> Nestle Waters
  Thermo Fisher Scientific -> Fisher Scientific
  Unilever               -> Unilever Food Solutions
  Verizon Communications -> Verizon Business
  Deutsche Post DHL      -> DHL Supply Chain
```

## API routes

Read paths (all HTTP 200):

```
/api/suppliers?page=1&pageSize=5      /api/suppliers?meta=true
/api/suppliers?rollup=parent          /api/suppliers?onlyStale=true
/api/suppliers/1                      /api/hierarchy?flat=true
/api/classifications?pageSize=5       /api/classifications?view=queue
/api/classifications?view=segments    /api/classify?plan=true
/api/classify?q=computer&limit=5      /api/audit?pageSize=10
/api/audit?view=summary               /api/reports?pageSize=5
/api/reports?view=budget              /api/settings
/api/health                           /api/metrics
/api/export?format=csv                /api/export?format=csv&rollup=parent&minConfidence=0.7
/api/export?format=rollup             /api/export?format=hierarchy
/api/export?format=pdf&rollup=parent  /api/export?format=pdf&confidenceState=low&segment=43
```

Error paths behave correctly:

```
/api/export?format=xlsx      -> 400
/api/sync (no secret)        -> 401
/api/hierarchy self-link     -> 400 "A supplier cannot be its own parent."
/api/hierarchy cycle         -> 400 "Refusing to link VMware as the parent of Dell Technologies:
                                      it is already a subsidiary of it."
```

Write paths:

```
POST /api/enrich     -> processed 3, enriched 3, provider=heuristic, credits 0
POST /api/classify   -> fails fast with "GROQ_API_KEY is not set..." (no per-supplier failures)
POST /api/sync       -> candidatesFound 60, enriched 60, batches 12, stoppedReason=completed
POST /api/reports    -> storedId 1, 44,527 bytes, rows 110
GET  /api/reports/1/download -> 200 application/pdf, attachment; filename="verification-weekly-report.pdf"
PATCH /api/classifications/1 -> corrected 43211500, appliedToSubsidiaries true, affected [1, 2]
GET  /api/suppliers/2 -> VMware inherits 43211500, inherited=True, reviewed=True,
                         parent=Dell Technologies
POST /api/hierarchy  -> createdPlaceholder true for "Wolseley PLC"
DELETE /api/hierarchy -> unlinked supplier 27
```

Audit trail after the run:

```
created=111  enriched=111  updated=110  linked=23  synced=3  classified=2  inherited=2
report_generated=2  unlinked=1  corrected=1  propagated=1
```

## Reports

| Artefact | Detail |
|---|---|
| CSV | 317 lines, 27.6 KB; header row + `# Segment breakdown` + `# Parent roll-up` + `# Low-confidence review appendix`; UTF-8 BOM `EF BB BF` |
| PDF | 8 pages, 44,362 bytes, `PDFDocument.load()` succeeds; title `UNSPSC spend report …` |
| Stored reports | 2 rows in `reports` with non-null `bytea` blobs (44,527 and 44,913 bytes) |

## Render worker

```
health  (no auth)  -> 200, cheap, jobs + nextRunAt for sync (03:00 UTC) and report (Mon 06:00 UTC)
ready   (no auth)  -> 200 {"database":"reachable"}
status  (no auth)  -> 401
status  (secret)   -> 200 scheduler + stats + Groq budget + taxonomy count
POST /run?job=sync   -> 200 lastStatus=success runCount=1
POST /run?job=report -> 200 lastStatus=success runCount=1
POST /run?job=bogus  -> 400
POST /run?job=catchup -> 200

Cron catch-up on wake-up (the Render free-tier scenario):
  $ psql -c "update audit_log set created_at = now() - interval '3 days' where action='synced'"
  restart worker ->
    [worker] job sync scheduled {"cron":"0 3 * * *","next":"2026-09-20T03:00:00.000Z"}
    [worker] catching up missed sync run {"since":"2026-09-17T00:57:01.102Z"}
    [worker] sync finished {"stoppedReason":"completed","durationMs":58}

Keep-alive script:
  $ node scripts/ping-worker.mjs http://127.0.0.1:3200
  [2026-09-20T00:56:51Z] health OK in 68ms · uptime 29s · jobs: sync next=..., report next=...
```

## Bugs found and fixed during verification

| Bug | Impact if shipped | Fix |
|---|---|---|
| **Every mutating endpoint was unauthenticated** | Anyone on the internet could rewrite classifications (`PATCH /api/classifications/:id`), change `/api/settings`, upload CSVs, or burn the Groq daily quota via `/api/classify` | Deny-by-default `middleware.ts` + `requireAuth()` in all 27 route handlers; fail-closed (503) in production when no secret is set |
| Ambiguous `id` in the current-classification join | Every supplier list 500'd against real Postgres | Aliased the subquery column to `classification_id` (`services/suppliers.ts`, `services/classification.ts`) |
| Few-shot examples used class prefixes | All classifications capped at 0.4 confidence | Verified v26 commodity codes + `loadVerifiedFewShotExamples()` runtime repair |
| Raw `Date` bound into a `sql` template | `/api/health` enrichment-credit check threw | `gte()` helper with a typed column |
| Health `ok` treated an unconfigured optional provider as an outage | Uptime monitors would alarm falsely | Only `database` is a hard dependency; others report `degraded` |
| Shifted CSV row promoted a NAICS code into `parent` | Invented parent companies, wrong hierarchy | `sanitizeParentName()` + `shiftedRows` warning in the upload response |
| External parent matching the supplier was mis-detected as "already linked" | Could not link a supplier to a same-named parent, or created a duplicate row | Resolve existing rows by normalised name before creating a placeholder |
| Catch-up fired on a brand-new deployment | Immediate sync against a possibly unmigrated database | `hasRunHistory()` guard: catch-up only when a previous run exists |
| Unquoted comma in the sample CSV | Silent column shift in the shipped example data | Quoted the amount field; added CSV-shape regression tests |
| `next.config.ts` with Next 14 | `next lint`/`next build` refused to start | Switched to `next.config.mjs` |
| Duplicate single-member clusters from virtual-parent handling | A supplier classified twice; roll-up double-counted | Restructured `buildHierarchy`/`planClassification` |
| Dangling `parent_id` also joined a virtual cluster | Orphan spend counted in two families | Orphans are computed for every node and excluded from virtual clustering |
| Test suite reassigned `process.env` wholesale in `afterEach` | Suites passed in isolation and failed in a full run (detached the object `tests/setup.ts` holds) | Delete only the keys the suite set; documented in `tests/auth.test.ts` |
| **Dashboard overflowed 332px on a phone** | Horizontal page scroll on every mobile view; the worst kind of responsive bug, invisible on a desktop check | `width: max-content` on `.table-scroll table` so the intrinsic table width stays inside the scroll container, plus `min-w-0` on grid/flex children |
| Visual harness: CDP wrapper did not unwrap the message `result` | Every measurement read `undefined` — the audit "passed" while checking nothing | Resolve with `message.result`; throw with the method name on error |
| Visual harness: viewport override applied late | A 390px phone was measured at 722px, so the first mobile audit tested the desktop layout | Re-apply metrics per navigation and assert the layout viewport, failing loudly instead of silently |
| Visual harness: compared `window.innerWidth` | Disagreed with the CSS viewport in headless Chromium (722 vs 390), masking real overflow | Anchor on `document.documentElement.clientWidth`, which is what media queries use |
| Visual harness: `elementFromPoint` clickable-area probe | Reported 1×1 for every control (delegated clicks resolve to an ancestor), producing false failures | Read `::after` inset geometry from computed styles and attribute the hit area to a checkbox's `<label>` |
| Checkboxes, switches and sort headers were 16–22px | Below the WCAG 2.5.8 24px minimum; hard to tap on mobile | 32–36px padded hit areas via wrapper elements and pseudo-elements, without changing the visual density |
| **Build failed on Vercel as `Failed to collect page data for /_not-found`** | The whole deploy was blocked by a message naming no file, no variable and no cause — it cost three redeploys to not diagnose | `app/layout.tsx` resolves metadata defensively; the real cause was that `getEnv()` threw while the root layout was evaluated during page-data collection. Reproduced locally by reverting the guard: exit 1, and the route named varies by build order (`/login` locally, `/_not-found` on Vercel) |
| Any invalid environment value aborted a deployment | A typo in a dashboard field (`CLASSIFY_CONFIDENCE_THRESHOLD=70`, `SYNC_STALE_DAYS=30 days`) failed the build with an unreadable message | `getEnv()` substitutes the default for the offending variable, leaves the rest of the configuration intact, and names what it ignored in one compact log line; `app/not-found.tsx` added so the route has an explicit owner |
| **`MIDDLEWARE_INVOCATION_FAILED` on every route of a live deployment** | Nine numeric variables left at `0` in the Vercel dashboard reached `getEnv()` through `lib/auth.ts` and killed the Edge middleware: `/`, `/upload`, `/audit`, `/reports` and every API route returned a bare 500, while `/login` and static assets kept working — so the app looked deployed but was entirely unusable. `GET /api/health` returned an empty 500, hiding the reason; only `/api/auth/session` leaked it | `getEnv()` no longer throws for tuning values, so the middleware has nothing to propagate. `middleware.ts` additionally catches anything unexpected and fails closed with a 503 stating the reason, instead of letting the platform return an opaque crash |
| A misconfiguration that no longer throws became invisible | Degrading silently would trade a loud outage for a quiet wrong setting | `getEnvIssues()` records what was ignored and `GET /api/health` reports it as a `configuration` check naming every variable, so the problem is visible from outside the process |
| **The demo would have asked an expired session to trust fabricated data** | The first implementation treated *any* unauthenticated request as a demo visitor, including one presenting an invalid or expired credential. A signed-in owner whose session lapsed would have been shown invented suppliers and amounts while believing they were looking at their real deployment — worse than an extra sign-in | `resolveRequestRole` returns `denied` for a presented-but-invalid credential and reserves `demo` for a request carrying no credential at all. Both cases are covered by tests |
| Demo segment bars were grouped by the superseded code | `segmentsOf()` bucketed on `unspscCode` while production groups on `coalesce(correctedCode, unspscCode)`. A human-corrected row was therefore filed under its old segment, so a bar carried the wrong segment's name and the demo reported 14 segments where the data has 15 | Switched to `effectiveCode.slice(0, 2)`, with a test asserting the reported segment codes equal the set derived from `effectiveCode` |
| **A blank environment variable defeated every schema default** | Found on the live deployment's `/api/health`: `groq: "configured ( / )"`. zod's `.default()` applies only to `undefined`, so `z.string().default('llama-3.3-70b-versatile').parse('')` returns `''`. A `GROQ_MODEL_ACCURATE` created but left empty therefore became an empty model name, which Groq rejects — **all classification would have failed** — while blank numeric fields silently became `0`, disabling the daily budget reserve and the enrichment credit limit | Blank and whitespace-only values are pruned before parsing (`withoutBlankValues`), so an empty dashboard field means "unset" and every `.default()` applies. Verified against a production server using the live deployment's exact environment: model names, `reserve: 50` and the 14,400/day 8B limit all restore |
| **~36 × `TypeError: Invalid URL` during the Vercel build, exit 1** | Unfixable from app code as previously documented: Next.js itself runs `new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)` unguarded in `lib/metadata/resolvers/resolve-url.js`, and does so even when the app supplies its own `metadataBase` | `lib/vercel-origin.mjs` repairs a full URL to its host and drops an unusable value; `next.config.mjs` runs it before prerender workers are forked, so the correction is inherited. Verified: the same input that produced exit 1 and 36 errors now builds clean |
| Environment warning repeated once per prerender worker | Sixteen multi-line blocks buried the variable names they existed to surface | The build path emits a single compact line per process; memoisation keeps it to one call per process. Locked in by a test asserting no newline and exactly one call |

