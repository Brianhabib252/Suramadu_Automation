import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { GeminiPolicyPayload } from '../ai/geminiNewsPolicy';
import type { NewsExtractionResult } from './newsExtract';
import { aiEvaluate } from './policyLLM';

const baseExtraction: Pick<
  NewsExtractionResult,
  'html' | 'text' | 'signals' | 'images' | 'eventDate' | 'uploadDate'
> = {
  html: '<p>Example</p>',
  text:
    'Apa yang terjadi dan siapa yang hadir? Di mana dan kapan kegiatan berlangsung? Mengapa ini penting menurut pimpinan.',
  signals: {
    paragraphCount: 4,
    minSentencesPerParagraph: 3,
    imageCount: 2,
    allowedHostCount: 1,
    hostedImageCount: 1,
    sentenceCount: 12,
  },
  images: [
    { src: 'https://i.ibb.co/sample-one.png', alt: 'a' },
    { src: 'https://i.ibb.co/sample-two.png', alt: 'b' },
  ],
  eventDate: '2024-10-10T00:00:00.000Z',
  uploadDate: '2024-10-11T00:00:00.000Z',
};

const originalEnv = process.env.GEMINI_API_KEY;
const originalEnv1 = process.env.GEMINI_API_KEY_1;
const originalEnv2 = process.env.GEMINI_API_KEY_2;
const originalEnv3 = process.env.GEMINI_API_KEY_3;
const originalDisableFallback = process.env.GEMINI_DISABLE_LOCAL_FALLBACK;

