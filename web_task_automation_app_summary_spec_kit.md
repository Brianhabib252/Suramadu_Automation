# Web Task Automation App — Summary & Spec Kit

## 1) Executive Summary
A cross‑platform desktop application that automates repetitive actions on websites (form filling, clicking, checkbox/radio selections, navigating pages) and adds an AI “News Review” module that reads articles, summarizes them, and decides whether they are worth producing/publishing. The system uses a reliable browser automation core (Playwright) orchestrated by an Agent layer with a declarative Task DSL. It supports human‑in‑the‑loop review, robust logging, and safe operation within website Terms of Service.

---

## 2) Goals & Non‑Goals
**Goals**
- Automate common web tasks: text input, button clicks, checkboxes/radios, dropdowns, pagination, file upload, and multi‑page flows.
- Provide a declarative Task DSL (YAML/JSON) so non‑developers and agents can define workflows.
- Add an AI News Review pipeline: fetch → clean → summarize → classify (Worth/Not Worth) → produce structured output.
- Offer scheduling, retries, idempotent runs, audit logs, screenshots, and HTML snapshots for debugging.
- Support a visual flow builder and an execution console.

**Non‑Goals**
- Bypassing CAPTCHAs, paywalls, or access controls.
- General web scraping at massive scale. Focus is reliability and compliance.
- Full CMS or publishing platform (export hooks provided instead).

---

## 3) Key Use Cases
1. **Form Automation:** Login (where permitted), fill multiple fields, check terms, submit, and verify confirmation.
2. **Bulk Data Entry:** Iterate over CSV/JSON rows and submit forms with validation and duplicate checks.
3. **Review Queues:** Open queued items, apply rule‑based + AI checks, submit decisions, and move to next.
4. **News Review:** Read article pages, extract main text, summarize, classify “Worth to produce?”, output a structured brief.
5. **Pagination & Multi‑Page:** Navigate next/prev, tab through sections, wait for network idle, handle dynamic content.

---

## 4) Architecture Overview
**Recommended pattern:** TypeScript + Playwright for automation (deterministic & fast) with an Agent Orchestrator. ML/LLM features live in a Python service (FastAPI) or Node microservice depending on team preference.

### 4.1 Components
- **Desktop Shell:** Tauri (Rust core, very lightweight) or Electron (mature ecosystem).
- **Automation Engine:** Playwright (Chromium/Firefox/WebKit, headful/headless). Selenium is optional but Playwright preferred for reliability & locator model.
- **Agent Orchestrator:** Runs Tasks; maintains state machine for each step; handles retries/timeouts; exposes a tool API to the LLM.
- **AI Service:** Summarization, classification, dedup, source quality scoring; can be Python FastAPI.
- **Scheduler & Queue:** Lightweight job queue (BullMQ/Redis if Node; RQ/Redis or Celery if Python).
- **Storage:** SQLite or Postgres for tasks/runs/metrics; object store for artifacts (screenshots, HTML dumps, JSON outputs).
- **UI:** Flow Builder + Run Console + Dataset Labeler for news.

### 4.2 Data Flow (high level)
1. User/Agent defines a Task in DSL → stored in DB.
2. Orchestrator parses → compiles to Playwright steps.
3. Engine executes with robust locators; gathers artifacts.
4. (Optional) Text/HTML to AI Service → summary + verdict.
5. Results saved; notifications/hooks fired.

### 4.3 Suggested Tech Stack
- **Core:** TypeScript 5+, Node 20+, Playwright.
- **Desktop:** Tauri (preferred for performance) or Electron.
- **Backend API:** NestJS (Node) or FastAPI (Python). Start with one; call the other over HTTP if needed.
- **AI/ML:** Python (FastAPI, Pydantic, scikit‑learn), or Node LLM SDKs. Embeddings via an external API or local models.
- **DB:** Postgres (production) or SQLite (dev). Prisma or SQLModel as ORM.
- **Queue:** Redis + BullMQ (Node) or RQ/Celery (Python).
- **Packaging:** Docker for services; auto‑updater for desktop.

---

## 5) AI / News Review Module
**Pipeline**
1. **Ingestion:** URL(s) → fetch HTML → boilerplate removal → detect main content → language detect.
2. **Summarization:** Map‑reduce summarization for long texts; produce: title, 1‑para summary, key facts, entities, topics.
3. **Classification:** Binary/tri‑class (Worth/Borderline/Not Worth) using:
   - Heuristics (source credibility, recency, topic relevance) +
   - Classifier (logistic reg or small transformer) +
   - Optional LLM judge for tie‑breaks with chain‑of‑thought hidden.
4. **Dedup/Similarity:** Embeddings → cosine similarity against recent articles to avoid duplicates.
5. **Output:** JSON brief (see schema below) + confidence + recommended next actions.
6. **Human‑in‑the‑loop:** Review UI to override verdicts; feedback stored for continuous learning.

**Model training data**
- Label small seed set (500–2k) with verdict + reasons.
- Use active learning: sample low‑confidence items for labeling.
- Track drift; retrain periodically.

---

## 6) Task DSL & Tooling APIs
### 6.1 DSL (YAML) — Example
```yaml
name: "Submit Customer Leads"
variables:
  - csv_path: "/path/leads.csv"
setup:
  - navigate: "https://example.com/login"
  - type: { selector: "input[name=email]", value: "{{secrets.USER}}" }
  - type: { selector: "input[name=password]", value: "{{secrets.PASS}}" }
  - click: { selector: "button:has-text(\"Sign in\")" }
  - wait_for: { state: "networkidle" }
loop:
  dataset:
    from_csv: "{{csv_path}}"
  steps:
    - navigate: "https://example.com/leads/new"
    - type: { selector: "#name", value: "{{row.name}}" }
    - type: { selector: "#phone", value: "{{row.phone}}" }
    - check: { selector: "#terms" }
    - select: { selector: "#priority", value: "{{row.priority}}" }
    - click: { selector: "button[type=submit]" }
    - assert:
        contains_text: { selector: ".toast", text: "Created" }
    - artifact:
        screenshot: { path: "artifacts/{{row.id}}.png" }
```

