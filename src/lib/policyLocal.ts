/**
 * Implements the deterministic, fast policy checks that gate the AI stage.
 * Rules cover image hosting, language heuristics, 5W+1H completeness, sentence
 * thresholds, freshness, and routine-content detection.
 */
import type { ExtractedImage, NewsSignals } from './newsExtract';

export interface PolicyInput {
  text: string;
  images: ExtractedImage[];
  eventDate?: string | Date;
  uploadDate?: string | Date;
  signals: NewsSignals;
  nowJkt: Date;
}

export interface PolicyDetails {
  missingCoreInfo?: string[];
  sentenceCount?: number;
  imageCount?: number;
  externalImageHosts?: string[];
  eventDate?: Date;
  uploadDate?: Date;
  now?: Date;
  routineKeywordsHit?: string[];
  workingDaysToUpload?: number;
  workingDaysToEvaluation?: number;
}

export interface PolicyResult {
  violations: string[];
  details: PolicyDetails;
}

const RULE_IMAGE_HOSTING = '#I1 Foto Hosting';
const RULE_BAHASA = '#T1 Bahasa/Jurnalistik';
const RULE_CORE_INFO = '#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)';
const RULE_SENTENCE_COUNT = '#T3 Jumlah Kalimat';
const RULE_FRESHNESS = '#T4 Up to date';
const RULE_ROUTINE = '#T5 Informatif';

const INDONESIAN_COMMON_WORDS = [
  'yang',
  'untuk',
  'dengan',
  'pada',
  'dari',
  'akan',
  'sebagai',
  'bahwa',
  'atau',
  'karena',
];

const ROUTINE_KEYWORDS = [
  'rutin',
  'rutinitas',
  'setiap hari',
  'setiap minggu',
  'setiap senin',
  'setiap bulan',
  'apel pagi',
  'apel sore',
  'senam',
  'olahraga',
  'coffee morning',
  'kerja bakti',
  'briefing',
  'istighosah',
  'kultum',
  'jumat berkah',
];

const EXCEPTION_KEYWORDS = [
  'pelantikan',
  'peresmian',
  'seminar',
  'simposium',
  'rapat koordinasi',
  'diskusi',
  'bimbingan',
  'diklat',
  'workshop',
  'peluncuran',
  'sidang',
];

/**
 * Evaluate extracted article data against the local rule set, returning both
 * violation codes and contextual details that downstream logic can surface.
 */
export function evaluateAgainstPolicy(
  input: PolicyInput,
): PolicyResult {
  const { text, images = [], eventDate, uploadDate, signals, nowJkt } = input;
  const details: PolicyDetails = {
    imageCount: signals.imageCount,
    now: nowJkt,
  };
  const violations: string[] = [];

  const normalizedText = text.trim();
  const lowerText = normalizedText.toLowerCase();

  // Image rule
  const externalHosts = detectExternalImageHosts(images);
  if (externalHosts.length > 0) {
    details.externalImageHosts = externalHosts;
  }
  const hostedImageCount =
    typeof signals.hostedImageCount === 'number'
      ? signals.hostedImageCount
      : 0;
  const hasHostedImage =
    hostedImageCount > 0 ||
    (signals.allowedHostCount ?? 0) > 0 ||
    externalHosts.length > 0;
  if (!hasHostedImage) {
    violations.push(RULE_IMAGE_HOSTING);
  }

  // Rule #T1
  const bahasaOk = isLikelyIndonesian(lowerText) && hasReasonableSentenceLength(normalizedText);
  if (!bahasaOk) {
    violations.push(RULE_BAHASA);
  }

  // Rule #T2
  const missingCoreInfo = identifyMissingCoreInfo(lowerText);
  if (missingCoreInfo.length > 0) {
    violations.push(RULE_CORE_INFO);
    details.missingCoreInfo = missingCoreInfo;
  }

  // Rule #T3
  const sentenceCount = splitSentences(normalizedText).length;
  details.sentenceCount = sentenceCount;
  if (sentenceCount < 12) {
    violations.push(RULE_SENTENCE_COUNT);
  }

  // Rule #T4
  const eventDateValue = toDateOrUndefined(eventDate);
  const uploadDateValue = toDateOrUndefined(uploadDate);
  details.eventDate = eventDateValue;
  if (uploadDateValue) {
    details.uploadDate = uploadDateValue;
  }
  let freshnessOk = true;
  if (!eventDateValue) {
    freshnessOk = false;
  } else {
    const evaluationDateValue = nowJkt;
    const workingDaysToEvaluation = workingDaysBetween(
      eventDateValue,
      evaluationDateValue,
    );
    details.workingDaysToEvaluation = workingDaysToEvaluation;
    if (workingDaysToEvaluation > 2) {
      freshnessOk = false;
    }

    if (uploadDateValue) {
      const workingDaysToUpload = workingDaysBetween(
        eventDateValue,
        uploadDateValue,
      );
      details.workingDaysToUpload = workingDaysToUpload;
      if (workingDaysToUpload > 1) {
        freshnessOk = false;
      }
    }
  }

  if (!freshnessOk) {
    violations.push(RULE_FRESHNESS);
  }

  // Rule #T5
  const routineHits = findRoutineHits(lowerText);
  const hasException = EXCEPTION_KEYWORDS.some((kw) =>
    lowerText.includes(kw),
  );
  if (routineHits.length > 0 && !hasException) {
    violations.push(RULE_ROUTINE);
    details.routineKeywordsHit = routineHits;
  }

  return { violations, details };
}

