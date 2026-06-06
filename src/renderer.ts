import { concatWithPauses, peakNormalize, type RenderedSegment } from "./audio.js";
import type { PcmCache } from "./cache.js";
import { chunk } from "./chunker.js";
import { resolveSegment, type Script, type Segment } from "./schema.js";
import type { Synthesizer } from "./tts.js";

// The deterministic core of the renderer, decoupled from the CLI and from file
// IO so it can be driven directly in tests with a fake `Synthesizer`. Given a
// validated script it returns the finished PCM; encoding and writing are the
// command's job.
export interface RenderDeps {
  client: Synthesizer;
  cache: PcmCache;
  /** Override the model for every segment (CLI --model). */
  modelOverride?: string;
  /** Override the voice for every segment (CLI --voice). */
  voiceOverride?: string;
  /** Peak-normalize the assembled audio. Default true. */
  normalize?: boolean;
  /** Progress sink; defaults to no-op. */
  onProgress?: (message: string) => void;
}

// Synthesize one segment's PCM: a cache hit returns immediately; otherwise the
// segment is technically chunked, each piece synthesized, and the pieces
// rejoined into a single per-segment buffer that is then cached. The cached
// unit is the whole segment, so the key is stable across chunker changes.
export async function renderSegmentPcm(
  script: Script,
  segment: Segment,
  deps: RenderDeps,
): Promise<Buffer> {
  const progress = deps.onProgress ?? (() => {});
  const resolved = resolveSegment(script, segment);
  const model = deps.modelOverride ?? resolved.model;
  const voice = deps.voiceOverride ?? resolved.voice;

  const key = deps.cache.key({
    model,
    voice,
    instructions: resolved.instructions,
    text: resolved.text,
  });

  const cached = deps.cache.get(key);
  if (cached !== undefined) {
    progress(`  ${segment.id}: cache hit`);
    return cached;
  }

  const pieces = chunk(resolved.text, script.max_chars);
  const buffers: Buffer[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const label = pieces.length > 1 ? `${segment.id} [${i + 1}/${pieces.length}]` : segment.id;
    progress(`  ${label}: synthesizing (${voice})`);
    try {
      const pcm = await deps.client.synthesize({
        model,
        voice,
        input: pieces[i] as string,
        instructions: resolved.instructions,
      });
      buffers.push(pcm);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to synthesize segment "${segment.id}": ${reason}`);
    }
  }

  const pcm = Buffer.concat(buffers);
  deps.cache.set(key, pcm);
  return pcm;
}

/** Render a whole validated script to finished PCM, in segment order. */
export async function renderScriptToPcm(script: Script, deps: RenderDeps): Promise<Buffer> {
  const rendered: RenderedSegment[] = [];
  for (const segment of script.segments) {
    const pcm = await renderSegmentPcm(script, segment, deps);
    rendered.push({ pcm, pauseAfterMs: segment.pause_after_ms ?? 0 });
  }

  const assembled = concatWithPauses(rendered);
  return deps.normalize === false ? assembled : peakNormalize(assembled);
}