### 6.2 Agent Tool API (TypeScript signatures)
```ts
interface BrowserTools {
  navigate(url: string): Promise<void>;
  type(selector: string, value: string, mode?: "clear"|"append"): Promise<void>;
  click(selectorOrText: string): Promise<void>;
  check(selector: string, value?: boolean): Promise<void>; // true = check, false = uncheck
  select(selector: string, option: string): Promise<void>;
  waitFor(opts: {state?: "load"|"domcontentloaded"|"networkidle", selector?: string, timeoutMs?: number}): Promise<void>;
  extractText(selector: string): Promise<string>;
  saveHtml(path: string): Promise<void>;
  screenshot(path: string): Promise<void>;
}

interface NewsAI {
  summarize(htmlOrText: string): Promise<{title: string; summary: string; key_facts: string[]; entities: string[]}>;
  classify(input: {title: string; summary: string; key_facts: string[]; entities: string[]; signals?: Record<string, any>}): Promise<{verdict: "WORTH"|"BORDERLINE"|"NOT_WORTH"; confidence: number; reasons: string[]}>;
  similarity(text: string): Promise<{duplicates: Array<{id: string; score: number}>}>;
}
```

### 6.3 Task Run Output Schema (JSON)
```json
{
  "task_id": "uuid",
  "run_id": "uuid",
  "status": "SUCCEEDED|FAILED|PARTIAL",
  "started_at": "2025-10-09T03:21:00Z",
  "finished_at": "2025-10-09T03:23:11Z",
  "steps": [
    {"name": "navigate", "ok": true, "latency_ms": 320},
    {"name": "type", "ok": true, "latency_ms": 52}
  ],
  "artifacts": [
    {"type": "screenshot", "path": "artifacts/lead-123.png"},
    {"type": "html", "path": "artifacts/lead-123.html"}
  ],
  "news_brief": {
    "title": "...",
    "summary": "...",
    "key_facts": ["..."],
    "entities": ["..."],
    "verdict": "WORTH",
    "confidence": 0.84,
    "reasons": ["Strong source", "High relevance"],
    "duplicates": [{"id": "abc", "score": 0.86}]
  }
}
```

---

## 7) Reliability, Selectors & Anti‑Fragility
- Prefer **role‑based and text** locators, e.g., `getByRole('button', { name: /submit/i })`.
- Fallbacks: data‑testids → ARIA roles → visible text → CSS/XPath as last resort.
- Use **explicit waits** for network idle or specific selectors; avoid arbitrary sleeps.
- Exponential backoff retries for transient errors; circuit‑breaker for repeated failures.
- Idempotency keys when submitting forms to prevent duplicates.

---

## 8) Security & Compliance
- Respect site ToS; configurable **domain allowlist**.
- Never attempt CAPTCHA solving; prompt human review instead.
- Secrets vault for credentials (OS keychain, dotenv-vault, or cloud KMS). Mask in logs.
- Strict permissioning: per‑task scopes; audit trail of actions and data touched.
- PII redaction in artifacts; optional on‑device processing for sensitive workflows.

---

## 9) UX & Product Surfaces
- **Flow Builder:** Drag‑and‑drop steps (Navigate, Type, Click, Check, Select, Loop, If/Else, Pause for Review).
- **Run Console:** Live logs, step status, screenshots, DOM snapshot diff, retry button.
- **News Reviewer:** Left: article text & highlights. Right: summary, verdict, reasons, confidence, toggle to override.
- **Datasets:** Upload CSV/JSON; map columns to selectors.
- **Scheduler:** Cron‑like UI; time windows; backoff; notifications.

---

## 10) Implementation Plan & Milestones
**Phase 0 — Foundations (1–2 weeks)**
- Repo scaffolding; mono‑repo (pnpm) or poly‑repo.
- Pick shell (Tauri) and core (Playwright). Set up DB (SQLite dev, Postgres prod). Telemetry hooks.

**Phase 1 — Automation MVP (2–4 weeks)**
- Implement DSL parser → Playwright executor (Navigate/Type/Click/Check/Select/Wait/Assert/Artifacts).
- Run Console with live logs & screenshots. Error taxonomy & retries.

**Phase 2 — News AI (2–3 weeks)**
- Text cleaning; summarization; heuristic + ML classifier; verdict UI.
- Feedback loop storage; basic dedup with embeddings.

**Phase 3 — Visual Builder & Scheduler (2–3 weeks)**
- Drag‑and‑drop flow builder; CSV dataset loops; cron scheduler; notifications.

**Phase 4 — Hardening (ongoing)**
- Auth, secrets, allowlist, packaging, updater, tests, docs.

> Deliverables per phase: runnable desktop app, API docs for tools, example tasks, test suite coverage report, packaging scripts.

---

## 11) Testing & QA Strategy
- **Unit:** DSL parsing, selector utilities, retry logic, AI service endpoints.
- **Integration:** Full tasks against staging sites (local test server with known DOM and mock data).
- **E2E:** Record & replay interactions; snapshot tests for DOM states.
- **AI Eval:** Labelled set for precision/recall; monitor confusion matrix; track calibration.
- **Load/Soak:** Long‑running automations; memory leak checks.

---

## 12) Deployment & Ops
- Desktop builds (Win/macOS/Linux) via Tauri bundler; auto‑update channel.
- Optional headless service mode in Docker for server‑side runs.
- Logs to SQLite/Postgres + S3‑compatible store for artifacts.
- Observability: structured logs, metrics (success rate, MTTR, throughput), traces around step execution.
- Error reporting via Sentry or equivalent.

---

## 13) Metrics & KPIs
- **Automation Success Rate** (per task, per site).
- **Median Task Duration**; **Step Failure Rate** and top error codes.
- **News Classifier Precision/Recall** on a validation set; **Reviewer Override Rate**.
- **Duplicate Suppression Rate** after similarity check.

---

## 14) Risks & Mitigations
- **DOM Drift / Site Changes:** Use robust locators, health checks, and rapid update path for flows.
- **Ethical/Legal:** Enforce allowlist, user credentials ownership, and ToS checks; no CAPTCHA bypass.
- **Model Drift:** Periodic re‑evaluation; active learning from overrides.
- **Rate Limits/Blocks:** Throttling and randomized delays; respect robots and site policies.

---

