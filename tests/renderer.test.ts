import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BYTES_PER_SAMPLE, concatWithPauses, silence } from "../src/audio.ts";
import { PcmCache } from "../src/cache.ts";
import { renderScriptToPcm } from "../src/renderer.ts";
import { parseScript, type Script } from "../src/schema.ts";
import type { SynthesizeParams, Synthesizer } from "../src/tts.ts";
import { mockPcm } from "./helpers.ts";

// A fake synthesizer: records every call and returns deterministic PCM. `fail`
// makes it throw if called — used to prove cache hits avoid the network.
class FakeSynth implements Synthesizer {
  calls: SynthesizeParams[] = [];
  constructor(private readonly fail = false) {}
  async synthesize(params: SynthesizeParams): Promise<Buffer> {
    if (this.fail) throw new Error("synthesize should not have been called");
    this.calls.push(params);
    return mockPcm(params.voice, params.input);
  }
}

function script(overrides: Record<string, unknown>): Script {
  const { script: parsed } = parseScript({
    title: "t",
    voices: { host: { voice: "cedar" }, guest: { voice: "marin" } },
    segments: [{ id: "a", speaker: "host", text: "first line" }],
    ...overrides,
  });
  if (!parsed) throw new Error("expected parseable script");
  return parsed;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-ttp-render-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("preserves segment order and inserts pauses", async () => {
  const s = script({
    segments: [
      { id: "a", speaker: "host", text: "alpha", pause_after_ms: 200 },
      { id: "b", speaker: "guest", text: "bravo" },
    ],
  });
  const client = new FakeSynth();
  const pcm = await renderScriptToPcm(s, {
    client,
    cache: new PcmCache(undefined),
    normalize: false,
  });

  const expected = concatWithPauses([
    { pcm: mockPcm("cedar", "alpha"), pauseAfterMs: 200 },
    { pcm: mockPcm("marin", "bravo"), pauseAfterMs: 0 },
  ]);
  assert.deepEqual(pcm, expected);
  // The 200ms gap really is present between the two segments.
  assert.equal(
    pcm.length,
    mockPcm("cedar", "alpha").length + silence(200).length + mockPcm("marin", "bravo").length,
  );
});

test("applies model and voice overrides to every segment", async () => {
  const s = script({
    segments: [
      { id: "a", speaker: "host", text: "one" },
      { id: "b", speaker: "guest", text: "two" },
    ],
  });
  const client = new FakeSynth();
  await renderScriptToPcm(s, {
    client,
    cache: new PcmCache(undefined),
    modelOverride: "tts-1-hd",
    voiceOverride: "shimmer",
  });
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls.every((c) => c.model === "tts-1-hd" && c.voice === "shimmer"));
});

test("technically chunks an oversized segment into multiple synth calls", async () => {
  const s = script({
    max_chars: 10,
    segments: [{ id: "a", speaker: "host", text: "one. two. three. four." }],
  });
  const client = new FakeSynth();
  await renderScriptToPcm(s, { client, cache: new PcmCache(undefined) });
  assert.ok(client.calls.length > 1, "oversized segment should be split into pieces");
  // Every piece is within the technical limit.
  assert.ok(client.calls.every((c) => c.input.length <= 10));
});

test("a cache hit skips synthesis entirely on re-render", async () => {
  const s = script({ segments: [{ id: "a", speaker: "host", text: "cache me" }] });
  const cache = new PcmCache(dir);

  // First render populates the cache.
  const first = await renderScriptToPcm(s, { client: new FakeSynth(), cache });

  // Second render with a client that throws if touched — must succeed from cache
  // and produce byte-identical output.
  const second = await renderScriptToPcm(s, { client: new FakeSynth(true), cache });
  assert.deepEqual(second, first);
});

test("labels which segment failed when synthesis errors", async () => {
  const s = script({ segments: [{ id: "boom", speaker: "host", text: "x" }] });
  const failing: Synthesizer = {
    synthesize: async () => {
      throw new Error("upstream 500");
    },
  };
  await assert.rejects(
    () => renderScriptToPcm(s, { client: failing, cache: new PcmCache(undefined) }),
    /Failed to synthesize segment "boom": upstream 500/,
  );
});

test("normalization is on by default and lengthens nothing", async () => {
  const s = script({ segments: [{ id: "a", speaker: "host", text: "normalize me please" }] });
  const client = new FakeSynth();
  const normalized = await renderScriptToPcm(s, { client, cache: new PcmCache(undefined) });
  const raw = mockPcm("cedar", "normalize me please");
  // Same number of samples, but peak pushed up toward full scale.
  assert.equal(normalized.length, raw.length);
  let normPeak = 0;
  for (let i = 0; i < normalized.length; i += BYTES_PER_SAMPLE) {
    normPeak = Math.max(normPeak, Math.abs(normalized.readInt16LE(i)));
  }
  assert.ok(normPeak > 30000, `expected near-full-scale peak, got ${normPeak}`);
});
