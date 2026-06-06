import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

// Load a script file into an untyped object. The contract format is YAML only:
// the agent is responsible for producing a valid contract, so there is no
// format-guessing here — anything that is not `.yaml`/`.yml` is a hard error.
export function loadScriptFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`Script file not found: ${path}`);
  }

  const ext = extname(path).toLowerCase();
  if (!YAML_EXTENSIONS.has(ext)) {
    throw new Error(`agent-ttp scripts must be YAML (.yaml/.yml). Got: ${ext || "no extension"}`);
  }

  const raw = readFileSync(path, "utf8");
  try {
    return parseYaml(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse YAML in ${path}: ${message}`);
  }
}