## 15) Sample Playwright Snippets
```ts
// click by accessible name
await page.getByRole('button', { name: /submit/i }).click();
// type with clear
const el = page.locator('input[name=email]');
await el.fill('user@example.com');
// wait for toast
await page.locator('.toast:has-text("Created")').waitFor();
```

---

## 16) Acceptance Criteria (MVP)
- Run a YAML task that logs in (where permitted), fills 5+ fields, submits, and verifies a success indicator.
- Loop over CSV data and create 20+ records with <2% failure rate on a stable staging site.
- News Review: given a URL, produce a structured brief with summary, entities, verdict, confidence.
- All runs have artifacts (screenshot + HTML) and structured logs; errors are retryable; secrets are masked.

---

## 17) API & Integration Hooks
- **Webhooks:** `run.completed`, `run.failed`, `news.verdict`.
- **Exports:** JSON/CSV for results; optional Google Sheets/Notion connectors (modular).
- **CLI:** `auto run task.yaml --vars file=leads.csv --headless`.

---

## 18) Future Enhancements
- Visual selector picker (record steps by clicking in an embedded browser).
- Vision model for element detection when selectors are brittle.
- Multi‑tab orchestration; parallelism with resource quotas.
- Role‑based access control and workspace sharing.
- Policy engine: disallow posting to external sites unless explicitly approved.

---

## 19) Site‑Specific MVP: Suramadu "Pengadilan Berita" Auto‑Review

### 19.1 Overview
Automate review/confirmation of news items on **suramadu.pta-surabaya.go.id**. The app logs in, opens the **Superuser → Pengadilan Berita** list, iterates items with status **Belum Dikonfirmasi**, opens each item, loads the content, evaluates it against the eight policy checks below, and then either **Konfirmasi** or **Tolak** with reasons. Repeat until no pending items remain.

> **Important**: Use only if you are authorized to operate this account and the website’s ToS permits this automation. Add the domain to the app’s allowlist.

### 19.2 Credentials & Security
- Store credentials as secrets (do **not** hardcode in code/logs). For local dev, use `.env` (masked in logs); for prod, use OS keychain or KMS.
- **Provided by user:**
  ```env
  SURAMADU_USERNAME=200102252025061007
  SURAMADU_PASSWORD=200102252025061007
  ```
- Bind to the Task DSL as `{{secrets.SURAMADU_USERNAME}}` and `{{secrets.SURAMADU_PASSWORD}}`.

### 19.2.1 Login Page Elements & Steps (/auth/masuk)
**Form Markup (provided):** `form#form-login` with fields `input[name="nip"]`, `input[name="pass"]`, and `button[type="submit"]` labeled **Sign In**.

**Playwright snippet:**
```ts
await page.goto('https://suramadu.pta-surabaya.go.id/auth/masuk', { waitUntil: 'domcontentloaded' });
await page.locator('form#form-login input[name="nip"]').fill(process.env.SURAMADU_USERNAME!);
await page.locator('form#form-login input[name="pass"]').fill(process.env.SURAMADU_PASSWORD!);
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.locator('form#form-login button[type="submit"]:has-text("Sign In")').click(),
]);
// Optional: verify login success or handle error
const loginError = page.locator('.alert, .invalid-feedback, .text-danger');
if (await loginError.first().isVisible()) throw new Error('Login failed: invalid credentials or server error');
```

> Tip: prefer form‑scoped selectors to avoid collisions with similarly named inputs elsewhere.

### 19.3 Navigation & Selectors (assumptions)
- **Login URL**: `https://suramadu.pta-surabaya.go.id/auth/masuk`
- **List URL**: `https://suramadu.pta-surabaya.go.id/superuser/pengadilan_berita`
- Use accessible/name or text locators whenever possible, with fallbacks:
  - Username: `getByLabel(/username|email|akun/i)` → fallback: `input[type="text"]:below(label:has-text("User"))`
  - Password: `getByLabel(/password|kata sandi/i)` → fallback: `input[type="password"]`
  - Login button: `getByRole('button', { name: /masuk|login|sign in/i })`
  - Table rows with pending status: `tr:has(td:has-text("Belum Dikonfirmasi"))`
  - Row **Aksi** button: within the same row, `getByRole('button', { name: /aksi|action|detail/i })`
  - Detail/Confirm buttons: `getByRole('button', { name: /konfirmasi/i })`, `getByRole('button', { name: /tolak/i })`
  - **Deskripsi** field container: `section:has(h2:has-text("Deskripsi"))`, fallback: `[data-field="deskripsi"], .deskripsi, #deskripsi`

### 19.4 Loop Algorithm (TypeScript pseudocode)
```ts
async function processPendingNews(page: Page, maxPages = 10) {
  await page.goto('https://suramadu.pta-surabaya.go.id/');
  await page.getByRole('textbox').first().fill(process.env.SURAMADU_USERNAME!);
  await page.getByRole('textbox', { name: /password|kata sandi/i }).fill(process.env.SURAMADU_PASSWORD!);
  await page.getByRole('button', { name: /login|masuk|sign in/i }).click();
  await page.waitForLoadState('networkidle');

  for (let p = 0; p < maxPages; p++) {
    await page.goto('https://suramadu.pta-surabaya.go.id/superuser/pengadilan_berita');
    await page.waitForLoadState('domcontentloaded');

    const pendingRows = page.locator('tr:has(td:has-text("Belum Dikonfirmasi"))');
    const count = await pendingRows.count();
    if (count === 0) break;

    for (let i = 0; i < count; i++) {
      const row = pendingRows.nth(i);
      const aksiBtn = row.getByRole('button', { name: /aksi|action|detail/i });
      await aksiBtn.click();

      // Wait detail view loaded
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('section:has-text("Deskripsi")', { timeout: 10000 }).catch(() => {});

      const { text, images, eventDate } = await extractNews(page);
      const evalResult = await evaluateAgainstPolicy(text, images, eventDate);

      if (evalResult.violations.length === 0) {
        await page.getByRole('button', { name: /konfirmasi/i }).click();
        await page.waitForLoadState('networkidle');
      } else {
        await page.getByRole('button', { name: /tolak/i }).click();
        const reasonBox = page.getByRole('textbox', { name: /alasan|deskripsi|keterangan/i });
        await reasonBox.fill(formatRejection(evalResult.violations));
        await page.getByRole('button', { name: /kirim|submit|simpan/i }).click();
        await page.waitForLoadState('networkidle');
      }
    }
  }
}
```

