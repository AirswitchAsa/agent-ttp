// The contract between the agent (writer) and the CLI (renderer).
//
// A script is a small, declarative document. Generation parameters cascade
// across three levels — script defaults, named voice, per-segment override —
// with the most specific value winning. A "segment" is both the unit of
// configuration and the unit of technical chunking.

/** The text-to-speech model used by default when a script omits `model`. */
export const DEFAULT_MODEL = "gpt-4o-mini-tts-2025-12-15";

/** Default fallback voice when a voice config omits `voice`. */
export const DEFAULT_VOICE = "cedar";

// OpenAI's TTS hard limit is 4096 characters per request. We default the
// technical-chunk threshold below that to leave headroom for tokenization
// differences (notably CJK, where one character can be multiple tokens).
export const TTS_HARD_CHAR_LIMIT = 4096;
export const DEFAULT_MAX_CHARS = 2000;

// Soft authoring guidance: above this length a segment is usually more
// listenable split into separate beats. The validator warns but never blocks.
export const RECOMMENDED_MAX_CHARS = 1200;

/** Known built-in voices for gpt-4o-mini-tts. Used for warnings only — the */
/** list drifts over time, so an unknown name is never a hard error. */
export const KNOWN_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

/** Models that do not support the `instructions` parameter. */
export const LEGACY_MODELS = ["tts-1", "tts-1-hd"] as const;

// Recognized keys at each level. Anything outside these sets is almost always a
// typo (e.g. `pause_after` for `pause_after_ms`, or `voice` on a segment instead
// of `speaker`); the parser warns rather than silently dropping it.
const KNOWN_SCRIPT_KEYS = new Set([
  "title",
  "language",
  "style",
  "model",
  "max_chars",
  "voices",
  "segments",
]);
const KNOWN_VOICE_KEYS = new Set(["voice", "instructions", "model"]);
const KNOWN_SEGMENT_KEYS = new Set([
  "id",
  "speaker",
  "text",
  "language",
  "intent",
  "pause_after_ms",
  "instructions",
  "model",
]);

export interface VoiceConfig {
  /** OpenAI voice id, e.g. "cedar" or "marin". */
  voice: string;
  /**
   * Delivery direction in natural language — the one steering knob the TTS
   * model exposes. Controls accent, emotional range, intonation, tone, pace
   * ("speed of speech"), and whispering. gpt-4o-mini-tts only.
   */
  instructions?: string;
  /** Override the script-level model for this voice. */
  model?: string;
}

export interface Segment {
  /** Stable, unique id. Used in cache keys and error messages. */
  id: string;
  /** Must reference a key in `voices`. Alternating speakers = dialogue. */
  speaker: string;
  /** The spoken text for this block. */
  text: string;
  /**
   * Spoken language of this segment (e.g. "zh-CN", "es"). The API has no
   * language parameter — language is a property of the text itself — so this
   * is local metadata: it seeds delivery instructions and the duration
   * estimate. It lives on the segment because a single episode (e.g. language
   * learning) can switch languages block to block. Falls back to the
   * script-level `language` default.
   */
  language?: string;
  /** Free-form authoring metadata (e.g. "hook"). Not sent to the API. */
  intent?: string;
  /** Silence inserted after this segment, in milliseconds. */
  pause_after_ms?: number;
  /** Per-segment delivery override; wins over the voice's instructions. */
  instructions?: string;
  /** Per-segment model override. */
  model?: string;
}

export interface Script {
  title: string;
  /** Default spoken language for segments that do not set their own. */
  language?: string;
  style?: string;
  model: string;
  max_chars: number;
  voices: Record<string, VoiceConfig>;
  segments: Segment[];
}

/** A single problem found while parsing or validating a script. */
export interface Issue {
  level: "error" | "warning" | "info";
  message: string;
  segmentId?: string;
  field?: string;
}

