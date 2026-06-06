import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Caches generated PCM by a content hash so unchanged segments are never
// re-synthesized. The cached unit is a whole segment's PCM (after any internal
// chunks are rejoined), so the key is stable even if the chunker's splitting
// behavior changes later. Editing one segment's text busts only that entry.

export interface CacheKeyParts {
  model: string;
  voice: string;
  instructions?: string;
  text: string;
}

// NUL separator between key fields. NUL cannot occur in any of the values
// (model ids, voice names, instructions, spoken text), so it unambiguously
// delimits them: `["a", "b c"]` and `["a b", "c"]` hash differently. Built from
// a char code rather than a raw control byte so it stays visible in the source.
const FIELD_SEPARATOR = String.fromCharCode(0);

export class PcmCache {
  readonly #dir: string;
  readonly #enabled: boolean;

  /** Pass `undefined` to disable caching entirely (no reads, no writes). */
  constructor(dir: string | undefined) {
    this.#enabled = dir !== undefined;
    this.#dir = dir ?? "";
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  // The key intentionally includes everything that changes the audio: model,
  // voice, instructions, and the exact text.
  key(parts: CacheKeyParts): string {
    const material = [parts.model, parts.voice, parts.instructions ?? "", parts.text].join(
      FIELD_SEPARATOR,
    );
    return createHash("sha256").update(material).digest("hex");
  }

  #pathFor(key: string): string {
    return join(this.#dir, `${key}.pcm`);
  }

  get(key: string): Buffer | undefined {
    if (!this.#enabled) return undefined;
    const path = this.#pathFor(key);
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
  }

  set(key: string, pcm: Buffer): void {
    if (!this.#enabled) return;
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(this.#pathFor(key), pcm);
  }
}
