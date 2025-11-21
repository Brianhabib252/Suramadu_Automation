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
  rejection_message_id: z
    .string()
    .nullish()
    .transform((value) => (value == null || value.trim().length === 0 ? undefined : value)),
  rejection_message: z
    .string()
    .nullish()
    .transform((value) => (value == null || value.trim().length === 0 ? undefined : value)),
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
    uploadDateISO?: string;
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

export interface GeminiVerificationInput extends GeminiPolicyInput {
  initialViolations: string[];
  initialReasons: string[];
}

const DEFAULT_MODEL =
  process.env.GEMINI_DEFAULT_MODEL ??
  process.env.GEMINI_MODEL ??
  'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = resolveDefaultTimeout();
const DEFAULT_RETRY_COUNT = resolveDefaultRetryCount();
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;

const IMAGE_RULE_LABEL = '#I1 Foto Hosting';
const IMAGE_RULE_REASON =
  'Berita harus menyertakan foto yang diunggah melalui imgbb atau layanan hosting eksternal. Tidak ditemukan foto dari layanan hosting tersebut.';

const TEXT_RULE_DEFINITIONS = [
  '1. Tidak menggunakan Bahasa Indonesian yang baik (laporkan sebagai "#T1 Bahasa/Jurnalistik").',
  '2. Tidak ada unsur nama orang, waktu, dan lokasi (tatap muka maupun daring) pada berita (laporkan sebagai "#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)"). Catatan: penyebutan nama kantor/instansi, alamat, atau aula tertentu sudah dianggap memenuhi unsur lokasi walaupun tidak diawali kata "di".',
  '3. Jumlah kalimat informatif kurang dari 12 (laporkan sebagai "#T3 Jumlah Kalimat").',
  '4. Tanggal berita lebih lama dari lusa kemarin atau lebih dari dua hari kerja sebelum hari ini (hari Sabtu/Minggu tidak dihitung) (laporkan sebagai "#T4 Up to date").',
  '5. Tanggal kegiatan di deskripsi lebih lama lebih dari satu hari kerja dibanding tanggal berita diupload (hari Sabtu/Minggu tidak dihitung) (laporkan sebagai "#T4 Up to date").',
  '6. Berita tidak informatif (kegiatan rutin biasa seperti apel, briefing, coffee morning, senam, olahraga, kerja bakti, kultum, jumat berkah) (laporkan sebagai "#T5 Informatif").',
  '7. Bila penilaian dilakukan pada hari Sabtu atau Minggu maka berita kegiatan pada hari Kamis dan Jumat tetap dianggap up to date dan jangan dilaporkan sebagai "#T4 Up to date".',
].join('\n');

/**
 * Invoke Gemini with a resilience strategy (timeouts, retries, model fallback)
 * and return a normalized payload that adheres to the expected schema.
 */
export async function callGeminiPolicy(
  input: GeminiPolicyInput,
  options: GeminiPolicyCallOptions = {},
): Promise<GeminiPolicyPayload> {
  const { text, html, signals } = input;
  const sanitizedText = redactPii(text);
  const imageValidation = validateImageSignals(signals);
  const payload = buildPromptPayload(sanitizedText, html, signals);
  const raw = await requestGeminiResponse(payload, input, options);
  return mergeWithImageValidation(raw, imageValidation);
}

export async function callGeminiVerification(
  input: GeminiVerificationInput,
  options: GeminiPolicyCallOptions = {},
): Promise<GeminiPolicyPayload> {
  const { text, html, signals, initialViolations, initialReasons } = input;
  if (!initialViolations || initialViolations.length === 0) {
    throw new Error('Verification requires at least one initial violation.');
  }
  const sanitizedText = redactPii(text);
  const payload = buildVerificationPrompt(
    sanitizedText,
    html,
    signals,
    initialViolations,
    initialReasons,
  );
  return requestGeminiResponse(payload, input, options);
}

