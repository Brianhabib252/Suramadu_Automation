# Suramadu Automation – Project Documentation

## High-Level Workflow
- `src/index.ts` parses CLI flags, loads YAML workflows, and hands control to the DSL runner. When no task is supplied it executes a minimal Playwright demo for smoke testing.
- The DSL runner (`src/dsl/runner.ts`) executes each step against a single Playwright page via `BrowserTools`, tracks shared state (extraction results, AI evaluations, artifacts), and streams richly formatted logs using `cliTheme`.
- Article detail pages are scraped by `extractNews` in `src/lib/newsExtract.ts`, which returns HTML/text, image metadata, and quality signals needed for policy checks.
- `src/lib/policyLocal.ts` runs deterministic checks (image hosting, Indonesian language heuristics, 5W+1H coverage, sentence count, freshness, routine detection). If the article passes image validation and a Gemini key is available, `src/lib/policyLLM.ts` escalates to the LLM.
- When Gemini is enabled, `src/ai/geminiNewsPolicy.ts` builds a JSON prompt, retries across candidate models, validates the response, and merges it with image-host sanity checks.
- Decisions are written back to the portal via the DSL `decision_apply` step, which chooses approve/reject controls, injects AI rejection text, clicks the confirmation flow, and waits for the navigation state requested in the YAML file.
- Every iteration writes JSON extracts, HTML dumps, and screenshots under `artifacts/runs/<run-id>/`, giving operators a full audit trail.

## Source Directory Overview
- `src/index.ts` – Main CLI entry point; creates run identifiers, renders header panels, and orchestrates dry-run vs live execution.
- `src/plain.ts` – Alternate entry point that forces ASCII/no-color output before requiring `index.ts`.
- `src/lib/browserTools.ts` – Project-tailored Playwright wrapper that centralises launch settings, error screenshots, navigation retries, and helper methods (`type`, `waitFor`, `saveHtml`, `screenshot`, etc.).
- `src/lib/newsExtract.ts` – DOM extraction logic that gracefully falls back across multiple selectors, resolves relative image URLs, normalises event dates, and calculates sentence/paragraph metrics.
- `src/lib/policyLocal.ts` – Declarative rule engine that returns violation codes alongside detailed context (missing core information, external hosts, sentence counts, routine keywords).
- `src/lib/policyLLM.ts` – Orchestrates the local rule evaluation, optional Gemini call, and conversion to a unified `AiEvaluationResult` consumed by the DSL.
- `src/lib/cliTheme.ts` – ANSI/ASCII theming utilities for panels, status lines, and tree-like detail output; used by both the CLI entry point and the DSL runner.
- `src/lib/time.ts` – Jakarta time helpers used for run IDs and timestamp labels.
- `src/dsl/schema.ts` – Type definitions plus strict validators for every supported DSL step (`navigate`, `type`, `foreach`, `while_selector`, `ai_evaluate`, `decision_apply`, etc.), producing human-readable error messages when YAML is malformed.
- `src/dsl/runner.ts` – Executes validated steps, handles retries, manages artifact directories per item, resolves environment placeholders, and bridges higher-level steps (`extract_news`, `ai_evaluate`, `decision_apply`) with BrowserTools.
- `src/ai/geminiNewsPolicy.ts` – Gemini integration: builds prompts, enforces result schemas with zod, retries on transient failures, and merges deterministic image-host validation.
- `scripts/showReason.ts` – Standalone script that logs into the portal, re-runs extraction + AI evaluation for a given URL, and prints the rejection rationale. Useful for diagnosis outside the main workflow.
- `examples/*.yaml` – Reference DSL playbooks (login-only, extraction-only, full Suramadu review) that demonstrate the supported step types and looping constructs.

## Execution Details
1. **Argument Parsing** – `parseArgs` in `src/index.ts` recognises flags such as `--dry-run`, `--headful`, `--retries`, and `--slowmo`, defaulting to headless, single retry, and chromium channel.
2. **Dry Run Mode** – `runDry` loads the YAML, formats each step through `describeTaskPlan`, and prints numbered entries wrapped to the panel width (44 characters).
3. **Live Run Mode** – `runFromDsl` creates a unique run ID (`nowJakarta` + random suffix), sets up `artifacts/runs/<run-id>/`, launches `BrowserTools`, and then calls `runTask`.
4. **Runner State** – `RunnerState` in `src/dsl/runner.ts` carries the current artifact directory, last extraction, AI result, and a halt flag. Looping helpers (`foreach`, `while_selector`) create per-item folders such as `item-001/`.
5. **Error Handling** – `BrowserTools` wraps each operation in `execute`, capturing a timestamped screenshot when Playwright throws. The DSL runner retries steps with transient network/navigation errors up to the configured retry count.
6. **Decision Application** – `runDecisionApplyStep` resolves form controls, toggles them via `setChecked` or `click`, injects AI rejection paragraphs when required, optionally handles confirmation dialogs, and respects custom post-wait states/timeouts.
7. **Artifacts** – `writeJsonArtifact` writes extraction payloads, while `generateArtifactPath` centralises naming for screenshots/HTML, ensuring directories exist before writing.

## DSL Step Catalogue (Highlights)
- `navigate` – Call `BrowserTools.navigate` with optional load state/timeout overrides.
- `type`, `click`, `wait_for`, `assert` – Map directly to Playwright locator helpers.
- `artifact` – Persist a screenshot or HTML snapshot. When nested under loops, artifacts are stored inside the per-item directory.
- `extract_news` – Invoke `extractNews` and stash the JSON artefact + `lastExtract` state.
- `ai_evaluate` – Run `aiEvaluate` using `lastExtract`, logging the source (local vs Gemini), decision, and violations.
- `decision_apply` – Toggle approval controls, submit the form, and optionally wait for and interact with confirmation modals.
- `foreach` / `while_selector` – Loop constructs that scope `context.row` for nested actions and support automatic iteration counters plus optional `max_iterations`.
- `break_if` – Allows early exit when a selector is absent (e.g., no more rows remain).

## Testing & Quality
- Unit tests in `src/lib/policyLocal.test.ts` and `src/lib/policyLLM.test.ts` verify the rule engine and LLM integration logic (host detection, sentence thresholds, Gemini fallback).
- `npm test`, `npm run lint`, and `npm run format` (see `package.json`) provide the standard quality gates.
- `artifacts/` is ignored by git but created on demand; review run outputs there for debugging.

## Operational Notes
- Required secrets: `SURAMADU_USERNAME`, `SURAMADU_PASSWORD`, optional `GEMINI_API_KEY` (configured via `.env`).
- Set `GEMINI_MODEL` or `GEMINI_POLICY_TIMEOUT_MS` in `.env` to tune Gemini behaviour.
- Use `npm run dev -- --dry-run <yaml>` to validate DSL changes without touching the browser.
- `scripts/showReason.ts` can be executed with `npx ts-node --project tsconfig.json scripts/showReason.ts <detail-url>` to inspect AI outcomes for a specific article.
- For plain logging (CI, terminals without ANSI support), run `npm run dev:plain -- <yaml>` which loads `src/plain.ts` before the CLI.

