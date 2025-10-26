# Suramadu Automation

Browser-based automation that reviews pending news articles in the Suramadu portal, validates their content against local and AI-assisted policies, and applies approve/reject decisions automatically.

## Features
- **Task DSL** &mdash; High-level YAML workflow (`examples/suramadu-auto-review.yaml`) that drives Playwright actions such as navigation, filtering, scraping, and decision making.
- **Smart policy engine** &mdash; Combines a fast local validator (`src/lib/policyLocal.ts`) with Gemini for nuanced language checks (`src/ai/geminiNewsPolicy.ts`).
- **Artifact trail** &mdash; Every run stores JSON extracts, page HTML, and screenshots under `artifacts/runs/<run-id>/` to aid audits and debugging.
- **Extensible CLI runner** &mdash; Flags for headless/headful runs, retries, slow motion, and dry-run planning (`src/index.ts`), with terminal progress grouped into four high-level phases.

## Repository Layout
```
├── examples/                 # Reusable automation flows (YAML DSL)
├── scripts/                  # Utility scripts (e.g., showReason.ts)
├── src/
│   ├── ai/                   # Gemini prompt + parsing
│   ├── dsl/                  # Runner + schema for YAML tasks
│   └── lib/                  # Browser helpers, extraction, policy logic
└── artifacts/                # Screenshots, HTML dumps, extracted data per run
```

## Prerequisites
1. **Node.js 18+** (Playwright 1.56 requires Node 18 or newer).
2. **npm** (bundled with Node).
3. Optional but recommended: Google Gemini API key.

## Installation
```bash
npm install
npm run pw:install      # downloads required Playwright browsers
```

### Environment Variables
Create a `.env` in the repo root (see `.env` template in the project) and provide:
```
SURAMADU_USERNAME=<portal username>
SURAMADU_PASSWORD=<portal password>
GEMINI_API_KEY=<optional Google Gemini key>

# Optional tuning
GEMINI_MODEL=gemini-2.5-flash
GEMINI_POLICY_TIMEOUT_MS=120000
```
Without `GEMINI_API_KEY` the automation falls back to the local policy engine only.

## Running the Automation
```bash
# Execute the Suramadu review playbook in headless mode
npm run dev -- examples/suramadu-auto-review.yaml

# Inspect what would run without touching the browser
npm run dev -- --dry-run examples/suramadu-auto-review.yaml

# Watch the browser (Chrome channel) while running
npm run dev -- --chrome examples/suramadu-auto-review.yaml

# Retry flaky steps up to 2 additional times
npm run dev -- --retries=2 examples/suramadu-auto-review.yaml

# Plain-text logging (no color/box decorations) for debugging
npm run dev:plain -- examples/suramadu-auto-review.yaml
```
Each invocation creates a timestamped run directory under `artifacts/runs/` that stores:
- `extract-*.json` &mdash; Structured article data (text, images, signals).
- `page-*.html` & screenshots.
- Modern CLI output with colored step panels, retry warnings, four-phase progress (`Step 1/4` … `Step 4/4`), and ASCII-safe fallbacks for non-TTY terminals (switch to `npm run dev:plain` for undecorated logs).

## How the Workflow Operates
1. **Bootstrap session (Steps 1–6)** &mdash; Navigates to the login page, submits credentials, and waits for the authenticated dashboard.
2. **Prepare queue (Steps 7–9)** &mdash; Opens the news management table, focuses the search box, and applies the `Status : Belum Dikonfirmasi` filter.
3. **Review loop (Step 10)** &mdash; Iterates each pending row: refreshes the filter, opens the article, captures DOM content (`src/lib/newsExtract.ts`), evaluates policy rules (local plus Gemini), collects artifacts, applies the decision, and returns to the queue.
4. **Completion check (Step 11)** &mdash; Confirms the queue no longer contains pending rows before ending the run.

## Extending the DSL
- Add or modify steps in the YAML file. Supported step types include `navigate`, `wait_for`, `type`, `click`, `while_selector`, `extract_news`, `ai_evaluate`, `decision_apply`, `artifact`, and more (see `src/dsl/schema.ts` for validation rules).
- Use `--dry-run` to verify ordering after edits.
- Keep custom workflows in `examples/` for consistency.

## Utilities
- `scripts/showReason.ts` &mdash; Opens a specific news detail page, re-runs extraction + AI evaluation, and prints the resulting violations/rejection message. Useful for manual diagnosis.
  ```bash
  npx ts-node --project tsconfig.json scripts/showReason.ts <detail-page-url>
  ```

## Quality Checks
```bash
npm test          # run Vitest unit tests (policy logic)
npm run lint      # eslint across src/
npm run format    # prettier check
```

## Troubleshooting
- **Automation fails with login errors** &mdash; Recheck credentials in `.env` and confirm no captcha/manual verification is required.
- **Gemini timeouts** &mdash; Ensure the API key is valid or raise `GEMINI_POLICY_TIMEOUT_MS`.
- **Playwright browser downloads** &mdash; Re-run `npm run pw:install` after Node/OS updates or if browsers were removed.

## License
This project is licensed under the ISC license (see `package.json`).
