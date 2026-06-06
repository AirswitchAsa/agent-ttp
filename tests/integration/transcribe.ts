// Transcribes rendered audio back to text via OpenAI's transcription endpoint,
// so the eval can compute word/character error rate against the script. This is
// eval-only tooling (it lives under tests/, not src/) — the shipped CLI never
// transcribes.

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

export interface TranscribeOptions {
  apiKey: string;
  model?: string;
  /** Language hint (ISO-639-1, e.g. "en", "es") improves accuracy. */
  language?: string;
}

// Send WAV bytes (lossless → better STT) and return the transcript text.
export async function transcribe(wav: Buffer, options: TranscribeOptions): Promise<string> {
  const form = new FormData();
  form.append("model", options.model ?? DEFAULT_TRANSCRIBE_MODEL);
  form.append("response_format", "text");
  if (options.language) {
    // gpt-4o-mini-transcribe takes a 2-letter primary subtag.
    form.append("language", options.language.split("-")[0] ?? options.language);
  }
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}` },
    body: form,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Transcription failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return body.trim();
}
