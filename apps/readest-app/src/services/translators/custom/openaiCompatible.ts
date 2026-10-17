import type { LanguageModel } from 'ai';
import { getAIFetch } from '@/services/ai/utils/httpFetch';
import { getPromptTemplate } from '@/store/customTranslatorStore';
import { md5Fingerprint } from '@/utils/md5';
import type { CustomTranslator } from '@/types/translation';
import { ErrorCodes, TranslationContext, TranslationProvider } from '../types';
import { renderPrompt, toLanguageName } from './prompts';
import { CUSTOM_TRANSLATOR_PREFIX } from './constants';

const BATCH_DELAY_MS = 50;
const MAX_BATCH_ITEMS = 4;
const MAX_BATCH_CHARS = 3000;
const MAX_INFLIGHT_BATCHES = 4;
const REQUEST_TIMEOUT_MS = 60_000;

// Every rule block ends by naming the target language again: the template
// above it names it once, at the top, and a model handed an English book,
// English rules and an English passage drifted into answering in English
// (a custom template may not even contain {{targetLang}}). `target` is the
// language name, e.g. "Simplified Chinese".
const singleRules = (target: string) =>
  "Output only the translation of the user's text, without explanations, notes or quotation marks. " +
  `The translation is in ${target}.`;
export const passageRules = (target: string) =>
  'The user\'s message is JSON: "text" is an excerpt selected from the book, "before" and "after" are the passage around it. ' +
  'Translate only "text", with the sense it has in that passage, keeping its form (a word stays a word, a phrase a phrase). ' +
  'Output only the translation, without explanations, notes or quotation marks. ' +
  `The translation is in ${target}.`;
const batchRules = (n: number, target: string) =>
  `The user's text contains ${n} numbered blocks, each starting with a marker line like [n]. ` +
  `Translate every block and output exactly ${n} blocks in the same order, each starting with its original [n] marker line. ` +
  `Output only the translations, without explanations or notes. Every translation is in ${target}.`;

interface Item {
  text: string;
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
  cancelled?: boolean;
}

