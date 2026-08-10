# Tibo Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publicly deploy a bilingual, independently styled Tibo reset forecast dashboard that mirrors validated public JSON from the reference project without using GPT or the X API.

**Architecture:** A dependency-free static frontend reads only local mirrored JSON. A Python standard-library synchronizer validates and atomically refreshes upstream data for local startup and GitHub Pages deployments; a PowerShell launcher reuses a healthy local server or cold-starts one after synchronization.

**Tech Stack:** HTML5, CSS, browser JavaScript, SVG, Python 3 standard library, PowerShell 5+, GitHub Actions, GitHub Pages.

---

## File map

- `site/index.html`: semantic page structure, metadata, bilingual labels, accessible controls.
- `site/styles.css`: observatory visual system, responsive layout, chart and state styles.
- `site/app.js`: data loading, normalization, rendering, i18n, charts, alerts and sharing.
- `site/health.json`: launcher identity and health endpoint.
- `site/favicon.svg`: original abstract radar mark.
- `site/data/*.json`: validated upstream mirror and synchronization status.
- `scripts/sync_data.py`: atomic upstream JSON synchronizer.
- `scripts/start-site.ps1`: health-aware local server launcher.
- `启动 Tibo Reset.cmd`: double-click entrypoint.
- `tests/test_sync_data.py`: synchronizer unit tests using temporary files and a local HTTP server.
- `tests/check_static.py`: static contract checks for HTML, translations and required assets.
- `.github/workflows/pages.yml`: scheduled refresh and GitHub Pages deployment.
- `README.md`: usage, source attribution, deployment and maintenance notes.

### Task 1: Establish the static contract and failing checks

**Files:**
- Create: `tests/check_static.py`
- Create: `site/health.json`

- [ ] **Step 1: Write the static contract check**

Create a Python script that exits non-zero unless `site/index.html`, `site/styles.css`, `site/app.js`, `site/favicon.svg`, and all required section IDs exist. The required IDs are `forecast`, `factors`, `signals`, `history`, `performance`, `resets`, and `methodology`. It must also assert that `app.js` contains `zh-CN`, `en`, `tibo-reset-language`, and the five relative JSON paths.

```python
required_ids = {"forecast", "factors", "signals", "history", "performance", "resets", "methodology"}
for section_id in required_ids:
    assert f'id="{section_id}"' in html, section_id
for token in ("zh-CN", "en", "tibo-reset-language", "./data/prediction.json"):
    assert token in javascript, token
```

- [ ] **Step 2: Run the check and confirm failure**

Run: `python -X utf8 tests/check_static.py`

Expected: non-zero exit because the site files do not yet exist.

- [ ] **Step 3: Create the health identity**

Create `site/health.json` with stable content:

```json
{"app":"tibo-reset","status":"ok","schema":1}
```

### Task 2: Implement and test the data mirror

**Files:**
- Create: `scripts/sync_data.py`
- Create: `tests/test_sync_data.py`
- Create: `site/data/.gitkeep`

- [ ] **Step 1: Write synchronizer tests**

Tests must cover successful fetch, invalid JSON rejection, required-key rejection, preservation of the prior file on failure, and the shape of `sync-status.json`. Use `tempfile.TemporaryDirectory`, `http.server.ThreadingHTTPServer`, and no external packages.

