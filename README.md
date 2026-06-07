# agent-ttp

Render an **agent-authored YAML podcast script** into a complete, listenable MP3 using OpenAI text-to-speech.
[episode.mp3](https://github.com/user-attachments/files/28682650/episode.mp3)

This is **not** a raw text-to-speech tool. The model is:

```
raw source → an agent rewrites it into a listening-first script → the CLI renders it to audio
```

- **The agent is the writer/producer.** It reads source material and rewrites it into coherent spoken segments.
- **The CLI is the renderer/compiler.** It validates, technically chunks overlong segments, calls TTS, inserts pauses, normalizes, and stitches a single file. It never tries to understand the source.

## Install

Run the CLI directly with `npx` (no install needed):

```bash
npx @spicadust/agent-ttp --help
```

Install the **agent skill** (teaches a coding agent the author → validate → render workflow) with [`npx skills`](https://github.com/vercel-labs/skills):

```bash
# project-local
npx skills add https://github.com/AirswitchAsa/agent-ttp/tree/main/skills/agent-ttp
# or global, scoped to Claude Code
npx skills add https://github.com/AirswitchAsa/agent-ttp/tree/main/skills/agent-ttp -g -a claude-code
```

Requires Node ≥ 20 and an OpenAI API key. No `ffmpeg` — audio is assembled in-process.

## Provide your OpenAI API key

`render` needs a key; `validate` does not. The key is resolved in this order — the first one found wins:

```bash
npx @spicadust/agent-ttp render … --api-key sk-...   # 1. explicit flag
export OPENAI_API_KEY=sk-...              # 2. environment variable
echo 'OPENAI_API_KEY=sk-...' >> .env      # 3. .env in the current directory
npx @spicadust/agent-ttp api-key set                 # 4. stored in ~/.agent-ttp/config.json (prompts, hidden input)
```

Check what's active with `npx @spicadust/agent-ttp api-key status`.

## Quick start

```bash
npx @spicadust/agent-ttp validate script.yaml     # free, no API calls, no key required
npx @spicadust/agent-ttp render script.yaml -o episode.mp3
```

Worked examples live in [`skills/agent-ttp/examples/`](skills/agent-ttp/examples/):

| File | What it shows |
| --- | --- |
| [`script.yaml`](skills/agent-ttp/examples/script.yaml) | Two-voice dialogue introducing the tool |
| [`en-article-briefing.yaml`](skills/agent-ttp/examples/en-article-briefing.yaml) | Single-narrator news briefing rewritten from an article |
| [`zh-paper-summary.yaml`](skills/agent-ttp/examples/zh-paper-summary.yaml) | Mandarin (`zh-CN`) explainer summarizing a paper |
| [`bilingual-language-learning.yaml`](skills/agent-ttp/examples/bilingual-language-learning.yaml) | Per-segment `language` override — English instruction, Spanish examples |

Validate any of them without an API key: `npx @spicadust/agent-ttp validate skills/agent-ttp/examples/zh-paper-summary.yaml`.

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
pace, emotion, and whispering. agent-ttp intentionally exposes no separate `speed` parameter:
pacing is part of `instructions` (e.g. "speak slowly and clearly"), which keeps one delivery
model instead of two competing ones. **`language` is per-segment**: the API has no language
field, so the resolved language is carried through `instructions` as a natural-language clause
(`zh-CN` → "Speak in Mandarin Chinese."), and a single episode can switch languages block to
block — which is what makes language-learning content possible.

### Two kinds of chunking, kept separate

- **Semantic chunking** is the agent's editorial job: writing coherent spoken segments.
- **Technical chunking** is the CLI's job: splitting a segment on sentence boundaries *only*
  when it exceeds `max_chars`, then stitching the audio back seamlessly.

## Commands

Invoke via `npx @spicadust/agent-ttp <command>`, or as the bare `agent-ttp <command>` after a global install. The grammar below uses the short form.

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
