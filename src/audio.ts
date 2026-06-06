import { Mp3Encoder } from "@breezystack/lamejs";

// OpenAI TTS `pcm` output is raw 24 kHz, 16-bit signed, little-endian, mono,
// with no header. Every number below derives from that contract. Because we
// work entirely in PCM until the very end, concatenation, silence, and
// normalization are plain buffer math — no external binary (no ffmpeg) ever.
export const SAMPLE_RATE = 24_000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

const DEFAULT_MP3_KBPS = 64;
// lamejs consumes samples one MPEG frame at a time.
const MP3_FRAME_SAMPLES = 1152;

export interface RenderedSegment {
  pcm: Buffer;
  pauseAfterMs: number;
}

/** A buffer of digital silence `ms` milliseconds long, sample-aligned. */
export function silence(ms: number): Buffer {
  if (ms <= 0) return Buffer.alloc(0);
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  return Buffer.alloc(samples * BYTES_PER_SAMPLE);
}

// Concatenate rendered segments in order, inserting each segment's trailing
// pause as silence. The pause after the final segment is intentionally kept —
// it gives the episode a clean tail rather than ending abruptly.
export function concatWithPauses(segments: RenderedSegment[]): Buffer {
  const parts: Buffer[] = [];
  for (const segment of segments) {
    parts.push(segment.pcm);
    const gap = silence(segment.pauseAfterMs);
    if (gap.length > 0) parts.push(gap);
  }
  return Buffer.concat(parts);
}

// Peak-normalize so the loudest sample reaches `targetPeak` of full scale.
// This is amplitude normalization, not loudness (LUFS) normalization — a
// deliberate v0 simplification. Returns the buffer unchanged when silent.
export function peakNormalize(pcm: Buffer, targetPeak = 0.95): Buffer {
  const samples = pcmToInt16(pcm);
  let maxAbs = 0;
  for (const sample of samples) {
    const abs = Math.abs(sample);
    if (abs > maxAbs) maxAbs = abs;
  }
  if (maxAbs === 0) return pcm;

  const gain = (targetPeak * 32767) / maxAbs;
  // Nothing to do if it would only attenuate an already-quiet track upward by
  // a negligible amount, or if it is already at target.
  if (gain >= 0.999 && gain <= 1.001) return pcm;

  const out = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i += 1) {
    const scaled = Math.round((samples[i] as number) * gain);
    const clamped = Math.max(-32768, Math.min(32767, scaled));
    out.writeInt16LE(clamped, i * BYTES_PER_SAMPLE);
  }
  return out;
}

/** Wrap raw PCM in a 44-byte canonical WAV header. */
export function encodeWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Encode raw PCM to MP3 in-process with the pure-JS lamejs encoder — no native
// binary. Feeds the encoder one MPEG frame of samples at a time, then flushes.
export function encodeMp3(pcm: Buffer, kbps = DEFAULT_MP3_KBPS): Buffer {
  const samples = pcmToInt16(pcm);
  const encoder = new Mp3Encoder(CHANNELS, SAMPLE_RATE, kbps);
  const chunks: Buffer[] = [];

  for (let offset = 0; offset < samples.length; offset += MP3_FRAME_SAMPLES) {
    const frame = samples.subarray(offset, offset + MP3_FRAME_SAMPLES);
    const encoded = encoder.encodeBuffer(frame);
    if (encoded.length > 0)
      chunks.push(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.length));
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(Buffer.from(tail.buffer, tail.byteOffset, tail.length));
  return Buffer.concat(chunks);
}

/** Encode finished PCM to the format implied by `format` ("mp3" | "wav"). */
export function encode(pcm: Buffer, format: "mp3" | "wav", kbps?: number): Buffer {
  return format === "wav" ? encodeWav(pcm) : encodeMp3(pcm, kbps);
}

// View a PCM byte buffer as 16-bit samples. Uses a zero-copy typed-array view
// when the buffer is 2-byte aligned, otherwise copies into an aligned array.
function pcmToInt16(pcm: Buffer): Int16Array {
  const sampleCount = pcm.length >> 1;
  if (pcm.byteOffset % 2 === 0) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
  }
  const copy = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    copy[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
  }
  return copy;
}
