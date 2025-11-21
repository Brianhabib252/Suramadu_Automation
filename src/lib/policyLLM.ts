/**
 * Bridges local policy evaluation with the optional Gemini review. Always
 * applies fast heuristics first, then escalates to the LLM when the article
 * passes image validation and an API key is configured.
 */
import { formatInTimeZone } from 'date-fns-tz';
import {
  callGeminiPolicy,
  callGeminiVerification,
  type GeminiPolicyPayload,
} from '../ai/geminiNewsPolicy';
import type { NewsExtractionResult } from './newsExtract';
import {
  evaluateAgainstPolicy,
  type PolicyDetails,
  type PolicyResult,
} from './policyLocal';

const VIOLATION_MESSAGES: Record<string, string> = {
  '#I1 Foto Hosting':
    'Tambahkan foto yang diunggah melalui imgbb atau layanan hosting eksternal sebelum mengajukan berita.',
  '#T1 Bahasa/Jurnalistik':
    'Gunakan bahasa Indonesia baku dan narasi jurnalistik yang jelas.',
  '#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)':
    'Lengkapi unsur nama orang, waktu, dan lokasi (baik tatap muka maupun daring) dalam pemberitaan.',
  '#T3 Jumlah Kalimat':
    'Pastikan teks berisi minimal 12 kalimat informatif.',
  '#T4 Up to date':
    'Berita melewati batas waktu maksimal dua hari kerja dari tanggal kegiatan atau lebih dari satu hari kerja dari tanggal upload.',
  '#T5 Informatif':
    'Perkaya isi berita agar tidak sekadar kegiatan rutin tanpa nilai berita.',
  // Legacy mappings for compatibility with existing data
  '#5 Hosting Foto':
    'Tambahkan foto yang diunggah melalui imgbb atau layanan hosting eksternal sebelum mengajukan berita.',
  '#6 Up to date':
    'Berita melewati batas waktu H+1 hari kerja dari tanggal kegiatan.',
  '#7 Informatif':
    'Perkaya isi berita agar tidak sekadar kegiatan rutin tanpa nilai berita.',
  '#1 Bahasa/Jurnalistik':
    'Gunakan bahasa Indonesia baku dan narasi jurnalistik yang jelas.',
  '#2 5W+1H':
    'Lengkapi unsur kapan, di mana, dan siapa dalam pemberitaan.',
  '#T2 Unsur Kapan/Di mana/Siapa':
    'Lengkapi unsur kapan, di mana, dan siapa dalam pemberitaan.',
  '#T2 Unsur Nama Orang, Waktu, Lokasi (Langsung ditempat maupun Online)':
    'Lengkapi unsur nama orang, waktu, dan lokasi (baik tatap muka maupun daring) dalam pemberitaan.',
  '#3 Paragraf':
    'Pastikan teks berisi minimal 12 kalimat informatif.',
};

const JAKARTA_TZ = 'Asia/Jakarta';
const EVALUATION_ATTEMPT_BASE_DELAY_MS = 2_000;
const EVALUATION_ATTEMPT_MAX_DELAY_MS = 30_000;
const AI_CONFIRMATION_PHRASE = 'Dikonfirmasi oleh AI';
const AI_CONFIRMATION_SUFFIX = ` (${AI_CONFIRMATION_PHRASE})`;
const AI_CONFIRMATION_PHRASE_LOWER = AI_CONFIRMATION_PHRASE.toLowerCase();

function ensureAiConfirmationTag(text: string): string {
  if (!text) {
    return text;
  }
  if (text.toLowerCase().includes(AI_CONFIRMATION_PHRASE_LOWER)) {
    return text;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const leadingWhitespaceMatch = line.match(/^\s*/);
    const leading = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : '';
    const trimmed = line.trim();
    lines[i] = `${leading}${trimmed}${AI_CONFIRMATION_SUFFIX}`;
    return lines.join('\n');
  }
  return `${text}${AI_CONFIRMATION_SUFFIX}`;
}

export interface AiEvaluateInput {
  extraction: Pick<NewsExtractionResult, 'html' | 'text' | 'signals' | 'images' | 'eventDate' | 'uploadDate'>;
  now?: Date;
}

