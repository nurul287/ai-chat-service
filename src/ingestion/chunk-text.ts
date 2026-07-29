const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 120;

/**
 * Splits text for embedding. Paragraph-first so a chunk rarely cuts mid-idea;
 * only a single paragraph that exceeds maxChars on its own is hard-split, with
 * a small overlap carried across the boundary so a fact spanning the cut is
 * still retrievable from at least one chunk.
 *
 * Character-based rather than token-based deliberately: it needs no tokenizer
 * dependency, and at these sizes the approximation is well inside the
 * embedding model's context window.
 */
export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      const step = Math.max(1, maxChars - overlapChars);
      for (let start = 0; start < paragraph.length; start += step) {
        const slice = paragraph.slice(start, start + maxChars);
        if (slice.trim().length > 0) chunks.push(slice);
        if (start + maxChars >= paragraph.length) break;
      }
      continue;
    }

    if (current.length + paragraph.length + 2 > maxChars) flush();
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
  }

  flush();
  return chunks;
}
