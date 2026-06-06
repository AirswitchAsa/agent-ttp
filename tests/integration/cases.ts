import { concatWithPauses, peakNormalize, type RenderedSegment } from "../../src/audio.ts";
import { PcmCache } from "../../src/cache.ts";
import { renderSegmentPcm } from "../../src/renderer.ts";
import { parseScript, resolveSegment, type Script } from "../../src/schema.ts";
import type { Synthesizer } from "../../src/tts.ts";

// Eval fixtures, each chosen to exercise one capability and kept short to keep
// API cost down. The same scripts feed both the rich eval harness (eval.ts) and
// the assertion-based integration tests.
export interface EvalCase {
  name: string;
  /** What this case demonstrates / what to look or listen for. */
  focus: string;
  script: Record<string, unknown>;
}

export interface RenderedPart {
  id: string;
  voice: string;
  language?: string;
  text: string;
  pcm: Buffer;
  pauseAfterMs: number;
}

export interface RenderedCase {
  script: Script;
  parts: RenderedPart[];
  /** Assembled, peak-normalized PCM — exactly what the renderer would output. */
  pcm: Buffer;
}

// Render a case through the real renderer pieces: per-segment synthesis, then
// the same concat + normalize the production path uses. Returns per-segment PCM
// too, so the eval can measure pauses and voice distinctness.
export async function renderCase(
  client: Synthesizer,
  raw: Record<string, unknown>,
): Promise<RenderedCase> {
  const { script, issues } = parseScript(raw);
  if (!script) throw new Error(`eval case did not parse: ${JSON.stringify(issues)}`);

  const cache = new PcmCache(undefined);
  const parts: RenderedPart[] = [];
  const assembled: RenderedSegment[] = [];

  for (const segment of script.segments) {
    const resolved = resolveSegment(script, segment);
    const pcm = await renderSegmentPcm(script, segment, { client, cache });
    parts.push({
      id: segment.id,
      voice: resolved.voice,
      language: resolved.language,
      text: resolved.text,
      pcm,
      pauseAfterMs: resolved.pauseAfterMs,
    });
    assembled.push({ pcm, pauseAfterMs: resolved.pauseAfterMs });
  }

  return { script, parts, pcm: peakNormalize(concatWithPauses(assembled)) };
}

export const EVAL_CASES: EvalCase[] = [
  {
    name: "repo-intro",
    focus:
      "Two-voice dialogue introducing the repo; WER + voice distinctness. Also a listenable intro.",
    script: {
      title: "What is agent-ttp?",
      language: "en",
      style: "clear, friendly, technical",
      voices: {
        host: { voice: "cedar", instructions: "Warm, clear narrator. Measured pace." },
        guest: { voice: "marin", instructions: "Curious co-host, conversational." },
      },
      segments: [
        {
          id: "hook",
          speaker: "host",
          pause_after_ms: 400,
          text: "Welcome. Today we are looking at agent ttp, a small command line tool that turns a written script into a finished podcast.",
        },
        {
          id: "question",
          speaker: "guest",
          pause_after_ms: 350,
          text: "So an agent writes the script, and the tool simply renders it to audio?",
        },
        {
          id: "answer",
          speaker: "host",
          text: "Exactly. The agent is the writer, and the command line tool is the renderer. It calls text to speech and stitches the segments together.",
        },
      ],
    },
  },
  {
    name: "pauses",
    focus: "Pause accuracy: the measured silence between segments should match pause_after_ms.",
    script: {
      title: "pause check",
      language: "en",
      voices: { v: { voice: "cedar", instructions: "Neutral narrator." } },
      segments: [
        { id: "one", speaker: "v", pause_after_ms: 600, text: "First sentence, before the pause." },
        { id: "two", speaker: "v", text: "Second sentence, after the pause." },
      ],
    },
  },
  {
    name: "pace",
    focus:
      "Instructions steer pace: the slow delivery should run longer than the fast one for identical text.",
    script: {
      title: "pace check",
      language: "en",
      voices: {
        slow: {
          voice: "cedar",
          instructions: "Speak very slowly and deliberately, with long pauses.",
        },
        fast: { voice: "cedar", instructions: "Speak quickly and energetically, at a brisk pace." },
      },
      segments: [
        { id: "slow", speaker: "slow", text: "The quick brown fox jumps over the lazy dog." },
        { id: "fast", speaker: "fast", text: "The quick brown fox jumps over the lazy dog." },
      ],
    },
  },
  {
    name: "multilingual",
    focus:
      "Per-segment language: an English line and a Spanish line in one episode, scored in each language.",
    script: {
      title: "language learning",
      language: "en",
      voices: { teacher: { voice: "marin", instructions: "Friendly, clear language teacher." } },
      segments: [
        {
          id: "en",
          speaker: "teacher",
          language: "en",
          text: "Here is how you say good morning in Spanish.",
        },
        { id: "es", speaker: "teacher", language: "es", text: "Buenos días, ¿cómo estás hoy?" },
      ],
    },
  },
  {
    name: "chunking",
    focus:
      "Technical chunking: a low max_chars forces a split; WER confirms no text is dropped at the seams.",
    script: {
      title: "chunk check",
      language: "en",
      max_chars: 80,
      voices: { v: { voice: "cedar", instructions: "Neutral narrator." } },
      segments: [
        {
          id: "long",
          speaker: "v",
          text: "This is the first sentence. This is the second sentence. This is the third sentence. And this is the fourth sentence, which pushes us over the limit.",
        },
      ],
    },
  },
];
