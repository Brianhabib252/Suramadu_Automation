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
const originalDisableFallback = process.env.GEMINI_DISABLE_LOCAL_FALLBACK;

describe('policyLLM.aiEvaluate', () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_DISABLE_LOCAL_FALLBACK;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalEnv;
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
      expect.stringContaining('Dikonfirmasi oleh AI'),
    );
    expect(result.rejection_message).toBeDefined();
    expect(result.rejection_message?.toLowerCase()).toContain(
      'dikonfirmasi oleh ai',
    );
    expect(result.verification?.outcome).toBe('confirmed');
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
});
