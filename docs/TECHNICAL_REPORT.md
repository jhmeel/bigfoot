# Bigfoot 1.2.1 — Technical report

Scope: the move to an on-device AI (Qwen3-VL) as the default model, the tool tray, Draw and Math,
continuous voice (Talk), the plugin validator, onboarding and settings changes, and the installer.
Date: 30 September 2026.

## 1. Summary

| Area | Before | Now |
|---|---|---|
| Default model | Claude, with an API key required at setup | Qwen3-VL on the user's PC; no key, works offline |
| Cloud models | Claude, OpenAI, Gemini | Claude or OpenAI, optional, online only (Gemini removed) |
| Speech-to-text | OpenAI key by default | Whisper bundled in the installer, offline; cloud optional |
| Tools | Keyboard shortcuts | Desktop double-click tool tray: Talk, Point, Draw, Math, Type, Clear |
| Drawing | AI-only temporary annotations | Full Draw tool; the AI sees and edits the user's drawing |
| Voice | Hold-to-talk or wake word, one request | Talk mode: continuous, hands-free, until turned off |
| Plugins | Drop a file, restart, errors only in the log | Template, validator in an isolated process, capability review, install/remove in Settings |

## 2. Architecture

```
Electron main process
  controller.js ── Talk mode, tasks, tool tray, Draw/Math sessions, replies
  agent.js ─────── agent loop → llm/ (local | anthropic | openai) → tool calls
  local/ ───────── catalog → manager (download, verify, install) → runtime (llama-server)
  capture.js ───── screenshots (+ user's drawing composited in) ↔ coordinate mapping
  plugins/ ─────── registry, built-in tools (incl. edit_drawing), validator, manager
  input.js ─────── native helper: SendInput, key state, desktop double-click, wake word, offline STT
Renderers
  overlay ──────── buddy, annotations, Draw (overlay-ink.js), Math (overlay-math.js)
  toolbar ──────── tool tray window
  app / onboarding  settings, model setup UI (local-ai.js), download banner
  engine ───────── microphone, VAD, speech playback, image compositing
```

## 3. Local AI

### 3.1 What is downloaded

Pinned files, each verified by SHA-256 before it is used (`src/main/local/catalog.js`):

| Model | Weights (Q4_K_M) | Vision projector (Q8_0) | Total with runtime |
|---|---|---|---|
| Qwen3-VL 2B | 1,107,409,952 B | 445,053,216 B | ~1.5 GB |
| Qwen3-VL 4B | 2,497,281,664 B | 453,974,304 B | ~2.8 GB |
| Qwen3-VL 8B | 5,027,784,800 B | 752,289,728 B | ~5.4 GB |
| Qwen3-VL 30B-A3B | 18,556,687,168 B | 712,148,928 B | ~18 GB |

Models come from the official `Qwen/Qwen3-VL-*-Instruct-GGUF` repositories on Hugging Face (Apache-2.0),
addressed by commit hash so a repository update can never change what Bigfoot installs. The runtime is
llama.cpp release b11276 (MIT): the Vulkan build for x64 (NVIDIA, AMD, and Intel GPUs, with CPU
fallbacks) and the CPU build for ARM64.

All nine URLs were verified live to answer `206 Partial Content` with byte-exact sizes, which is what
resuming depends on. The runtime archive's hash was verified against the published digest.

### 3.2 Recommendation

`recommend()` uses dedicated VRAM (registry `HardwareInformation.qwMemorySize`, or `nvidia-smi`), RAM,
and free disk. Integrated GPUs (under 2 GB reported) count as no GPU.

- Pick: 30B at ≥ 20 GB VRAM, 8B at ≥ 7 GB, 4B at ≥ 4 GB or ≥ 15 GB RAM, otherwise 2B.
- A size is **unavailable** when VRAM + (RAM − 3.5 GB) can't hold it ("Requires more memory") or the
  disk can't; **tight** when it only fits by leaving Windows too little ("may be slow").
