// Technical chunking only — never semantic. The agent has already shaped the
// text into listenable segments; this splits a segment solely when it exceeds
// the TTS character limit, preserving sentence boundaries where possible so the
// rejoined audio sounds seamless.
//
// Boundary set covers both Western (.!?) and CJK (。！？…) terminators plus
// hard line breaks. A run with no boundary that still overflows is hard-split
// at the limit as a last resort.

const SENTENCE_BOUNDARY = /(?<=[.!?。！？…]|\n)/u;

/**
 * Split `text` into pieces each no longer than `maxChars`.
 * Returns `[text]` unchanged when it already fits.
 */
export function chunk(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const sentences = splitSentences(trimmed);
  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    // A single sentence longer than the limit cannot be packed; flush what we
    // have, then hard-split the oversized sentence on its own.
    if (sentence.length > maxChars) {
      if (current.length > 0) {
        pieces.push(current.trim());
        current = "";
      }
      pieces.push(...hardSplit(sentence, maxChars));
      continue;
    }

    if (current.length + sentence.length > maxChars) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim().length > 0) pieces.push(current.trim());
  return pieces.filter((piece) => piece.length > 0);
}

// Split into sentence-ish units, keeping the terminating punctuation attached
// so reassembly is lossless.
function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((part) => part)
    .filter((part) => part.length > 0);
}

// Last-resort split for a single sentence with no usable boundary: cut on the
// nearest whitespace before the limit, falling back to a hard character cut.
function hardSplit(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = sentence;

  // Guard against a non-positive limit (the validator rejects it, but never let
  // the loop fail to advance and spin): always cut at least one character.
  const limit = Math.max(1, maxChars);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) pieces.push(rest);
  return pieces;
}
