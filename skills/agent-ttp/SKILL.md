---
name: agent-ttp
description: Use when turning long source material (articles, papers, notes, documents) into a listenable podcast-style audio file. Guides the agent to rewrite the source into a listening-first YAML script, validate it, and render it to MP3 with the agent-ttp CLI. Do NOT use for raw, mechanical text-to-speech of unedited text.
---

# agent-ttp: author a podcast script, then render it

`agent-ttp` splits the work in two:

- **You (the agent) are the writer/producer.** You read raw source material and rewrite it into a listening-first script.
- **The CLI is the renderer/compiler.** It deterministically turns your script into audio. It does **not** understand the source — it only renders what you write.

## The two kinds of chunking (keep them separate)

1. **Semantic chunking — your job.** Break the meaning into coherent spoken *segments* with clear intent and natural transitions. This is editorial work.
2. **Technical chunking — the CLI's job.** If a segment exceeds the model's input limit, the CLI splits it on sentence boundaries and stitches the audio back. You never do this.

## Workflow

When the user hands you a file, treat it as **source material** to rewrite (unless it is already a valid script — then just validate and render).

1. **Read** the source in full.
2. **Rewrite** into spoken prose: drop the original paragraph structure, headings, lists, tables, and citations.
3. **Segment** into coherent blocks — one spoken beat with a single intent each.
4. **Add delivery metadata**: `speaker`, `intent`, `pause_after_ms`, and per-block `instructions` where delivery should change.
5. **Write** the script as a YAML file (schema below).
6. **Validate** — fix every error, review warnings.
7. **Render**, then return the output path to the user.

## Writing guidance

**Structure the episode — don't just transcribe.**

- **Hook** (one segment, `intent: hook`): the most interesting idea or question, in plain language, before any setup.
- **Orient** (one or two segments): why this matters and what the listener will get.
- **Body**: one coherent beat per segment, ordered so each builds on the last.
- **Close**: a brief recap or takeaway, not an abrupt stop.

**Length and pacing.**

- Aim for segments of roughly **30–90 seconds** — a few hundred words in English, or ~300–900 Chinese characters. `validate` warns past ~1200 characters; treat that as "split this beat."
- Use `pause_after_ms` to breathe: ~**300–500 ms** between beats, ~**700–1000 ms** at a topic shift or before a punchline. Don't pause after every sentence — the model paces within a segment.

**Write for the ear, not the eye.**

- No markdown, tables, code fences, bare URLs, or "(see figure 3)". `validate` warns on these; fix by rewriting as spoken prose.
- **Normalize anything that reads badly aloud.** Say it the way you'd speak it: numbers and units ("ninety-five percent", not "95%"), symbols (`%`, `&`, `/`, `$`, `→`), and dates ("twenty twenty-four"). Expand acronyms on first use. Don't make the model guess `e.g.`, `Q3`, or `$4.2B`.
- Turn structure into speech: a list becomes "three things — first… second… and finally…"; a table becomes a sentence comparing the rows that matter.
- Every segment carries information or moves the thread forward — cut filler.

**Voices and delivery.**

- For a **two-person dialogue**, define two voices and alternate `speaker` across segments. The block list *is* the conversation; pauses give turn-taking.
- Use `instructions` to steer delivery (tone, pace, a rising question) on segments that need it. To slow a passage down, say so there ("speak slowly and clearly") — there is no separate speed knob.

## Script schema (YAML only)

```yaml
title: "Episode title"            # required
language: "zh-CN"                  # optional DEFAULT language; each segment may override
style: "calm, dense, explanatory"  # optional; global delivery hint
model: "gpt-4o-mini-tts-2025-12-15"  # optional; defaults to the latest gpt-4o-mini-tts snapshot
max_chars: 2000                    # optional; technical-chunk threshold (1–4096)

voices:                            # at least one; name -> config
  host:
    voice: cedar                   # OpenAI voice (cedar/marin recommended)
    instructions: "Calm, knowledge-focused Mandarin."  # delivery: tone, accent, pace, emotion
  guest:
    voice: marin
    instructions: "Thoughtful podcast co-host."

segments:                          # ordered list of spoken blocks
  - id: intro                      # unique, stable id
    speaker: host                  # must match a key in `voices`
    intent: hook                   # metadata only (not spoken)
    pause_after_ms: 700            # silence after this block
    text: >
      Spoken prose for this block.
  - id: example
    speaker: host
    language: "es"                 # per-segment language override
    instructions: "Ask as a genuine, curious question."  # per-block delivery override
    text: >
      ...
```

**Parameter cascade (most-specific wins):** a segment's `model` / `instructions` / `language` override the voice's, which override the script-level defaults. `speaker` binds the segment to a voice.

**`language` is per-segment.** The API has no language parameter, so the resolved language is carried as a "Speak in …" clause appended to the delivery `instructions` — applied even when you also give explicit instructions. This is what makes **language-learning** episodes work: an English explanation block and a Spanish example block render each in its own language.

## CLI reference

```bash
# Validate — free, no API key, no network. Always do this first.
npx agent-ttp validate script.yaml
npx agent-ttp validate script.yaml --json     # structured report

# Render to audio (needs an API key):
npx agent-ttp render script.yaml -o episode.mp3
npx agent-ttp render script.yaml -o episode.wav        # zero-encode WAV

# Optional render flags (combine as needed):
#   --model <id> / --voice <name>   override for every segment
#   --no-cache                      disable the per-segment cache
#   --no-normalize                  skip peak normalization
#   --cache <dir>                   custom cache directory
#   --bitrate <kbps>                MP3 bitrate, 8–320 (default 64)

# API key:
npx agent-ttp api-key set         # also: status, unset
```

Output format follows the `-o` extension: `.mp3` (default) or `.wav`. A worked example lives at `examples/script.yaml`.

## When something's missing

- **No Node / `npx`:** the CLI needs Node ≥ 20. If it isn't installed, tell the user to install it — don't improvise a workaround. (Inside this repo you can instead run `npx tsx src/cli.ts <cmd>`.)
- **No API key:** `validate` still runs and its report shows `api key: MISSING`. `render` fails with a clear message until a key is provided via `OPENAI_API_KEY` (env or `.env`) or `agent-ttp api-key set`. **Never invent a key** — ask the user to set one, then re-run `render`. The validated script needs no rework.
- **A render interrupted partway** re-uses already-synthesized segments from the cache on the next run, so retries are cheap.
