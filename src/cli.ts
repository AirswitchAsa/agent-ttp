#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { apiKeyCommand } from "./commands/api-key.js";
import { renderCommand } from "./commands/render.js";
import { validateCommand } from "./commands/validate.js";
import { printError } from "./output.js";
import { TtsError } from "./tts.js";

const program = new Command();

program
  .name("agent-ttp")
  .description(
    "Render an agent-authored YAML podcast script to audio via OpenAI text-to-speech. " +
      "The agent writes the script; this CLI is a deterministic renderer.",
  )
  // Single source of truth for the version — package.json, imported directly.
  .version(pkg.version);

for (const command of [renderCommand, validateCommand, apiKeyCommand]) {
  program.addCommand(command);
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof TtsError) {
    printError(`OpenAI TTS ${error.status}: ${JSON.stringify(error.body)}`);
  } else {
    printError(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
