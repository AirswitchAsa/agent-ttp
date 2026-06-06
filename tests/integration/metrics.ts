import { BYTES_PER_SAMPLE, SAMPLE_RATE } from "../../src/audio.ts";

// Quantitative measurements over raw PCM and over text. Kept pure and free of
// any network so the eval harness's numbers are themselves trustworthy and
// unit-testable. All PCM is the pipeline's canonical 24kHz/16-bit/mono.

export function durationSeconds(pcm: Buffer): number {
  return pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
}

function peakSample(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += BYTES_PER_SAMPLE) {
    const abs = Math.abs(pcm.readInt16LE(i));
    if (abs > peak) peak = abs;
  }
  return peak;
}

/** Peak level in dBFS (0 dB = full scale). Returns -Infinity for silence. */
export function peakDbfs(pcm: Buffer): number {
  const peak = peakSample(pcm);
  return peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak / 32767);
}

/** RMS level in dBFS — a rough loudness proxy. */
export function rmsDbfs(pcm: Buffer): number {
  if (pcm.length < BYTES_PER_SAMPLE) return Number.NEGATIVE_INFINITY;
  let sumSquares = 0;
  let count = 0;
  for (let i = 0; i + 1 < pcm.length; i += BYTES_PER_SAMPLE) {
    const s = pcm.readInt16LE(i) / 32767;
    sumSquares += s * s;
    count += 1;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, count));
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}

/** Fraction of samples whose magnitude is below `floor` of full scale. */
export function silenceFraction(pcm: Buffer, floor = 0.01): number {
  if (pcm.length < BYTES_PER_SAMPLE) return 1;
  const threshold = floor * 32767;
  let quiet = 0;
  let count = 0;
  for (let i = 0; i + 1 < pcm.length; i += BYTES_PER_SAMPLE) {
    if (Math.abs(pcm.readInt16LE(i)) < threshold) quiet += 1;
    count += 1;
  }
  return quiet / count;
}

// Lowercase and strip punctuation/symbols, keeping letters, numbers, and (for
// CJK) the characters themselves. Used to normalize both reference and
// transcribed text before scoring.
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tokenize for scoring: word-level when the text has spaces (Latin scripts),
// character-level otherwise (CJK, which is not whitespace-delimited).
function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];
  return /\s/.test(normalized) ? normalized.split(" ") : Array.from(normalized.replace(/\s/g, ""));
}

function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (cur[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      cur[j] = Math.min(del, ins, sub);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

// Word error rate (or character error rate for CJK): edit distance between the
// reference and hypothesis token streams, divided by the reference length.
// 0 = perfect; ~1 = entirely wrong. This is the headline quality metric — it
// objectively answers "did the TTS say what we told it to?".
export function errorRate(reference: string, hypothesis: string): number {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}
