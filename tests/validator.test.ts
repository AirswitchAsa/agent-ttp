import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScript, type Script } from "../src/schema.ts";
import { hasErrors, validate } from "../src/validator.ts";

function build(overrides: Record<string, unknown>): Script {
  const { script } = parseScript({
    title: "t",
    voices: { host: { voice: "cedar", instructions: "calm" } },
    segments: [{ id: "a", speaker: "host", text: "A spoken sentence of reasonable length here." }],
    ...overrides,
  });
  if (!script) throw new Error("expected a parseable script");
  return script;
}

test("clean script has no errors", () => {
  const report = validate(build({}));
  assert.equal(hasErrors(report), false);
});

test("unknown speaker is a hard error", () => {
  const script = build({ segments: [{ id: "a", speaker: "ghost", text: "hello there" }] });
  const report = validate(script);
  assert.ok(hasErrors(report));
  assert.ok(report.issues.some((i) => i.field === "speaker" && i.level === "error"));
});

test("empty text is a hard error", () => {
  const script = build({ segments: [{ id: "a", speaker: "host", text: "   " }] });
  const report = validate(script);
  assert.ok(report.issues.some((i) => i.field === "text" && i.level === "error"));
});

test("a negative pause_after_ms is a hard error", () => {
  const script = build({
    segments: [{ id: "a", speaker: "host", text: "hello there", pause_after_ms: -100 }],
  });
  const report = validate(script);
  assert.ok(hasErrors(report));
  assert.ok(report.issues.some((i) => i.field === "pause_after_ms" && i.level === "error"));
});

test("an unusually long pause_after_ms warns but does not block", () => {
  const script = build({
    segments: [{ id: "a", speaker: "host", text: "hello there", pause_after_ms: 30000 }],
  });
  const report = validate(script);
  assert.equal(hasErrors(report), false);
  assert.ok(report.issues.some((i) => i.field === "pause_after_ms" && i.level === "warning"));
});

test("a reasonable pause_after_ms produces no pause issues", () => {
  const script = build({
    segments: [{ id: "a", speaker: "host", text: "hello there", pause_after_ms: 700 }],
  });
  const report = validate(script);
  assert.ok(!report.issues.some((i) => i.field === "pause_after_ms"));
});

test("instructions on a legacy model is a hard error", () => {
  const script = build({
    model: "tts-1",
    voices: { host: { voice: "alloy", instructions: "calm" } },
  });
  const report = validate(script);
  assert.ok(report.issues.some((i) => i.field === "instructions" && i.level === "error"));
});

test("a --model override onto a legacy model is caught (instructions unsupported)", () => {
  // Script is valid on its own (gpt-4o-mini-tts + instructions), but the CLI
  // override would send instructions to tts-1 — caught before any API call.
  const script = build({});
  const report = validate(script, { modelOverride: "tts-1" });
  assert.ok(report.issues.some((i) => i.field === "instructions" && i.level === "error"));
});

test("a --voice override to an unknown voice warns", () => {
  const report = validate(build({}), { voiceOverride: "not-a-real-voice" });
  assert.ok(report.issues.some((i) => i.field === "voice" && i.level === "warning"));
});

test("seeded parser issues are folded into the report", () => {
  const seeded = [{ level: "warning" as const, message: "from the parser", field: "x" }];
  const report = validate(build({}), { seedIssues: seeded });
  assert.ok(report.issues.some((i) => i.message === "from the parser"));
});

test("markdown artifacts produce warnings, not errors", () => {
  const script = build({
    segments: [{ id: "a", speaker: "host", text: "See the table:\n| a | b |\n| 1 | 2 |" }],
  });
  const report = validate(script);
  assert.equal(hasErrors(report), false);
  assert.ok(report.issues.some((i) => i.level === "warning" && /table/.test(i.message)));
});

test("oversized segment is previewed as technically chunked", () => {
  const long = "句子。".repeat(1000); // ~3000 chars, over default max_chars 2000
  const script = build({ segments: [{ id: "a", speaker: "host", text: long }] });
  const report = validate(script);
  assert.ok(report.chunkedSegments.some((c) => c.id === "a" && c.pieces > 1));
  assert.ok(report.issues.some((i) => i.level === "info" && /chunked/.test(i.message)));
});

test("estimates a positive duration", () => {
  const report = validate(build({}));
  assert.ok(report.estimatedSeconds > 0);
});

test("an unknown voice name is a warning, not an error", () => {
  const script = build({ voices: { host: { voice: "not-a-real-voice", instructions: "x" } } });
  const report = validate(script);
  assert.equal(hasErrors(report), false);
  assert.ok(report.issues.some((i) => i.field === "voice" && i.level === "warning"));
});

test("a very long segment warns about splitting (without being chunked)", () => {
  // 1600 chars: over the recommended 1200, but under the default max_chars 2000,
  // so it warns but is not technically chunked.
  const script = build({ segments: [{ id: "a", speaker: "host", text: "字。".repeat(800) }] });
  const report = validate(script);
  assert.ok(
    report.issues.some((i) => i.level === "warning" && /consider splitting/.test(i.message)),
  );
  assert.equal(report.chunkedSegments.length, 0);
});

test("the report reflects api-key presence as a boolean", () => {
  const report = validate(build({}));
  assert.equal(typeof report.apiKey.present, "boolean");
  assert.ok(typeof report.apiKey.source === "string");
});

test("per-segment language drives the duration estimate", () => {
  // Same character count, different languages → different estimated durations,
  // because CJK is spoken at a lower chars/sec than Latin text. The estimator
  // keys off the language tag, so each segment carries its own.
  const cjk = validate(
    build({ segments: [{ id: "a", speaker: "host", text: "字".repeat(100), language: "zh-CN" }] }),
  );
  const latin = validate(
    build({ segments: [{ id: "a", speaker: "host", text: "a".repeat(100), language: "en" }] }),
  );
  assert.ok(cjk.estimatedSeconds > latin.estimatedSeconds);
});
