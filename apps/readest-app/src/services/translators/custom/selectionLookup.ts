/**
 * Streaming lookup behind the translate popup for LLM translators, modelled
 * on SubWord's subtitle lookup: a word or short phrase gets a dictionary-style
 * card (pronunciation, meaning in this passage, base form, other senses) and a
 * longer selection a plain translation. Both arrive token by token and the
 * card is re-parsed from the partial reply, so its first line is on screen
 * long before the model has finished.
 */
import type { CustomTranslator } from '@/types/translation';
import { md5Fingerprint } from '@/utils/md5';
import { getPromptTemplate } from '@/store/customTranslatorStore';
import type { TranslationContext } from '../types';
import { renderPrompt } from './prompts';
import { PASSAGE_RULES, createChatModel, streamReply, stripReasoning } from './openaiCompatible';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;
// SubWord's rule: past four words it is a sentence, and a translation is what
// the reader wants.
const MAX_CARD_WORDS = 4;
const MAX_CARD_CHARS = 48;

/**
 * The labels are fixed English keys the model echoes verbatim, whatever the
 * target language, so the partial reply can be parsed line by line; the UI
 * shows its own localized labels. Each line is optional so a word already in
 * its base form or with no other sense worth noting gets a shorter card.
 */
export const CARD_RULES = `The user's message is JSON: "text" is a word or short phrase selected from the book, "before" and "after" are the passage around it.
Explain "text" as it is used in that passage. Write in {{targetLang}}, except the pronunciation and base form. Output only these lines, in this order, with these exact English labels and nothing else:
Pronunciation: IPA of "text" as written, between slashes, e.g. /ˈmuːlə/; for a phrase the whole phrase
Meaning: part-of-speech abbreviation and a dictionary-style gloss of the sense in this passage — a few words, not a sentence, no grammar commentary; when "text" forms a set phrase with the words next to it, give the phrase and its gloss instead, e.g. "phr. figure out — work out"
Base form: only when "text" is inflected — its dictionary form, IPA and the inflection, e.g. "leave /liːv/ (left is the past participle)"; omit this line otherwise
Also: one or two other common senses of "text", each a part-of-speech abbreviation and a few words, separated by semicolons; omit this line when there is nothing worth noting
Put nothing before the first label and do not repeat a label inside its value.`;

export interface SelectionLookupInput extends TranslationContext {
  text: string;
  sourceLang: string;
  targetLang: string;
}

export interface SelectionEntry {
  /** Set for a long selection, which gets a translation instead of a card. */
  translation?: string;
  pronunciation?: string;
  meaning?: string;
  baseForm?: string;
  also?: string;
}

export const isCardSelection = (text: string): boolean => {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_CARD_CHARS &&
    trimmed.split(/\s+/).length <= MAX_CARD_WORDS
  );
};

const LABEL_KEYS: Record<string, keyof SelectionEntry> = {
  pronunciation: 'pronunciation',
  meaning: 'meaning',
  'base form': 'baseForm',
  also: 'also',
};
// Markdown emphasis around the label and a full-width colon are both common.
const LABEL_LINE =
  /^\s*\**\s*(pronunciation|meaning|base form|also)\s*\**\s*[:：]\s*\**\s*(.*?)\s*\**\s*$/i;
const EMPTY_VALUE = /^(none|n\/a|—|-|无|無)$/i;

/** A reasoning block still open at the end of a partial reply hides everything. */
const visibleText = (reply: string): string =>
  /^\s*<think>/.test(reply) && !reply.includes('</think>') ? '' : stripReasoning(reply);

/** Tolerates a partial reply: the lines so far, the last one possibly cut. */
export const parseSelectionEntry = (reply: string): SelectionEntry => {
  const entry: SelectionEntry = {};
  for (const raw of visibleText(reply).split('\n')) {
    const match = LABEL_LINE.exec(raw);
    if (match) {
      const value = match[2]!;
      if (value && !EMPTY_VALUE.test(value)) entry[LABEL_KEYS[match[1]!.toLowerCase()]!] = value;
    } else if (!entry.meaning && raw.trim()) {
      // A model that skips the labels still gets its first line shown.
      entry.meaning = raw.trim();
    }
  }
  return entry;
};

const cache = new Map<string, SelectionEntry>();

export const __clearSelectionLookupCacheForTests = () => cache.clear();

export const lookupSelection = async (
  translator: CustomTranslator,
  input: SelectionLookupInput,
  onEntry: (entry: SelectionEntry) => void,
  signal: AbortSignal,
): Promise<SelectionEntry> => {
  const card = isCardSelection(input.text);
  const vars = {
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    bookTitle: input.bookTitle,
    bookAuthor: input.bookAuthor,
  };
  const system = `${renderPrompt(getPromptTemplate(input.promptId), vars)}\n\n${
    card ? renderPrompt(CARD_RULES, vars) : PASSAGE_RULES
  }`;
  const prompt = JSON.stringify({
    text: input.text,
    before: input.passage?.before ?? '',
    after: input.passage?.after ?? '',
  });
  const toEntry = (reply: string): SelectionEntry =>
    card ? parseSelectionEntry(reply) : { translation: visibleText(reply) };

  const key = md5Fingerprint(
    JSON.stringify([translator.id, translator.updatedAt, translator.model, system, prompt]),
  );
  const cached = cache.get(key);
  if (cached) {
    onEntry(cached);
    return cached;
  }

  signal.throwIfAborted();
  // Own controller for the same reason as the context dictionary: tauriFetch
  // leaves an unhandled rejection when a finished request's signal fires.
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const reply = await streamReply(
      translator.baseUrl ?? '',
      {
        model: await createChatModel(translator),
        system,
        prompt,
        temperature: translator.temperature,
        maxRetries: 1,
        abortSignal: controller.signal,
      },
      (soFar) => onEntry(toEntry(soFar)),
    );
    const entry = toEntry(reply);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
    onEntry(entry);
    return entry;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
};
