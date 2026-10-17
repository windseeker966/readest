import { describe, it, expect, vi, beforeEach } from 'vitest';

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: streamTextMock };
});
vi.mock('@/services/ai/utils/httpFetch', () => ({ getAIFetch: () => vi.fn() }));

import {
  isCardSelection,
  lookupSelection,
  parseSelectionEntry,
  __clearSelectionLookupCacheForTests,
} from '@/services/translators/custom/selectionLookup';
import type { CustomTranslator } from '@/types/translation';

const translator: CustomTranslator = {
  id: 'llm',
  type: 'openai-compatible',
  name: 'My LLM',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  addedAt: 1,
  updatedAt: 1,
};

type StreamArgs = { system: string; prompt: string; providerOptions?: unknown };

/** A reply delivered in the given pieces, or failing with `error` first. */
const streamOf = (pieces: string[], error?: unknown) => ({
  fullStream: (async function* () {
    if (error) {
      yield { type: 'error', error };
      return;
    }
    for (const text of pieces) yield { type: 'text-delta', id: '0', text };
  })(),
});

const input = {
  text: 'left',
  passage: { before: 'The equipment had been', after: 'to gather dust.' },
  sourceLang: 'en',
  targetLang: 'zh-CN',
};

describe('isCardSelection', () => {
  it('gives a word or short phrase a card and a sentence a translation', () => {
    expect(isCardSelection('left')).toBe(true);
    expect(isCardSelection('kick back')).toBe(true);
    expect(isCardSelection('had been left to gather dust')).toBe(false);
    expect(isCardSelection('')).toBe(false);
  });
});

describe('parseSelectionEntry', () => {
  it('reads the labelled lines, including a cut-off last line', () => {
    expect(
      parseSelectionEntry('Pronunciation: /left/\nMeaning: v. 搁置（leave 的过去分词）\nBase fo'),
    ).toEqual({
      pronunciation: '/left/',
      meaning: 'v. 搁置（leave 的过去分词）',
    });
  });

  it('tolerates markdown labels, full-width colons and placeholder values', () => {
    expect(
      parseSelectionEntry(
        '**Pronunciation：** /left/\n**Meaning:** v. 搁置\nBase form: none\nAlso: adj. 左边的',
      ),
    ).toEqual({ pronunciation: '/left/', meaning: 'v. 搁置', also: 'adj. 左边的' });
  });

  it('hides an open reasoning block and shows an unlabelled first line as the meaning', () => {
    expect(parseSelectionEntry('<think>the word is')).toEqual({});
    expect(parseSelectionEntry('<think>done</think>\n搁置')).toEqual({ meaning: '搁置' });
  });
});

describe('lookupSelection', () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    __clearSelectionLookupCacheForTests();
  });

  it('streams a card for a word, re-parsing after every delta', async () => {
    streamTextMock.mockReturnValue(
      streamOf(['Pronunciation: /left/\n', 'Meaning: v. 搁置\n', 'Also: adj. 左边的']),
    );
    const seen: unknown[] = [];
    const entry = await lookupSelection(
      translator,
      input,
      (e) => seen.push(e),
      new AbortController().signal,
    );
    expect(entry).toEqual({ pronunciation: '/left/', meaning: 'v. 搁置', also: 'adj. 左边的' });
    expect(seen[0]).toEqual({ pronunciation: '/left/' });
    expect(seen.at(-1)).toEqual(entry);
    const args = streamTextMock.mock.calls[0]![0] as StreamArgs;
    expect(args.system).toContain('Simplified Chinese');
    expect(args.system).toContain('Base form:');
    expect(JSON.parse(args.prompt)).toEqual({
      text: 'left',
      sentence: 'The equipment had been «left» to gather dust.',
      ...input.passage,
    });
    expect(args.system).toContain('part of speech');
    expect(args.providerOptions).toEqual({ custom: { thinking: { type: 'disabled' } } });
  });

  it('streams a plain translation for a sentence', async () => {
    streamTextMock.mockReturnValue(streamOf(['器材被', '搁置在那里积灰。']));
    const entry = await lookupSelection(
      translator,
      { ...input, text: 'The equipment had been left to gather dust.' },
      () => {},
      new AbortController().signal,
    );
    expect(entry).toEqual({ translation: '器材被搁置在那里积灰。' });
    const { system } = streamTextMock.mock.calls[0]![0] as StreamArgs;
    expect(system).not.toContain('Base form:');
    // The rules name the target again at the end; the template alone let the
    // model drift into answering in the book's language.
    expect(system).toContain('The translation is in Simplified Chinese.');
  });

  it('serves a repeated lookup from the cache without a request', async () => {
    streamTextMock.mockReturnValue(streamOf(['Meaning: v. 搁置']));
    const signal = new AbortController().signal;
    await lookupSelection(translator, input, () => {}, signal);
    const seen: unknown[] = [];
    await lookupSelection(translator, input, (e) => seen.push(e), signal);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ meaning: 'v. 搁置' }]);
  });

  it('retries without the reasoning switch when the endpoint rejects it', async () => {
    streamTextMock
      .mockReturnValueOnce(
        streamOf(
          [],
          Object.assign(new Error('Bad Request'), {
            statusCode: 400,
            responseBody:
              '{"error":{"message":"Unrecognized request argument supplied: thinking"}}',
          }),
        ),
      )
      .mockReturnValueOnce(streamOf(['Meaning: v. 搁置']));
    const entry = await lookupSelection(
      { ...translator, baseUrl: 'https://strict.example.com/v1' },
      input,
      () => {},
      new AbortController().signal,
    );
    expect(entry).toEqual({ meaning: 'v. 搁置' });
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect((streamTextMock.mock.calls[1]![0] as StreamArgs).providerOptions).toBeUndefined();
  });

  it('surfaces other stream errors', async () => {
    streamTextMock.mockReturnValue(
      streamOf([], Object.assign(new Error('Unauthorized'), { statusCode: 401 })),
    );
    await expect(
      lookupSelection(translator, input, () => {}, new AbortController().signal),
    ).rejects.toThrow('Unauthorized');
  });
});
