import assert from "node:assert/strict";
import { test } from "node:test";
import { BYTES_PER_SAMPLE, SAMPLE_RATE } from "../src/audio.ts";
import {
  durationSeconds,
  errorRate,
  normalizeText,
  peakDbfs,
  rmsDbfs,
} from "./integration/metrics.ts";

function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i += 1)
    buf.writeInt16LE(samples[i] as number, i * BYTES_PER_SAMPLE);
  return buf;
}

test("durationSeconds matches sample count and rate", () => {
  assert.equal(durationSeconds(pcm(new Array(SAMPLE_RATE).fill(0))), 1);
});

test("peakDbfs is 0 at full scale and -Infinity for silence", () => {
  assert.ok(Math.abs(peakDbfs(pcm([32767, -100]))) < 0.01);
  assert.equal(peakDbfs(pcm([0, 0, 0])), Number.NEGATIVE_INFINITY);
});

test("rmsDbfs is negative for sub-full-scale signal", () => {
  assert.ok(rmsDbfs(pcm([10000, -10000, 10000, -10000])) < 0);
});

test("normalizeText lowercases and strips punctuation", () => {
  assert.equal(normalizeText("Hello, World!  It's here."), "hello world it s here");
});

test("errorRate is 0 for identical text (ignoring case/punctuation)", () => {
  assert.equal(errorRate("Hello world.", "hello world"), 0);
});

test("errorRate counts word substitutions (WER)", () => {
  // one of four words wrong -> 0.25
  assert.equal(errorRate("the quick brown fox", "the quick brown dog"), 0.25);
});

test("errorRate handles deletions and insertions", () => {
  assert.equal(errorRate("a b c d", "a b c"), 0.25); // one deletion / 4 ref words
  assert.equal(errorRate("a b c d", "a b c d e"), 0.25); // one insertion / 4 ref words
});

test("errorRate falls back to character-level for CJK", () => {
  // 5 reference chars, 1 substituted -> 0.2 CER
  assert.equal(errorRate("今天天气好", "今天天气坏"), 0.2);
});