### 19.5 Policy Checks (map to user’s 8 items)
**We treat each bullet as a *violation*. If any violation is present → Tolak; otherwise → Konfirmasi.**

1) **Bahasa & Jurnalistik Tidak Baik/Benar**  
   - Detect language; violation if not **Indonesian**.  
   - Optionally run an LLM grammar/style rubric (score < threshold → violation).

2) **Tidak Mengandung 5W+1H**  
   - Heuristics + LLM to test presence of: What/Siapa/Kapan/Di mana/Mengapa/Bagaimana.  
   - Violation if ≥2 elements missing or confidence low.

3) **Bukan 4 Paragraf Layak**  
   - Parse paragraphs; require **≥4** paragraphs, each **≥3–4 sentences**.  
   - Violation if count/length below thresholds.

4) **Foto Tidak Mencukupi (2, unik)**  
   - Require **≥2 images**: cover + body; ensure different `src` and not identical hash/size.  
   - Violation if <2 or duplicates.

5) **Tidak Ada Foto via imgbb/hosting untuk Gandrung**  
   - Violation if no image URL from **imgbb.com** or configured hosting allowlist supplying a direct link for Gandrung.

6) **Tidak Up-to-date (Max H+1 hari kerja)**  
   - Extract event date from content/meta.  
   - Compute business-day delta (Asia/Jakarta).  
   - Violation if delta > 1 working day.

7) **Tidak Informatif / Hanya Kegiatan Rutin**  
   - Keyword rules (apel, briefing, coffee morning, senam/olahraga, kerja bakti, istighosah/kultum/Jumat berkah, perawatan sarpras, tupoksi harian) + LLM informativeness score.  
   - Violation if classified as routine/low‑info.

8) **Tidak Ada Kutipan/Pesan**  
   - Detect quotes or verbs: *kata, ujar, menyampaikan, menuturkan, menjelaskan*.  
   - Violation if no explicit quote/message found.

**Rejection message format (example)**
```
Ditolak karena tidak memenuhi persyaratan: [#2 5W+1H], [#3 Paragraf], [#6 Up to date].
```

#### 19.5.B Status Radio Controls (Konfirmasi/Ditolak)
**Context:** On the confirmation page (`/superuser/pengadilan_berita/konfirmasi/{nomor}/{judul}`) the decision is made via **radio inputs**:
```html
<div class="icheck-material-success icheck-inline">
  <input type="radio" id="inline-radio-success" name="status" value="1">
  <label for="inline-radio-success">Konfirmasi</label>
</div>
<div class="icheck-material-danger icheck-inline">
  <input type="radio" id="inline-radio-danger" name="status" value="2">
  <label for="inline-radio-danger">Ditolak</label>
</div>
```

**Selectors:**
- Konfirmasi: `input[name="status"][value="1"]` or `label[for="inline-radio-success"]`
- Ditolak: `input[name="status"][value="2"]` or `label[for="inline-radio-danger"]`
- Submit: `button:has-text("Mengubah Berita"), button:has-text("Simpan"), button:has-text("Submit"), button[type="submit"]`

**Playwright snippet:**
```ts
// Choose outcome based on evaluation
if (evalResult.violations.length === 0) {
  await page.locator('input[name="status"][value="1"]').check(); // Konfirmasi
} else {
  await page.locator('input[name="status"][value="2"]').check(); // Ditolak
  // Fill reason textarea if present
  const reason = formatRejection(evalResult.violations);
  const reasonBox = page.locator('textarea, [role="textbox"]');
  if (await reasonBox.first().isVisible()) await reasonBox.fill(reason);
}

// Verify radio state before submit (defensive)
await expect(page.locator(`input[name="status"][value="${evalResult.violations.length===0?1:2}"]`)).toBeChecked();

// Submit decision
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.locator('button:has-text("Simpan"), button:has-text("Submit"), button[type="submit"]').first().click(),
]);
```

**DSL branch alternative (uses radios instead of buttons):**
```yaml
- branch:
    when: "{{ai.ok}}"  # ok = meets all 8 requirements
    then:
      - check: { selector: "input[name='status'][value='1']" }   # Konfirmasi
      - click: { selector: "button:has-text('Simpan'), button:has-text('Submit'), button[type='submit']" }
    else:
      - check: { selector: "input[name='status'][value='2']" }   # Ditolak
      - type:  { selector: "textarea, [role=textbox]", value: "{{ai.rejection_message_id}}" }
      - click: { selector: "button:has-text('Simpan'), button:has-text('Submit'), button[type='submit']" }
```

> **Note:** Keep both the **button-based** and **radio-based** flows in the library and select at runtime by probing which elements exist. This protects against UI changes.

#### 19.5.C Submit Controls (Mengubah Berita / Batalkan)
**Context:** Setelah memilih status (radio **Konfirmasi/Ditolak**) dan mengisi alasan (jika Ditolak), pengiriman keputusan dilakukan melalui tombol submit di area `.col-sm-10`.

**Markup (disediakan):**
```html
<button type="submit" class="btn btn-white btn-round px-5">Mengubah Berita<i class="icon-lock"></i></button>
<a href="javascript:void(0)" onclick="window.history.back();" class="btn btn-danger btn-round waves-effect waves-light m-1">Batalkan</a>
```

**Selectors:**
- Submit (utama): `button:has-text("Mengubah Berita")`
- Submit (fallback): `button[type="submit"]`
- Cancel: `a.btn.btn-danger.btn-round`

**Playwright snippet:**
```ts
// Submit decision
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.getByRole('button', { name: /Mengubah Berita/i }).click()
  .catch(() => page.locator('button[type="submit"]').first().click())
]);

// Optional: confirm success (toast/redirect)
await page.locator('.alert-success, .toast-success, .swal2-success').first().waitFor({ timeout: 5000 }).catch(() => {});

// Cancel (if user chose to back out)
// await page.locator('a.btn.btn-danger.btn-round').click();
```

**DSL snippet:**
```yaml
- click: { selector: "button:has-text('Mengubah Berita'), button[type='submit']" }
- wait_for: { state: "networkidle" }
```

