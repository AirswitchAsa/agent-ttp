import { Command } from "commander";
import { clearStoredApiKey, configPath, resolveApiKeySource, setStoredApiKey } from "../config.js";
import { printLine } from "../output.js";

// Control codes handled during hidden entry.
const ETX = 3; // Ctrl-C
const BACKSPACE = 8;
const LF = 10;
const CR = 13;
const DEL = 127;

function sourceLabel(source: string): string {
  if (source === "environment") return "OPENAI_API_KEY environment variable";
  if (source === "dotenv") return "current-directory .env";
  if (source === "user_config") return "stored user config";
  return "not configured";
}

async function readPipedSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let value = "";

    function cleanup(): void {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    }

    function onData(chunk: Buffer | string): void {
      const text = chunk.toString("utf8");
      for (const char of text) {
        const code = char.charCodeAt(0);
        if (code === ETX) {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (code === CR || code === LF) {
          cleanup();
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (code === DEL || code === BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    process.stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function readApiKey(): Promise<string> {
  if (process.stdin.isTTY === true) return promptHidden("Paste OpenAI API key: ");
  return readPipedSecret();
}

export const apiKeyCommand = new Command("api-key").description(
  "Manage the stored OpenAI API key.",
);

apiKeyCommand
  .command("set")
  .description("Store an OpenAI API key in the user config.")
  .action(async () => {
    const apiKey = await readApiKey();
    if (apiKey.length === 0) throw new Error("API key cannot be empty.");
    setStoredApiKey(apiKey);
    printLine(`Saved OpenAI API key to ${configPath()}.`);
  });

apiKeyCommand
  .command("status")
  .description("Show where the active OpenAI API key is coming from.")
  .action(() => {
    const resolution = resolveApiKeySource();
    printLine(`status: ${resolution.source === "missing" ? "missing" : "configured"}`);
    printLine(`source: ${sourceLabel(resolution.source)}`);
    if (resolution.path !== undefined) printLine(`path: ${resolution.path}`);
    if (resolution.source !== "user_config") {
      printLine(`user config: ${configPath()}`);
    }
  });

apiKeyCommand
  .command("unset")
  .description("Remove the stored API key from the user config.")
  .action(() => {
    const removed = clearStoredApiKey();
    printLine(
      removed ? `Removed stored API key from ${configPath()}.` : "No stored API key found.",
    );
  });
