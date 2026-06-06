import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { Command } from "commander";
import { BYTES_PER_SAMPLE, encode, SAMPLE_RATE } from "../audio.js";
import { PcmCache } from "../cache.js";
import { defaultCacheDirectory, resolveApiKey } from "../config.js";
import { printLine } from "../output.js";
import { loadScriptFile } from "../parser.js";
import { renderScriptToPcm } from "../renderer.js";
import { parseScript } from "../schema.js";
import { TtsClient } from "../tts.js";
import { hasErrors, validate } from "../validator.js";
import { formatDuration, printReport } from "./_shared.js";

interface RenderOptions {
  output: string;
  model?: string;
  voice?: string;
  apiKey?: string;
  cache: string | false;
  normalize: boolean;
  bitrate?: string;
}

function outputFormat(path: string): "mp3" | "wav" {
  const ext = extname(path).toLowerCase();
  if (ext === ".mp3") return "mp3";
  if (ext === ".wav") return "wav";
  throw new Error(`Unsupported output format "${ext || "(none)"}". Use .mp3 or .wav.`);
}

function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

export const renderCommand = new Command("render")
  .description("Render a script file to audio (mp3 or wav).")
  .argument("<script>", "path to the YAML script file")
  .requiredOption("-o, --output <file>", "output file path (.mp3 or .wav)")
  .option("--model <model>", "override the model for every segment")
  .option("--voice <voice>", "override the voice for every segment")
  .option("--api-key <key>", "OpenAI API key (otherwise resolved from env/.env/config)")
  .option("--cache <dir>", "cache directory for generated audio", defaultCacheDirectory())
  .option("--no-cache", "disable the audio cache")
  .option("--no-normalize", "skip peak amplitude normalization")
  .option("--bitrate <kbps>", "MP3 bitrate in kbps (default 64)")
  .action(async (scriptPath: string, options: RenderOptions) => {
    const format = outputFormat(options.output);
    const kbps = options.bitrate === undefined ? undefined : Number(options.bitrate);
    if (kbps !== undefined && (!Number.isFinite(kbps) || kbps < 8 || kbps > 320)) {
      throw new Error(`Invalid --bitrate "${options.bitrate}". Use a number between 8 and 320.`);
    }
    if (kbps !== undefined && format === "wav") {
      progress("note: --bitrate is ignored for WAV output (WAV is uncompressed).");
    }

    // Parse + shape-validate.
    const { script, issues } = parseScript(loadScriptFile(scriptPath));
    if (script === undefined) {
      for (const issue of issues) {
        printLine(`  error   ${issue.field ? `[${issue.field}] ` : ""}${issue.message}`);
      }
      throw new Error("Script is not parseable; fix the errors above.");
    }

    // Semantic validation — fail fast before spending any API calls. CLI
    // overrides are validated as the effective model/voice, and parser warnings
    // are folded in, so nothing slips past on the way to a paid render.
    const report = validate(script, {
      modelOverride: options.model,
      voiceOverride: options.voice,
      seedIssues: issues,
    });
    printReport(report);
    printLine();
    if (hasErrors(report)) {
      throw new Error("Validation failed; no audio was generated.");
    }

    const apiKey = options.apiKey ?? resolveApiKey();
    // AGENT_TTP_TTS_ENDPOINT overrides the OpenAI URL — used by tests against a
    // local mock, and by anyone pointing at a compatible/proxy endpoint.
    const client = new TtsClient({ apiKey, endpoint: process.env.AGENT_TTP_TTS_ENDPOINT });
    const cache = new PcmCache(options.cache === false ? undefined : options.cache);
    if (cache.enabled) progress(`cache: ${options.cache}`);

    progress(`rendering ${script.segments.length} segment(s)…`);
    const pcm = await renderScriptToPcm(script, {
      client,
      cache,
      modelOverride: options.model,
      voiceOverride: options.voice,
      normalize: options.normalize,
      onProgress: progress,
    });

    const audio = encode(pcm, format, kbps);

    // Atomic write: assemble fully in memory, then write to a temp file and
    // rename, so a crash never leaves a truncated output. The temp name is
    // pid-scoped to avoid two concurrent renders racing on the same file, and
    // is cleaned up if the rename never happens.
    const tmp = `${options.output}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, audio);
      renameSync(tmp, options.output);
    } catch (error) {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
      throw error;
    }

    const seconds = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    const mb = (audio.length / 1_048_576).toFixed(2);
    printLine(
      `wrote ${options.output} — ${format.toUpperCase()}, ${formatDuration(seconds)}, ${mb} MB`,
    );
  });