function isLikelyIndonesian(text: string): boolean {
  if (!text) {
    return false;
  }
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return false;
  }
  const uniqueTokens = new Set(tokens);
  const hits = INDONESIAN_COMMON_WORDS.reduce((count, word) => {
    return uniqueTokens.has(word) ? count + 1 : count;
  }, 0);
  return hits >= 3;
}

function hasReasonableSentenceLength(text: string): boolean {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return false;
  }
  const totalWords = sentences.reduce((acc, sentence) => {
    return acc + tokenize(sentence).length;
  }, 0);
  const avg = totalWords / sentences.length;
  return avg <= 35;
}

function identifyMissingCoreInfo(text: string): string[] {
  const checks: [string, RegExp[]][] = [
    [
      'Kapan',
      [
        /\bkapan\b/iu,
        /\btanggal\b/iu,
        /\bhari\b/iu,
        /\bpukul\b/iu,
        /\bpada\s(hari|tanggal)\b/iu,
        /\b(\d{1,2}\s+[a-z�-]+\s+\d{4})\b/ui,
        /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/iu,
      ],
    ],
    [
      'Di mana',
      [
        /\bdi\s+(?:aula|kantor|balai|gedung|ruang|ruangan|lapangan|masjid|kelurahan|desa|kecamatan|kabupaten|kota)\b/iu,
        /\bdi\s+[A-Z][\w-]+/u,
        /\bloc(?:ation)?\b/iu,
      ],
    ],
    [
      'Siapa',
      [
        /\bsiapa\b/iu,
        /\boleh\b/iu,
        /\bkepala\b/iu,
        /\bbupati\b/iu,
        /\bketua\b/iu,
        /\bsekretaris\b/iu,
        /\b(humas|narasumber|peserta)\b/iu,
        /\b(?:dr|ir|hj|h)\.?/iu,
      ],
    ],
  ];

  const missing: string[] = [];
  for (const [label, patterns] of checks) {
    const hit = patterns.some((pattern) => pattern.test(text));
    if (!hit) {
      missing.push(label);
    }
  }
  return missing;
}

function detectExternalImageHosts(images: ExtractedImage[]): string[] {
  const externalHosts = new Set<string>();
  for (const image of images) {
    const src = image?.src?.trim();
    if (!src) {
      continue;
    }
    if (/^(data|blob):/i.test(src)) {
      continue;
    }
    const isAbsolute = /^https?:\/\//i.test(src);
    if (!isAbsolute) {
      continue;
    }
    const host = extractHostname(src);
    if (!host) {
      continue;
    }
    if (shouldFlagExternalHost(host)) {
      externalHosts.add(host);
    }
  }
  return Array.from(externalHosts);
}

function extractHostname(src: string): string | undefined {
  try {
    const url = new URL(src, 'https://placeholder.local');
    if (!url.hostname) {
      return undefined;
    }
    if (url.hostname === 'placeholder.local') {
      return undefined;
    }
    return url.hostname;
  } catch {
    return undefined;
  }
}

function shouldFlagExternalHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized.includes('imgbb') || normalized.endsWith('ibb.co')) {
    return true;
  }
  if (normalized === 'localhost' || normalized === '127.0.0.1') {
    return false;
  }
  if (normalized.endsWith('.go.id')) {
    return false;
  }
  if (normalized.includes('bangkalan')) {
    return false;
  }
  if (normalized.includes('gandrung')) {
    return false;
  }
  return true;
}

function toDateOrUndefined(value?: string | Date): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function workingDaysBetween(start: Date, end: Date): number {
  const startOfStart = startOfDay(start);
  const startOfEnd = startOfDay(end);
  if (startOfStart > startOfEnd) {
    return 0;
  }
  let count = 0;
  let cursor = new Date(startOfStart);
  while (cursor < startOfEnd) {
    cursor = addDays(cursor, 1);
    if (!isWeekend(cursor)) {
      count += 1;
    }
  }
  return count;
}

function startOfDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0,
  );
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function findRoutineHits(text: string): string[] {
  const hits = ROUTINE_KEYWORDS.filter((kw) =>
    text.includes(kw),
  );
  return hits;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúàèìòùäëïöüâêîôûçñ]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