async function requestGeminiResponse(
  prompt: string,
  input: GeminiPolicyInput,
  options: GeminiPolicyCallOptions,
): Promise<GeminiPolicyPayload> {
  const { apiKey, abortSignal } = input;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required');
  }
  const client = new GoogleGenAI({ apiKey });
  const retries = normalizeRetryCount(options.retries);

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
                  parts: [{ text: prompt }],
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
        (parsed as GeminiPolicyPayload & { _model?: string })._model =
          normalizedModel;
        parsed.violations = parsed.violations.map((v) => v.trim()).filter(Boolean);
        parsed.reasons = parsed.reasons.map((r) => r.trim()).filter(Boolean);
        return parsed;
      } catch (error) {
        lastError = error;
        if (isModelNotFoundError(error)) {
          break;
        }
        const retryable = isRetryableError(error);
        const hasMoreAttempts = attempt < retries;
        if (!retryable) {
          throw error;
        }
        if (!hasMoreAttempts) {
          // Exhausted retries for this model; move to the next candidate.
          break;
        }
        const backoffMs = Math.min(
          BASE_RETRY_DELAY_MS * 2 ** attempt,
          MAX_RETRY_DELAY_MS,
        );
        const jitter = Math.floor(Math.random() * 250);
        await delay(backoffMs + jitter);
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
  const uploadDate = signals.uploadDateISO ?? 'tidak diketahui';
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
    `Catatan penting: hari ini (zona waktu Jakarta/WIB) adalah ${evaluationLabel}. Kriteria 4 hanya terpenuhi bila tanggal kegiatan lebih dari dua hari kerja sebelum tanggal ini (abaikan Sabtu/Minggu).`,
  );
  lines.push(
    `Jika tersedia gunakan tanggal upload berikut sebagai pembanding tambahan untuk kriteria 4: ${uploadDate}. Laporkan pelanggaran bila selisih tanggal kegiatan dan tanggal upload lebih dari satu hari kerja (hari Sabtu/Minggu tidak dihitung).`,
  );
  lines.push(
    `Gunakan total kalimat informatif sebagai acuan: kriteria 3 hanya terpenuhi bila jumlah kalimat kurang dari 12. Jika total kalimat 12 atau lebih, jangan laporkan pelanggaran #T3.`,
  );
  lines.push('');
  lines.push(
    'Contoh interpretasi unsur lokasi: "Rapat digelar di Aula Pengadilan Agama Nganjuk" -> unsur lokasi sudah terpenuhi walaupun tidak menuliskan kata "di" secara eksplisit di setiap kalimat.',
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
  lines.push(`- Tanggal upload (ISO, jika ada): ${uploadDate}`);
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

function buildVerificationPrompt(
  text: string,
  html: string | undefined,
  signals: GeminiPolicyInput['signals'],
  violations: string[],
  reasons: string[],
): string {
  const lines: string[] = [];
  lines.push(
    'Tinjau ulang keputusan penolakan berita berikut dan pastikan alasan yang diberikan benar atau keliru.',
  );
  lines.push('');
  lines.push('Teks berita (bersihkan asumsi, gunakan kutipan langsung bila perlu):');
  lines.push(text.trim() || '(teks kosong)');

  if (html && html.trim().length > 0) {
    lines.push('');
    lines.push(
      'Cuplikan HTML yang sama seperti sebelumnya (gunakan hanya jika diperlukan untuk memverifikasi klaim):',
    );
    lines.push(html.trim());
  }

  lines.push('');
  lines.push('Klaim pelanggaran awal yang wajib diverifikasi satu per satu:');
  violations.forEach((code, index) => {
    const reason = reasons[index] ?? reasons[reasons.length - 1] ?? '';
    lines.push(`- ${code}: ${reason || '(alasan tidak tersedia)'}`);
    lines.push(
      `  Pertanyaan: Apakah benar pelanggaran "${code}" tersebut terjadi? Jelaskan bukti yang mendukung atau membantah.`,
    );
  });

  lines.push('');
  lines.push('Gunakan data pendukung berikut untuk memastikan jawaban akurat:');
  lines.push(`- Jumlah paragraf: ${signals.paragraphCount}`);
  lines.push(
    `- Minimal kalimat per paragraf: ${signals.minSentencesPerParagraph}`,
  );
  lines.push(`- Total kalimat informatif (perkiraan): ${signals.sentenceCount}`);
  lines.push(
    `- Tanggal kegiatan (ISO, jika ada): ${signals.eventDateISO ?? 'tidak diketahui'}`,
  );
  lines.push(
    `- Tanggal upload (ISO, jika ada): ${signals.uploadDateISO ?? 'tidak diketahui'}`,
  );

  lines.push('');
  lines.push(
    'Instruksi penting verifikasi:',
  );
  lines.push(
    '- Fokus hanya pada pelanggaran yang tercantum di atas, jangan menciptakan pelanggaran baru.',
  );
  lines.push(
    '- Ingat bahwa penyebutan nama kantor, aula, atau alamat unik sudah memenuhi unsur lokasi (contoh: "Rapat digelar di Aula Pengadilan Agama Nganjuk" berarti unsur lokasi ada).',
  );
  lines.push(
    '- Jika semua pelanggaran terbukti benar, set ok=false dan jelaskan bukti pendukung pada "reasons".',
  );
  lines.push(
    '- Jika ada pelanggaran yang ternyata tidak benar, hapus dari daftar dan set ok=true bila tidak ada pelanggaran tersisa.',
  );
  lines.push(
    '- Jawab menggunakan JSON VALID yang sama: { "ok": boolean, "violations": string[], "reasons": string[], "confidence": number (0-1), "rejection_message_id"?: string, "rejection_message"?: string }',
  );
  lines.push('- Gunakan bahasa Indonesia.');
  lines.push('- Jangan mengulang alasan lama tanpa memeriksa kembali isi berita.');

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

function resolveDefaultRetryCount(): number {
  const candidate = process.env.GEMINI_POLICY_RETRIES;
  if (candidate) {
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 3;
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
  if (!error) {
    return false;
  }
  const asObject = typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const numericStatuses: number[] = [];
  const stringStatuses: string[] = [];
  const stringCodes: string[] = [];
  const numericCodes: number[] = [];

  const pushStatus = (value: unknown): void => {
    if (typeof value === 'number') {
      numericStatuses.push(value);
    } else if (typeof value === 'string') {
      stringStatuses.push(value.toUpperCase());
    }
  };
  const pushCode = (value: unknown): void => {
    if (typeof value === 'number') {
      numericCodes.push(value);
    } else if (typeof value === 'string') {
      stringCodes.push(value.toUpperCase());
    }
  };

  if (asObject) {
    pushStatus(asObject.status);
    pushCode(asObject.code);
    const nested = asObject.error as
      | { status?: unknown; code?: unknown; message?: unknown }
      | undefined;
    if (nested) {
      pushStatus(nested.status);
      pushCode(nested.code);
    }
  }

  const normalizedMessage =
    typeof (error as { message?: unknown }).message === 'string'
      ? ((error as { message?: string }).message ?? '').toLowerCase()
      : '';
  const nestedMessage =
    typeof (asObject?.error as { message?: unknown } | undefined)?.message === 'string'
      ? (
          (asObject?.error as { message?: string }).message ?? ''
        ).toLowerCase()
      : '';

  const messageHints = (value: string): boolean =>
    value.includes('service unavailable') ||
    value.includes('temporarily unavailable') ||
    value.includes('model is overloaded') ||
    value.includes('please try again later') ||
    value.includes('try again later') ||
    value.includes('too many requests') ||
    value.includes('resource exhausted') ||
    value.includes('rate limit') ||
    value.includes('timed out');

  if (numericStatuses.some((status) => status === 429 || status === 503)) {
    return true;
  }
  if (numericCodes.some((code) => code === 429 || code === 503)) {
    return true;
  }
  if (
    stringStatuses.some((status) =>
      ['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'TOO_MANY_REQUESTS'].includes(status),
    )
  ) {
    return true;
  }
  if (
    stringCodes.some((code) =>
      ['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'TOO_MANY_REQUESTS'].includes(code),
    )
  ) {
    return true;
  }
  if (messageHints(normalizedMessage) || messageHints(nestedMessage)) {
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

export function resolveModelCandidates(explicit?: string): string[] {
  const fallbackModels = parseModelList(process.env.GEMINI_FALLBACK_MODELS);
  const candidates = [
    explicit,
    process.env.GEMINI_DEFAULT_MODEL,
    process.env.GEMINI_MODEL,
    ...fallbackModels,
    DEFAULT_MODEL,
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0',
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const modelName of candidates) {
    if (!modelName || typeof modelName !== 'string') {
      continue;
    }
    const normalized = modelName.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseModelList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,;\n\r]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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

function normalizeRetryCount(explicit?: number): number {
  if (
    typeof explicit === 'number' &&
    Number.isFinite(explicit) &&
    explicit >= 0
  ) {
    return Math.floor(explicit);
  }
  return DEFAULT_RETRY_COUNT;
}
