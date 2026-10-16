import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sentenceAround, useVocabStore, vocabKey, vocabToJsonl } from '@/store/vocabStore';
import type { EnvConfigType } from '@/services/environment';

const writeFile = vi.fn();
const envConfig = {
  getAppService: async () => ({
    exists: async () => true,
    readFile: async () =>
      JSON.stringify({
        entries: [
          {
            id: 'a',
            word: 'Stuffy',
            wordKey: 'stuffy',
            meaning: 'adj. 闷的',
            createdAt: '2026-10-16T10:00:00.000Z',
          },
        ],
      }),
    writeFile,
  }),
} as unknown as EnvConfigType;

describe('sentenceAround', () => {
  it('cuts the sentence out of the passage on both sides', () => {
    expect(
      sentenceAround(
        'since we were skipping class. The school ping-pong equipment had been ',
        'left',
        ' to gather dust on the gym, and the air was stuffy. Along the edge',
      ),
    ).toBe(
      'The school ping-pong equipment had been left to gather dust on the gym, and the air was stuffy.',
    );
  });

  it('puts back the spaces a trimmed passage lost around a Latin selection', () => {
    expect(sentenceAround('The equipment had been', 'left', 'to gather dust. Next')).toBe(
      'The equipment had been left to gather dust.',
    );
    expect(sentenceAround('器材被', 'left', '了。')).toBe('器材被left了。');
  });

  it('understands full-width sentence ends without a following space', () => {
    expect(sentenceAround('前一句。器材被', '搁置', '了。后一句。')).toBe('器材被搁置了。');
  });
});

describe('useVocabStore', () => {
  beforeEach(async () => {
    writeFile.mockReset();
    useVocabStore.setState({ entries: [], loaded: false });
    await useVocabStore.getState().load(envConfig);
  });

  it('loads vocab.json and finds a word regardless of case', () => {
    expect(useVocabStore.getState().entries).toHaveLength(1);
    expect(useVocabStore.getState().find('stuffy ')?.id).toBe('a');
    expect(vocabKey('Don’t')).toBe("don't");
  });

  it('adds a word once, newest first, and writes the file', async () => {
    const { add } = useVocabStore.getState();
    const added = add({ word: 'left', meaning: 'v. 搁置', source: 'Readest：Adachi' });
    expect(add({ word: 'LEFT' })).toBe(added);
    expect(useVocabStore.getState().entries.map((e) => e.word)).toEqual(['left', 'Stuffy']);
    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledWith(
      'vocab.json',
      'Settings',
      expect.stringContaining('"left"'),
    );
  });

  it('removes by id', () => {
    useVocabStore.getState().remove('a');
    expect(useVocabStore.getState().entries).toEqual([]);
  });
});

describe('vocabToJsonl', () => {
  it('writes LearningPack import objects oldest first without empty fields', () => {
    const lines = vocabToJsonl([
      {
        id: 'b',
        word: 'left',
        wordKey: 'left',
        sentence: 'It had been left.',
        phonetic: '/lɛft/',
        meaning: 'v. 搁置',
        form: 'leave /liːv/',
        source: 'Readest：Adachi',
        createdAt: '2026-10-17T00:00:00.000Z',
        bookHash: 'h',
        cfi: 'epubcfi(/6/2)',
        noteId: 'n',
      },
      { id: 'a', word: 'Stuffy', wordKey: 'stuffy', createdAt: '2026-10-16T10:00:00.000Z' },
    ])
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { word: 'Stuffy', createdAt: '2026-10-16T10:00:00.000Z' },
      {
        word: 'left',
        sentence: 'It had been left.',
        meaning: 'v. 搁置',
        phonetic: '/lɛft/',
        form: 'leave /liːv/',
        source: 'Readest：Adachi',
        createdAt: '2026-10-17T00:00:00.000Z',
      },
    ]);
  });
});
