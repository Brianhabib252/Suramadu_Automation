import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { GeminiPolicyPayload } from '../ai/geminiNewsPolicy';
import type { NewsExtractionResult } from './newsExtract';
import { aiEvaluate } from './policyLLM';

const baseExtraction: Pick<
  NewsExtractionResult,
  'html' | 'text' | 'signals' | 'images' | 'eventDate'
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
};

const originalEnv = process.env.GEMINI_API_KEY;

describe('policyLLM.aiEvaluate', () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalEnv;
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
    } satisfies GeminiPolicyPayload);

    const result = await aiEvaluate(
      {
        extraction: baseExtraction,
        now: new Date('2024-10-11T00:00:00.000Z'),
      },
      { geminiCaller: stub },
    );

    expect(stub).toHaveBeenCalledOnce();
    expect(result.source).toBe('gemini');
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['#T1 Bahasa/Jurnalistik']);
    expect(result.rejection_message_id).toBe('perbaiki_bahasa');
    expect(result.reasons).toContain('Perbaiki penggunaan bahasa sesuai kaidah.');
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
});