- Examples (unit-tested): RTX 4060 + 16 GB → 8B, 30B unavailable; 8 GB laptop without GPU → 2B,
  4B tight, 8B/30B unavailable.

### 3.3 Download manager (`local/manager.js`, `local/download.js`)

States: `queued → downloading ⇄ waiting (network) → verifying → installing → ready`, plus `paused`
(user) and `failed`.

- Every attempt resumes the `.part` file with an HTTP Range request; a server that ignores Range is
  detected (200 instead of 206) and the file restarts cleanly.
- A connection with no bytes for 45 s is dropped and reopened (slow or stalled links).
- Network errors retry with backoff up to 30 s; offline waits for the connection to return. After 12
  consecutive attempts with no new bytes the job becomes `failed`; Retry continues from disk.
- A checksum mismatch re-downloads that file once; a second mismatch fails with a clear message.
- Disk space is checked up front, including room to unpack the runtime.
- The job's intent (model, paused/failed) is persisted, so a download resumes after a restart and a
  user pause stays paused.
- Installing a different size keeps the old model until the new one is verified, then removes it.

### 3.4 Runtime (`local/runtime.js`)

`llama-server` runs on `127.0.0.1` with a free port and a random per-session API key, `--jinja` for
tool calling, and a context of 16k (≥ 24 GB RAM) or 8k; llama.cpp's `--fit` spreads layers between
GPU and RAM. By default ("Keep the AI loaded") it is loaded 3 s after Bigfoot starts, never unloaded,
and restarted automatically if it crashes (up to 3 times in 10 minutes). With the setting off it
unloads after 10 idle minutes. Startup failures are translated into user-facing reasons (out of
memory, damaged model files, port in use).

### 3.5 Latency work (measured)

The first installed build never answered on the test laptop (i5-8350U, Intel UHD 620, 8 GB): its
logs showed the model starting and a question left unanswered for two minutes. Measured on that
machine with the installed Qwen3-VL 2B:

| Configuration | Prompt reading | Result |
|---|---|---|
| Vulkan on the integrated GPU + `mlock` (1.1 as first shipped) | **3.1 tokens/s**, 0.7 GB RAM free | A Bigfoot request needed 15+ minutes |
| Vulkan on the integrated GPU, no `mlock` | failed with a server error | — |
| CPU only, 597 image tokens | 24 tokens/s | screenshot question 113 s |
| **CPU only, 256 image tokens (adopted)** | 36 tokens/s | **screenshot question 26 s**, chat follow-up 1.8 s |

Measures now in place:

| Measure | Effect (measured on the test laptop) |
|---|---|
| Integrated GPU → CPU only (`--device none`); `mlock` only with a real GPU and ≥ 16 GB RAM | 3.1 → 36 tokens/s prompt reading; no memory starvation |
| `--image-max-tokens` 256 on CPU (768 / 1024 with a GPU), 1024 px screenshots | Screenshot question 113 s → 26 s |
| Threads = physical cores − 1, below-normal priority | Windows and other apps stay responsive while the model works |
| Warm-up of the system prompt and tools, saved with `--slot-save-path` and restored at start | 77 s once; **0.55 s** on every later start |
| RAM prompt cache (`--cache-ram`, default) | Switching between chat and screen prompts: 5 s instead of 100 s |
| Keep loaded, preload at startup, auto-restart | No cold starts |
| Screenshots dropped in batches, `--cache-reuse 256` | Cached context survives across steps |
| Streaming into the chat and the bubble, and speaking each sentence as soon as it's complete | First words appear (and are heard) about 2 s into a reply |
| 10-minute timeout for local requests (was 30 s) | The first cold warm-up is no longer cut off and misreported as "offline" |

End result on the test laptop: "What is your name?" answered in 8.3 s (full sentence) after restart.
Not adopted: speculative decoding (speeds up writing, not the image reading that dominates).

### 3.6 Provider (`llm/local.js`)