**Notes:**
- Beberapa UI menampilkan *ikon* di dalam tombol; gunakan pencarian berbasis **text** agar robust.
- Tambahkan guard agar tidak double-submit (disable tombol setelah klik atau cek spinner).

#### 19.5.D Gemini (Google) AI Integration for Policy Checks
**Purpose:** Use Google Gemini to judge whether the **Deskripsi** meets the 8 requirements. We combine deterministic heuristics (paragraph count, image hosts, event date) with an LLM verdict to reduce false positives.

**Dependencies (Node):**
```bash
npm i @google/generative-ai zod date-fns date-fns-tz
```

**Secrets (.env):**
```env
# Provided by user — store securely, do not commit
GEMINI_API_KEY=AIzaSyBLG25ZOThGPtmZmH3N5SyDA7VQXWmwotE
```

**Service (TypeScript):**
```ts
// src/ai/geminiNewsPolicy.ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";

const schema = z.object({
  verdict: z.enum(["WORTH", "BORDERLINE", "NOT_WORTH"]).describe("Overall decision"),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
  checks: z.object({
    bahasa_jurnalistik_ok: z.boolean(),
    fiveW1H_ok: z.boolean(),
    paragraphs_ok: z.boolean(),
    photos_ok: z.boolean(),
    photo_host_ok: z.boolean(),
    up_to_date_ok: z.boolean(),
    informative_ok: z.boolean(),
    has_quote_ok: z.boolean(),
    missing_5w1h: z.array(z.string()).default([])
  })
});

export type GeminiVerdict = z.infer<typeof schema>;

const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro"; // or gemini-1.5-flash for speed

export async function geminiEvaluateNews(input: {
  text: string;           // plain text (from Deskripsi)
  html?: string;          // raw HTML if available
  signals: {              // deterministic pre-checks from app
    paragraphs: number;
    minSentencesPerParagraph: number;
    imageCount: number;
    allowedHostImageCount: number;
    eventDateISO?: string; // extracted event date if known
    nowISO: string;        // now in Asia/Jakarta
    routineKeywordsHit?: string[];
  };
}): Promise<GeminiVerdict> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({ model: MODEL });

  const prompt = `You are a strict Indonesian news editor. Judge if a news DESKRIPSI fulfills 8 requirements.

REQUIREMENTS (all must pass):
1) Bahasa Indonesia & journalism quality are proper.
2) Contains 5W+1H (What, Who, When, Where, Why, How).
3) At least 4 paragraphs; each paragraph has 3-4+ sentences.
4) At least 2 real, distinct photos (cover + body).
5) Photo host must be on an allowlist (e.g., imgbb.com / i.ibb.co).
6) Up-to-date: published event date is no later than H+1 working day from the event.
7) Informative (not merely routine like apel/briefing/coffee morning/senam/kerja bakti/istighosah/kultum/Jumat berkah/perawatan sarpras/tupoksi harian).
8) Contains at least one quote/message from a speaker.

You will receive deterministic SIGNALS from our heuristics. Use them as ground truth for counts/hosts/dates when reasonable, but still read the text to verify context.

Return strict JSON only (no markdown). Fields: {verdict: WORTH|BORDERLINE|NOT_WORTH, confidence: 0..1, reasons: string[], checks: {bahasa_jurnalistik_ok, fiveW1H_ok, paragraphs_ok, photos_ok, photo_host_ok, up_to_date_ok, informative_ok, has_quote_ok, missing_5w1h: string[]}}.`;

  const content = [
    { role: "user", parts: [{ text: prompt }] },
    { role: "user", parts: [{ text: `TEXT:
${input.text}
` }] },
    { role: "user", parts: [{ text: `SIGNALS:
${JSON.stringify(input.signals)}
` }] },
  ];

  const res = await model.generateContent({
    contents: content,
    generationConfig: { temperature: 0.2, maxOutputTokens: 512, responseMimeType: "application/json" },
  });

  const json = JSON.parse(res.response.text());
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Gemini JSON parse failed: ${parsed.error.toString()}`);
  }
  return parsed.data;
}
```

**Mapping Gemini → App policy:**
```ts
function mapGeminiToViolations(g: GeminiVerdict): string[] {
  const v: string[] = [];
  if (!g.checks.bahasa_jurnalistik_ok) v.push('#1 Bahasa/Jurnalistik');
  if (!g.checks.fiveW1H_ok) v.push('#2 5W+1H');
  if (!g.checks.paragraphs_ok) v.push('#3 Paragraf');
  if (!g.checks.photos_ok) v.push('#4 Foto');
  if (!g.checks.photo_host_ok) v.push('#5 Hosting Foto');
  if (!g.checks.up_to_date_ok) v.push('#6 Up to date');
  if (!g.checks.informative_ok) v.push('#7 Informatif');
  if (!g.checks.has_quote_ok) v.push('#8 Kutipan');
  return v;
}
```

**Agent Tool binding:**
- Tool name: `news_policy_suramadu_v1`
- Implementation: call `geminiEvaluateNews()` with extracted `text/html` + `signals`.
- Output contract for DSL `ai_evaluate` step:
```json
{
  "ok": true,                       // true if violations.length === 0
  "violations": ["#2 5W+1H", "#5 Hosting Foto"],
  "confidence": 0.82,
  "reasons": ["Missing WHY/HOW","Images not from allowed host"]
}
```

**Runtime safeguards:**
- Timeout 15s; 1 retry on `UNAVAILABLE`/429; exponential backoff.
- Redact credentials and PII from prompts; never send cookies or secrets.
- Log only the size of text, not the full body (store in artifacts if needed).

**Cost/latency:** Use `gemini-1.5-flash` for queue sweeps; escalate to `1.5-pro` when borderline (e.g., confidence 0.4–0.6).

**DSL usage (no change):**
```yaml
- ai_evaluate:
    using: "news_policy_suramadu_v1"
    inputs:
      text_selector: "section:has-text('Deskripsi'), [data-field='deskripsi'], .deskripsi, #deskripsi"
      image_selector: "img"
