import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const generateContentMock = vi.fn();
const googleGenAiCtor = vi.fn().mockImplementation(({ apiKey }: { apiKey: string }) => ({
  models: {
    generateContent: (options: Record<string, unknown>) =>
      generateContentMock({ ...options, apiKey }),
  },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: googleGenAiCtor,
}));

const ORIGINAL_ENV = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_API_KEY_1: process.env.GEMINI_API_KEY_1,
  GEMINI_API_KEY_2: process.env.GEMINI_API_KEY_2,
  GEMINI_API_KEY_3: process.env.GEMINI_API_KEY_3,
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
    process.env.GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
    delete process.env.GEMINI_MODEL;
    process.env.GEMINI_FALLBACK_MODELS = ' gemini-2.5-flash ';

    const { resolveModelCandidates } = await import('./geminiNewsPolicy');
    const order = resolveModelCandidates();

    expect(order.slice(0, 2)).toEqual([
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
    ]);
  });

  it('normalizes legacy 3.0 aliases to supported 2.5 model names', async () => {
    process.env.GEMINI_DEFAULT_MODEL = 'models/gemini-3.0-flash-lite';
    process.env.GEMINI_FALLBACK_MODELS = 'gemini-3.0-flash';

    const { resolveModelCandidates } = await import('./geminiNewsPolicy');
    const order = resolveModelCandidates();

    expect(order.slice(0, 3)).toEqual([
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
    ]);
  });

  it('reads up to three configured Gemini API keys in order', async () => {
    process.env.GEMINI_API_KEY_1 = 'first-key';
    process.env.GEMINI_API_KEY_2 = 'second-key';
    process.env.GEMINI_API_KEY_3 = 'third-key';
    process.env.GEMINI_API_KEY = 'second-key';

    const { resolveConfiguredGeminiApiKeys } = await import('./geminiNewsPolicy');

    expect(resolveConfiguredGeminiApiKeys()).toEqual([
      'first-key',
      'second-key',
      'third-key',
    ]);
  });

  it('switches to fallback models when the primary exhausts retries', async () => {
    process.env.GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
    process.env.GEMINI_FALLBACK_MODELS = 'gemini-2.5-flash';
    process.env.GEMINI_POLICY_RETRIES = '0';
    const successPayload = JSON.stringify({
      ok: true,
      violations: [],
      reasons: [],
      confidence: 0.9,
    });

    generateContentMock.mockImplementation(({ model }: { model: string }) => {
      if (model === 'gemini-2.5-flash-lite') {
        return Promise.reject(
          new Error(
            'got status: 503 Service Unavailable. {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
          ),
        );
      }
      if (model === 'gemini-2.5-flash') {
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
    ).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
    expect(result.ok).toBe(true);
  });

  it('rotates to the next API key when the current key is rate limited', async () => {
    process.env.GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
    process.env.GEMINI_POLICY_RETRIES = '0';
    const successPayload = JSON.stringify({
      ok: true,
      violations: [],
      reasons: [],
      confidence: 0.92,
    });

    generateContentMock.mockImplementation(
      ({ apiKey, model }: { apiKey: string; model: string }) => {
        if (apiKey === 'key-1') {
          return Promise.reject(
            Object.assign(new Error('Daily limit exceeded for this API key.'), {
              status: 429,
              error: {
                code: 429,
                status: 'RESOURCE_EXHAUSTED',
                message: 'Daily limit exceeded for this API key.',
              },
            }),
          );
        }
        if (apiKey === 'key-2' && model === 'gemini-2.5-flash-lite') {
          return Promise.resolve({
            response: { text: () => successPayload },
          });
        }
        return Promise.reject(new Error(`unexpected request ${apiKey}:${model}`));
      },
    );

    const { callGeminiPolicy } = await import('./geminiNewsPolicy');
    const result = await callGeminiPolicy({
      apiKey: 'key-1',
      apiKeys: ['key-1', 'key-2', 'key-3'],
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

    expect(
      generateContentMock.mock.calls.map(
        ([options]) => `${options.apiKey}:${options.model}`,
      ),
    ).toEqual([
      'key-1:gemini-2.5-flash-lite',
      'key-2:gemini-2.5-flash-lite',
    ]);
    expect(result.ok).toBe(true);
  });
});