/** Fully resolved generation parameters for one segment after the cascade. */
export interface ResolvedSegment {
  id: string;
  text: string;
  model: string;
  voice: string;
  instructions?: string;
  /** Resolved spoken language (segment, else script default). Metadata only. */
  language?: string;
  pauseAfterMs: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Turn an untyped parsed-YAML object into a typed `Script`, collecting every
// shape problem rather than throwing on the first. Returns the script only
// when there are no errors; otherwise the caller reports `issues`. Warnings
// (unknown keys, wrong-typed optional fields) are returned alongside a valid
// script so the commands can surface them without blocking.
export function parseScript(raw: unknown): { script?: Script; issues: Issue[] } {
  const issues: Issue[] = [];
  const err = (message: string, field?: string): void => {
    issues.push({ level: "error", message, field });
  };
  const warn = (message: string, field?: string, segmentId?: string): void => {
    issues.push({ level: "warning", message, field, segmentId });
  };
  // Warn (but don't fail) when a present optional field has the wrong type; the
  // value is dropped, which would otherwise be a silent footgun.
  const checkType = (
    container: Record<string, unknown>,
    key: string,
    expected: "string" | "number",
    segmentId?: string,
  ): void => {
    const value = container[key];
    if (value === undefined || value === null) return;
    const ok =
      expected === "string"
        ? typeof value === "string"
        : typeof value === "number" && Number.isFinite(value);
    if (!ok) {
      warn(`\`${key}\` must be a ${expected}; ignoring the provided value.`, key, segmentId);
    }
  };
  const warnUnknownKeys = (
    container: Record<string, unknown>,
    known: Set<string>,
    label: string,
    segmentId?: string,
  ): void => {
    for (const key of Object.keys(container)) {
      if (!known.has(key)) warn(`Unknown field "${key}" ${label}; ignored.`, key, segmentId);
    }
  };

  if (!isObject(raw)) {
    return { issues: [{ level: "error", message: "Script must be a YAML mapping." }] };
  }

  warnUnknownKeys(raw, KNOWN_SCRIPT_KEYS, "at the script level");

  const title = asString(raw.title);
  if (title === undefined || title.trim().length === 0) {
    err("Missing required field: title", "title");
  }
  checkType(raw, "language", "string");
  checkType(raw, "style", "string");
  checkType(raw, "model", "string");
  checkType(raw, "max_chars", "number");

  const model = asString(raw.model) ?? DEFAULT_MODEL;
  const maxChars = asNumber(raw.max_chars) ?? DEFAULT_MAX_CHARS;
  if (maxChars > TTS_HARD_CHAR_LIMIT) {
    err(
      `max_chars (${maxChars}) exceeds the TTS hard limit of ${TTS_HARD_CHAR_LIMIT}.`,
      "max_chars",
    );
  } else if (!Number.isInteger(maxChars) || maxChars < 1) {
    err(`max_chars (${maxChars}) must be a positive integer.`, "max_chars");
  }

  const voices: Record<string, VoiceConfig> = {};
  if (raw.voices !== undefined) {
    if (!isObject(raw.voices)) {
      err("`voices` must be a mapping of name to voice config.", "voices");
    } else {
      for (const [name, value] of Object.entries(raw.voices)) {
        if (!isObject(value)) {
          err(`Voice "${name}" must be a mapping.`, `voices.${name}`);
          continue;
        }
        warnUnknownKeys(value, KNOWN_VOICE_KEYS, `in voice "${name}"`);
        checkType(value, "voice", "string");
        checkType(value, "instructions", "string");
        checkType(value, "model", "string");
        const voice = asString(value.voice) ?? DEFAULT_VOICE;
        voices[name] = {
          voice,
          instructions: asString(value.instructions),
          model: asString(value.model),
        };
      }
    }
  }
  if (Object.keys(voices).length === 0) {
    err("At least one voice must be defined under `voices`.", "voices");
  }

  const segments: Segment[] = [];
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    err("`segments` must be a non-empty list.", "segments");
  } else {
    const seenIds = new Set<string>();
    raw.segments.forEach((value, index) => {
      if (!isObject(value)) {
        err(`Segment #${index + 1} must be a mapping.`, `segments[${index}]`);
        return;
      }
      const id = asString(value.id) ?? `segment-${index + 1}`;
      // A duplicate id is a warning, not a hard error: cache keys are content-
      // based, so duplicates still render correctly — they only make error and
      // progress labels ambiguous. Warning rather than failing lets the rest of
      // validation run instead of short-circuiting on the first clash.
      if (seenIds.has(id)) {
        warn(`Duplicate segment id "${id}"; ids should be unique.`, undefined, id);
      }
      seenIds.add(id);

      warnUnknownKeys(value, KNOWN_SEGMENT_KEYS, "in segment", id);

      const speaker = asString(value.speaker);
      if (speaker === undefined) {
        issues.push({ level: "error", message: "Segment is missing `speaker`.", segmentId: id });
      }
      // Wrong-typed text is a hard error (not a silent empty segment).
      if (value.text !== undefined && typeof value.text !== "string") {
        issues.push({
          level: "error",
          segmentId: id,
          field: "text",
          message: "`text` must be a string.",
        });
      }
      checkType(value, "language", "string", id);
      checkType(value, "intent", "string", id);
      checkType(value, "instructions", "string", id);
      checkType(value, "model", "string", id);
      checkType(value, "pause_after_ms", "number", id);
      const text = asString(value.text) ?? "";

      segments.push({
        id,
        speaker: speaker ?? "",
        text,
        language: asString(value.language),
        intent: asString(value.intent),
        pause_after_ms: asNumber(value.pause_after_ms),
        instructions: asString(value.instructions),
        model: asString(value.model),
      });
    });
  }

  if (issues.some((issue) => issue.level === "error")) {
    return { issues };
  }

  return {
    script: {
      title: title as string,
      language: asString(raw.language),
      style: asString(raw.style),
      model,
      max_chars: maxChars,
      voices,
      segments,
    },
    issues,
  };
}

// Apply the cascade for one segment. Delivery instructions are most-specific-
// wins with no concatenation among them (segment > voice > style), which keeps
// delivery predictable. Language is a separate concern: because the API has no
// language parameter, the resolved language is always appended as its own clause
// so a multi-language episode renders each block in its own language — even when
// the block also carries explicit delivery instructions.
export function resolveSegment(script: Script, segment: Segment): ResolvedSegment {
  const voice = script.voices[segment.speaker];
  const model = segment.model ?? voice?.model ?? script.model;
  const language = segment.language ?? script.language;
  const delivery = segment.instructions ?? voice?.instructions ?? script.style;
  const instructions = composeInstructions(delivery, language);
  return {
    id: segment.id,
    text: segment.text,
    model,
    voice: voice?.voice ?? DEFAULT_VOICE,
    instructions: instructions === "" ? undefined : instructions,
    language,
    pauseAfterMs: segment.pause_after_ms ?? 0,
  };
}

// Combine the chosen delivery direction with the resolved language. Language is
// how spoken language reaches the model — the API has no language parameter — so
// it is always carried, appended after any delivery instructions.
function composeInstructions(delivery: string | undefined, language: string | undefined): string {
  const parts: string[] = [];
  if (delivery) parts.push(delivery);
  if (language) parts.push(`Speak in ${language}.`);
  return parts.join(" ").trim();
}
