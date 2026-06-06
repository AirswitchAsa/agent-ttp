# agent-ttp

Render an **agent-authored YAML podcast script** into a complete, listenable MP3 using OpenAI text-to-speech.

This is **not** a raw text-to-speech tool. The model is:

```
raw source → an agent rewrites it into a listening-first script → the CLI renders it to audio
```

- **The agent is the writer/producer.** It reads source material and rewrites it into coherent spoken segments.
- **The CLI is the renderer/compiler.** It validates, technically chunks overlong segments, calls TTS, inserts pauses, normalizes, and stitches a single file. It never tries to understand the source.

## Install

```bash
npx @spicadust/agent-ttp --help
```

Requires Node ≥ 20 and an OpenAI API key. No `ffmpeg` — audio is assembled in-process.

## Quick start

```bash
export OPENAI_API_KEY=sk-...           # or: npx agent-ttp api-key set

npx agent-ttp validate script.yaml     # free, no API calls
npx agent-ttp render script.yaml -o episode.mp3
```

A worked example is in [`skills/agent-ttp/examples/script.yaml`](skills/agent-ttp/examples/script.yaml).

## Script format (YAML)

```yaml
title: "Transformer Paper Walkthrough"
language: "zh-CN"                       # default language; each segment may override
style: "calm, dense, explanatory"
model: "gpt-4o-mini-tts-2025-12-15"    # latest gpt-4o-mini-tts snapshot
max_chars: 2000                         # technical-chunk threshold (≤ 4096)

voices:
  host:  { voice: cedar, instructions: "Calm, knowledge-focused Mandarin." }
  guest: { voice: marin, instructions: "Thoughtful podcast co-host." }

segments:
  - id: intro
    speaker: host
    intent: hook
    pause_after_ms: 700
    text: >
      Today we are going to explain what this paper actually solves.
  - id: question
    speaker: guest               # alternating speaker = dialogue
    instructions: "Ask as a genuine, curious question."
    text: >
      So the real question is which bottleneck it removes?
```

**Parameter cascade** (most-specific wins): a segment's `model` / `instructions` / `language`
override the voice's, which override the script-level defaults. The `speaker` field binds a
segment to a named voice — alternate speakers and you get a two-person dialogue for free.

**`instructions` is the only delivery knob** — natural-language direction for tone, accent,
pace, emotion, and whispering (there is no separate `speed` parameter). **`language` is
per-segment**: the API has no language field, so language is carried through `instructions`,
and a single episode can switch languages block to block — which is what makes language-learning
content possible.

### Two kinds of chunking, kept separate

- **Semantic chunking** is the agent's editorial job: writing coherent spoken segments.
- **Technical chunking** is the CLI's job: splitting a segment on sentence boundaries *only*
  when it exceeds `max_chars`, then stitching the audio back seamlessly.

## Commands

```bash
agent-ttp validate <script.yaml> [--json]
agent-ttp render <script.yaml> -o <out.mp3|out.wav>
    [--model <id>] [--voice <name>] [--api-key <key>]
    [--cache <dir> | --no-cache] [--no-normalize] [--bitrate <kbps>]
agent-ttp api-key set | status | unset
```

- Output format follows the `-o` extension: `.mp3` (default, ~0.5 MB/min) or `.wav` (uncompressed, zero-encode).
- The API key resolves from `--api-key` → `OPENAI_API_KEY` → `.env` → `~/.agent-ttp/config.json`.
- Generated audio is cached per segment (keyed on model + voice + instructions + text),
  so re-rendering after editing one segment only re-synthesizes that segment.

## How it works

PCM is the universal currency. Each segment is synthesized as raw 24 kHz/16-bit/mono PCM,
concatenated with silence for pauses, peak-normalized, and encoded **once** at the end —
WAV via a hand-written header, MP3 via the pure-JS [`lamejs`](https://github.com/zhuker/lamejs)
encoder. No external binary is ever invoked.

## Agent skill

[`skills/agent-ttp/SKILL.md`](skills/agent-ttp/SKILL.md) teaches a coding agent the full
workflow: read source → rewrite into a listening-first script → validate → render → return the file.

## License

MIT
