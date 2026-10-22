// Splits extracted text into passages small enough to embed and to quote back
// to the model, keeping paragraphs together where they fit.
const TARGET_CHARS = 1000;
const OVERLAP_CHARS = 150;

export function chunkText(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > TARGET_CHARS) {
      if (current) chunks.push(current);
      current = "";
      chunks.push(...splitLong(paragraph));
      continue;
    }
    if (current && current.length + paragraph.length + 2 > TARGET_CHARS) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** A paragraph longer than one chunk: cut at sentence ends where possible, with overlap. */
function splitLong(paragraph: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(start + TARGET_CHARS, paragraph.length);
    if (end < paragraph.length) {
      const sentenceEnd = paragraph.lastIndexOf(". ", end);
      if (sentenceEnd > start + TARGET_CHARS / 2) end = sentenceEnd + 1;
    }
    pieces.push(paragraph.slice(start, end).trim());
    if (end >= paragraph.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return pieces;
}
