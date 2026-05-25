// Simple char-based chunker. ~1600 chars ≈ 400 tokens (English).
// More accurate token-aware chunking deferred until we hit length issues.

const CHUNK_CHARS = 1600;
const OVERLAP_CHARS = 200;

export function chunkText(text: string, chunkSize = CHUNK_CHARS): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    chunks.push(text.slice(pos, pos + chunkSize));
    pos += chunkSize - OVERLAP_CHARS;
    if (pos + OVERLAP_CHARS >= text.length) break;
  }
  return chunks;
}
