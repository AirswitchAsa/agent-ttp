import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk } from "../src/chunker.ts";

test("returns text unchanged when within the limit", () => {
  assert.deepEqual(chunk("Hello world.", 100), ["Hello world."]);
});

test("returns nothing for empty/whitespace text", () => {
  assert.deepEqual(chunk("   \n ", 100), []);
});

test("splits only at sentence boundaries when possible", () => {
  const text = "One sentence here. Two sentences here. Three sentences here.";
  const pieces = chunk(text, 25);
  assert.ok(pieces.length > 1);
  // No piece exceeds the limit.
  for (const piece of pieces) assert.ok(piece.length <= 25, `piece too long: ${piece}`);
  // Reassembly preserves all the words in order.
  assert.equal(pieces.join(" ").replace(/\s+/g, " ").trim(), text);
});

test("respects CJK sentence terminators", () => {
  const text = "第一句话。第二句话。第三句话。";
  const pieces = chunk(text, 6);
  assert.ok(pieces.length >= 2);
  for (const piece of pieces) assert.ok(piece.length <= 6);
});

test("hard-splits a single oversized sentence with no boundary", () => {
  const text = "x".repeat(50);
  const pieces = chunk(text, 20);
  assert.equal(pieces.length, 3);
  for (const piece of pieces) assert.ok(piece.length <= 20);
  assert.equal(pieces.join(""), text);
});

test("a non-positive limit terminates instead of spinning", () => {
  // The validator rejects max_chars < 1, but the chunker must never hang if a
  // bad value reaches it: it advances at least one character per cut.
  const pieces = chunk("abc def", 0);
  assert.ok(pieces.length > 0);
  assert.equal(pieces.join(""), "abcdef");
});

test("packs multiple short sentences into as few pieces as fit", () => {
  const text = "A. B. C. D. E.";
  const pieces = chunk(text, 6);
  // Each piece holds more than one sentence where it fits.
  assert.ok(pieces.length < 5);
});
