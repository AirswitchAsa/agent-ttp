import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { TtsClient, TtsError } from "../src/tts.ts";
import { type MockTtsServer, mockPcm, startMockTtsServer } from "./helpers.ts";

let server: MockTtsServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

test("sends the correct request shape and returns the response bytes", async () => {
  server = await startMockTtsServer();
  const client = new TtsClient({ apiKey: "sk-test", endpoint: server.url });

  const pcm = await client.synthesize({
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    input: "hello world",
    instructions: "calm",
  });

  assert.equal(server.calls.length, 1);
  const body = server.calls[0]?.body;
  assert.equal(body?.model, "gpt-4o-mini-tts");
  assert.equal(body?.voice, "cedar");
  assert.equal(body?.input, "hello world");
  assert.equal(body?.instructions, "calm");
  // The pipeline standardizes on raw PCM, and `speed` must never be sent.
  assert.equal(body?.response_format, "pcm");
  assert.equal("speed" in (body ?? {}), false);
  assert.deepEqual(pcm, mockPcm("cedar", "hello world"));
});

test("omits instructions when none are given", async () => {
  server = await startMockTtsServer();
  const client = new TtsClient({ apiKey: "sk-test", endpoint: server.url });
  await client.synthesize({ model: "tts-1", voice: "alloy", input: "hi" });
  assert.equal("instructions" in (server.calls[0]?.body ?? {}), false);
});

test("retries on 500 then succeeds", async () => {
  let hits = 0;
  server = await startMockTtsServer((body) => {
    hits += 1;
    if (hits <= 2) return { status: 500, body: "server error" };
    return { status: 200, body: mockPcm(String(body.voice), String(body.input)) };
  });
  const client = new TtsClient({ apiKey: "sk-test", endpoint: server.url, maxRetries: 3 });
  const pcm = await client.synthesize({ model: "m", voice: "cedar", input: "retry me" });
  assert.equal(hits, 3);
  assert.ok(pcm.length > 0);
});

test("does not retry on a 4xx and throws a TtsError carrying the body", async () => {
  let hits = 0;
  server = await startMockTtsServer(() => {
    hits += 1;
    return { status: 400, body: JSON.stringify({ error: { message: "bad voice" } }) };
  });
  const client = new TtsClient({ apiKey: "sk-test", endpoint: server.url, maxRetries: 3 });
  await assert.rejects(
    () => client.synthesize({ model: "m", voice: "nope", input: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof TtsError);
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(hits, 1, "4xx must not be retried");
});

test("gives up after maxRetries on persistent 503 and throws the last status", async () => {
  let hits = 0;
  server = await startMockTtsServer(() => {
    hits += 1;
    return { status: 503, body: "down" };
  });
  const client = new TtsClient({ apiKey: "sk-test", endpoint: server.url, maxRetries: 2 });
  await assert.rejects(
    () => client.synthesize({ model: "m", voice: "cedar", input: "x" }),
    TtsError,
  );
  assert.equal(hits, 3, "1 initial try + 2 retries");
});

test("honors a numeric Retry-After header without hanging", async () => {
  let hits = 0;
  server = await startMockTtsServer((body) => {
    hits += 1;
    if (hits === 1) return { status: 429, headers: { "retry-after": "0" }, body: "slow down" };
    return { status: 200, body: mockPcm(String(body.voice), String(body.input)) };
  });
  const client = new TtsClient({ apiKey: "sk-test", endpoint: server.url, maxRetries: 2 });
  const pcm = await client.synthesize({ model: "m", voice: "cedar", input: "x" });
  assert.equal(hits, 2);
  assert.ok(pcm.length > 0);
});
