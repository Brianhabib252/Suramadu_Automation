import { formatInTimeZone } from 'date-fns-tz';
import { callGeminiPolicy, type GeminiPolicyPayload } from '../ai/geminiNewsPolicy';
import type { NewsExtractionResult } from './newsExtract';
import {
  evaluateAgainstPolicy,
  type PolicyDetails,
} from './policyLocal';

const VIOLATION_MESSAGES: Record<string, string> = {
  '#I1 Foto Hosting':
    'Tambahkan foto yang diunggah melalui imgbb atau layanan hosting eksternal sebelum mengajukan berita.',
  '#T1 Bahasa/Jurnalistik':
    'Gunakan bahasa Indonesia baku dan narasi jurnalistik yang jelas.',
  '#T2 Unsur Kapan/Di mana/Siapa':
    'Lengkapi unsur kapan, di mana, dan siapa dalam pemberitaan.',
  '#T3 Jumlah Kalimat':
    'Pastikan teks berisi minimal 12 kalimat informatif.',
  '#T4 Up to date':
    'Berita melewati batas waktu H+1 hari kerja dari tanggal kegiatan.',
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
  '#3 Paragraf':
    'Pastikan teks berisi minimal 12 kalimat informatif.',
};

const JAKARTA_TZ = 'Asia/Jakarta';

export interface AiEvaluateInput {
  extraction: Pick<NewsExtractionResult, 'html' | 'text' | 'signals' | 'images' | 'eventDate'>;
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
  details: PolicyDetails;
  rawGemini?: GeminiPolicyPayload;
}

export interface AiEvaluateOptions {
  geminiCaller?: typeof callGeminiPolicy;
}

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
    signals: extraction.signals,
    nowJkt,
  });

  const localResult: AiEvaluationResult = buildResultFromLocal(
    local.violations,
    local.details,
    nowJkt,
  );

  if (local.violations.includes('#I1 Foto Hosting')) {
    return localResult;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const geminiCaller = options.geminiCaller ?? callGeminiPolicy;

  if (!apiKey || !extraction.text.trim()) {
    return localResult;
  }

  const hostedImageCount = Math.max(
    extraction.signals.hostedImageCount ?? 0,
    extraction.signals.allowedHostCount,
    local.details.externalImageHosts?.length ?? 0,
  );

  try {
    const gemini = await geminiCaller({
      apiKey,
      text: extraction.text,
      html: extraction.html,
      signals: {
        paragraphCount: extraction.signals.paragraphCount,
        minSentencesPerParagraph: extraction.signals.minSentencesPerParagraph,
        imageCount: extraction.signals.imageCount,
        allowedHostCount: extraction.signals.allowedHostCount,
        hostedImageCount,
        sentenceCount: extraction.signals.sentenceCount,
        eventDateISO: extraction.eventDate,
        evaluationDateISO,
        evaluationDateLabel,
      },
    });

    return buildResultFromGemini(
      gemini,
      local.details,
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Gemini evaluation failed, falling back to local policy:', error);
    return localResult;
  }
}

function buildResultFromLocal(
  violations: string[],
  details: PolicyDetails,
  nowJkt: Date,
): AiEvaluationResult {
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
  };
}

function buildResultFromGemini(
  gemini: GeminiPolicyPayload,
  details: PolicyDetails,
): AiEvaluationResult {
  const violations = gemini.violations ?? [];
  const ok = gemini.ok ?? violations.length === 0;

  const reasons =
    gemini.reasons && gemini.reasons.length > 0
      ? gemini.reasons
      : mapViolationsToReasons(violations, details);

  const rejectionMessage =
    gemini.rejection_message ??
    buildRejectionMessage(violations, reasons, details, details.now ?? new Date());

  return {
    ok,
    violations,
    reasons,
    confidence: gemini.confidence ?? (ok ? 0.7 : 0.5),
    rejection_message: rejectionMessage,
    rejection_message_id:
      gemini.rejection_message_id ??
      (violations[0] ? slugViolation(violations[0]) : undefined),
    source: 'gemini',
    details,
    rawGemini: gemini,
  };
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
      (violation === '#T2 Unsur Kapan/Di mana/Siapa' ||
        violation === '#2 5W+1H') &&
      details.missingCoreInfo?.length
    ) {
      return `${base} Unsur yang belum ada: ${details.missingCoreInfo.join(', ')}.`;
    }
    if (
      (violation === '#I1 Foto Hosting' || violation === '#5 Hosting Foto') &&
      details.externalImageHosts?.length
    ) {
      return `${base} Host terdeteksi: ${details.externalImageHosts.join(', ')}.`;
    }
    if (
      (violation === '#T3 Jumlah Kalimat' || violation === '#3 Paragraf') &&
      typeof details.sentenceCount === 'number'
    ) {
      return `${base} Saat ini baru ${details.sentenceCount} kalimat.`;
    }
    return base;
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
  lines.push('Berita ditolak karena tidak memenuhi persyaratan berikut:');
  reasons.forEach((reason) => lines.push(`- ${reason}`));

  if (
    (violations.includes('#T4 Up to date') || violations.includes('#6 Up to date')) &&
    details.eventDate
  ) {
    const formatted = formatInTimeZone(details.eventDate, JAKARTA_TZ, 'd MMMM yyyy');
    lines.push(`- Tanggal kegiatan: ${formatted}.`);
  }

  return lines.join('\n');
}

function slugViolation(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}
