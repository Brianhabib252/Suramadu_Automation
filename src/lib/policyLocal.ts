/**
 * Deterministic Suramadu news-policy evaluator. The local engine deliberately
 * keeps every decision explainable so it can act as a reliable fallback when
 * Gemini is unavailable.
 */
import { formatInTimeZone } from 'date-fns-tz';
import type { ExtractedImage, NewsSignals } from './newsExtract';

export interface PolicyInput {
  text: string;
  images: ExtractedImage[];
  eventDate?: string | Date;
  uploadDate?: string | Date;
  signals: NewsSignals;
  nowJkt: Date;
}

export interface CoreInfoEvidence {
  who: string[];
  when: string[];
  where: string[];
}

export interface PolicyDetails {
  missingCoreInfo?: string[];
  coreInfoEvidence?: CoreInfoEvidence;
  sentenceCount?: number;
  wordCount?: number;
  languageScore?: number;
  journalismIssues?: string[];
  imageCount?: number;
  externalImageHosts?: string[];
  eventDate?: Date;
  uploadDate?: Date;
  now?: Date;
  routineKeywordsHit?: string[];
  newsworthyKeywordsHit?: string[];
  freshnessIssues?: string[];
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
const JAKARTA_TZ = 'Asia/Jakarta';

const INDONESIAN_FUNCTION_WORDS = new Set([
  'ada',
  'agar',
  'akan',
  'antara',
  'atau',
  'bahwa',
  'bagi',
  'dalam',
  'dan',
  'dari',
  'dengan',
  'di',
  'hingga',
  'ini',
  'itu',
  'juga',
  'karena',
  'kepada',
  'melalui',
  'menjadi',
  'oleh',
  'pada',
  'para',
  'sebagai',
  'serta',
  'setelah',
  'tersebut',
  'untuk',
  'yang',
]);

const ENGLISH_FUNCTION_WORDS = new Set([
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'is',
  'of',
  'on',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'with',
]);

const INDONESIAN_AFFIX_PATTERN =
  /^(?:ber|di|ke|me|mem|men|meng|pe|pem|pen|peng|per|se|ter)[a-z]{4,}(?:kan|i|an|nya)?$/u;

const ROUTINE_PATTERNS: Array<[string, RegExp]> = [
  ['apel pagi', /\bapel\s+pagi\b/iu],
  ['apel sore', /\bapel\s+sore\b/iu],
  ['briefing', /\bbriefing\b/iu],
  ['coffee morning', /\bcoffee\s+morning\b/iu],
  ['senam/olahraga', /\b(?:senam|olahraga)\b/iu],
  ['kerja bakti', /\bkerja\s+bakti\b/iu],
  ['istighosah', /\bistighosah\b/iu],
  ['kultum', /\bkultum\b/iu],
  ['Jumat berkah', /\bjum(?:at|\u2019at)\s+berkah\b/iu],
  ['kegiatan rutin', /\b(?:kegiatan\s+)?rutin(?:itas)?\b/iu],
  ['agenda berkala', /\b(?:setiap\s+(?:hari|minggu|senin|bulan)|agenda\s+berkala)\b/iu],
];

const NEWSWORTHY_PATTERNS: Array<[string, RegExp]> = [
  ['pelantikan/peresmian', /\b(?:pelantikan|dilantik|peresmian|diresmikan)\b/iu],
  ['penghargaan/prestasi', /\b(?:penghargaan|anugerah|juara|prestasi|rekor)\b/iu],
  ['inovasi/peluncuran', /\b(?:inovasi|peluncuran|diluncurkan|layanan\s+baru)\b/iu],
  [
    'kerja sama resmi',
    /\b(?:penandatanganan|nota\s+kesepahaman|perjanjian\s+kerja\s+sama|mou)\b/iu,
  ],
  [
    'keputusan/hasil penting',
    /\b(?:memutuskan|keputusan|menghasilkan|menetapkan|capaian|realisasi)\b/iu,
  ],
  [
    'pendidikan resmi',
    /\b(?:seminar|simposium|bimbingan\s+teknis|diklat|workshop|asistensi|pendampingan|sosialisasi)\b/iu,
  ],
  [
    'kampanye publik/integritas',
    /\b(?:public\s+campaign|kampanye\s+publik|zona\s+integritas)\b/iu,
  ],
  [
    'koordinasi strategis',
    /\b(?:rapat\s+koordinasi|evaluasi\s+kinerja|program\s+prioritas)\b/iu,
  ],
  [
    'penanganan kejadian',
    /\b(?:bencana|darurat|evakuasi|penanganan|bantuan\s+kemanusiaan)\b/iu,
  ],
  [
    'proses hukum penting',
    /\b(?:putusan|persidangan|sidang|mediasi\s+berhasil|eksekusi)\b/iu,
  ],
];

const ROLE_WORDS = [
  'bupati',
  'wakil bupati',
  'wali kota',
  'ketua',
  'wakil ketua',
  'kepala',
  'sekretaris',
  'hakim',
  'panitera',
  'narasumber',
  'pemateri',
  'direktur',
  'menteri',
  'gubernur',
  'camat',
  'lurah',
];

const PERSON_ENTITY_STOP_PHRASES = [
  'Pemerintah Kabupaten',
  'Pemerintah Kota',
  'Pengadilan Agama',
  'Pengadilan Tinggi',
  'Mahkamah Agung',
  'Aula Pengadilan',
  'Ruang Sidang',
  'Hari Senin',
  'Hari Selasa',
  'Hari Rabu',
  'Hari Kamis',
  'Hari Jumat',
  'Acara Berlangsung',
  'Agenda Utama',
];

interface LanguageAnalysis {
  ok: boolean;
  score: number;
  wordCount: number;
  issues: string[];
}

interface RoutineAnalysis {
  routineHits: string[];
  newsworthyHits: string[];
  routineOnly: boolean;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** Evaluate I1 and T1-T5 in a stable order and retain evidence for messages. */
export function evaluateAgainstPolicy(input: PolicyInput): PolicyResult {
  const { text, images = [], eventDate, uploadDate, signals, nowJkt } = input;
  const normalizedText = normalizeWhitespace(text);
  const details: PolicyDetails = {
    imageCount: signals.imageCount,
    now: nowJkt,
  };
  const violations: string[] = [];

  const externalHosts = detectExternalImageHosts(images);
  if (externalHosts.length > 0) {
    details.externalImageHosts = externalHosts;
  }
  const hostedImageCount = Math.max(
    signals.hostedImageCount ?? 0,
    signals.allowedHostCount ?? 0,
    externalHosts.length,
  );
  if (hostedImageCount === 0) {
    violations.push(RULE_IMAGE_HOSTING);
  }

  const language = analyzeLanguageAndJournalism(normalizedText);
  details.languageScore = language.score;
  details.wordCount = language.wordCount;
  if (language.issues.length > 0) {
    details.journalismIssues = language.issues;
  }
  if (!language.ok) {
    violations.push(RULE_BAHASA);
  }

  const coreInfo = analyzeCoreInformation(text, eventDate);
  details.coreInfoEvidence = coreInfo.evidence;
  if (coreInfo.missing.length > 0) {
    details.missingCoreInfo = coreInfo.missing;
    violations.push(RULE_CORE_INFO);
  }

  const sentenceCount = splitInformativeSentences(normalizedText).length;
  details.sentenceCount = sentenceCount;
  if (sentenceCount < 12) {
    violations.push(RULE_SENTENCE_COUNT);
  }

  const freshness = analyzeFreshness(eventDate, uploadDate, nowJkt);
  details.eventDate = freshness.eventDate;
  details.uploadDate = freshness.uploadDate;
  details.workingDaysToEvaluation = freshness.workingDaysToEvaluation;
  details.workingDaysToUpload = freshness.workingDaysToUpload;
  if (freshness.issues.length > 0) {
    details.freshnessIssues = freshness.issues;
    violations.push(RULE_FRESHNESS);
  }

  const routine = analyzeRoutineContent(normalizedText);
  if (routine.routineHits.length > 0) {
    details.routineKeywordsHit = routine.routineHits;
  }
  if (routine.newsworthyHits.length > 0) {
    details.newsworthyKeywordsHit = routine.newsworthyHits;
  }
  if (routine.routineOnly) {
    violations.push(RULE_ROUTINE);
  }

  return { violations, details };
}

function analyzeLanguageAndJournalism(text: string): LanguageAnalysis {
  const words = tokenize(text);
  const sentences = splitInformativeSentences(text);
  const issues: string[] = [];
  if (words.length === 0) {
    return {
      ok: false,
      score: 0,
      wordCount: 0,
      issues: ['Teks berita kosong atau tidak dapat dibaca.'],
    };
  }

  const functionWordHits = words.filter((word) =>
    INDONESIAN_FUNCTION_WORDS.has(word),
  ).length;
  const affixHits = words.filter((word) => INDONESIAN_AFFIX_PATTERN.test(word)).length;
  const englishHits = words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length;
  const markerRatio =
    (functionWordHits + Math.min(affixHits, words.length * 0.2)) / words.length;
  const englishRatio = englishHits / words.length;
  const sentenceWordCounts = sentences.map((sentence) => tokenize(sentence).length);
  const averageSentenceWords =
    sentenceWordCounts.length > 0
      ? sentenceWordCounts.reduce((sum, count) => sum + count, 0) /
        sentenceWordCounts.length
      : words.length;
  const shortSentenceRatio =
    sentenceWordCounts.length > 0
      ? sentenceWordCounts.filter((count) => count < 3).length / sentenceWordCounts.length
      : 1;
  const alphabeticCharacters = Array.from(text).filter((char) => /\p{L}/u.test(char));
  const uppercaseCharacters = alphabeticCharacters.filter(
    (char) => char === char.toUpperCase() && char !== char.toLowerCase(),
  );
  const uppercaseRatio =
    alphabeticCharacters.length > 0
      ? uppercaseCharacters.length / alphabeticCharacters.length
      : 0;
  const punctuationAbuse = /[!?]{3,}|\.{4,}|,{3,}/u.test(text);

  let score = 0;
  if (markerRatio >= 0.12) score += 0.35;
  else if (markerRatio >= 0.07) score += 0.2;
  else if (markerRatio >= 0.04) score += 0.1;
  if (englishRatio <= 0.04) score += 0.15;
  else if (englishRatio <= 0.1) score += 0.07;
  if (words.length >= 80) score += 0.15;
  else if (words.length >= 45) score += 0.1;
  else if (words.length >= 25) score += 0.04;
  if (averageSentenceWords >= 4 && averageSentenceWords <= 35) score += 0.2;
  else if (averageSentenceWords <= 45) score += 0.08;
  if (shortSentenceRatio <= 0.25) score += 0.1;
  if (uppercaseRatio <= 0.18 && !punctuationAbuse) score += 0.05;
  score = Math.min(1, Number(score.toFixed(2)));

  if (markerRatio < 0.07 || englishRatio > Math.max(0.12, markerRatio)) {
    issues.push('Ciri kosakata Bahasa Indonesia tidak cukup kuat.');
  }
  if (words.length < 45) {
    issues.push(`Teks terlalu singkat untuk berita utuh (${words.length} kata).`);
  }
  if (averageSentenceWords > 35) {
    issues.push(
      `Rata-rata kalimat terlalu panjang (${averageSentenceWords.toFixed(1)} kata per kalimat).`,
    );
  }
  if (shortSentenceRatio > 0.35) {
    issues.push('Terlalu banyak fragmen atau kalimat yang sangat pendek.');
  }
  if (uppercaseRatio > 0.25) {
    issues.push('Penggunaan huruf kapital berlebihan.');
  }
  if (punctuationAbuse) {
    issues.push('Penggunaan tanda baca berlebihan atau tidak wajar.');
  }

  return {
    ok: score >= 0.58 && markerRatio >= 0.07 && englishRatio <= 0.12,
    score,
    wordCount: words.length,
    issues,
  };
}

function analyzeCoreInformation(
  text: string,
  eventDate?: string | Date,
): {
  missing: string[];
  evidence: CoreInfoEvidence;
} {
  const normalized = normalizeWhitespace(text);
  const evidence: CoreInfoEvidence = {
    who: findPersonEvidence(normalized),
    when: findPatternEvidence(normalized, [
      /\b(?:senin|selasa|rabu|kamis|jumat|jum\u2019at|sabtu|ahad)\b[^.!?]{0,45}/giu,
      /\bhari\s+minggu\b[^.!?]{0,45}/giu,
      /\b\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}\b/giu,
      /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gu,
      /\b(?:pukul|jam)\s+\d{1,2}(?:[.:]\d{2})?(?:\s*(?:wib|wita|wit))?\b/giu,
      /\b(?:kemarin|hari\s+ini|pekan\s+ini|bulan\s+ini)\b/giu,
    ]),
    where: findPatternEvidence(normalized, [
      /\b(?:secara\s+)?(?:daring|virtual|online)\b/giu,
      /\b(?:zoom|telekonferensi|video\s+conference|google\s+meet|microsoft\s+teams)\b/giu,
      /^(?:[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,3}),\s*(?=\d{1,2}\s|(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu)\b)/gu,
      /\b(?:di|pada)\s+(?:aula|kantor|balai|gedung|ruang(?:an)?|lapangan|halaman|area|masjid|hotel|media\s+center|ptsp|desa|kelurahan|kecamatan|kabupaten|kota|pengadilan|sekolah|kampus)[^,.!?;]{0,70}/giu,
      /\b(?:aula|kantor|balai|gedung(?:\s+arsip)?|ruang(?:an)?|hotel|media\s+center|area\s+ptsp)\s+[A-Z][^,.!?;]{2,60}/gu,
      /\b(?:bertempat|berlokasi|diselenggarakan|digelar|berlangsung|dipusatkan|dilaksanakan)\s+(?:di|pada)\s+[^,.!?;]{3,70}/giu,
      /\b(?:pengadilan\s+agama|kantor|balai|kampus)\s+[^,.!?;]{2,60}\s+menjadi\s+tuan\s+rumah\b/giu,
    ]),
  };

