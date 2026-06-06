import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { BYTES_PER_SAMPLE } from "../src/audio.ts";
import type { SynthesizeParams } from "../src/tts.ts";

// A captured request to the mock server: the parsed JSON body the client sent.
export interface MockCall {
  body: SynthesizeParams & Record<string, unknown>;
}

export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export type Responder = (body: MockCall["body"], callIndex: number) => MockResponse;

export interface MockTtsServer {
  url: string;
  calls: MockCall[];
  close: () => Promise<void>;
}

// Deterministic fake PCM for a given (voice, text): length scales with text so
// different texts yield different durations, and the constant sample value is
// derived from voice+text so different voices/texts yield different content.
// This lets tests assert ordering, distinctness, and pacing without real audio.
export function mockPcm(voice: string, text: string): Buffer {
  const samples = Math.max(1, text.trim().length) * 240; // 10ms/char at 24kHz
  const seed = createHash("sha256").update(`${voice}:${text}`).digest();
  const value = (seed.readInt16LE(0) % 8000) + 1; // non-zero, bounded
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(value, i * BYTES_PER_SAMPLE);
  return buf;
}

const defaultResponder: Responder = (body) => ({
  status: 200,
  body: mockPcm(String(body.voice), String(body.input)),
});

// Start a local HTTP server that imitates POST /v1/audio/speech. Records every
// request body and delegates the response to `responder` (default: 200 + fake
// PCM). Returns the base URL to pass as the TtsClient `endpoint`.
export async function startMockTtsServer(
  responder: Responder = defaultResponder,
): Promise<MockTtsServer> {
  const calls: MockCall[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: MockCall["body"];
      try {
        body = JSON.parse(raw);
      } catch {
        body = {} as MockCall["body"];
      }
      const index = calls.length;
      calls.push({ body });
      const result = responder(body, index);
      res.writeHead(result.status, result.headers ?? {});
      res.end(result.body ?? "");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server failed to bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1/audio/speech`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
