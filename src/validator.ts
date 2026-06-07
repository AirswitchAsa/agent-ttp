import { chunk } from "./chunker.js";
import { resolveApiKeySource } from "./config.js";
import {
  type Issue,
  KNOWN_VOICES,
  LEGACY_MODELS,
  MAX_REASONABLE_PAUSE_MS,
  RECOMMENDED_MAX_CHARS,
  resolveSegment,
  type Script,
} from "./schema.js";

export interface ValidationReport {
  issues: Issue[];
  /** Estimated finished duration in seconds, including pauses. */
  estimatedSeconds: number;
  /** Total spoken characters across all segments. */
  totalChars: number;
  /** Number of segments that will be technically chunked, and into how many. */
  chunkedSegments: { id: string; pieces: number }[];
  apiKey: { present: boolean; source: string };
}

// Rough speaking rates by language family, characters per second. CJK packs
// far more meaning per character than Latin scripts, so it reads slower in
// chars/sec. These drive a duration *estimate* only, never rendering.
const CJK_CHARS_PER_SEC = 5.0;
const LATIN_CHARS_PER_SEC = 15.0;

// Markdown / formatting artifacts that read badly when spoken aloud. Their
// presence is a warning: the agent likely pasted source text without rewriting.
const ARTIFACT_CHECKS: { test: RegExp; label: string }[] = [
  { test: /```/, label: "code fence (```)" },
  { test: /^\s*\|.*\|\s*$/m, label: "markdown table row" },
  { test: /!\[[^\]]*\]\([^)]*\)/, label: "markdown image" },
  { test: /\[[^\]]+\]\([^)]+\)/, label: "markdown link" },
  { test: /https?:\/\/\S+/, label: "raw URL" },
  { test: /^\s{0,3}#{1,6}\s/m, label: "markdown heading" },
  { test: /[*_]{2}[^*_]+[*_]{2}/, label: "bold/italic markup" },
];

function charsPerSecond(language: string | undefined): number {
  if (language && /^(zh|ja|ko|yue)/i.test(language)) return CJK_CHARS_PER_SEC;
  return LATIN_CHARS_PER_SEC;
}

export interface ValidateOptions {
  /** CLI --model: overrides every segment's model. Validated as the effective model. */
  modelOverride?: string;
  /** CLI --voice: overrides every segment's voice. Validated as the effective voice. */
  voiceOverride?: string;
  /** Parser warnings (unknown keys, wrong-typed fields) to fold into the report. */
  seedIssues?: Issue[];
}

// Validate a parsed script. Pure and network-free except for reading where the
// API key would come from (no key value is logged, only its source). CLI
// overrides are validated as the *effective* model/voice so `--model tts-1` (or
// an unknown `--voice`) is caught before any API call, not after.
export function validate(script: Script, options: ValidateOptions = {}): ValidationReport {
  const issues: Issue[] = [...(options.seedIssues ?? [])];
  let totalChars = 0;
  let spokenSeconds = 0;
  let pauseSeconds = 0;
  const chunkedSegments: { id: string; pieces: number }[] = [];

  for (const segment of script.segments) {
    const id = segment.id;
    const text = segment.text.trim();

    // Speaker must resolve to a defined voice — this is a hard error.
    if (!segment.speaker || script.voices[segment.speaker] === undefined) {
      issues.push({
        level: "error",
        segmentId: id,
        field: "speaker",
        message: `Unknown speaker "${segment.speaker}". Define it under \`voices\`.`,
      });
    }

    // Pause bounds. A negative pause is invalid (it silently becomes no pause
    // at render); an oversized one is almost always a typo. Checked before the
    // empty-text bail so it is reported independently of the text content.
    if (segment.pause_after_ms !== undefined) {
      if (segment.pause_after_ms < 0) {
        issues.push({
          level: "error",
          segmentId: id,
          field: "pause_after_ms",
          message: `pause_after_ms (${segment.pause_after_ms}) must be ≥ 0.`,
        });
      } else if (segment.pause_after_ms > MAX_REASONABLE_PAUSE_MS) {
        issues.push({
          level: "warning",
          segmentId: id,
          field: "pause_after_ms",
          message: `pause_after_ms (${segment.pause_after_ms}) is unusually long (> ${MAX_REASONABLE_PAUSE_MS} ms); is this intended?`,
        });
      }
    }

    if (text.length === 0) {
      issues.push({ level: "error", segmentId: id, field: "text", message: "Empty segment text." });
      continue;
    }

    const resolved = resolveSegment(script, segment);
    const effectiveModel = options.modelOverride ?? resolved.model;
    const effectiveVoice = options.voiceOverride ?? resolved.voice;

    // instructions are unsupported on legacy models.
    if (resolved.instructions && (LEGACY_MODELS as readonly string[]).includes(effectiveModel)) {
      issues.push({
        level: "error",
        segmentId: id,
        field: "instructions",
        message: `Model "${effectiveModel}" does not support \`instructions\`. Use gpt-4o-mini-tts.`,
      });
    }

    // Unknown voice name: warn but allow (the voice list drifts over time).
    if (!(KNOWN_VOICES as readonly string[]).includes(effectiveVoice)) {
      issues.push({
        level: "warning",
        segmentId: id,
        field: "voice",
        message: `Voice "${effectiveVoice}" is not a known built-in voice; rendering may fail.`,
      });
    }

    // Soft length guidance — warn only when a segment runs long enough that it
    // would be more listenable split into separate beats.
    if (text.length > RECOMMENDED_MAX_CHARS) {
      issues.push({
        level: "warning",
        segmentId: id,
        field: "text",
        message: `Segment is ${text.length} chars; consider splitting (recommended ≤ ${RECOMMENDED_MAX_CHARS}).`,
      });
    }

    // TTS-hostile artifacts.
    for (const { test, label } of ARTIFACT_CHECKS) {
      if (test.test(text)) {
        issues.push({
          level: "warning",
          segmentId: id,
          field: "text",
          message: `Contains ${label}, which reads badly aloud. Rewrite as spoken prose.`,
        });
      }
    }

    // Technical chunking preview — shares `max_chars` with the renderer.
    const pieces = chunk(text, script.max_chars);
    if (pieces.length > 1) {
      chunkedSegments.push({ id, pieces: pieces.length });
      issues.push({
        level: "info",
        segmentId: id,
        message: `Will be technically chunked into ${pieces.length} pieces (over max_chars ${script.max_chars}).`,
      });
    }

    totalChars += text.length;
    spokenSeconds += text.length / charsPerSecond(resolved.language);
    pauseSeconds += resolved.pauseAfterMs / 1000;
  }

  const apiKey = resolveApiKeySource();
  return {
    issues,
    estimatedSeconds: Math.round(spokenSeconds + pauseSeconds),
    totalChars,
    chunkedSegments,
    apiKey: { present: apiKey.source !== "missing", source: apiKey.source },
  };
}

export function hasErrors(report: ValidationReport): boolean {
  return report.issues.some((issue) => issue.level === "error");
}