```python
self.assertEqual(json.loads((data_dir / "prediction.json").read_text())["prediction"]["within_24h"], 0.8)
self.assertEqual(json.loads((data_dir / "sync-status.json").read_text())["overall_status"], "ok")
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `python -X utf8 -m unittest tests.test_sync_data -v`

Expected: import failure because `scripts.sync_data` does not exist.

- [ ] **Step 3: Implement the synchronizer**

Define a `Source` dataclass with `name`, `url`, and `required_keys`. Fetch with `urllib.request.Request` and a descriptive User-Agent, validate UTF-8 JSON and top-level type/keys, write to a sibling temporary file, then call `os.replace`. Expose `sync_all(output_dir, sources=DEFAULT_SOURCES)` and a CLI with `--output-dir`. Return exit code 0 when at least cached data remains usable; return 1 only when a required file has neither a fresh result nor a previous valid cache.

- [ ] **Step 4: Run unit tests**

Run: `python -X utf8 -m unittest tests.test_sync_data -v`

Expected: all tests pass.

- [ ] **Step 5: Fetch the live mirror**

Run: `python -X utf8 scripts/sync_data.py --output-dir site/data`

Expected: five JSON files plus `sync-status.json`, with overall status `ok`.

### Task 3: Build the bilingual page shell and visual system

**Files:**
- Create: `site/index.html`
- Create: `site/styles.css`
- Create: `site/favicon.svg`

- [ ] **Step 1: Build semantic HTML**

Create the complete section order from the design spec, loading `styles.css` and `app.js` with relative URLs. Buttons must be native `button` elements, status text must use `aria-live="polite"`, and charts require accessible text summaries.

- [ ] **Step 2: Implement the observatory theme**

Use CSS custom properties for ink, coral, ice, amber and glass surfaces. Implement a responsive 12-column desktop grid, a single-column breakpoint at 760px, focus-visible outlines, reduced-motion support, and no external font or image requests.

- [ ] **Step 3: Create an original SVG mark**

Build a square favicon with a gradient radar ring and centered `T`; do not import or trace the reference image.

- [ ] **Step 4: Run static checks**

Run: `python -X utf8 tests/check_static.py`

Expected: failure only for missing JavaScript translation/data tokens.

### Task 4: Implement the dashboard controller

**Files:**
- Create: `site/app.js`

- [ ] **Step 1: Define translations and state**

Create complete `zh-CN` and `en` dictionaries for every visible label. Default to Chinese unless `localStorage['tibo-reset-language']` is `en`; update `document.documentElement.lang` and all `[data-i18n]` nodes on toggle.

- [ ] **Step 2: Load and normalize data**

Use `Promise.allSettled` for the six local JSON reads. Coerce probabilities into `[0,1]`, return safe empty arrays for malformed histories, and expose a single normalized view model. Never use `innerHTML` for upstream text.

- [ ] **Step 3: Render forecast and factors**

Set CSS variables for three radial gauges, render the next-reset countdown, confidence, factor bars and the localized action recommendation. Thresholds: 24h below 0.35 is calm, 0.35–0.60 watch, above 0.60 warning.

- [ ] **Step 4: Render signals, charts, metrics and resets**

Pick the newest item for Tibo/OpenAI/Community, draw an SVG path from at most 160 evenly sampled 24h history points, show upstream metrics with a caution label, and deduplicate reset records by `reset_time + notes` before sorting descending.

- [ ] **Step 5: Implement alerts and sharing**

Request notification permission only after button activation. Fire at 5h > 0.5 or 24h > 0.6, persist armed/fired state, and reset fired flags after probabilities fall below thresholds. Use `navigator.share` with a clipboard fallback and visible success/error feedback.

- [ ] **Step 6: Add refresh and stale-state behavior**

Refresh local JSON every five minutes, show stale state when upstream `updated_at` exceeds 90 minutes, and display cache/error details from `sync-status.json` without hiding existing data.

- [ ] **Step 7: Run syntax and static checks**

Run: `node --check site/app.js`

Run: `python -X utf8 tests/check_static.py`

Expected: both pass.

### Task 5: Build and verify the one-click launcher

**Files:**
- Create: `scripts/start-site.ps1`
- Create: `启动 Tibo Reset.cmd`

- [ ] **Step 1: Implement health-aware startup**

Accept `-Port 4178` and `-NoBrowser`. Request `/health.json`; reuse only when `app` equals `tibo-reset`. If the port is occupied by another app, fail with a clear message. Otherwise run the synchronizer, start `python -m http.server` hidden with `--directory site`, record PID/logs under `.runtime`, retry the health request for up to 20 seconds, and open the default browser only after success.

- [ ] **Step 2: Create the double-click wrapper**

The CMD file must resolve its own directory and call:

```bat
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-site.ps1"
```

- [ ] **Step 3: Verify cold start and reuse**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-site.ps1 -NoBrowser`

Expected: health check returns `app=tibo-reset`.

Run the same command again.

Expected: output says the existing healthy server is reused and the PID does not change.

### Task 6: Add documentation and deployment automation

**Files:**
- Create: `README.md`
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Document operation and attribution**

Explain double-click startup, manual synchronization, source endpoints, the no-affiliation disclaimer, cache behavior, GitHub Pages URL, and how scheduled workflows may be disabled after prolonged repository inactivity.

- [ ] **Step 2: Create the Pages workflow**

Grant `contents: read`, `pages: write`, and `id-token: write`. On push to `main`, `workflow_dispatch`, and cron `*/20 * * * *`, run Python sync, upload `site/`, then deploy with the official Pages actions.

- [ ] **Step 3: Validate workflow and repository hygiene**

Parse YAML if PyYAML is available; otherwise check required action names and permissions with `Select-String`. Add `.gitignore` for `.runtime`, Python cache and temporary synchronization files.

### Task 7: Visual QA, deployment and proof

**Files:**
- Create: `artifacts/tibo-reset-desktop.png`
- Create: `artifacts/tibo-reset-mobile.png`

- [ ] **Step 1: Run the full local verification suite**

Run unit tests, static checks, JavaScript syntax check, JSON parse checks and the launcher cold-start test. All must pass before deployment.

- [ ] **Step 2: Capture desktop and mobile screenshots**

Use Edge headless with virtual time budget against localhost at 1440×2200 and 390×1200. Verify both images are nonblank and inspect them for overflow, clipped labels and incorrect default language.

- [ ] **Step 3: Initialize and publish the repository**

Initialize `main`, commit the verified project, create public repository `Parkersback/tibo-reset`, push, configure GitHub Pages for Actions, and trigger the workflow.

- [ ] **Step 4: Verify the public URL**

Wait for the Pages deployment, then require HTTP 200 at `https://parkersback.github.io/tibo-reset/`. Verify the rendered title, Chinese default content, data timestamp and relative asset/data requests.

- [ ] **Step 5: Write the Obsidian project card**

Record local path, public URL, verification commands, source-data boundary, deployment status and maintenance caveats through the standard `New-CodexObsidianCard.ps1` workflow, then read back the generated card.
