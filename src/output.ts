export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function printLine(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}