describe('policyLLM.aiEvaluate', () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY_1;
    delete process.env.GEMINI_API_KEY_2;
    delete process.env.GEMINI_API_KEY_3;
    delete process.env.GEMINI_DISABLE_LOCAL_FALLBACK;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalEnv;
    }
    if (originalEnv1 === undefined) {
      delete process.env.GEMINI_API_KEY_1;
    } else {
      process.env.GEMINI_API_KEY_1 = originalEnv1;
    }
    if (originalEnv2 === undefined) {
      delete process.env.GEMINI_API_KEY_2;
    } else {
      process.env.GEMINI_API_KEY_2 = originalEnv2;
    }
    if (originalEnv3 === undefined) {
      delete process.env.GEMINI_API_KEY_3;
    } else {
      process.env.GEMINI_API_KEY_3 = originalEnv3;
    }
    if (originalDisableFallback === undefined) {
      delete process.env.GEMINI_DISABLE_LOCAL_FALLBACK;
    } else {
      process.env.GEMINI_DISABLE_LOCAL_FALLBACK = originalDisableFallback;
    }
  });

  it('falls back to local policy when no Gemini key', async () => {
    const result = await aiEvaluate({
      extraction: baseExtraction,
      now: new Date('2024-10-11T00:00:00.000Z'),
    });

    expect(result.source).toBe('local');
    expect(result.violations.length).toBeGreaterThanOrEqual(0);
  });

  it('returns a complete and specific local rejection message', async () => {
    const extraction = {
      ...baseExtraction,
      text:
        'Pada hari Senin pegawai mengikuti apel pagi di kantor. Kegiatan rutin berjalan tertib. Pegawai kemudian kembali bekerja.',
      eventDate: undefined,
      uploadDate: undefined,
      signals: {
        ...baseExtraction.signals,
        sentenceCount: 3,
      },
    };

    const result = await aiEvaluate({
      extraction,
      now: new Date('2024-10-11T00:00:00.000Z'),
    });

    expect(result.source).toBe('local');
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        '#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)',
        '#T3 Jumlah Kalimat',
        '#T4 Up to date',
        '#T5 Informatif',
      ]),
    );
    expect(result.rejection_message).toContain('Saat ini baru 3 kalimat');
    expect(result.rejection_message).toContain('Tanggal kegiatan tidak ditemukan');
    expect(result.rejection_message).toContain('apel pagi');
    expect(result.rejection_message).toContain('Dikonfirmasi Otomatis');
  });

  it('uses Gemini output when API key is available', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const stub = vi.fn().mockResolvedValue({
      ok: false,
      violations: ['#T1 Bahasa/Jurnalistik'],
      reasons: ['Perbaiki penggunaan bahasa sesuai kaidah.'],
      confidence: 0.8,
      rejection_message_id: 'perbaiki_bahasa',
      rejection_message: 'Penggunaan bahasa belum sesuai kaidah.',
    } satisfies GeminiPolicyPayload);
    const verificationStub = vi.fn().mockResolvedValue({
      ok: false,
      violations: ['#T1 Bahasa/Jurnalistik'],
      reasons: ['Penolakan tetap berlaku.'],
      confidence: 0.76,
      rejection_message: undefined,
      rejection_message_id: undefined,
    } satisfies GeminiPolicyPayload);

    const result = await aiEvaluate(
      {
        extraction: baseExtraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub, geminiVerificationCaller: verificationStub },
    );

    expect(stub).toHaveBeenCalledOnce();
    expect(verificationStub).toHaveBeenCalledOnce();
    expect(result.source).toBe('gemini');
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['#T1 Bahasa/Jurnalistik']);
    expect(result.rejection_message_id).toBe('perbaiki_bahasa');
    expect(result.reasons).toContainEqual(
      expect.stringContaining('Dikonfirmasi Otomatis'),
    );
    expect(result.rejection_message).toBeDefined();
    expect(result.rejection_message?.toLowerCase()).toContain(
      'dikonfirmasi otomatis',
    );
    expect(result.verification?.outcome).toBe('confirmed');
  });

  it('passes configured API keys in fallback order to Gemini callers', async () => {
    process.env.GEMINI_API_KEY_1 = 'key-one';
    process.env.GEMINI_API_KEY_2 = 'key-two';
    process.env.GEMINI_API_KEY_3 = 'key-three';
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      violations: [],
      reasons: ['Berita lolos pemeriksaan AI.'],
      confidence: 0.9,
      rejection_message_id: undefined,
      rejection_message: undefined,
    } satisfies GeminiPolicyPayload);

    const result = await aiEvaluate(
      {
        extraction: baseExtraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub },
    );

    expect(stub).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'key-one',
        apiKeys: ['key-one', 'key-two', 'key-three'],
      }),
    );
    expect(result.source).toBe('gemini');
  });

  it('overturns rejection when verification approves the article', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const stub = vi.fn().mockResolvedValue({
      ok: false,
      violations: ['#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)'],
      reasons: ['Tidak ditemukan unsur di mana.'],
      confidence: 0.6,
      rejection_message_id: 'unsur_nama_waktu_lokasi',
      rejection_message: 'Tidak ditemukan unsur lokasi.',
    } satisfies GeminiPolicyPayload);
    const verificationStub = vi.fn().mockResolvedValue({
      ok: true,
      violations: [],
      reasons: ['Verifikasi ulang: lokasi sebenarnya disebutkan.'],
      confidence: 0.74,
      rejection_message_id: undefined,
      rejection_message: undefined,
    } satisfies GeminiPolicyPayload);

    const result = await aiEvaluate(
      {
        extraction: baseExtraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub, geminiVerificationCaller: verificationStub },
    );

    expect(stub).toHaveBeenCalledOnce();
    expect(verificationStub).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.rejection_message).toBeUndefined();
    expect(result.source).toBe('gemini');
    expect(result.verification?.outcome).toBe('overturned');
    expect(result.reasons.join(' ')).toContain('Verifikasi');
  });

  it('drops Gemini #T3 when local sentence count is sufficient', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const stub = vi.fn().mockResolvedValue({
      ok: false,
      violations: ['#T3 Jumlah Kalimat'],
      reasons: ['Jumlah kalimat informatif lebih dari 12.'],
      confidence: 0.42,
      rejection_message_id: 't3',
      rejection_message: 'Jumlah kalimat kurang dari 12.',
    } satisfies GeminiPolicyPayload);
    const verificationStub = vi.fn().mockResolvedValue({
      ok: false,
      violations: ['#T3 Jumlah Kalimat'],
      reasons: ['Penolakan awal tetap berlaku.'],
      confidence: 0.4,
      rejection_message_id: 't3',
      rejection_message: 'Kalimat kurang.',
    } satisfies GeminiPolicyPayload);

    const sentences = [
      'Kegiatan Suramadu berlangsung pada hari Rabu, 9 Oktober 2024 di Aula BKPSDM Surabaya.',
      'Acara resmi dimulai pukul 09.00 WIB.',
      'Budi Santoso selaku Kepala Dinas membuka pidato pembukaan.',
      'Tri Risma hadir mewakili Pemerintah Kota Surabaya.',
      'Para camat dan lurah mengikuti kegiatan tersebut.',
      'Agenda utama membahas layanan publik terpadu.',
      'Tim inovasi memaparkan capaian semester ketiga.',
      'Peserta berdiskusi kelompok mengenai strategi pelayanan.',
      'Moderator menjelaskan jadwal implementasi program.',
      'Panitia menyediakan dokumentasi lengkap untuk media.',
      'Rapat ditutup dengan penandatanganan komitmen bersama.',
      'Seluruh peserta meninggalkan aula kota setelah sesi foto.',
    ];
    const longText = sentences.join(' ');
    const extraction = {
      ...baseExtraction,
      text: longText,
      signals: {
        ...baseExtraction.signals,
        sentenceCount: 12,
      },
    };

    const result = await aiEvaluate(
      {
        extraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub, geminiVerificationCaller: verificationStub },
    );

    expect(stub).toHaveBeenCalledOnce();
    expect(verificationStub).toHaveBeenCalledOnce();
    expect(result.source).toBe('gemini');
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.reasons).toContain('Berita memenuhi seluruh kebijakan lokal.');
  });

  it('falls back to local when Gemini throws', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const stub = vi.fn().mockRejectedValue(new Error('rate limited'));

    const result = await aiEvaluate(
      {
        extraction: baseExtraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub },
    );

    expect(stub).toHaveBeenCalledOnce();
    expect(result.source).toBe('local');
  });

  it('allows fallback when Gemini returns service unavailable errors even if disabled', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_DISABLE_LOCAL_FALLBACK = 'true';
    const serverError = Object.assign(new Error('The model is overloaded. Please try again later.'), {
      status: 503,
      error: {
        code: 503,
        status: 'UNAVAILABLE',
        message: 'The model is overloaded. Please try again later.',
      },
    });
    const stub = vi.fn().mockRejectedValue(serverError);

    const result = await aiEvaluate(
      {
        extraction: baseExtraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub },
    );

    expect(stub).toHaveBeenCalledOnce();
    expect(result.source).toBe('local');
    expect(result.timeoutWarning).toBe(true);
  });

  it('keeps using local policy for non-temporary Gemini failures', async () => {
    process.env.GEMINI_API_KEY = 'invalid-key';
    process.env.GEMINI_DISABLE_LOCAL_FALLBACK = 'true';
    const stub = vi.fn().mockRejectedValue(
      Object.assign(new Error('API key is invalid.'), {
        status: 401,
        code: 'UNAUTHENTICATED',
      }),
    );

    const result = await aiEvaluate(
      {
        extraction: baseExtraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub },
    );

    expect(stub).toHaveBeenCalledOnce();
    expect(result.source).toBe('local');
    expect(result.ok).toBe(false);
  });
});