export interface AiEvaluationResult {
  ok: boolean;
  violations: string[];
  reasons: string[];
  confidence: number;
  rejection_message_id?: string;
  rejection_message?: string;
  source: 'gemini' | 'local';
  modelLabel?: string;
  details: PolicyDetails;
  rawGemini?: GeminiPolicyPayload;
  timeoutWarning?: boolean;
  verification?: VerificationMetadata;
}

export interface AiEvaluateOptions {
  geminiCaller?: typeof callGeminiPolicy;
  geminiVerificationCaller?: typeof callGeminiVerification;
}

export interface VerificationMetadata {
  attempted: boolean;
  outcome: 'confirmed' | 'overturned' | 'failed';
  notes?: string;
  raw?: GeminiPolicyPayload;
}

/**
 * Evaluate an extracted article using local heuristics and, when available,
 * the Gemini policy model. Returns a unified result object consumed by the DSL.
 */
export async function aiEvaluate(
  input: AiEvaluateInput,
  options: AiEvaluateOptions = {},
): Promise<AiEvaluationResult> {
  const { extraction } = input;
  const nowJkt = input.now ?? new Date();
  const evaluationDateISO = formatInTimeZone(
    nowJkt,
    JAKARTA_TZ,
    "yyyy-MM-dd'T'HH:mm:ssXXX",
  );
  const evaluationDateLabel = formatInTimeZone(
    nowJkt,
    JAKARTA_TZ,
    "d MMMM yyyy HH.mm 'WIB'",
  );

  const local = evaluateAgainstPolicy({
    text: extraction.text,
    images: extraction.images ?? [],
    eventDate: extraction.eventDate,
    uploadDate: extraction.uploadDate,
    signals: extraction.signals,
    nowJkt,
  });

  const localResult: AiEvaluationResult = buildResultFromLocal(
    local,
    nowJkt,
  );

  if (local.violations.includes('#I1 Foto Hosting')) {
    return localResult;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const geminiCaller = options.geminiCaller ?? callGeminiPolicy;
  const geminiVerificationCaller =
    options.geminiVerificationCaller ?? callGeminiVerification;

  if (!apiKey || !extraction.text.trim()) {
    return localResult;
  }

  const hostedImageCount = Math.max(
    extraction.signals.hostedImageCount ?? 0,
    extraction.signals.allowedHostCount,
    local.details.externalImageHosts?.length ?? 0,
  );

  const evaluationAttempts = resolveEvaluationAttemptCount();
  const requireGemini = shouldRequireGeminiDecision();
  let lastGeminiError: unknown;

  for (let attempt = 0; attempt < evaluationAttempts; attempt += 1) {
    try {
      const gemini = await geminiCaller({
        apiKey,
        text: extraction.text,
        html: extraction.html,
        signals: {
          paragraphCount: extraction.signals.paragraphCount,
          minSentencesPerParagraph:
            extraction.signals.minSentencesPerParagraph,
          imageCount: extraction.signals.imageCount,
          allowedHostCount: extraction.signals.allowedHostCount,
          hostedImageCount,
          sentenceCount: extraction.signals.sentenceCount,
          eventDateISO: extraction.eventDate,
          uploadDateISO: extraction.uploadDate,
          evaluationDateISO,
          evaluationDateLabel,
        },
      });

      let verificationMeta: VerificationMetadata | undefined;
      let finalGemini: GeminiPolicyPayload = gemini;
      const shouldVerify =
        gemini.ok === false && (gemini.violations?.length ?? 0) > 0;

      if (shouldVerify) {
        try {
          const verification = await geminiVerificationCaller({
            apiKey,
            text: extraction.text,
            html: extraction.html,
            signals: {
              paragraphCount: extraction.signals.paragraphCount,
              minSentencesPerParagraph:
                extraction.signals.minSentencesPerParagraph,
              imageCount: extraction.signals.imageCount,
              allowedHostCount: extraction.signals.allowedHostCount,
              hostedImageCount,
              sentenceCount: extraction.signals.sentenceCount,
              eventDateISO: extraction.eventDate,
              uploadDateISO: extraction.uploadDate,
              evaluationDateISO,
              evaluationDateLabel,
            },
            initialViolations: gemini.violations ?? [],
            initialReasons: gemini.reasons ?? [],
          });
          const overturned = verification.ok ?? false;
          verificationMeta = {
            attempted: true,
            outcome: overturned ? 'overturned' : 'confirmed',
            notes: overturned
              ? 'Penolakan awal dibatalkan setelah verifikasi ulang.'
              : 'Penolakan awal dikonfirmasi ulang oleh AI.',
            raw: verification,
          };
          if (overturned) {
            const confirmationReasons =
              verification.reasons && verification.reasons.length > 0
                ? verification.reasons
                : [
                    ensureAiConfirmationTag(
                      'Verifikasi ulang AI menyatakan berita memenuhi kebijakan.',
                    ),
                  ];
            finalGemini = {
              ...finalGemini,
              ok: true,
              violations: [],
              reasons: confirmationReasons,
              rejection_message: undefined,
              rejection_message_id: undefined,
              confidence: Math.max(verification.confidence ?? 0.65, 0.65),
            };
          } else {
            finalGemini = {
              ...finalGemini,
              violations:
                verification.violations && verification.violations.length > 0
                  ? verification.violations
                  : finalGemini.violations,
              reasons:
                verification.reasons && verification.reasons.length > 0
                  ? verification.reasons
                  : finalGemini.reasons,
              rejection_message:
                verification.rejection_message ?? finalGemini.rejection_message,
              rejection_message_id:
                verification.rejection_message_id ??
                finalGemini.rejection_message_id,
              confidence: Math.min(
                finalGemini.confidence ?? 0.5,
                verification.confidence ?? 0.6,
              ),
            };
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(
            'Gemini verification failed, using initial rejection:',
            error,
          );
          verificationMeta = {
            attempted: true,
            outcome: 'failed',
            notes:
              error instanceof Error
                ? error.message
                : 'Unknown verification error',
          };
        }
      }

      return buildResultFromGemini(
        finalGemini,
        local,
        verificationMeta,
      );
    } catch (error) {
      lastGeminiError = error;
      const hasMoreAttempts = attempt < evaluationAttempts - 1;
      if (hasMoreAttempts) {
        const waitMs = Math.min(
          EVALUATION_ATTEMPT_BASE_DELAY_MS * 2 ** attempt,
          EVALUATION_ATTEMPT_MAX_DELAY_MS,
        );
        await delay(waitMs);
        continue;
      }
      const temporaryOutage = isTemporaryGeminiOutage(error);
      if (requireGemini && !temporaryOutage) {
        throw lastGeminiError instanceof Error
          ? lastGeminiError
          : new Error(
              typeof lastGeminiError === 'string'
                ? lastGeminiError
                : 'Gemini evaluation failed.',
            );
      }
      // eslint-disable-next-line no-console
      console.warn(
        temporaryOutage
          ? 'Gemini temporarily unavailable, falling back to local policy:'
          : 'Gemini evaluation failed, falling back to local policy:',
        error,
      );
      if (temporaryOutage || isTimeoutLike(error)) {
        localResult.timeoutWarning = true;
      }
      return localResult;
    }
  }

  return localResult;
}

function resolveEvaluationAttemptCount(): number {
  const candidate = process.env.GEMINI_EVALUATION_ATTEMPTS;
  if (candidate) {
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 1;
}

function shouldRequireGeminiDecision(): boolean {
  const flag =
    process.env.GEMINI_DISABLE_LOCAL_FALLBACK ??
    process.env.GEMINI_REQUIRE_REMOTE_DECISION;
  if (!flag) {
    return false;
  }
  const normalized = flag.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function buildResultFromLocal(
  local: PolicyResult,
  nowJkt: Date,
): AiEvaluationResult {
  const { violations, details } = local;
  const reasons = mapViolationsToReasons(violations, details);
  const ok = violations.length === 0;
  const rejectionMessage = buildRejectionMessage(violations, reasons, details, nowJkt);
  return {
    ok,
    violations,
    reasons,
    confidence: ok ? 0.6 : 0.4,
    rejection_message: rejectionMessage,
    rejection_message_id: violations[0] ? slugViolation(violations[0]) : undefined,
    source: 'local',
    details,
    timeoutWarning: false,
  };
}

function buildResultFromGemini(
  gemini: GeminiPolicyPayload,
  local: PolicyResult,
  verification?: VerificationMetadata,
): AiEvaluationResult {
  const details = local.details;
  const originalViolations = gemini.violations ?? [];
  const harmonizedViolations = reconcileGeminiViolations(
    originalViolations,
    local,
  );
  const ok =
    harmonizedViolations.length === 0
      ? true
      : gemini.ok ?? false;

  const violationsChanged =
    harmonizedViolations.length !== originalViolations.length;
  const shouldReuseGeminiReasons =
    !violationsChanged && gemini.reasons && gemini.reasons.length > 0;

  const rawReasons: string[] =
    shouldReuseGeminiReasons && Array.isArray(gemini.reasons)
      ? [...gemini.reasons]
      : mapViolationsToReasons(harmonizedViolations, details);
  const reasons =
    harmonizedViolations.length > 0
      ? rawReasons.map((reason) => ensureAiConfirmationTag(reason))
      : rawReasons;

  let rejectionMessage: string | undefined;
  if (!ok) {
    const candidateMessage =
      gemini.rejection_message?.trim() ??
      buildRejectionMessage(
        harmonizedViolations,
        reasons,
        details,
        details.now ?? new Date(),
      ) ??
      'Berita ditolak.';
    rejectionMessage = ensureAiConfirmationTag(candidateMessage);
  }

  const primaryViolation = harmonizedViolations[0];
  const rejectionId =
    ok
      ? undefined
      : !violationsChanged && gemini.rejection_message_id
      ? gemini.rejection_message_id
      : primaryViolation
      ? slugViolation(primaryViolation)
      : undefined;

  return {
    ok,
    violations: harmonizedViolations,
    reasons,
    confidence: gemini.confidence ?? (ok ? 0.7 : 0.5),
    rejection_message: rejectionMessage,
    rejection_message_id: rejectionId,
    source: 'gemini',
    modelLabel: extractModelLabel(gemini),
    details,
    rawGemini: gemini,
    timeoutWarning: false,
    verification,
  };
}

function reconcileGeminiViolations(
  violations: string[],
  local: PolicyResult,
): string[] {
  if (violations.length === 0) {
    return violations;
  }
  const localCodes = new Set(local.violations);
  const localHasFreshness =
    localCodes.has('#T4 Up to date') || localCodes.has('#6 Up to date');
  const localHasSentenceCountIssue =
    localCodes.has('#T3 Jumlah Kalimat') || localCodes.has('#3 Paragraf');
  return violations.filter((code) => {
    if (
      (code === '#T4 Up to date' || code === '#6 Up to date') &&
      !localHasFreshness
    ) {
      return false;
    }
    if (
      (code === '#T3 Jumlah Kalimat' || code === '#3 Paragraf') &&
      !localHasSentenceCountIssue
    ) {
      return false;
    }
    return true;
  });
}

function mapViolationsToReasons(
  violations: string[],
  details: PolicyDetails,
): string[] {
  if (violations.length === 0) {
    return ['Berita memenuhi seluruh kebijakan lokal.'];
  }
  return violations.map((violation) => {
    const base = VIOLATION_MESSAGES[violation] ?? violation;
    if (
      (violation === '#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)' ||
        violation === '#T2 Unsur Kapan/Di mana/Siapa' ||
        violation === '#2 5W+1H') &&
      details.missingCoreInfo?.length
    ) {
      const message = `${base} Unsur yang belum ada: ${details.missingCoreInfo.join(', ')}.`;
      return ensureAiConfirmationTag(message);
    }
    if (
      (violation === '#I1 Foto Hosting' || violation === '#5 Hosting Foto') &&
      details.externalImageHosts?.length
    ) {
      const message = `${base} Host terdeteksi: ${details.externalImageHosts.join(', ')}.`;
      return ensureAiConfirmationTag(message);
    }
    if (
      (violation === '#T3 Jumlah Kalimat' || violation === '#3 Paragraf') &&
      typeof details.sentenceCount === 'number'
    ) {
      const message = `${base} Saat ini baru ${details.sentenceCount} kalimat.`;
      return ensureAiConfirmationTag(message);
    }
    return ensureAiConfirmationTag(base);
  });
}

function buildRejectionMessage(
  violations: string[],
  reasons: string[],
  details: PolicyDetails,
  nowJkt: Date,
): string | undefined {
  if (violations.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  lines.push(
    ensureAiConfirmationTag(
      'Berita ditolak karena tidak memenuhi persyaratan berikut:',
    ),
  );
  reasons.forEach((reason) => lines.push(`- ${reason}`));

  if (
    (violations.includes('#T4 Up to date') || violations.includes('#6 Up to date')) &&
    details.eventDate
  ) {
    const formatted = formatInTimeZone(details.eventDate, JAKARTA_TZ, 'd MMMM yyyy');
    lines.push(`- Tanggal kegiatan: ${formatted}.`);
    if (details.uploadDate) {
      const uploadFormatted = formatInTimeZone(details.uploadDate, JAKARTA_TZ, 'd MMMM yyyy');
      lines.push(`- Tanggal upload: ${uploadFormatted}.`);
    }
    if (typeof details.workingDaysToEvaluation === 'number') {
      lines.push(`- Selisih ke tanggal konfirmasi: ${details.workingDaysToEvaluation} hari kerja.`);
    }
    if (typeof details.workingDaysToUpload === 'number') {
      lines.push(`- Selisih ke tanggal upload: ${details.workingDaysToUpload} hari kerja.`);
    }
  }

  return lines.join('\n');
}

function slugViolation(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isTimeoutLike(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const extractMessage = (): string | undefined => {
    if (typeof error === 'string') {
      return error;
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
    ) {
      return (error as { message?: string }).message;
    }
    return undefined;
  };
  const message = extractMessage()?.toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('time out')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTemporaryGeminiOutage(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (typeof error === 'string') {
    const normalized = error.toLowerCase();
    return (
      normalized.includes('model is overloaded') ||
      normalized.includes('service unavailable') ||
      normalized.includes('temporarily unavailable') ||
      normalized.includes('please try again later') ||
      normalized.includes('try again later') ||
      normalized.includes('too many requests')
    );
  }
  if (typeof error !== 'object') {
    return false;
  }
  const status = (error as { status?: number }).status;
  const codeNumber =
    typeof (error as { code?: number }).code === 'number'
      ? (error as { code: number }).code
      : undefined;
  const codeString =
    typeof (error as { code?: string }).code === 'string'
      ? ((error as { code: string }).code ?? '').toUpperCase()
      : undefined;
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? ((error as { message?: string }).message ?? '')
      : '';
  const nested = (error as {
    error?: { code?: number | string; status?: string; message?: string };
  }).error;

  const numericCandidates: number[] = [];
  const textualCandidates: string[] = [];
  if (typeof status === 'number') {
    numericCandidates.push(status);
  }
  if (typeof codeNumber === 'number') {
    numericCandidates.push(codeNumber);
  }
  if (codeString) {
    textualCandidates.push(codeString);
  }
  if (nested) {
    if (typeof nested.code === 'number') {
      numericCandidates.push(nested.code);
    } else if (typeof nested.code === 'string') {
      textualCandidates.push(nested.code.toUpperCase());
    }
    if (typeof nested.status === 'string') {
      textualCandidates.push(nested.status.toUpperCase());
    }
  }

  const normalizedMessage = message.toLowerCase();
  const nestedMessage =
    typeof nested?.message === 'string' ? nested.message.toLowerCase() : '';

  if (numericCandidates.some((value) => value === 429 || value === 503)) {
    return true;
  }
  if (
    textualCandidates.some((value) =>
      ['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'TOO_MANY_REQUESTS'].includes(
        value,
      ),
    )
  ) {
    return true;
  }
  if (
    normalizedMessage.includes('model is overloaded') ||
    normalizedMessage.includes('service unavailable') ||
    normalizedMessage.includes('temporarily unavailable') ||
    normalizedMessage.includes('please try again later') ||
    normalizedMessage.includes('try again later') ||
    normalizedMessage.includes('too many requests')
  ) {
    return true;
  }
  if (
    nestedMessage.includes('model is overloaded') ||
    nestedMessage.includes('service unavailable') ||
    nestedMessage.includes('temporarily unavailable') ||
    nestedMessage.includes('please try again later') ||
    nestedMessage.includes('try again later') ||
    nestedMessage.includes('too many requests')
  ) {
    return true;
  }
  return false;
}

function extractModelLabel(gemini: GeminiPolicyPayload): string | undefined {
  const modelName = (gemini as { _model?: string })._model;
  if (!modelName) {
    return undefined;
  }
  const normalized = modelName.replace(/^models\//i, '');
  const display = normalized.replace(/_/g, '-');
  return display;
}

