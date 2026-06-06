import { Command } from "commander";
import { printJson, printLine } from "../output.js";
import { loadScriptFile } from "../parser.js";
import { parseScript } from "../schema.js";
import { hasErrors, validate } from "../validator.js";
import { printReport } from "./_shared.js";

// The free, no-network front door to the same checks `render` runs. An agent
// uses this to catch script problems before paying to render anything.
export const validateCommand = new Command("validate")
  .description("Validate a script file without rendering (no API calls).")
  .argument("<script>", "path to the YAML script file")
  .option("--json", "emit the full report as JSON")
  .action((scriptPath: string, options: { json?: boolean }) => {
    const raw = loadScriptFile(scriptPath);
    const { script, issues } = parseScript(raw);

    // Shape errors mean we cannot build a Script to validate semantically;
    // report them and stop here.
    if (script === undefined) {
      if (options.json === true) {
        printJson({ ok: false, issues });
        process.exitCode = 1;
        return;
      }
      for (const issue of issues) {
        printLine(
          `  ${issue.level.padEnd(7)} ${issue.field ? `[${issue.field}] ` : ""}${issue.message}`,
        );
      }
      printLine(`\nsummary: ${issues.length} error(s) — script is not parseable.`);
      process.exitCode = 1;
      return;
    }

    const report = validate(script, { seedIssues: issues });
    if (options.json === true) {
      printJson({ ok: !hasErrors(report), ...report });
    } else {
      printReport(report);
    }
    if (hasErrors(report)) process.exitCode = 1;
  });
