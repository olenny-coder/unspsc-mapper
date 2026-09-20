# Verification log

Executed against a real Postgres 16 instance (Docker) with the complete UNSPSC v26 taxonomy
seeded. Recorded here so a reviewer can reproduce each step.

## Static checks

| Command | Result |
|---|---|
| `npm run lint` (`next lint --max-warnings=0`) | ✔ No ESLint warnings or errors |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm test` (Vitest) | 12 files, **239 tests passed** |
| `npm run build` (`next build`) | compiled successfully; 18 dynamic API routes, 14 prerendered routes (7 pages + robots.txt, sitemap.xml, webmanifest), `ƒ Middleware 44 kB` |
| `npx tsx scripts/smoke-offline.ts` | SMOKE TEST PASSED |

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

