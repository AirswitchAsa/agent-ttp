import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BYTES_PER_SAMPLE, encode, SAMPLE_RATE } from "../../src/audio.ts";
import { PcmCache } from "../../src/cache.ts";
import { resolveApiKeySource } from "../../src/config.ts";
import { renderScriptToPcm } from "../../src/renderer.ts";
import { parseScript } from "../../src/schema.ts";
import { TtsClient } from "../../src/tts.ts";
import { EVAL_CASES, renderCase } from "./cases.ts";
import { durationSeconds, errorRate } from "./metrics.ts";
import { transcribe } from "./transcribe.ts";

// Real-endpoint assertions. Skipped unless an API key resolves (env/.env/config).
// Run with `npm run test:integration`. These cost a small amount of OpenAI usage.
const resolution = resolveApiKeySource();
const apiKey = resolution.key;
const skip = apiKey === undefined;
const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

function caseScript(name: string): Record<string, unknown> {
  const found = EVAL_CASES.find((c) => c.name === name);
  if (!found) throw new Error(`unknown eval case: ${name}`);
  return found.script;
}

test("CLI renders a script to a valid MP3 end to end", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-ttp-itest-"));
  try {
    const script = join(dir, "script.yaml");
    const out = join(dir, "episode.mp3");
    writeFileSync(
      script,
      [
        'title: "Smoke Test"',
        'language: "en"',
        "voices:",
        "  host: { voice: cedar }",
        "segments:",
        "  - id: one",
        "    speaker: host",
        '    text: "If you can hear this sentence, the renderer works end to end."',
      ].join("\n"),
    );
    execFileSync("node", ["dist/cli.js", "render", script, "-o", out, "--no-cache"], {
      stdio: "inherit",
    });
    const audio = readFileSync(out);
    assert.ok(audio.length > 1000);
    assert.equal(audio[0], 0xff);
    assert.ok((audio[1] as number) >= 0xe0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round-trip WER stays low per segment for a clear English render", { skip }, async () => {
  const client = new TtsClient({ apiKey: apiKey ?? "" });
  const rendered = await renderCase(client, caseScript("repo-intro"));
  // Transcribe each segment separately: short clips are reliable, so this
  // measures TTS fidelity rather than whole-episode STT truncation.
  for (const part of rendered.parts) {
    const hyp = await transcribe(encode(part.pcm, "wav"), { apiKey: apiKey ?? "", language: "en" });
    const wer = errorRate(part.text, hyp);
    assert.ok(wer < 0.2, `segment "${part.id}" WER too high (${wer.toFixed(3)}): "${hyp}"`);
  }
});

test("inserted pause matches pause_after_ms in the real output", { skip }, async () => {
  const client = new TtsClient({ apiKey: apiKey ?? "" });
  const rendered = await renderCase(client, caseScript("pauses"));
  const sumParts = rendered.parts.reduce((n, p) => n + p.pcm.length, 0);
  const expectedMs = rendered.parts.reduce((n, p) => n + p.pauseAfterMs, 0);
  const measuredMs = Math.round((rendered.pcm.length - sumParts) / BYTES_PER_MS);
  assert.ok(
    Math.abs(measuredMs - expectedMs) <= 50,
    `pause off: expected ${expectedMs}ms, got ${measuredMs}ms`,
  );
});

test("different voices produce different audio for identical text", { skip }, async () => {
  const client = new TtsClient({ apiKey: apiKey ?? "" });
  const text = "The quick brown fox jumps over the lazy dog.";
  const cedar = await client.synthesize({ model: "gpt-4o-mini-tts", voice: "cedar", input: text });
  const marin = await client.synthesize({ model: "gpt-4o-mini-tts", voice: "marin", input: text });
  assert.ok(cedar.length > 0 && marin.length > 0);
  assert.equal(cedar.equals(marin), false, "two voices should not produce identical PCM");
});

test("instructions steer pace: slow runs longer than fast", { skip }, async () => {
  const client = new TtsClient({ apiKey: apiKey ?? "" });
  const rendered = await renderCase(client, caseScript("pace"));
  const slow = rendered.parts.find((p) => p.id === "slow");
  const fast = rendered.parts.find((p) => p.id === "fast");
  assert.ok(slow && fast);
  assert.ok(
    durationSeconds(slow.pcm) > durationSeconds(fast.pcm),
    `expected slow > fast, got ${durationSeconds(slow.pcm).toFixed(2)}s vs ${durationSeconds(fast.pcm).toFixed(2)}s`,
  );
});

test("a cached re-render is byte-identical and needs no network", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-ttp-cache-"));
  try {
    const cache = new PcmCache(dir);
    const { script } = parseScript({
      title: "cache",
      language: "en",
      voices: { v: { voice: "cedar" } },
      segments: [{ id: "a", speaker: "v", text: "Cache determinism check." }],
    });
    assert.ok(script);
    const realClient = new TtsClient({ apiKey: apiKey ?? "" });
    const first = await renderScriptToPcm(script, { client: realClient, cache });

    // Second pass: a client that throws if called — proves the cache served it.
    const throwing = {
      synthesize: async () => {
        throw new Error("network should not be touched on a cache hit");
      },
    };
    const second = await renderScriptToPcm(script, { client: throwing, cache });
    assert.deepEqual(second, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
