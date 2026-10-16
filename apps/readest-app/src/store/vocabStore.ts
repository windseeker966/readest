/**
 * The vocabulary: words saved from the translate popup, newest first, kept
 * in `vocab.json` beside the settings. One entry per word (case-insensitive),
 * keeping the first sentence and position it was saved from, as SubWord does.
 */
import { create } from 'zustand';
import type { EnvConfigType } from '@/services/environment';
import type { VocabEntry, VocabInput } from '@/types/vocab';
import { uniqueId } from '@/utils/misc';

const VOCAB_FILE = 'vocab.json';

let persistEnv: EnvConfigType | null = null;

/** SubWord's key: trimmed, lower-cased, curly apostrophe straightened. */
export const vocabKey = (word: string): string => word.trim().toLowerCase().replace(/’/g, "'");

/**
 * The sentence a selection sits in: the passage before it back to the last
 * sentence end, the selection, and the passage after it up to the next one.
 */
export const sentenceAround = (before: string, text: string, after: string): string => {
  const head = before.split(/(?<=[.!?])\s+|(?<=[。！？])/).pop() ?? '';
  const tail = after.match(/^[\s\S]*?(?:[.!?](?=\s|$)|[。！？])/)?.[0] ?? after;
  // The passage comes trimmed, so the spaces either side of the selection are
  // gone; put one back between two Latin words, never inside CJK text.
  const latin = /[A-Za-zÀ-ɏ0-9]/;
  const join = (left: string, right: string) =>
    latin.test(left.slice(-1)) && latin.test(right.charAt(0)) ? `${left} ${right}` : left + right;
  return join(join(head, text), tail).replace(/\s+/g, ' ').trim();
};

/** One LearningPack import object per line, oldest first, as SubWord exports. */
export const vocabToJsonl = (entries: VocabEntry[]): string =>
  [...entries]
    .reverse()
    .map((e) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries({
            word: e.word,
            sentence: e.sentence,
            meaning: e.meaning,
            phonetic: e.phonetic,
            form: e.form,
            note: e.note,
            source: e.source,
            createdAt: e.createdAt,
          }).filter(([, value]) => value),
        ),
      ),
    )
    .map((line) => `${line}\n`)
    .join('');

interface VocabState {
  entries: VocabEntry[];
  loaded: boolean;
  load(envConfig: EnvConfigType): Promise<void>;
  find(word: string): VocabEntry | undefined;
  /** Adds the word, or returns the entry it already has. */
  add(input: VocabInput): VocabEntry;
  remove(id: string): void;
}

const persist = (entries: VocabEntry[]) => {
  if (!persistEnv) return;
  void persistEnv
    .getAppService()
    .then((appService) =>
      appService.writeFile(VOCAB_FILE, 'Settings', JSON.stringify({ entries }, null, 2)),
    );
};

export const useVocabStore = create<VocabState>((set, get) => ({
  entries: [],
  loaded: false,

  load: async (envConfig) => {
    persistEnv = envConfig;
    const appService = await envConfig.getAppService();
    let entries: VocabEntry[] = [];
    try {
      if (await appService.exists(VOCAB_FILE, 'Settings')) {
        const text = (await appService.readFile(VOCAB_FILE, 'Settings', 'text')) as string;
        entries = (JSON.parse(text) as { entries?: VocabEntry[] }).entries ?? [];
      }
    } catch (err) {
      console.error('Failed to load the vocabulary', err);
    }
    set({ entries, loaded: true });
  },

  find: (word) => {
    const key = vocabKey(word);
    return get().entries.find((e) => e.wordKey === key);
  },

  add: (input) => {
    const existing = get().find(input.word);
    if (existing) return existing;
    const entry: VocabEntry = {
      ...input,
      id: uniqueId(),
      word: input.word.trim(),
      wordKey: vocabKey(input.word),
      createdAt: new Date().toISOString(),
    };
    const entries = [entry, ...get().entries];
    set({ entries });
    persist(entries);
    return entry;
  },

  remove: (id) => {
    const entries = get().entries.filter((e) => e.id !== id);
    set({ entries });
    persist(entries);
  },
}));

/** Reads `vocab.json` once; later changes flow through the store. */
export const ensureVocabLoaded = (envConfig: EnvConfigType): void => {
  if (!useVocabStore.getState().loaded) void useVocabStore.getState().load(envConfig);
};
