import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BYTES_PER_SAMPLE, encode, SAMPLE_RATE } from "../../src/audio.ts";
import { chunk } from "../../src/chunker.ts";
import { resolveApiKey } from "../../src/config.ts";
import { TtsClient } from "../../src/tts.ts";
import { EVAL_CASES, type RenderedCase, renderCase } from "./cases.ts";
import { durationSeconds, errorRate, peakDbfs, rmsDbfs } from "./metrics.ts";
import { transcribe } from "./transcribe.ts";

// Real-endpoint evaluation harness. Renders every fixture, measures it
// quantitatively (duration, level, pause accuracy, pace effect, WER via
// round-trip transcription), and writes both machine-readable (report.json)
// and human-readable (report.md) reports alongside the audio for listening.
//
//   npm run eval
//
// Costs a small amount of OpenAI usage (TTS + transcription). Texts are short.

const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

interface Transcript {
  id: string;
  reference: string;
  hypothesis: string;
  errorRate: number;
}

interface CaseResult {
  name: string;
  focus: string;
  seconds: number;
  peakDbfs: number;
  rmsDbfs: number;
  files: { mp3: string; wav: string };
  metrics: Record<string, string | number | boolean>;
  transcripts: Transcript[];
  error?: string;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

async function evaluateCase(
  apiKey: string,
  name: string,
  focus: string,
  rendered: RenderedCase,
): Promise<CaseResult> {
  const wav = encode(rendered.pcm, "wav");
  const mp3 = encode(rendered.pcm, "mp3");
  const mp3Path = join(OUTPUT_DIR, `${name}.mp3`);
  const wavPath = join(OUTPUT_DIR, `${name}.wav`);
  writeFileSync(mp3Path, mp3);
  writeFileSync(wavPath, wav);

  const metrics: Record<string, string | number | boolean> = {};
  const transcripts: Transcript[] = [];

  // Case-specific quantitative checks.
  if (name === "pauses") {
    const sumParts = rendered.parts.reduce((n, p) => n + p.pcm.length, 0);
    const expectedMs = rendered.parts.reduce((n, p) => n + p.pauseAfterMs, 0);
    const measuredMs = Math.round((rendered.pcm.length - sumParts) / BYTES_PER_MS);
    metrics.expectedPauseMs = expectedMs;
    metrics.measuredPauseMs = measuredMs;
    metrics.pauseErrorMs = Math.abs(measuredMs - expectedMs);
  } else if (name === "pace") {
    const slow = rendered.parts.find((p) => p.id === "slow");
    const fast = rendered.parts.find((p) => p.id === "fast");
    if (slow && fast) {
      metrics.slowSeconds = round(durationSeconds(slow.pcm));
      metrics.fastSeconds = round(durationSeconds(fast.pcm));
      metrics.slowerThanFast = durationSeconds(slow.pcm) > durationSeconds(fast.pcm);
    }
  } else {
    // WER cases (repo-intro, multilingual, chunking): transcribe each segment
    // separately, in its own language. Per-segment clips are short and clean, so
    // this isolates TTS fidelity instead of conflating it with whole-episode STT
    // truncation. The reported WER is the average across segments.
    let total = 0;
    for (const part of rendered.parts) {
      const hyp = await transcribe(encode(part.pcm, "wav"), {
        apiKey,
        language: part.language ?? "en",
      });
      const wer = errorRate(part.text, hyp);
      metrics[`wer_${part.id}`] = round(wer, 3);
      transcripts.push({
        id: part.id,
        reference: part.text,
        hypothesis: hyp,
        errorRate: round(wer, 3),
      });
      total += wer;
    }
    metrics.werAvg = round(total / Math.max(1, rendered.parts.length), 3);
    if (name === "repo-intro") {
      metrics.voices = [...new Set(rendered.parts.map((p) => p.voice))].join(", ");
    }
    if (name === "chunking" && rendered.parts[0]) {
      metrics.pieces = chunk(rendered.parts[0].text, rendered.script.max_chars).length;
    }
  }

  return {
    name,
    focus,
    seconds: round(durationSeconds(rendered.pcm)),
    peakDbfs: round(peakDbfs(rendered.pcm), 1),
    rmsDbfs: round(rmsDbfs(rendered.pcm), 1),
    files: { mp3: `${name}.mp3`, wav: `${name}.wav` },
    metrics,
    transcripts,
  };
}

function renderReportMarkdown(results: CaseResult[]): string {
  const lines: string[] = [];
  lines.push("# agent-ttp evaluation report", "");
  lines.push("Real-endpoint render of every fixture, with quantitative metrics and round-trip");
  lines.push(
    "transcription. Listen to the `.mp3`/`.wav` files in this folder for the qualitative side.",
    "",
  );
  lines.push("| case | duration | peak dBFS | rms dBFS | headline metric |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.name} | — | — | — | ERROR: ${r.error} |`);
      continue;
    }
    const headline = Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`| ${r.name} | ${r.seconds}s | ${r.peakDbfs} | ${r.rmsDbfs} | ${headline} |`);
  }
  lines.push("");

  for (const r of results) {
    lines.push(`## ${r.name}`, "", `_${r.focus}_`, "");
    if (r.error) {
      lines.push(`**ERROR:** ${r.error}`, "");
      continue;
    }
    lines.push(`- audio: [${r.files.mp3}](${r.files.mp3}) · [${r.files.wav}](${r.files.wav})`);
    lines.push(`- duration: ${r.seconds}s · peak ${r.peakDbfs} dBFS · rms ${r.rmsDbfs} dBFS`);
    for (const [k, v] of Object.entries(r.metrics)) lines.push(`- ${k}: ${v}`);
    for (const t of r.transcripts) {
      lines.push("", `**${t.id}** (error rate ${t.errorRate})`);
      lines.push(`> ref: ${t.reference}`);
      lines.push(`> got: ${t.hypothesis}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  let apiKey: string;
  try {
    apiKey = resolveApiKey();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const client = new TtsClient({ apiKey });

  const results: CaseResult[] = [];
  for (const evalCase of EVAL_CASES) {
    process.stderr.write(`rendering ${evalCase.name}…\n`);
    try {
      const rendered = await renderCase(client, evalCase.script);
      results.push(await evaluateCase(apiKey, evalCase.name, evalCase.focus, rendered));
    } catch (error) {
      results.push({
        name: evalCase.name,
        focus: evalCase.focus,
        seconds: 0,
        peakDbfs: 0,
        rmsDbfs: 0,
        files: { mp3: "", wav: "" },
        metrics: {},
        transcripts: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  writeFileSync(join(OUTPUT_DIR, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(OUTPUT_DIR, "report.md"), renderReportMarkdown(results));

  // Console summary.
  console.log("\nEvaluation summary:");
  for (const r of results) {
    if (r.error) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
      continue;
    }
    const headline = Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`  ✓ ${r.name}: ${r.seconds}s peak=${r.peakDbfs}dBFS ${headline}`);
  }
  console.log(`\nReport + audio written to ${OUTPUT_DIR}`);
}

await main();