  if (evidence.when.length === 0) {
    const structuredDate = toJakartaDateParts(eventDate);
    if (structuredDate) {
      evidence.when.push(
        `Tanggal kegiatan terstruktur: ${structuredDate.year}-${String(
          structuredDate.month,
        ).padStart(2, '0')}-${String(structuredDate.day).padStart(2, '0')}`,
      );
    }
  }

  const missing: string[] = [];
  if (evidence.when.length === 0) missing.push('Kapan');
  if (evidence.where.length === 0) missing.push('Di mana');
  if (evidence.who.length === 0) missing.push('Siapa');
  return { missing, evidence };
}

function findPersonEvidence(text: string): string[] {
  const evidence = new Set<string>();
  const roleAlternation = ROLE_WORDS.map(escapeRegExp).join('|');
  const rolePattern = new RegExp(`\\b(?:${roleAlternation})\\b`, 'giu');
  const capitalizedName =
    /\b(?:Dr\.?\s+|Ir\.?\s+|H\.?\s+|Hj\.?\s+)?\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){1,4}\b/u;
  for (const match of text.matchAll(rolePattern)) {
    const start = match.index ?? 0;
    const clause = text.slice(start, start + 120).split(/[.!?;]/u)[0] ?? '';
    if (capitalizedName.test(clause)) {
      evidence.add(normalizeWhitespace(clause).slice(0, 100));
    }
  }

