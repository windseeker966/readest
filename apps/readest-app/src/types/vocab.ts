/**
 * A word saved from the translate popup.
 *
 * The exported fields are LearningPack's vocabulary import format
 * (`PackFormat/import_vocab.sh`) — the same ones SubWord exports — so the
 * vocabularies from the three apps merge: `word`, `sentence`, `meaning`,
 * `phonetic`, `form`, `note`, `source`, `createdAt` (ISO 8601). The rest is
 * Readest's own, for jumping back to the word and for its highlight.
 */
export interface VocabEntry {
  id: string;
  word: string;
  /** Trimmed, lower-cased `word`; one entry per key, as in SubWord. */
  wordKey: string;
  /** The sentence the word was selected in. */
  sentence?: string;
  /** Part of speech and gloss in this passage. */
  meaning?: string;
  /** IPA, between slashes. */
  phonetic?: string;
  /** Dictionary form when the word was inflected. */
  form?: string;
  /** Other common senses. */
  note?: string;
  /** "Readest：<book title>", as SubWord writes "YouTube：<video title>". */
  source?: string;
  createdAt: string;
  bookHash?: string;
  bookTitle?: string;
  cfi?: string;
  /** The yellow highlight made when the word was saved; removed with it. */
  noteId?: string;
}

/** What a caller supplies; id, key and time are filled in by the store. */
export type VocabInput = Omit<VocabEntry, 'id' | 'wordKey' | 'createdAt'>;
