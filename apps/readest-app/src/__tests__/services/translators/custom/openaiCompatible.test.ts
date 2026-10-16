import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});
vi.mock('@/services/ai/utils/httpFetch', () => ({ getAIFetch: () => vi.fn() }));

import { createOpenAICompatibleTranslator } from '@/services/translators/custom/openaiCompatible';
import { renderPrompt, DEFAULT_TRANSLATION_PROMPT } from '@/services/translators/custom/prompts';
import { ErrorCodes } from '@/services/translators/types';
import type { CustomTranslator } from '@/types/translation';

const config: CustomTranslator = {
  id: 'abc',
  type: 'openai-compatible',
  name: 'My LLM',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  addedAt: 1,
  updatedAt: 1,
};

type GenerateArgs = { system: string; prompt: string };
const lastCall = (n = -1): GenerateArgs => generateTextMock.mock.calls.at(n)![0] as GenerateArgs;

const numbered = (texts: string[]) => texts.map((t, i) => `[${i + 1}]\n${t}`).join('\n\n');

describe('renderPrompt', () => {
  it('substitutes language names and book metadata', () => {
    const out = renderPrompt('{{sourceLang}}>{{targetLang}} {{bookTitle}} / {{bookAuthor}}', {
      sourceLang: 'fr',
      targetLang: 'en',
      bookTitle: 'Candide',
      bookAuthor: 'Voltaire',
    });
    expect(out).toBe('French>English Candide / Voltaire');
  });

  it('renders auto-detect and missing metadata as neutral text', () => {
    const out = renderPrompt('{{sourceLang}}|{{bookTitle}}|', {
      sourceLang: 'AUTO',
      targetLang: 'en',
    });
    expect(out).toBe('the source language||');
  });
});

