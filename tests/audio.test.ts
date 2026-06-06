import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BYTES_PER_SAMPLE,
  concatWithPauses,
  encode,
  encodeMp3,
  encodeWav,
  peakNormalize,
  SAMPLE_RATE,
  silence,
} from "../src/audio.ts";

// Build a PCM buffer from an array of 16-bit samples.
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i += 1) {
    buf.writeInt16LE(samples[i] as number, i * BYTES_PER_SAMPLE);
  }
  return buf;
}

test("silence is the right byte length and all zeros", () => {
  const ms = 500;
  const buf = silence(ms);
  const expectedSamples = Math.round((ms / 1000) * SAMPLE_RATE);
  assert.equal(buf.length, expectedSamples * BYTES_PER_SAMPLE);
  assert.ok(buf.every((byte) => byte === 0));
});

test("silence(0) is empty", () => {
  assert.equal(silence(0).length, 0);
  assert.equal(silence(-10).length, 0);
});

test("concatWithPauses preserves order and inserts the right silence", () => {
  const a = pcm([1, 2, 3]);
  const b = pcm([4, 5, 6]);
  const out = concatWithPauses([
    { pcm: a, pauseAfterMs: 0 },
    { pcm: b, pauseAfterMs: 100 },
  ]);
  const pauseSamples = Math.round((100 / 1000) * SAMPLE_RATE);
  const expectedLen = a.length + b.length + pauseSamples * BYTES_PER_SAMPLE;
  assert.equal(out.length, expectedLen);
  // First six samples are the two segments back-to-back.
  assert.equal(out.readInt16LE(0), 1);
  assert.equal(out.readInt16LE(3 * BYTES_PER_SAMPLE), 4);
});

test("peakNormalize scales the loudest sample to ~95% full scale", () => {
  const input = pcm([1000, -2000, 500]);
  const out = peakNormalize(input, 0.95);
  let maxAbs = 0;
  for (let i = 0; i < out.length / BYTES_PER_SAMPLE; i += 1) {
    maxAbs = Math.max(maxAbs, Math.abs(out.readInt16LE(i * BYTES_PER_SAMPLE)));
  }
  // Target peak is 0.95 * 32767 ≈ 31128.
  assert.ok(Math.abs(maxAbs - Math.round(0.95 * 32767)) <= 1, `peak was ${maxAbs}`);
});

test("peakNormalize leaves digital silence untouched", () => {
  const input = pcm([0, 0, 0]);
  assert.deepEqual(peakNormalize(input), input);
});

test("encodeWav prepends a 44-byte RIFF/WAVE header with correct fields", () => {
  const data = pcm([1, 2, 3, 4]);
  const wav = encodeWav(data);
  assert.equal(wav.length, 44 + data.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.readUInt32LE(40), data.length); // data chunk size
});

test("encodeMp3 produces a non-empty MP3 with a valid frame sync", () => {
  // A short sine-ish ramp; lamejs needs real sample data to emit frames.
  const samples = Array.from({ length: 4800 }, (_, i) => Math.round(8000 * Math.sin(i / 5)));
  const mp3 = encodeMp3(pcm(samples), 64);
  assert.ok(mp3.length > 0);
  // MP3 frame sync: first 11 bits set (0xFF 0xEx/0xFx).
  assert.equal(mp3[0], 0xff);
  assert.ok((mp3[1] as number) >= 0xe0);
});

test("encode() dispatches on the requested format", () => {
  const samples = Array.from({ length: 2400 }, (_, i) => Math.round(6000 * Math.sin(i / 4)));
  const wav = encode(pcm(samples), "wav");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  const mp3 = encode(pcm(samples), "mp3");
  assert.equal(mp3[0], 0xff);
  assert.notDeepEqual(wav.subarray(0, 4), mp3.subarray(0, 4));
});