```

---

#### 19.5.E Rejection Reason Text (Bahasa Indonesia)
**Kebutuhan:** Bila hasil evaluasi (Gemini + heuristik) menetapkan **Ditolak**, aplikasi **wajib mengisi** kolom alasan/penjelasan di halaman konfirmasi dengan **teks Bahasa Indonesia** yang merangkum faktor-faktor yang **tidak terpenuhi** dari 8 persyaratan.

**Pemetaan faktor → label Indonesia (standar):**
- **#1 Bahasa/Jurnalistik:** "1. Tidak menggunakan Bahasa Indonesia dan jurnalistik yang baik dan benar."
- **#2 5W+1H:** "2. Tidak ada unsur yang mengandung 5W + 1H berita (What, Who, When, Why, Where & How)."
- **#3 Paragraf:** "3. Tidak berisi 4 paragraf (1 paragraf berisi minimal 3–4 kalimat)."
- **#4 Foto:** "4. Tidak mencukupi 2 foto (1 untuk cover, 1 untuk isi berita, rill & tidak boleh sama)."
- **#5 Hosting Foto:** "5. Tidak ada foto yang diupload di website imgbb/web hosting lainnya agar mendapatkan link yang dapat dibaca di Aplikasi Gandrung (cara terlampir)."
- **#6 Up to date:** "6. Berita tidak up to date (Max H+1 hari kerja dari kegiatan/acara/event tersebut)."
- **#7 Informatif:** "7. Berita tidak informatif (selain kegiatan rutin/biasa seperti apel/briefing, coffee morning, senam/olahraga/kerja bakti, istighosah/kultum/Jumat berkah, perawatan sarana prasarana, tupoksi personal sehari-hari, dsb)."
- **#8 Kutipan:** "8. Tidak ada minimal satu pesan/kutipan sambutan/pemateri/narsum atau sejenisnya."

**Format pesan yang diisikan (disarankan):**
```
Berita ditolak karena tidak memenuhi persyaratan berikut:
- [daftar poin pelanggaran dari 1 s.d. 8]
Rincian:
- (opsional) Unsur 5W+1H yang belum ada: ...
- (opsional) Paragraf: X paragraf; minimal 4 paragraf, tiap paragraf ≥ 3 kalimat.
- (opsional) Foto ditemukan: Y; host yang diizinkan: imgbb.com / i.ibb.co.
- (opsional) Tanggal kegiatan: dd mmmm yyyy; melebihi H+1 hari kerja.
Silakan perbaiki sesuai poin di atas lalu ajukan kembali.
```

**Generator alasan (TypeScript):**
```ts
// src/lib/rejectionText.ts
import { format } from "date-fns";
import { id } from "date-fns/locale";