Built on the OpenAI-compatible provider. Qwen3-VL points on a 0–1000 grid regardless of image size,
so the provider translates, in both directions, clicks, drags, zoom regions, `annotate` and
`edit_drawing` points and regions, `[POINT]` tags, and cursor positions. Replies are streamed. Up to
four screenshots stay in history (trimmed to two in one step); if the context still overflows, the
history is cut to the current request and retried; if
the server disappears mid-request it is restarted once. There are no spending limits: the local
model is free, and cloud usage is billed to the user's own key.

### 3.7 Provider resolution and offline behavior

`resolveProvider(settings, { online })`: a chosen cloud provider with a key while online; otherwise
the installed local model; otherwise any keyed cloud provider; otherwise none. If a cloud request
fails because the connection dropped mid-task, the agent restarts the request on the local model.
Legacy settings (a cloud provider selected without its key) migrate to local on load.

## 4. Voice and Talk mode

Speech-to-text is whisper.cpp (b5130, MIT) with the English base model (Q8), bundled in the installer
by `scripts/fetch-speech.js` (SHA-256 verified) and run as a loopback server kept loaded at below-normal
priority. On the same recording, Whisper was word-perfect ("Hey Bigfoot, open Spotify and play some
relaxing jazz, then set the volume to 30%.") in 1.9–5 s depending on the laptop's power state, where
the Windows dictation recognizer produced "A Bigfoot open spot avoid employees so relaxing jazz dancer
the volume to 30%". Windows dictation is no longer used; the wake word still uses Windows' keyword
spotter, which only listens for the assistant's name.

Talk (tray or Draw bar) toggles continuous listening: each utterance ends on 1.3 s of silence, is
transcribed by Whisper, and runs as a request; listening resumes when Bigfoot is
idle again, so it never hears its own speech. While waiting, silence is discarded every 30 s so
memory stays flat and the microphone isn't reopened. Talk ends on the Talk button, Esc, or "stop
listening"/"that's all"/"goodbye". Hands-free listening never captures the mouse; only hold-to-talk
enables drag-to-highlight.

Replies are spoken sentence by sentence while they stream. Each sentence is keyed by its letters and
digits and spoken at most once per request, so the final reply (with tags removed and spacing
changed) can't repeat what streaming already said. When the local model describes a plan instead of
acting ("I'll open Chrome and search…"), the agent discards that text, including the speech queue
and the live chat message, and asks it to call the tools, at most twice per request. The system
prompt also tells it directly how to search (open_url with a Google query) and how to draw
(edit_drawing with a picture). Paths like `C:\Users\YourUsername\…` that a model invents are
mapped to the real home folder.

## 5. Tool tray, Draw, and Math

- **Tray trigger**: a low-level mouse hook in the native helper recognizes physical (not injected)
  double-clicks using the system double-click time and distance, then checks off the hook thread,
  via the window class (`Progman`/`WorkerW`) and UI Automation, that the point is empty desktop and
  not an icon. Windows silently drops a low-level hook that answers too slowly (as happened while the
  first build starved the PC), so the helper re-attaches it every 10 s; if UI Automation fails under
  load, a desktop double-click is accepted rather than ignored.
- **Draw** (`overlay-ink.js`): vector strokes on a committed canvas with a live canvas for the stroke
  in progress, so undo, redo, and the eraser are exact. Windows passes clicks on fully transparent
  pixels to the window underneath (which made the desktop draw its selection box instead of ink), so
  capture layers carry a ~1% tint. Pointer mode makes the overlay click-through while hover still
  reaches the toolbar. The overlay takes keyboard focus only while a tool is open.
- **AI and the drawing**: screen capture can't see Bigfoot's overlay, so the drawing is exported and
  composited onto every screenshot and zoom the model receives. The `edit_drawing` tool adds strokes
  and shapes, erases a region, or clears; edits are recorded in the user's undo history. During a
  request the overlay passes clicks through so the AI's actions reach the apps below. Verified live:
  a hand-drawn stroke appeared in the model's screenshot and zoom, and the tool erased it and drew a
  clean labelled ellipse. For requests like "draw a bird", `edit_drawing` has a `picture` shape
  backed by a library of 23 line drawings (`plugins/lib/pictures.js`, unit-square strokes fitted
  into the requested box, or the middle of the screen). Small models can't trace a recognizable
  picture point by point, so they name the subject instead.
- **Math** (`overlay-math.js`, `mathink.js`, `math.js`): strokes are grouped into expressions by
  proximity and read 0.2 s after the pen lifts by Windows' handwriting recognizer (WinRT
  `InkRecognizerContainer`, called from the native helper on its own MTA thread; 27–177 ms). The best
  reading among the candidates is chosen, handwriting look-alikes are fixed (l→1, O→0, x between
  numbers → ×), and the clean reading is shown under the ink. Answers wait for **Solve** (per
  expression, Solve all, or Enter), since "=" alone can't tell a sum from an equation: sums are computed
  exactly by a recursive-descent evaluator (no `eval`), an answer the user wrote is checked (✓ or
  corrected), and equations with one unknown are solved locally (`solveEquation` in `math.js`:
  f(v) = left − right is sampled; linear and quadratic are solved exactly, with fractions shown as
  fractions, and anything else by sign-change bisection over ±200). Only equations the solver can't
  handle go to the AI model. Letters that are commonly variables (b, q, z, s, t…) are no longer
  turned into digits, which had made "2b + 1 = 7" read as "26 + 1 = 7". A stroke that lands between
  two expressions on the same line joins them. Verified live: "7+5=" drawn on the overlay was read
  correctly and computed as 12.