  const attributionPattern =
    /\b(?:menurut|ujar|kata|jelas|ungkap|tutur|sambung|oleh)\s+(?:Dr\.?\s+|Ir\.?\s+|H\.?\s+|Hj\.?\s+)?([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,4})/gu;
  for (const match of text.matchAll(attributionPattern)) {
    evidence.add(normalizeWhitespace(match[0]).slice(0, 100));
  }

  if (evidence.size === 0) {
    const properNames =
      /\b(?:Dr\.?\s+|Ir\.?\s+|H\.?\s+|Hj\.?\s+)?[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,3}\b/gu;
    for (const match of text.matchAll(properNames)) {
      const candidate = normalizeWhitespace(match[0]);
      if (
        candidate &&
        !PERSON_ENTITY_STOP_PHRASES.some((phrase) =>
          candidate.toLowerCase().startsWith(phrase.toLowerCase()),
        )
      ) {
        evidence.add(candidate);
      }
      if (evidence.size >= 3) break;
    }
  }
  return Array.from(evidence).slice(0, 3);
}

function findPatternEvidence(text: string, patterns: RegExp[]): string[] {
  const evidence = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeWhitespace(match[0]);
      if (candidate) evidence.add(candidate.slice(0, 100));
      if (evidence.size >= 3) return Array.from(evidence);
    }
  }
  return Array.from(evidence);
}