export function formatRejectionID(opts: {
  violations: string[];             // ['#2 5W+1H', '#5 Hosting Foto']
  details?: {
    missing5w1h?: string[];
    paragraphs?: number;
    minSentencesPerParagraph?: number;
    imageCount?: number;
    allowedHostImageCount?: number;
    disallowedHosts?: string[];
    eventDate?: Date;
    now?: Date;
  };
}): string {
  const m: Record<string,string> = {
    '#1 Bahasa/Jurnalistik': '1. Tidak menggunakan Bahasa Indonesia dan jurnalistik yang baik dan benar.',
    '#2 5W+1H': '2. Tidak ada unsur yang mengandung 5W + 1H berita (What, Who, When, Why, Where & How).',
    '#3 Paragraf': '3. Tidak berisi 4 paragraf (1 paragraf berisi minimal 3–4 kalimat).',
    '#4 Foto': '4. Tidak mencukupi 2 foto (1 untuk cover, 1 untuk isi berita, rill & tidak boleh sama).',
    '#5 Hosting Foto': '5. Tidak ada foto yang diupload di website imgbb/web hosting lainnya agar mendapatkan link yang dapat dibaca di Aplikasi Gandrung (cara terlampir).',
    '#6 Up to date': '6. Berita tidak up to date (Max H+1 hari kerja dari kegiatan/acara/event tersebut).',
    '#7 Informatif': '7. Berita tidak informatif (selain kegiatan rutin/biasa seperti apel/briefing, coffee morning, senam/olahraga/kerja bakti, istighosah/kultum/Jumat berkah, perawatan sarana prasarana, tupoksi personal sehari-hari, dsb).',
    '#8 Kutipan': '8. Tidak ada minimal satu pesan/kutipan sambutan/pemateri/narsum atau sejenisnya.'
  };
  const lines = opts.violations.map(v => m[v] || v);
  const extra: string[] = [];
  const d = opts.details || {};
  if (opts.violations.includes('#2 5W+1H') && d.missing5w1h?.length) extra.push(`- Unsur 5W+1H yang belum ada: ${d.missing5w1h.join(', ')}`);
  if (opts.violations.includes('#3 Paragraf') && (d.paragraphs!=null || d.minSentencesPerParagraph!=null)) extra.push(`- Paragraf: ${d.paragraphs ?? '-'}; minimal 4 paragraf, tiap paragraf ≥ 3 kalimat.`);
  if (opts.violations.includes('#4 Foto') && d.imageCount!=null) extra.push(`- Foto ditemukan: ${d.imageCount}; minimal 2 dan harus unik.`);
  if (opts.violations.includes('#5 Hosting Foto')) {
    if (d.allowedHostImageCount!=null) extra.push(`- Foto dari host yang diizinkan: ${d.allowedHostImageCount} (disarankan imgbb.com / i.ibb.co).`);
    if (d.disallowedHosts?.length) extra.push(`- Host di luar daftar: ${Array.from(new Set(d.disallowedHosts)).join(', ')}`);
  }
  if (opts.violations.includes('#6 Up to date') && d.eventDate) extra.push(`- Tanggal kegiatan: ${format(d.eventDate, 'd MMMM yyyy', { locale: id })}.`);

  return [
    'Berita ditolak karena tidak memenuhi persyaratan berikut:',
    ...lines.map(l => `- ${l}`),
    (extra.length ? 'Rincian:' : ''),
    ...extra,
    'Silakan perbaiki sesuai poin di atas lalu ajukan kembali.'
  ].filter(Boolean).join('
');
}
```

**Selector alasan (umum, fallback):**
- `textarea[name="keterangan"]`, `textarea[name*="alasan"]`, `textarea`, `[role="textbox"]`

**Playwright pengisian alasan:**
```ts
if (evalResult.violations.length > 0) {
  const reasonText = formatRejectionID({
    violations: evalResult.violations,
    details: evalResult.details // isi dari extractor/LLM (optional)
  });
  const reasonBox = page.locator("textarea[name='keterangan'], textarea[name*='alasan'], textarea, [role='textbox']").first();
  if (await reasonBox.isVisible()) {
    await reasonBox.fill(reasonText);
  }
}
```

**Integrasi ke DSL (mengganti value alasan):**
```yaml
- branch:
    when: "{{ai.ok}}"
    then:
      - check: { selector: "input[name='status'][value='1']" }
    else:
      - check: { selector: "input[name='status'][value='2']" }
      - type:  { selector: "textarea, [role=textbox]", value: "{{ai.rejection_message_id}}" }
      - click: { selector: "button:has-text('Mengubah Berita'), button:has-text('Kirim'), button:has-text('Submit'), button:has-text('Simpan')" }
```

> **Catatan:** `{{ai.rejection_message_id}}` adalah pesan Indonesia yang dihasilkan dari gabungan hasil Gemini + heuristik (lihat 19.5.D dan helper `formatRejectionID`).

### 19.6 Extract & Evaluate Helpers (sketch)
```ts
async function extractNews(page: Page) {
  const text = await page.locator('section:has-text("Deskripsi"), [data-field="deskripsi"], .deskripsi, #deskripsi').innerText().catch(() => '');
  const images = await page.locator('img').evaluateAll(imgs => imgs.map(i => ({src: i.getAttribute('src') || '', alt: i.getAttribute('alt') || ''}))); 
  const eventDate = await guessEventDate(text, page);
  return { text, images, eventDate };
}

async function evaluateAgainstPolicy(text: string, images: {src:string}[], eventDate?: Date) {
  const violations: string[] = [];
  if (!(await isIndonesian(text)) || (await journalismScore(text)) < 0.6) violations.push('#1 Bahasa/Jurnalistik');
  const wChecklist = await fiveWOneH(text);
  if (wChecklist.missing.length >= 2) violations.push('#2 5W+1H');
  const p = paragraphStats(text);
  if (p.paragraphs < 4 || p.minSentencesPerParagraph < 3) violations.push('#3 Paragraf');
  if (!hasTwoDistinctImages(images)) violations.push('#4 Foto');
  if (!hasImgbbOrAllowedHost(images)) violations.push('#5 Hosting Foto');
  if (!isUpToDate(eventDate, 1)) violations.push('#6 Up to date');
  if (!(await isInformative(text))) violations.push('#7 Informatif');
  if (!hasQuote(text)) violations.push('#8 Kutipan');
  return { violations };
}
```

$1
name: "Suramadu Auto-Review Berita"
setup:
  - navigate: "https://suramadu.pta-surabaya.go.id/auth/masuk"
  - type: { selector: "form#form-login input[name='nip']", value: "{{secrets.SURAMADU_USERNAME}}" }
  - type: { selector: "form#form-login input[name='pass']", value: "{{secrets.SURAMADU_PASSWORD}}" }
  - click: { selector: "form#form-login button[type='submit']:has-text(\"Sign In\")" }
  - wait_for: { state: "networkidle" }
loop:
  while: { url: "https://suramadu.pta-surabaya.go.id/superuser/pengadilan_berita" }
  steps:
    - navigate: "https://suramadu.pta-surabaya.go.id/superuser/pengadilan_berita"
    - wait_for: { state: "domcontentloaded" }
    - foreach:
        selector: "tr:has(td:has-text('Belum Dikonfirmasi'))"
        steps:
          - in_row_click: { selector: "button:has-text('Aksi'), a:has-text('Detail')" }
          - wait_for: { selector: "section:has-text('Deskripsi')", timeoutMs: 10000 }
          - ai_evaluate:
              using: "news_policy_suramadu_v1"
              inputs:
                text_selector: "section:has-text('Deskripsi'), [data-field='deskripsi'], .deskripsi, #deskripsi"
                image_selector: "img"
          - branch:
              when: "{{ai.ok}}"
              then:
                - click: { selector: "button:has-text('Konfirmasi')" }
              else:
                - click: { selector: "button:has-text('Tolak')" }
                - type: { selector: "textarea, [role=textbox]", value: "{{ai.rejection_message_id}}" }
                - click: { selector: "button:has-text('Kirim'), button:has-text('Submit'), button:has-text('Simpan')" }
          - wait_for: { state: "networkidle" }
    - assert:
        empty_selector: "tr:has(td:has-text('Belum Dikonfirmasi'))"
    - break_if: { selector_empty: "tr:has(td:has-text('Belum Dikonfirmasi'))" }
$2

### 19.8 Observability & Safety for this Flow
- Save a screenshot + HTML for each processed item.  
- Log decisions with extracted signals (paragraph counts, quote presence, image hosts, event date).  
- Throttle actions; respect server rate limits.  
- Session expiry handler: detect redirected login; re‑authenticate once.

### 19.9 Scheduling
- Suggested: every 30–60 minutes during work hours (Asia/Jakarta). Use randomized jitter. Pause outside allowed windows.

---

## 20) AI Coder Prompt Packs

> Copy‑paste one **Stage** at a time into AI Coder. Each has Goal, Prompt, and Acceptance so you can iterate safely without hitting token limits.

### Stage 0 — Repo Scaffold (Node + TS + Playwright)
**Goal:** Initialize CLI project.
**Prompt:**
```
Create a Node 20 + TypeScript project scaffold for a CLI automation app.

Requirements:
- Tooling: ts-node, tsup (build), eslint+prettier, dotenv, npm scripts.
- Add Playwright (chromium) and @playwright/test for local runs.
- Project structure:
  /src/index.ts            // entrypoint CLI
  /src/lib/browserTools.ts // wrapper Playwright actions
  /src/lib/logger.ts       // structured logger
  /src/types.ts            // shared types
  /src/config.ts           // env loader (dotenv)
  /scripts/dev-run.ts      // dev helper
- NPM scripts: dev, build, start, test, pw:install
- Add .env.example with placeholders.
- Do NOT implement site logic yet.

Deliverables: package.json, tsconfig.json, eslint+prettier configs, source files with TODOs.
Acceptance: `npm i && npm run pw:install && npm run dev` prints "OK scaffold".
```

### Stage 1 — Browser Tools Wrapper
**Goal:** Stable API on top of Playwright.
**Prompt:**
```
Implement /src/lib/browserTools.ts that wraps Playwright.
APIs: navigate, type(mode: clear|append), click, check, select, waitFor({state|selector|timeoutMs}), extractText, saveHtml, screenshot.
Prefer getByRole/getByText; explicit waits; optional screenshot-on-error.
Update index.ts demo: open example.com and save /artifacts/demo.png.
Acceptance: demo runs reliably.
```

### Stage 2 — Minimal Task DSL (YAML) & Executor
**Prompt:**
```
Add YAML DSL + executor.
Files: /src/dsl/schema.ts, /src/dsl/runner.ts, /examples/hello.yaml
Supported steps: navigate, type, click, wait_for, assert(contains_text|empty_selector), artifact(screenshot|html)
CLI: `npm run dev -- examples/hello.yaml`
Acceptance: hello.yaml executes successfully.
```

### Stage 3 — Login Suramadu (/auth/masuk)
**Prompt:**
```
Create /examples/suramadu-login.yaml to log in to https://suramadu.pta-surabaya.go.id/auth/masuk.
Selectors:
- form#form-login input[name="nip"]
- form#form-login input[name="pass"]
- form#form-login button[type="submit"]:has-text("Sign In")
Use env: SURAMADU_USERNAME, SURAMADU_PASSWORD.
Add wait_for: { state: "networkidle" } after submit.
Acceptance: fields filled and submitted without errors.
```

### Stage 4 — List Scan & Row Action
**Prompt:**
```
Extend DSL with foreach + in_row_click.
foreach.selector: "tr:has(td:has-text('Belum Dikonfirmasi'))"
in_row_click: "button:has-text('Aksi'), a:has-text('Detail')" relative to row
Create /examples/suramadu-scan.yaml: login -> navigate to /superuser/pengadilan_berita -> iterate rows.
Acceptance: handles zero rows gracefully.
```

### Stage 5 — Extract Deskripsi (CKEditor) & Signals
**Prompt:**
```
Add /src/lib/newsExtract.ts with extractNews(page) -> { html, text, images[{src,alt}], eventDate? }.
Prefer textarea#editor[name="deskripsi"] value; fallback .ck-editor__editable innerHTML/innerText.
Compute signals: paragraphCount, minSentencesPerParagraph, imageCount, allowedHostCount (allowlist: i.ibb.co, imgbb.com). Catch typos like i.ibb.co.com.
Create /examples/suramadu-extract.yaml that dumps JSON to /artifacts/extract.json.
Acceptance: JSON contains expected fields.
```

### Stage 6 — Local Policy Heuristics (8 Rules)
**Prompt:**
```
Add /src/lib/policyLocal.ts
API: evaluateAgainstPolicy({ text, images, eventDate, signals, nowJkt }) => { violations: string[], details }
Rules:
#1 Indonesian + simple style score; #2 5W1H present (missing >=2 => violation);
#3 >=4 paragraphs & each >=3 sentences; #4 >=2 distinct images; #5 host allowlist;
#6 up-to-date H+1 working day (Asia/Jakarta); #7 not routine-only; #8 has quote verbs.
Wire temporary ai_evaluate to call local policy returning { ok, violations[], reasons[], confidence }.
Acceptance: unit tests for paragraphs, host check, H+1 logic.
```

### Stage 7 — Google Gemini Integration
**Prompt:**
```
Install: @google/generative-ai zod date-fns date-fns-tz
Files: /src/ai/geminiNewsPolicy.ts (JSON-only, schema-validated), /src/lib/policyLLM.ts.
.env: GEMINI_API_KEY=...
Modify ai_evaluate to call Gemini with { text, html?, signals }; fallback to local on error.
Timeout 15s, 1 retry on 429/UNAVAILABLE; redact PII.
Acceptance: with mocked Gemini JSON, violations map correctly.
```

### Stage 8 — Decision Radios & Submit
**Prompt:**
```
Add runner step decision_apply with:
 ok_selector: "input[name='status'][value='1']"
 reject_selector: "input[name='status'][value='2']"
 reason_selector: "textarea, [role=textbox]"
 submit_selector: "button:has-text('Mengubah Berita'), button[type='submit']"
 decision_source: "{{ai.ok}}"
 reason_source:  "{{ai.rejection_message_id}}"
Verify chosen radio is checked; wait networkidle after submit.
Acceptance: works with/without reason box.
```

### Stage 9 — Full Loop, Artifacts, Idempotency
**Prompt:**
```
Create /examples/suramadu-auto-review.yaml:
- login -> navigate list -> foreach pending -> open -> wait -> extract -> ai_evaluate -> decision_apply
- assert: empty_selector "tr:has(td:has-text('Belum Dikonfirmasi'))"
- break_if: selector_empty same as above
Executor: retry transient errors, save screenshot+HTML per item to /artifacts/runs/<runId>/, mask secrets, support --dry-run.
Acceptance: dry-run prints planned actions; normal run saves artifacts.
```

### Stage 10 — Scheduler & Observability
**Prompt:**
```
Add /src/scheduler.ts to run a task every N minutes (env), work-hours Asia/Jakarta, with jitter.
Webhook stubs: run.completed, run.failed.
Logger: JSON logs with taskId, runId, step, latencyMs; end-of-run summary.
Acceptance: `npm run start` schedules and runs; ctrl+c clean shutdown.
```

### Stage 11 — (Optional) Tauri Shell
**Prompt:**
```
Create minimal Tauri shell (React) to pick YAML, run, view last 20 logs, open artifacts folder.
Logic stays in Node service; UI is thin.
Acceptance: Build launches; triggering run invokes Node CLI.
```

---

## 21) Glossary
- **Task DSL:** Human‑readable plan that the Orchestrator compiles into browser actions.
- **Artifact:** Any output captured during a run (screenshot, HTML, JSON).
- **Verdict:** AI decision for a news item (WORTH/BORDERLINE/NOT_WORTH).