- **Asking about an area**: the lasso opens a small ask box on the overlay next to the area (the
  overlay takes focus only while the box is open). Earlier builds opened the main window for the
  question; that window then sat on top of the screen being asked about. In Talk mode the question
  is simply spoken. The mark fades 1.6 s after the question is sent, since screenshots never include
  the overlay anyway.
- **Home**: a chat (user bubbles, assistant replies streaming in, a quiet list of actions). The window
  stays open while chatting and minimizes only when the AI starts using the mouse or keyboard.

## 6. Plugins

`Add Plugin…` → `validate.js`: size and extension checks; syntax compiled with `vm.Script` without
running; the module loaded in a separate `ELECTRON_RUN_AS_NODE` process with an 8 s limit; the tool
contract, input schema (types, `items`, `required` ⊆ properties), and name clashes checked; source
scanned for capabilities (programs, files, internet, app features, dynamic code, system info). The
user sees tools, capabilities, problems, and suggestions and installs explicitly; install re-validates.
A file loads all of its tools or none. The registry's version feeds the conversation key, so the
model gets the new tool list on the next request. Settings lists built-in tools by purpose and custom
plugins with their load status.

## 7. Onboarding and settings

- Onboarding: Welcome → Name → Voice → Listen → Complete Setup. No providers, keys, or model switching
  appear there. The final step shows the device check, the recommendation, and the sizes; the primary
  button reads Download & Install, then Continue (the download keeps going), or Start Using <name>.
  Enter only advances from the name field and welcome screen, so no key press can start a download.
- Upgrades: `onboardedVersion` records which setup was completed. Someone who finished the 1.0 setup
  and has no local model opens on the Complete Setup step (1.1.0 as first shipped skipped it and
  opened Settings).
- Settings › Models: the on-PC model first (switch size, remove), then optional cloud models behind a
  warning that they need internet and are replaced by the local model offline. Settings › Voice holds
  voices, speech recognition, and the microphone. There is no Safety page and no spending limit;
  approvals keep their defaults (ask before risky actions and in sensitive windows).
- The main window shows a download banner on every page with Pause, Resume, Retry, and Cancel.
- `open_app` falls back to the web version of well-known apps (Spotify, YouTube, WhatsApp, …) when the
  app isn't installed, and no longer caches a failed app lookup.

## 8. Installer (`package.json` build, `build/installer.nsh`)

Assisted NSIS installer, per-user (no admin), selectable folder, Start menu and desktop shortcuts,
runs Bigfoot when done. Additions in this release:

- Stops Bigfoot's own `input-helper.exe` and `llama-server.exe` (matched by path) before install and
  uninstall, so crashed leftovers can't lock files.
- Uninstall removes the login entry and asks whether to delete settings and the downloaded model
  (default: keep). Updates never ask. Silent uninstalls keep data.
- The plugin validator's child script is unpacked from the archive so it can run in node mode.
- Whisper (server, libraries, and the 78 MB English model) ships in `resources/speech`, so speech
  recognition works right after install with no download.
- Not signed: SmartScreen warns until `CSC_LINK`/`CSC_KEY_PASSWORD` are set for the build.

## 9. Verification

`npm test`: 48 tests across five suites, all passing.

| Suite | Covers |
|---|---|
| core | costs, key mapping, coordinate mapping, plugin registry, provider resolution, settings |
| agent | the real agent loop with a scripted model: actions, approvals, file tools, stop, bounds checks, traced regions |
| local | recommendation, pinned URLs, registry parsing, streamed replies, batch screenshot trimming, hardware tuning, keep-loaded, resumable download (drop mid-file, Range ignored, 404), manager corruption/retry/cancel and pause persistence, grid conversion, `edit_drawing`, math evaluation, live handwriting interpretation, Whisper transcript cleanup, web-app fallback |
| plugins | template passes; syntax errors, clashes, schema errors, missing run, hanging and throwing plugins rejected; install, update, remove |
| speech-stream | sentences spoken while a reply streams, none twice, a new message after an action, Esc dropping queued speech |

Live checks in the running app (separate profile): all download URLs; runtime download, hash, and
unpack; onboarding flow; Settings pages; desktop double-click → tray → tool; Draw tools, undo/redo,
eraser, pointer mode; drawing composited into model screenshots; `edit_drawing` on a real drawing;
Talk mode on inside Draw and Esc ordering; plugin validator inside Electron; the installed 2B model
answering through the real provider and runtime (cold and restored warm-up); bundled Whisper through
the speech service; the math overlay reading and answering drawn strokes; the new Home chat.

**Not yet verified end to end:** the model's pointing precision and its drawing edits (the pipeline
around them is verified with scripted tool calls), and a full install/uninstall pass of the installer.

## 10. Performance

| Hardware | Model | Chat answer | Step with a screenshot |
|---|---|---|---|
| Laptop without GPU (i5-8350U, 8 GB) — measured | 2B | ~8 s (first words ~2 s) | ~26 s |
| RTX 4060 8 GB — estimate | 8B | ~1–2 s | ~1–3 s |
| RTX 4090 — estimate | 8B | under 1 s | ~1 s |
| Claude (cloud) — estimate | — | ~2 s | ~2–6 s |

"Real-time" (well under a second) for a model that reads a full screenshot needs a graphics card;
on CPU-only machines the vision encoder alone takes seconds, whatever the software around it does.

Pointing: dependable on labelled buttons, menus, and links; unreliable on targets under ~20 px.
Bigfoot's own coordinate mapping adds no error (unit-tested).

## 11. Known limitations and risks

1. Local model quality and speed on low-end hardware; long multi-app tasks (e.g. video editing) are
   beyond small local models and only partly within reach of cloud models.
2. Speech recognition is English only (Whisper base.en); the wake word depends on Windows' speech
   pack for the assistant's name.
3. The tray opens only on empty desktop by design (double-click elsewhere belongs to the app under it).
4. The math tool's live reading uses Windows' text recognizer, which handles digits and + − × ÷ = ( )
   well but not fractions, exponents, or two-line layouts; those need the AI model.
5. Plugins run with full access once installed; the validator informs, it doesn't sandbox.
6. The installer is unsigned.
7. `BIGFOOT_DEMO=qa` exposes internals for QA automation; it is off unless that variable is set.

## 12. Recommended next steps

1. Measure pointing error by target size with the 2B and 8B models, and add zoom-to-refine for small
   targets.
2. A single-request fast path for "where is X" questions.
3. A multilingual Whisper model as an option.
4. Code-sign the installer.