/** Split prose while protecting titles, legal degrees, decimals, and clock times. */
export function splitInformativeSentences(text: string): string[] {
  if (!text.trim()) return [];
  const protectedToken = '\uE000';
  let prepared = normalizeWhitespace(text)
    .replace(/\b(?:Dr|Drs|Dra|Ir|Hj|Prof|No|Nomor|Jl|Sdr|Sdri)\./giu, (value) =>
      value.replace(/\./g, protectedToken),
    )
    .replace(/\b(?:S|M|A)\.(?:H|Ag|Pd|Si|Kom|Kn|Ak)\.(?:[A-Z]\.)?/gu, (value) =>
      value.replace(/\./g, protectedToken),
    )
    .replace(/(?<=\d)\.(?=\d)/gu, protectedToken);

  prepared = prepared.replace(/([.!?]+["'\u201d\u2019)]*)\s+/gu, '$1\n');
  return prepared
    .split(/\n+/u)
    .map((sentence) => sentence.split(protectedToken).join('.').trim())
    .filter((sentence) => tokenize(sentence).length >= 2);
}

function analyzeFreshness(
  eventDateRaw: string | Date | undefined,
  uploadDateRaw: string | Date | undefined,
  now: Date,
): {
  eventDate?: Date;
  uploadDate?: Date;
  workingDaysToEvaluation?: number;
  workingDaysToUpload?: number;
  issues: string[];
} {
  const eventParts = toJakartaDateParts(eventDateRaw);
  const uploadParts = toJakartaDateParts(uploadDateRaw);
  const evaluationParts = toJakartaDateParts(now);
  const issues: string[] = [];
  const eventDate = eventParts ? datePartsToDate(eventParts) : undefined;
  const uploadDate = uploadParts ? datePartsToDate(uploadParts) : undefined;

  if (!eventParts) {
    issues.push('Tanggal kegiatan tidak ditemukan atau tidak valid.');
    return { eventDate, uploadDate, issues };
  }
  if (!evaluationParts) {
    issues.push('Tanggal penilaian tidak valid.');
    return { eventDate, uploadDate, issues };
  }

  const eventOrdinal = dateOrdinal(eventParts);
  const evaluationOrdinal = dateOrdinal(evaluationParts);
  if (eventOrdinal > evaluationOrdinal) {
    issues.push('Tanggal kegiatan berada setelah tanggal penilaian.');
  }

  const workingDaysToEvaluation = workingDaysBetween(eventParts, evaluationParts);
  if (workingDaysToEvaluation > 2) {
    issues.push(
      `Berita dikonfirmasi ${workingDaysToEvaluation} hari kerja setelah kegiatan (maksimal 2).`,
    );
  }

  let workingDaysToUpload: number | undefined;
  if (uploadParts) {
    if (dateOrdinal(uploadParts) < eventOrdinal) {
      issues.push('Tanggal upload berada sebelum tanggal kegiatan.');
    } else {
      workingDaysToUpload = workingDaysBetween(eventParts, uploadParts);
      if (workingDaysToUpload > 1) {
        issues.push(
          `Berita diunggah ${workingDaysToUpload} hari kerja setelah kegiatan (maksimal 1).`,
        );
      }
    }
  }

  return {
    eventDate,
    uploadDate,
    workingDaysToEvaluation,
    workingDaysToUpload,
    issues,
  };
}

function analyzeRoutineContent(text: string): RoutineAnalysis {
  const routineHits = ROUTINE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([label]) => label,
  );
  const newsworthyHits = NEWSWORTHY_PATTERNS.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([label]) => label);
  const outcomeEvidence =
    /\b(?:berhasil|meningkat|menurun|ditargetkan|ditetapkan|disepakati|mengumumkan)\b/iu.test(
      text,
    ) ||
    /\b(?:menyerahkan|menerima)\s+(?:penghargaan|bantuan|sertifikat|piagam|hadiah|putusan)\b/iu.test(
      text,
    );
  const routineOccurrences = ROUTINE_PATTERNS.reduce((count, [, pattern]) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return count + Array.from(text.matchAll(new RegExp(pattern.source, flags))).length;
  }, 0);
  const routineIsMainSubject = ROUTINE_PATTERNS.some(([, pattern]) =>
    pattern.test(text.slice(0, 320)),
  );
  return {
    routineHits,
    newsworthyHits,
    routineOnly:
      routineHits.length > 0 &&
      (routineIsMainSubject || routineOccurrences >= 2) &&
      newsworthyHits.length === 0 &&
      !outcomeEvidence,
  };
}