describe('createOpenAICompatibleTranslator', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('translates a single text with the rendered default prompt', async () => {
    generateTextMock.mockResolvedValue({ text: 'Bonjour' });
    const t = createOpenAICompatibleTranslator(config);
    const out = await t.translate(['Hello'], 'en', 'fr', null, false, undefined, {
      bookTitle: 'Book',
    });
    expect(out).toEqual(['Bonjour']);
    const args = lastCall();
    expect(args.system).toContain(
      renderPrompt(DEFAULT_TRANSLATION_PROMPT, {
        sourceLang: 'en',
        targetLang: 'fr',
        bookTitle: 'Book',
      }),
    );
    expect(args.prompt).toBe('Hello');
    expect(t.name).toBe('custom:abc');
    expect(t.label).toBe('My LLM');
  });

  it('coalesces concurrent calls into one numbered batch and splits the reply', async () => {
    generateTextMock.mockResolvedValue({ text: numbered(['Un', 'Deux', 'Trois']) });
    const t = createOpenAICompatibleTranslator(config);
    const results = await Promise.all([
      t.translate(['One'], 'en', 'fr'),
      t.translate(['Two', 'Three'], 'en', 'fr'),
    ]);
    expect(results).toEqual([['Un'], ['Deux', 'Trois']]);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(lastCall().prompt).toBe(numbered(['One', 'Two', 'Three']));
    expect(lastCall().system).toContain('[n]');
  });

  // Small batches with several in flight show the first paragraphs sooner
  // while still cutting the request count.
  it('sends up to 4 paragraphs per request with 4 requests in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    generateTextMock.mockImplementation(async ({ prompt }: GenerateArgs) => {
      await gate;
      const count = prompt.match(/^\[\d+\]$/gm)?.length ?? 1;
      return { text: numbered(Array.from({ length: count }, (_, i) => `T${i + 1}`)) };
    });
    const t = createOpenAICompatibleTranslator(config);
    const texts = Array.from({ length: 16 }, (_, i) => `P${i + 1}`);
    const pending = Promise.all(texts.map((text) => t.translate([text], 'en', 'fr')));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(generateTextMock).toHaveBeenCalledTimes(4);
    expect(generateTextMock.mock.calls.map(([args]) => (args as GenerateArgs).prompt)).toEqual([
      numbered(['P1', 'P2', 'P3', 'P4']),
      numbered(['P5', 'P6', 'P7', 'P8']),
      numbered(['P9', 'P10', 'P11', 'P12']),
      numbered(['P13', 'P14', 'P15', 'P16']),
    ]);
    release();
    await pending;
  });

  it('falls back to one request per text when the reply has the wrong block count', async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: 'Un et deux' })
      .mockResolvedValueOnce({ text: 'Un' })
      .mockResolvedValueOnce({ text: 'Deux' });
    const t = createOpenAICompatibleTranslator(config);
    const out = await t.translate(['One', 'Two'], 'en', 'fr');
    expect(out).toEqual(['Un', 'Deux']);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });

  // Small local models (e.g. gemma3) put each marker on the same line as its
  // translation; rejecting that re-sent every paragraph on its own.
  it('splits a reply whose markers share a line with the translation', async () => {
    generateTextMock.mockResolvedValue({ text: '[1]Un\n\n[2] Deux' });
    const t = createOpenAICompatibleTranslator(config);
    const out = await t.translate(['One', 'Two'], 'en', 'fr');
    expect(out).toEqual(['Un', 'Deux']);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('strips reasoning blocks from the reply', async () => {
    generateTextMock.mockResolvedValue({ text: '<think>hmm</think>\nBonjour' });
    const t = createOpenAICompatibleTranslator(config);
    expect(await t.translate(['Hello'], 'en', 'fr')).toEqual(['Bonjour']);
  });

  it('keeps a literal </think> that is not a leading reasoning block', async () => {
    generateTextMock.mockResolvedValue({ text: 'Il a écrit </think> au mur' });
    const t = createOpenAICompatibleTranslator(config);
    expect(await t.translate(['He wrote </think> on the wall'], 'en', 'fr')).toEqual([
      'Il a écrit </think> au mur',
    ]);
  });

  it('passes empty strings through without calling the model', async () => {
    const t = createOpenAICompatibleTranslator(config);
    expect(await t.translate(['', '  '], 'en', 'fr')).toEqual(['', '  ']);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  // "left" in "had been left to gather dust" came back as the direction when
  // the model saw nothing but the word.
  it('translates a selection with its passage in one unbatched request', async () => {
    generateTextMock.mockResolvedValue({ text: 'laissé' });
    const t = createOpenAICompatibleTranslator(config);
    const passage = { before: 'The equipment had been', after: 'to gather dust.' };
    const [selected, paragraph] = await Promise.all([
      t.translate(['left'], 'en', 'fr', null, false, undefined, { passage }),
      t.translate(['A paragraph.'], 'en', 'fr'),
    ]);
    expect(selected).toEqual(['laissé']);
    expect(paragraph).toEqual(['laissé']);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    const withPassage = generateTextMock.mock.calls.find(([args]) =>
      (args as GenerateArgs).prompt.startsWith('{'),
    )![0] as GenerateArgs;
    expect(JSON.parse(withPassage.prompt)).toEqual({ text: 'left', ...passage });
    expect(withPassage.system).toContain('"before" and "after"');
    expect(withPassage.system).not.toContain('[n]');
    expect(t.getCacheKey!('en', 'fr', { passage })).not.toBe(t.getCacheKey!('en', 'fr', {}));
  });

  // deepseek-flash reasons by default; a one-line translation waited on it.
  it('asks the endpoint not to reason', async () => {
    generateTextMock.mockResolvedValue({ text: 'Bonjour' });
    const t = createOpenAICompatibleTranslator(config);
    expect(await t.translate(['Hello'], 'en', 'fr')).toEqual(['Bonjour']);
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      providerOptions: { custom: { thinking: { type: 'disabled' } } },
    });
  });

  it('drops the reasoning switch for an endpoint that rejects it', async () => {
    generateTextMock
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Request'), {
          statusCode: 400,
          responseBody: '{"error":{"message":"Unrecognized request argument supplied: thinking"}}',
        }),
      )
      .mockResolvedValue({ text: 'Bonjour' });
    const t = createOpenAICompatibleTranslator({
      ...config,
      baseUrl: 'https://strict.example.com/v1',
    });
    expect(await t.translate(['Hello'], 'en', 'fr')).toEqual(['Bonjour']);
    expect(await t.translate(['Hi'], 'en', 'fr')).toEqual(['Bonjour']);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(generateTextMock.mock.calls[1]![0]).not.toHaveProperty('providerOptions');
    expect(generateTextMock.mock.calls[2]![0]).not.toHaveProperty('providerOptions');
  });

  it('surfaces a 400 that is not about the reasoning switch', async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error('Bad Request'), {
        statusCode: 400,
        responseBody: '{"error":{"message":"Model Not Exist"}}',
      }),
    );
    const t = createOpenAICompatibleTranslator(config);
    await expect(t.translate(['Hello'], 'en', 'fr')).rejects.toThrow('Bad Request');
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('maps 401 responses to UNAUTHORIZED', async () => {
    generateTextMock.mockRejectedValue(Object.assign(new Error('bad key'), { statusCode: 401 }));
    const t = createOpenAICompatibleTranslator(config);
    await expect(t.translate(['Hello'], 'en', 'fr')).rejects.toThrow(ErrorCodes.UNAUTHORIZED);
  });

  it('rejects an aborted caller without failing the rest of the batch', async () => {
    generateTextMock.mockResolvedValue({ text: 'Deux' });
    const t = createOpenAICompatibleTranslator(config);
    const controller = new AbortController();
    const aborted = t.translate(['One'], 'en', 'fr', null, false, controller.signal);
    const kept = t.translate(['Two'], 'en', 'fr');
    controller.abort();
    await expect(aborted).rejects.toThrow();
    expect(await kept).toEqual(['Deux']);
    expect(lastCall().prompt).toBe('Two');
  });

  // tauriFetch cancels its request from the signal's abort listener and never
  // handles that call's rejection, so a timeout firing after the reply
  // arrived raised "The resource id … is invalid" for every finished request.
  it('stops the request timeout once the reply arrives', async () => {
    vi.useFakeTimers();
    // Fake timers do not drive the native AbortSignal.timeout; model it on them.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      generateTextMock.mockResolvedValue({ text: 'Bonjour' });
      const t = createOpenAICompatibleTranslator(config);
      const pending = t.translate(['Hello'], 'en', 'fr');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      const { abortSignal } = generateTextMock.mock.calls[0]![0] as { abortSignal: AbortSignal };
      await vi.advanceTimersByTimeAsync(120_000);
      expect(abortSignal.aborted).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('uses a cache key that changes with the model and the prompt', () => {
    const t = createOpenAICompatibleTranslator(config);
    const other = createOpenAICompatibleTranslator({ ...config, model: 'other' });
    const k1 = t.getCacheKey!('en', 'fr', {});
    expect(k1.startsWith('custom:abc#')).toBe(true);
    expect(other.getCacheKey!('en', 'fr', {})).not.toBe(k1);
    expect(t.getCacheKey!('en', 'fr', { bookTitle: 'X' })).not.toBe(k1);
  });
});