interface PendingBatch {
  system: string;
  /** Target language name, for the rules appended to `system`. */
  target: string;
  items: Item[];
  chars: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Paragraphs batch together only when both the prompt and the target match. */
const batchKey = (system: string, target: string) => `${system}\u0000${target}`;

// Only a leading reasoning block: a book may legitimately quote `</think>`.
// The AI SDK is loaded on first use: it pulls in Node-only modules at import
// time, and the reader imports this file whether or not an LLM is configured.
let sdk: Promise<[typeof import('ai'), typeof import('@ai-sdk/openai-compatible')]> | undefined;
export const loadSDK = () =>
  (sdk ??= Promise.all([import('ai'), import('@ai-sdk/openai-compatible')]));

export const stripReasoning = (text: string) =>
  text.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();

export const createChatModel = async (config: CustomTranslator): Promise<LanguageModel> => {
  const [, { createOpenAICompatible }] = await loadSDK();
  return createOpenAICompatible({
    name: 'custom',
    baseURL: (config.baseUrl ?? '').replace(/\/+$/, ''),
    apiKey: config.apiKey || undefined,
    fetch: getAIFetch(),
  }).chatModel(config.model ?? '');
};

type GenerateTextOptions = Parameters<typeof import('ai').generateText>[0];

/**
 * DeepSeek's switch for its hybrid models: `deepseek-flash` reasons before
 * answering unless told not to, which doubles the latency of a one-line
 * translation and bills the reasoning as output. The provider spreads the
 * `custom` options straight into the request body, so the switch reaches
 * whichever endpoint the user configured; one that rejects unknown parameters
 * (OpenAI answers 400 naming the argument) is remembered and asked without it.
 */
const NO_THINKING_OPTIONS = { custom: { thinking: { type: 'disabled' } } };
const thinkingSwitchRejected = new Set<string>();

const rejectsThinkingSwitch = (err: unknown): boolean => {
  const { statusCode, responseBody, message } = err as {
    statusCode?: number;
    responseBody?: string;
    message?: string;
  };
  return statusCode === 400 && /thinking/i.test(responseBody ?? message ?? '');
};

/** `generateText` with reasoning switched off where the endpoint allows it. */
export const generateReply = async (
  endpoint: string,
  options: GenerateTextOptions,
): Promise<string> => {
  const [{ generateText }] = await loadSDK();
  if (!thinkingSwitchRejected.has(endpoint)) {
    try {
      const { text } = await generateText({ ...options, providerOptions: NO_THINKING_OPTIONS });
      return text;
    } catch (err) {
      if (!rejectsThinkingSwitch(err)) throw err;
      thinkingSwitchRejected.add(endpoint);
    }
  }
  const { text } = await generateText(options);
  return text;
};

type StreamTextOptions = Parameters<typeof import('ai').streamText>[0];

/**
 * `streamText` counterpart of {@link generateReply}: `onText` gets the reply
 * so far after every delta, so the popup can render the first line while the
 * rest is still being generated. Reasoning deltas are not text and are left
 * out. Returns the complete reply.
 */
export const streamReply = async (
  endpoint: string,
  options: StreamTextOptions,
  onText: (soFar: string) => void,
): Promise<string> => {
  const [{ streamText }] = await loadSDK();
  const run = async (providerOptions?: typeof NO_THINKING_OPTIONS) => {
    let text = '';
    // Errors are stream parts, not rejections: without this they would only
    // reach the console.
    const result = streamText({ ...options, ...(providerOptions && { providerOptions }) });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
        onText(text);
      } else if (part.type === 'error') {
        throw part.error;
      }
    }
    return text;
  };
  if (!thinkingSwitchRejected.has(endpoint)) {
    try {
      return await run(NO_THINKING_OPTIONS);
    } catch (err) {
      if (!rejectsThinkingSwitch(err)) throw err;
      thinkingSwitchRejected.add(endpoint);
    }
  }
  return run();
};

/** Splits a `[1]\n…\n\n[2]\n…` reply; returns null unless it holds exactly blocks 1..n. */
const splitNumbered = (text: string, n: number): string[] | null => {
  // A marker starts a line; some models continue the translation on that line.
  const parts = text.split(/^[ \t]*\[(\d+)\][ \t]*/m);
  const blocks: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (Number(parts[i]) !== blocks.length + 1) return null;
    blocks.push(parts[i + 1]!.trim());
  }
  return blocks.length === n ? blocks : null;
};

const toTranslatorError = (err: unknown): Error => {
  const status = (err as { statusCode?: number }).statusCode;
  if (status === 401 || status === 403) return new Error(ErrorCodes.UNAUTHORIZED);
  return err instanceof Error ? err : new Error(String(err));
};

