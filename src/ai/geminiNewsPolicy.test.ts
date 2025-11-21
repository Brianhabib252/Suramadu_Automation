import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const generateContentMock = vi.fn();
const googleGenAiCtor = vi.fn().mockImplementation(() => ({
  models: {
    generateContent: (options: unknown) => generateContentMock(options),
  },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: googleGenAiCtor,
}));

const ORIGINAL_ENV = {
  GEMINI_DEFAULT_MODEL: process.env.GEMINI_DEFAULT_MODEL,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_FALLBACK_MODELS: process.env.GEMINI_FALLBACK_MODELS,
  GEMINI_POLICY_RETRIES: process.env.GEMINI_POLICY_RETRIES,
};

function restoreEnv(): void {
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}

describe('Gemini model resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    generateContentMock.mockReset();
    googleGenAiCtor.mockClear();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('prioritizes env-configured fallbacks before built-in models', async () => {
    process.env.GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
    delete process.env.GEMINI_MODEL;
    process.env.GEMINI_FALLBACK_MODELS = ' gemini-2.0-flash , gemini-2.0 ';

    const { resolveModelCandidates } = await import('./geminiNewsPolicy');
    const order = resolveModelCandidates();

    expect(order.slice(0, 3)).toEqual([
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0',
    ]);
  });

  it('switches to fallback models when the primary exhausts retries', async () => {
    process.env.GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
    process.env.GEMINI_FALLBACK_MODELS = 'gemini-2.0-flash';
    process.env.GEMINI_POLICY_RETRIES = '0';
    const successPayload = JSON.stringify({
      ok: true,
      violations: [],
      reasons: [],
      confidence: 0.9,
    });

    generateContentMock.mockImplementation(({ model }: { model: string }) => {
      if (model === 'gemini-2.5-flash') {
        return Promise.reject(
          new Error(
            'got status: 503 Service Unavailable. {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
          ),
        );
      }
      if (model === 'gemini-2.0-flash') {
        return Promise.resolve({
          response: { text: () => successPayload },
        });
      }
      return Promise.reject(new Error(`unexpected model ${model}`));
    });

    const { callGeminiPolicy } = await import('./geminiNewsPolicy');
    const result = await callGeminiPolicy({
      apiKey: 'test',
      text: 'Contoh artikel',
      html: undefined,
      signals: {
        paragraphCount: 1,
        minSentencesPerParagraph: 1,
        imageCount: 1,
        allowedHostCount: 1,
        hostedImageCount: 1,
        sentenceCount: 12,
      },
    });

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(
      generateContentMock.mock.calls.map(([options]) => options.model),
    ).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
    expect(result.ok).toBe(true);
  });
});
