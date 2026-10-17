/**
 * The sentence a selection sits in: the passage before it back to the last
 * sentence end, the selection, and the passage after it up to the next one.
 * `mark` wraps the selection, e.g. in «», so a model can see exactly which
 * words in the sentence are meant.
 */
export const sentenceAround = (
  before: string,
  text: string,
  after: string,
  mark: [string, string] = ['', ''],
): string => {
  const head = before.split(/(?<=[.!?])\s+|(?<=[。！？])/).pop() ?? '';
  const tail = after.match(/^[\s\S]*?(?:[.!?](?=\s|$)|[。！？])/)?.[0] ?? after;
  // The passage comes trimmed, so the spaces either side of the selection are
  // gone; put one back between two Latin words, never inside CJK text. Decided
  // on the bare text so the marks neither add nor suppress a space.
  const latin = /[A-Za-zÀ-ɏ0-9]/;
  const spaceBefore = latin.test(head.slice(-1)) && latin.test(text.charAt(0)) ? ' ' : '';
  const spaceAfter = latin.test(text.slice(-1)) && latin.test(tail.charAt(0)) ? ' ' : '';
  return `${head}${spaceBefore}${mark[0]}${text}${mark[1]}${spaceAfter}${tail}`
    .replace(/\s+/g, ' ')
    .trim();
};
