import { printLine } from "../output.js";
import type { Issue } from "../schema.js";
import type { ValidationReport } from "../validator.js";

/** Human-readable mm:ss (or h:mm:ss) from a second count. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function formatIssue(issue: Issue): string {
  const where = issue.segmentId
    ? `[${issue.segmentId}${issue.field ? `.${issue.field}` : ""}]`
    : "";
  return `  ${issue.level.padEnd(7)} ${where} ${issue.message}`.replace(/\s+$/, "");
}

// Print the validation report in a stable, greppable layout. Shared by both
// `validate` (the whole output) and `render` (shown before rendering proceeds).
export function printReport(report: ValidationReport): void {
  const errors = report.issues.filter((i) => i.level === "error");
  const warnings = report.issues.filter((i) => i.level === "warning");
  const infos = report.issues.filter((i) => i.level === "info");

  for (const issue of [...errors, ...warnings, ...infos]) {
    printLine(formatIssue(issue));
  }
  if (report.issues.length > 0) printLine();

  printLine(
    `estimated duration: ${formatDuration(report.estimatedSeconds)} (${report.totalChars} chars)`,
  );
  if (report.chunkedSegments.length > 0) {
    const detail = report.chunkedSegments.map((c) => `${c.id}×${c.pieces}`).join(", ");
    printLine(`technical chunking: ${detail}`);
  }
  printLine(`api key: ${report.apiKey.present ? `present (${report.apiKey.source})` : "MISSING"}`);
  printLine(`summary: ${errors.length} error(s), ${warnings.length} warning(s)`);
}
