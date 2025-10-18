/**
 * Handles prompting Google Gemini with structured article data to obtain
 * policy decisions. Builds the JSON prompt, enforces schema validation, retries
 * across model candidates, and merges Gemini responses with deterministic
 * image-hosting checks.
 */
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const geminiResponseSchema = z.object({
  ok: z.boolean().optional(),
  violations: z.array(z.string()).optional().default([]),
  reasons: z.array(z.string()).optional().default([]),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  rejection_message_id: z.string().optional(),
  rejection_message: z.string().optional(),
});

export type GeminiPolicyPayload = z.infer<typeof geminiResponseSchema>;

export interface GeminiPolicyInput {
  apiKey: string;
  text: string;
  html?: string;
  signals: {
    paragraphCount: number;
    minSentencesPerParagraph: number;
    imageCount: number;
    allowedHostCount: number;
    hostedImageCount: number;
    sentenceCount: number;
    eventDateISO?: string;
    evaluationDateISO?: string;
    evaluationDateLabel?: string;
  };
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface GeminiPolicyCallOptions {
  retries?: number;
  model?: string;
}

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = resolveDefaultTimeout();

const IMAGE_RULE_LABEL = '#I1 Foto Hosting';
const IMAGE_RULE_REASON =
  'Berita harus menyertakan foto yang diunggah melalui imgbb atau layanan hosting eksternal. Tidak ditemukan foto dari layanan hosting tersebut.';

const TEXT_RULE_DEFINITIONS = [
  '1. Tidak menggunakan Bahasa Indonesia (laporkan sebagai "#T1 Bahasa/Jurnalistik").',
  '2. Tidak ada unsur kapan, dimana, dan siapa pada berita (laporkan sebagai "#T2 Unsur Waktu/Lokasi/Pelaku").',
  '3. Jumlah kalimat informatif kurang dari 12 (laporkan sebagai "#T3 Jumlah Kalimat").',
  '4. Berita diupload lebih lama dari hari kemarin (hari sabtu minggu tidak dihitung) (laporkan sebagai "#T4 Up to date").',
  '5. Berita tidak informatif (kegiatan rutin biasa seperti apel, briefing, coffee morning, senam, olahraga, kerja bakti, kultum, jumat berkah) (laporkan sebagai "#T5 Informatif").',
  '6. Bila penilaian dilakukan pada hari Sabtu atau Minggu maka berita kegiatan pada hari Kamis dan Jumat tetap dianggap up to date dan jangan dilaporkan sebagai "#T4 Up to date".',
].join('\n');

/**
 * Invoke Gemini with a resilience strategy (timeouts, retries, model fallback)
 * and return a normalized payload that adheres to the expected schema.
 */
export async function callGeminiPolicy(
  input: GeminiPolicyInput,
  options: GeminiPolicyCallOptions = {},
): Promise<GeminiPolicyPayload> {
  const { apiKey, text, html, signals, abortSignal } = input;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required');
  }

  const client = new GoogleGenAI({ apiKey });
  const sanitizedText = redactPii(text);
  const imageValidation = validateImageSignals(signals);
  const payload = buildPromptPayload(sanitizedText, html, signals);
  const retries = options.retries ?? 1;

  let lastError: unknown;
  const modelCandidates = resolveModelCandidates(options.model);

