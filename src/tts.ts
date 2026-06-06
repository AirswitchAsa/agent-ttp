// The sole network module. Calls OpenAI's POST /v1/audio/speech and returns
// raw PCM bytes (24 kHz, 16-bit, mono) for one chunk of text. Everything
// downstream is pure buffer math, so this is the only place that can fail
// after money is committed — hence retries and segment-labeled errors.

const ENDPOINT = "https://api.openai.com/v1/audio/speech";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;

export interface SynthesizeParams {
  model: string;
  voice: string;
  input: string;
  instructions?: string;
}

/** The one capability the renderer needs. Lets tests inject a fake client. */
export interface Synthesizer {
  synthesize(params: SynthesizeParams): Promise<Buffer>;
}

export interface TtsClientOptions {
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Override for tests; the real endpoint by default. */
  endpoint?: string;
}

export class TtsError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`OpenAI TTS responded with ${status}`);
    this.name = "TtsError";
    this.status = status;
    this.body = body;
  }
}

export class TtsClient implements Synthesizer {
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #endpoint: string;

  constructor(options: TtsClientOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#endpoint = options.endpoint ?? ENDPOINT;
  }

  // Synthesize one chunk. `pcm` response_format is forced here so callers never
  // have to think about it; the whole pipeline standardizes on raw PCM.
  async synthesize(params: SynthesizeParams): Promise<Buffer> {
    const body: Record<string, unknown> = {
      model: params.model,
      voice: params.voice,
      input: params.input,
      response_format: "pcm",
    };
    if (params.instructions) body.instructions = params.instructions;

    return this.#withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await fetch(this.#endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
            "user-agent": "agent-ttp",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          const buf = Buffer.from(await response.arrayBuffer());
          return { ok: true as const, value: buf };
        }
        const raw = await response.text();
        return {
          ok: false as const,
          status: response.status,
          raw,
          retryAfter: response.headers.get("retry-after"),
        };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  #shouldRetry(status: number): boolean {
    return status === 429 || status >= 500;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #retryDelayMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    }
    const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
    return exponential + Math.random() * (RETRY_BASE_DELAY_MS / 2);
  }

  #errorFrom(status: number, raw: string): TtsError {
    let payload: unknown;
    try {
      payload = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      payload = raw;
    }
    return new TtsError(status, payload);
  }

  #networkError(error: unknown): Error {
    if (error instanceof TtsError) return error;
    const isTimeout =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    if (isTimeout) return new Error(`Request to OpenAI timed out after ${this.#timeoutMs}ms.`);
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`Could not reach OpenAI: ${message}`);
  }

  // Retry transient failures (429/5xx, network errors, timeouts) with backoff.
  async #withRetry(
    run: () => Promise<
      | { ok: true; value: Buffer }
      | { ok: false; status: number; raw: string; retryAfter: string | null }
    >,
  ): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      let outcome:
        | { ok: true; value: Buffer }
        | { ok: false; status: number; raw: string; retryAfter: string | null };
      try {
        outcome = await run();
      } catch (error) {
        lastError = error;
        if (attempt < this.#maxRetries) {
          await this.#sleep(this.#retryDelayMs(attempt, null));
          continue;
        }
        throw this.#networkError(error);
      }
      if (outcome.ok) return outcome.value;
      if (this.#shouldRetry(outcome.status) && attempt < this.#maxRetries) {
        await this.#sleep(this.#retryDelayMs(attempt, outcome.retryAfter));
        continue;
      }
      throw this.#errorFrom(outcome.status, outcome.raw);
    }
    throw this.#networkError(lastError);
  }
}
