import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  parseScript,
  resolveSegment,
} from "../src/schema.ts";

const GOOD = {
  title: "Test",
  language: "en",
  style: "calm",
  voices: { host: { voice: "cedar", instructions: "Calm." }, guest: { voice: "marin" } },
  segments: [
    { id: "a", speaker: "host", text: "Hello." },
    { id: "b", speaker: "guest", text: "Hi.", instructions: "Curious." },
  ],
};

test("parses a valid script and applies defaults", () => {
  const { script, issues } = parseScript(GOOD);
  assert.equal(issues.filter((i) => i.level === "error").length, 0);
  assert.ok(script);
  assert.equal(script.model, DEFAULT_MODEL);
  assert.equal(script.max_chars, DEFAULT_MAX_CHARS);
  assert.equal(script.segments.length, 2);
});

test("reports missing title and empty voices/segments", () => {
  const { script, issues } = parseScript({ voices: {}, segments: [] });
  assert.equal(script, undefined);
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes("title"));
  assert.ok(fields.includes("voices"));
  assert.ok(fields.includes("segments"));
});

test("max_chars beyond the TTS hard limit is an error", () => {
  const { script, issues } = parseScript({
    title: "t",
    max_chars: 99_999,
    voices: { host: { voice: "cedar" } },
    segments: [{ id: "a", speaker: "host", text: "hi" }],
  });
  assert.equal(script, undefined);
  assert.ok(issues.some((i) => i.field === "max_chars"));
});

test("a segment without a speaker is a shape error", () => {
  const { script, issues } = parseScript({
    title: "t",
    voices: { host: { voice: "cedar" } },
    segments: [{ id: "a", text: "hi" }],
  });
  assert.equal(script, undefined);
  assert.ok(issues.some((i) => /missing `speaker`/.test(i.message)));
});

test("a voice without an explicit voice id falls back to the default", () => {
  const { script } = parseScript({
    title: "t",
    voices: { host: {} },
    segments: [{ id: "a", speaker: "host", text: "hi" }],
  });
  assert.ok(script);
  assert.equal(script.voices.host?.voice, DEFAULT_VOICE);
});

test("cascade: a per-segment model overrides voice and script model", () => {
  const { script } = parseScript({
    title: "t",
    model: "gpt-4o-mini-tts",
    voices: { host: { voice: "cedar", model: "tts-1" } },
    segments: [{ id: "a", speaker: "host", text: "hi", model: "tts-1-hd" }],
  });
  assert.ok(script);
  const [only] = script.segments;
  assert.ok(only);
  assert.equal(resolveSegment(script, only).model, "tts-1-hd");
});

test("flags duplicate segment ids as a warning without blocking", () => {
  const { script, issues } = parseScript({
    title: "x",
    voices: { host: { voice: "cedar" } },
    segments: [
      { id: "dup", speaker: "host", text: "one" },
      { id: "dup", speaker: "host", text: "two" },
    ],
  });
  // Content-based cache keys make duplicates safe to render; warn, don't block.
  assert.ok(script);
  assert.ok(issues.some((i) => i.level === "warning" && /Duplicate segment id/.test(i.message)));
});

test("max_chars below 1 (or non-integer) is an error", () => {
  for (const bad of [0, -5, 2.5]) {
    const { script, issues } = parseScript({
      title: "t",
      max_chars: bad,
      voices: { host: { voice: "cedar" } },
      segments: [{ id: "a", speaker: "host", text: "hi" }],
    });
    assert.equal(script, undefined, `max_chars=${bad} should be rejected`);
    assert.ok(issues.some((i) => i.field === "max_chars" && i.level === "error"));
  }
});

test("warns on unknown fields and wrong-typed optional fields", () => {
  const { script, issues } = parseScript({
    title: "t",
    bogus_top: 1, // unknown script field
    voices: { host: { voice: "cedar" } },
    segments: [
      // `voice` on a segment is a common mistake for `speaker`; pause is mistyped.
      { id: "a", speaker: "host", text: "hello", voice: "marin", pause_after_ms: "700" },
    ],
  });
  assert.ok(script); // warnings don't block
  assert.ok(issues.some((i) => i.level === "warning" && /bogus_top/.test(i.message)));
  assert.ok(
    issues.some((i) => i.level === "warning" && i.segmentId === "a" && /voice/.test(i.message)),
  );
  assert.ok(issues.some((i) => i.level === "warning" && i.field === "pause_after_ms"));
});

test("wrong-typed text is a hard error", () => {
  const { script, issues } = parseScript({
    title: "t",
    voices: { host: { voice: "cedar" } },
    segments: [{ id: "a", speaker: "host", text: 12345 }],
  });
  assert.equal(script, undefined);
  assert.ok(
    issues.some((i) => i.field === "text" && i.level === "error" && /string/.test(i.message)),
  );
});

test("cascade: segment instructions win over voice over script", () => {
  const { script } = parseScript(GOOD);
  assert.ok(script);
  const [first, second] = script.segments;
  assert.ok(first && second);
  const a = resolveSegment(script, first);
  const b = resolveSegment(script, second);
  // Delivery cascade: voice for `a`, segment override for `b`. The script's
  // `language: en` is always appended as its own clause (see next test).
  assert.match(a.instructions ?? "", /^Calm\./); // from voice
  assert.match(b.instructions ?? "", /^Curious\./); // from segment, overriding voice + script
  assert.match(a.instructions ?? "", /Speak in en\.$/);
  assert.match(b.instructions ?? "", /Speak in en\.$/);
  assert.equal(a.voice, "cedar");
  assert.equal(b.voice, "marin");
});

test("language is carried even when explicit instructions are present", () => {
  const { script } = parseScript({
    title: "Lesson",
    voices: { host: { voice: "cedar", instructions: "Thoughtful co-host." } },
    segments: [{ id: "ex", speaker: "host", text: "Hola.", language: "es" }],
  });
  assert.ok(script);
  const [only] = script.segments;
  assert.ok(only);
  const r = resolveSegment(script, only);
  // Both the explicit delivery direction and the language reach the model.
  assert.match(r.instructions ?? "", /Thoughtful co-host\./);
  assert.match(r.instructions ?? "", /Speak in es\./);
});

test("language resolves segment-first, falling back to the script default", () => {
  const { script } = parseScript({
    title: "Lesson",
    language: "en", // script default
    voices: { host: { voice: "cedar" } }, // no instructions -> language seeds them
    segments: [
      { id: "explain", speaker: "host", text: "Listen to this phrase." },
      { id: "example", speaker: "host", text: "Buenos días.", language: "es" }, // override
    ],
  });
  assert.ok(script);
  const [explain, example] = script.segments;
  assert.ok(explain && example);
  const a = resolveSegment(script, explain);
  const b = resolveSegment(script, example);
  assert.equal(a.language, "en");
  assert.equal(b.language, "es");
  // Resolved language is what reaches the model, via synthesized instructions.
  assert.match(a.instructions ?? "", /Speak in en\./);
  assert.match(b.instructions ?? "", /Speak in es\./);
});

test("synthesizes instructions from style/language when none given", () => {
  const { script } = parseScript({
    title: "x",
    language: "zh-CN",
    style: "calm, dense",
    voices: { host: { voice: "cedar" } }, // no instructions
    segments: [{ id: "a", speaker: "host", text: "hello" }],
  });
  assert.ok(script);
  const [only] = script.segments;
  assert.ok(only);
  const r = resolveSegment(script, only);
  assert.match(r.instructions ?? "", /calm, dense/);
  assert.match(r.instructions ?? "", /zh-CN/);
});