  for (const modelName of modelCandidates) {
    const normalizedModel = normalizeModelName(modelName);
    let attempt = 0;

    while (attempt <= retries) {
      const controller = new AbortController();
      const signal = mergeAbortSignals(abortSignal, controller.signal);

      try {
        const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const result = await withTimeout(
          attachAbortSignal(
            client.models.generateContent({
              model: normalizedModel,
              contents: [
                {
                  role: 'user',
                  parts: [{ text: payload }],
                },
              ],
              config: {
                responseMimeType: 'application/json',
              },
            }),
            signal,
          ),
          timeout,
          controller,
        );

        const responseText = extractTextFromResponse(result);
        if (!responseText) {
          throw new Error('Gemini returned empty response');
        }

        const parsed = geminiResponseSchema.parse(JSON.parse(responseText));
        parsed.violations = parsed.violations.map((v) => v.trim()).filter(Boolean);
        parsed.reasons = parsed.reasons.map((r) => r.trim()).filter(Boolean);

        const combined = mergeWithImageValidation(parsed, imageValidation);
        return combined;
      } catch (error) {
        lastError = error;
        if (isModelNotFoundError(error)) {
          break;
        }
        if (attempt >= retries || !isRetryableError(error)) {
          throw error;
        }
        await delay((attempt + 1) * 500);
      } finally {
        controller.abort();
      }
      attempt += 1;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unknown Gemini error');
}

function buildPromptPayload(
  text: string,
  html: string | undefined,
  signals: GeminiPolicyInput['signals'],
): string {
  const eventDate = signals.eventDateISO ?? 'tidak diketahui';
  const evaluationLabel =
    signals.evaluationDateLabel ??
    signals.evaluationDateISO ??
    'tidak diketahui';
  const lines: string[] = [];

  lines.push(text.trim() || '(teks kosong)');
  if (html && html.trim().length > 0) {
    lines.push('');
    lines.push('Cuplikan HTML (gunakan hanya jika diperlukan):');
    lines.push(html.trim());
  }

  lines.push('');
  lines.push('apakah berita diatas memenuhi kriteria berikut:');
  lines.push('');
  lines.push(TEXT_RULE_DEFINITIONS);
  lines.push('');
  lines.push('bila iya maka sebutkan kriteria apa saja yang dipenuhi');

  lines.push('');
  lines.push(
    `Catatan penting: hari ini (zona waktu Jakarta/WIB) adalah ${evaluationLabel}. Kriteria 4 hanya terpenuhi bila berita lebih dari satu hari kerja sebelum tanggal ini, bukan jika tanggal kegiatan sama atau setelahnya.`,
  );
  lines.push(
    `Gunakan total kalimat informatif sebagai acuan: kriteria 3 hanya terpenuhi bila jumlah kalimat kurang dari 12. Jika total kalimat 12 atau lebih, jangan laporkan pelanggaran #T3.`,
  );

  lines.push('');
  lines.push('Data pendukung:');
  lines.push(`- Jumlah paragraf: ${signals.paragraphCount}`);
  lines.push(
    `- Minimal kalimat per paragraf: ${signals.minSentencesPerParagraph}`,
  );
  lines.push(`- Jumlah gambar terdeteksi: ${signals.imageCount}`);
  lines.push(`- Gambar di hosting yang diizinkan: ${signals.allowedHostCount}`);
  lines.push(`- Foto hosting eksternal terdeteksi: ${signals.hostedImageCount}`);
  lines.push(`- Total kalimat informatif (perkiraan): ${signals.sentenceCount}`);
  lines.push(`- Tanggal kegiatan (ISO, jika ada): ${eventDate}`);
  lines.push(`- Tanggal penilaian (ISO Jakarta): ${signals.evaluationDateISO ?? 'tidak diketahui'}`);

  lines.push('');
  lines.push(
    'Jawab DALAM JSON VALID saja (tanpa teks tambahan) dengan format:',
  );
  lines.push(
    '{ "ok": boolean, "violations": string[], "reasons": string[], "confidence": number (0-1), "rejection_message_id"?: string, "rejection_message"?: string }',
  );
  lines.push(
    '- Set ok=false jika satu atau lebih kriteria terpenuhi, ok=true jika tidak ada kriteria terpenuhi.',
  );
  lines.push(
    '- Tuliskan setiap elemen "violations" menggunakan label rule yang sesuai (#T1, #T2, #T3, #T4, #T5).',
  );
  lines.push(
    '- "reasons" harus menjelaskan ringkas (bahasa Indonesia) kriteria mana yang terpenuhi dan alasannya.',
  );
  lines.push(
    '- Berikan confidence antara 0 dan 1 (gunakan 0.7 saat yakin ok, 0.5 atau lebih rendah saat menolak).',
  );
  lines.push(
    '- Jika menolak, isikan rejection_message berupa penjelasan singkat beserta kriteria yang terpenuhi.',
  );
  lines.push('- Jangan menambahkan informasi, fakta, atau asumsi baru.');

  return lines.join('\n');
}

interface ImageValidationResult {
  violations: string[];
  reasons: string[];
}

function mergeWithImageValidation(
  parsed: GeminiPolicyPayload,
  imageValidation: ImageValidationResult,
): GeminiPolicyPayload {
  const mergedViolations: string[] = [];
  const violationSet = new Set<string>();
  const textViolations = parsed.violations ?? [];
  for (const violation of [...imageValidation.violations, ...textViolations]) {
    const trimmed = violation.trim();
    if (!trimmed || violationSet.has(trimmed)) {
      continue;
    }
    violationSet.add(trimmed);
    mergedViolations.push(trimmed);
  }

  const mergedReasons: string[] = [];
  const reasonSet = new Set<string>();
  const textReasons = parsed.reasons ?? [];
  for (const reason of [...imageValidation.reasons, ...textReasons]) {
    const trimmed = reason.trim();
    if (!trimmed || reasonSet.has(trimmed)) {
      continue;
    }
    reasonSet.add(trimmed);
    mergedReasons.push(trimmed);
  }

  const baseConfidence =
    parsed.confidence ??
    ((parsed.ok ?? (textViolations.length === 0)) ? 0.7 : 0.5);

  const hasViolations = mergedViolations.length > 0;
  const finalOk = hasViolations ? false : parsed.ok ?? true;
  const finalConfidence = hasViolations ? Math.min(baseConfidence, 0.55) : baseConfidence;

  return {
    ...parsed,
    ok: finalOk,
    violations: mergedViolations,
    reasons: mergedReasons,
    confidence: finalConfidence,
  };
}

function validateImageSignals(
  signals: GeminiPolicyInput['signals'],
): ImageValidationResult {
  const violations: string[] = [];
  const reasons: string[] = [];

  const hostedCount = Math.max(
    signals.hostedImageCount ?? 0,
    signals.allowedHostCount ?? 0,
  );
  if (hostedCount === 0) {
    violations.push(IMAGE_RULE_LABEL);
    reasons.push(IMAGE_RULE_REASON);
  }

  return {
    violations,
    reasons,
  };
}

function resolveDefaultTimeout(): number {
  const candidate =
    process.env.GEMINI_TIMEOUT_MS ?? process.env.GEMINI_POLICY_TIMEOUT_MS;
  if (candidate) {
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 120_000;
}

function redactPii(value: string): string {
  return value.replace(/\b\d{5,}\b/g, '[REDACTED]');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = (error as { status?: number }).status;
  const code = (error as { code?: string }).code;
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? ((error as { message?: string }).message ?? '').toLowerCase()
      : '';

  if (status === 429 || status === 503) {
    return true;
  }
  if (code === 'RESOURCE_EXHAUSTED' || code === 'UNAVAILABLE') {
    return true;
  }
  if (message.includes('timed out')) {
    return true;
  }
  return false;
}

function isModelNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const status = (error as { status?: number }).status;
  const code = (error as { code?: string }).code?.toUpperCase?.();
  const message = ((error as { message?: string }).message ?? '').toLowerCase();
  return status === 404 || code === 'NOT_FOUND' || message.includes('not found');
}

interface GenAiContentPart {
  text?: string;
  [key: string]: unknown;
}

interface GenAiCandidate {
  content?: {
    parts?: GenAiContentPart[];
  };
}

interface GenAiResponseShape {
  candidates?: GenAiCandidate[];
  response?: {
    candidates?: GenAiCandidate[];
    text?: () => string;
  };
}

function extractTextFromResponse(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const responseShape = result as GenAiResponseShape;

  const responseText = responseShape.response?.text?.();
  if (typeof responseText === 'string' && responseText.trim().length > 0) {
    return responseText;
  }

  const candidateSets = [
    responseShape.response?.candidates,
    responseShape.candidates,
  ];

  for (const candidates of candidateSets) {
    if (!candidates) {
      continue;
    }
    for (const candidate of candidates) {
      const parts = candidate.content?.parts ?? [];
      for (const part of parts) {
        const partText = part.text;
        if (typeof partText === 'string' && partText.trim().length > 0) {
          return partText;
        }
      }
    }
  }

  return undefined;
}

function normalizeModelName(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

function resolveModelCandidates(explicit?: string): string[] {
  const candidates = [
    explicit,
    process.env.GEMINI_MODEL,
    DEFAULT_MODEL,
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const modelName of candidates) {
    if (!modelName || typeof modelName !== 'string') {
      continue;
    }
    if (!seen.has(modelName)) {
      seen.add(modelName);
      result.push(modelName);
    }
  }
  return result;
}

function attachAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ??
        new DOMException('Aborted', 'AbortError'),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timeoutRef: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutRef = setTimeout(() => {
      const timeoutError = new Error(
        `Gemini call timed out after ${timeoutMs}ms`,
      );
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }
  }
}

function mergeAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal,
): AbortSignal {
  if (!primary) {
    return secondary;
  }
  if (primary.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  primary.addEventListener('abort', onAbort, { once: true });
  secondary.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