function detectExternalImageHosts(images: ExtractedImage[]): string[] {
  const externalHosts = new Set<string>();
  for (const image of images) {
    const src = image?.src?.trim();
    if (!src || /^(?:data|blob):/iu.test(src) || !/^https?:\/\//iu.test(src)) {
      continue;
    }
    try {
      const host = new URL(src).hostname.toLowerCase();
      if (isExternalHostingHost(host)) externalHosts.add(host);
    } catch {
      // Invalid image URLs do not satisfy the hosting rule.
    }
  }
  return Array.from(externalHosts);
}

function isExternalHostingHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1') return false;
  if (host.endsWith('.go.id')) return false;
  if (host.includes('bangkalan') || host.includes('gandrung')) return false;
  return true;
}

function toJakartaDateParts(value?: string | Date): DateParts | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/u);
    if (dateOnly) {
      return validateDateParts({
        year: Number(dateOnly[1]),
        month: Number(dateOnly[2]),
        day: Number(dateOnly[3]),
      });
    }
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const label = formatInTimeZone(parsed, JAKARTA_TZ, 'yyyy-MM-dd');
  const [year, month, day] = label.split('-').map(Number);
  return validateDateParts({ year, month, day });
}

function validateDateParts(parts: DateParts): DateParts | undefined {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() !== parts.month - 1 ||
    date.getUTCDate() !== parts.day
  ) {
    return undefined;
  }
  return parts;
}

function datePartsToDate(parts: DateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function dateOrdinal(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

function workingDaysBetween(start: DateParts, end: DateParts): number {
  if (dateOrdinal(start) >= dateOrdinal(end)) return 0;
  let count = 0;
  let cursor = datePartsToDate(start);
  const endOrdinal = dateOrdinal(end);
  while (cursor.getTime() / 86_400_000 < endOrdinal) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