export const createOpenAICompatibleTranslator = (config: CustomTranslator): TranslationProvider => {
  let model: LanguageModel | undefined;
  const pending = new Map<string, PendingBatch>();
  const queue: PendingBatch[] = [];
  let inflight = 0;

  const getModel = async () => (model ??= await createChatModel(config));

  const renderSystem = (sourceLang: string, targetLang: string, context?: TranslationContext) =>
    renderPrompt(getPromptTemplate(context?.promptId), {
      sourceLang,
      targetLang,
      bookTitle: context?.bookTitle,
      bookAuthor: context?.bookAuthor,
    });

  const callModel = async (system: string, prompt: string): Promise<string> => {
    // Not AbortSignal.timeout: tauriFetch cancels from the signal's abort
    // listener without handling the result, so a timer that fires after the
    // reply leaves an unhandled "resource id is invalid" rejection.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const text = await generateReply(config.baseUrl ?? '', {
        model: await getModel(),
        system,
        prompt,
        temperature: config.temperature,
        maxRetries: 2,
        abortSignal: controller.signal,
      });
      return stripReasoning(text);
    } catch (err) {
      throw toTranslatorError(err);
    } finally {
      clearTimeout(timer);
    }
  };

  const translateBatch = async (system: string, target: string, items: Item[]) => {
    if (items.length === 1) {
      items[0]!.resolve(await callModel(`${system}\n\n${singleRules(target)}`, items[0]!.text));
      return;
    }
    const prompt = items.map((item, i) => `[${i + 1}]\n${item.text}`).join('\n\n');
    const reply = await callModel(`${system}\n\n${batchRules(items.length, target)}`, prompt);
    const blocks = splitNumbered(reply, items.length);
    if (blocks) {
      items.forEach((item, i) => item.resolve(blocks[i]!));
      return;
    }
    // The model merged or dropped blocks; translate one by one instead.
    await Promise.all(
      items.map(async (item) => {
        try {
          item.resolve(await callModel(`${system}\n\n${singleRules(target)}`, item.text));
        } catch (err) {
          item.reject(err);
        }
      }),
    );
  };

  const pump = () => {
    while (inflight < MAX_INFLIGHT_BATCHES && queue.length > 0) {
      const batch = queue.shift()!;
      const items = batch.items.filter((item) => !item.cancelled);
      if (items.length === 0) continue;
      inflight++;
      translateBatch(batch.system, batch.target, items)
        .catch((err) => items.forEach((item) => item.reject(err)))
        .finally(() => {
          inflight--;
          pump();
        });
    }
  };

  const flush = (key: string) => {
    const batch = pending.get(key);
    if (!batch) return;
    clearTimeout(batch.timer);
    pending.delete(key);
    queue.push(batch);
    pump();
  };

  const enqueue = (system: string, target: string, item: Item) => {
    const key = batchKey(system, target);
    const batch = pending.get(key);
    if (
      batch &&
      (batch.items.length >= MAX_BATCH_ITEMS || batch.chars + item.text.length > MAX_BATCH_CHARS)
    ) {
      flush(key);
    }
    let current = pending.get(key);
    if (!current) {
      current = { system, target, items: [], chars: 0 };
      current.timer = setTimeout(() => flush(key), BATCH_DELAY_MS);
      pending.set(key, current);
    }
    current.items.push(item);
    current.chars += item.text.length;
  };

  return {
    name: `${CUSTOM_TRANSLATOR_PREFIX}${config.id}`,
    label: config.name,
    concurrency: 16,
    // The passage is part of the key: the same word means different things in
    // different sentences, so a translation made for one must not serve another.
    getCacheKey: (sourceLang, targetLang, context) =>
      `${CUSTOM_TRANSLATOR_PREFIX}${config.id}#${md5Fingerprint(
        `${config.model}\n${renderSystem(sourceLang, targetLang, context)}\n${
          context?.passage ? `${context.passage.before}\u0000${context.passage.after}` : ''
        }`,
      )}`,
    translate: async (texts, sourceLang, targetLang, _token, _useCache, signal, context) => {
      signal?.throwIfAborted();
      const system = renderSystem(sourceLang, targetLang, context);
      const target = toLanguageName(targetLang);
      // A selection is one request on its own: batching would strip the
      // passage, and there is nothing to batch it with.
      if (context?.passage) {
        const { before, after } = context.passage;
        return Promise.all(
          texts.map((text) =>
            text?.trim()
              ? callModel(
                  `${system}\n\n${passageRules(target)}`,
                  JSON.stringify({ text, before, after }),
                )
              : text,
          ),
        );
      }
      const items: Item[] = [];
      const results = texts.map((text) => {
        if (!text?.trim()) return Promise.resolve(text);
        return new Promise<string>((resolve, reject) => {
          const item: Item = { text, resolve, reject };
          items.push(item);
          enqueue(system, target, item);
        });
      });
      const all = Promise.all(results);
      if (!signal) return all;
      return new Promise<string[]>((resolve, reject) => {
        const onAbort = () => {
          items.forEach((item) => (item.cancelled = true));
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        all.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    },
  };
};
