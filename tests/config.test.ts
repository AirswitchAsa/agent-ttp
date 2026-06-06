import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

// Point the config dir at a throwaway location and clear key env so tests are
// hermetic. Imported lazily after env is set so module-level reads see it.
let dir: string;
let savedConfigDir: string | undefined;
let savedApiKey: string | undefined;
let savedCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-ttp-test-"));
  savedConfigDir = process.env.AGENT_TTP_CONFIG_DIR;
  savedApiKey = process.env.OPENAI_API_KEY;
  savedCwd = process.cwd();
  process.env.AGENT_TTP_CONFIG_DIR = dir;
  delete process.env.OPENAI_API_KEY;
  // The resolver reads `.env` from the current directory; chdir into the empty
  // temp dir so the repo's own .env can't leak a key into these assertions.
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedConfigDir === undefined) delete process.env.AGENT_TTP_CONFIG_DIR;
  else process.env.AGENT_TTP_CONFIG_DIR = savedConfigDir;
  if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedApiKey;
  rmSync(dir, { recursive: true, force: true });
});

test("set then resolve reads from stored user config", async () => {
  const config = await import("../src/config.ts");
  assert.equal(config.resolveApiKeySource().source, "missing");
  config.setStoredApiKey("sk-test-123");
  const resolution = config.resolveApiKeySource();
  assert.equal(resolution.source, "user_config");
  assert.equal(resolution.key, "sk-test-123");
});

test("environment variable takes precedence over stored config", async () => {
  const config = await import("../src/config.ts");
  config.setStoredApiKey("sk-stored");
  process.env.OPENAI_API_KEY = "sk-env";
  const resolution = config.resolveApiKeySource();
  assert.equal(resolution.source, "environment");
  assert.equal(resolution.key, "sk-env");
});

test("unset removes the stored key", async () => {
  const config = await import("../src/config.ts");
  config.setStoredApiKey("sk-test");
  assert.equal(config.clearStoredApiKey(), true);
  assert.equal(config.resolveApiKeySource().source, "missing");
});

test("resolveApiKey throws an actionable error when missing", async () => {
  const config = await import("../src/config.ts");
  assert.throws(() => config.resolveApiKey(), /No OpenAI API key found/);
});
