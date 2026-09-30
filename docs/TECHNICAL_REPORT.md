# Bigfoot 1.1 — Technical report

Scope: the move to an on-device AI (Qwen3-VL) as the default model, the tool tray, Draw and Math,
continuous voice (Talk), the plugin validator, onboarding and settings changes, and the installer.
Date: 30 September 2026.

## 1. Summary

| Area | Before | Now |
|---|---|---|
| Default model | Claude, with an API key required at setup | Qwen3-VL on the user's PC; no key, works offline |
| Cloud models | Claude, OpenAI, Gemini | Claude or OpenAI, optional, online only (Gemini removed) |
| Speech-to-text | OpenAI key by default | Windows recognizer on the PC by default; cloud optional |
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

### 3.5 Latency work

Research (llama.cpp server documentation and issue reports) shows that on machines without a
graphics card the vision encoder dominates, and its cost scales with the image's token count.
Measures, in order of effect:

| Measure | Effect |
|---|---|
| Keep loaded, preload at startup, auto-restart | Removes cold starts (model load) entirely |
| `--image-max-tokens` by hardware (448 CPU / 768 small GPU / 1024) and matching screenshot size (1024 / 1280 px) | Cuts image encoding and prefill, the largest cost on small machines |
| Warm-up request with the system prompt and tools when the model loads | The first real request only reads the new screenshot and words |
| Screenshots dropped in batches (at 4, keep 2) instead of every turn, plus `--cache-reuse 256` | Keeps the server's prompt cache valid across steps instead of re-reading history |
| Streaming (`stream: true`) into the reply bubble | Text appears as it's generated |
| `--load-mode mmap+mlock` (falls back if Windows refuses) | Model stays in RAM; no page-ins between requests |

Not adopted: speculative decoding (speeds up writing, not the vision prefill that dominates),
KV-cache quantization of V (requires flash attention on every backend).

### 3.6 Provider (`llm/local.js`)

Built on the OpenAI-compatible provider. Qwen3-VL points on a 0–1000 grid regardless of image size,
so the provider translates, in both directions, clicks, drags, zoom regions, `annotate` and
`edit_drawing` points and regions, `[POINT]` tags, and cursor positions. Replies are streamed. Up to
four screenshots stay in history (trimmed to two in one step); if the context still overflows, the
history is cut to the current request and retried; if
the server disappears mid-request it is restarted once. Local usage is costed at $0 so spending
limits never block it.

### 3.7 Provider resolution and offline behavior

`resolveProvider(settings, { online })`: a chosen cloud provider with a key while online; otherwise
the installed local model; otherwise any keyed cloud provider; otherwise none. If a cloud request
fails because the connection dropped mid-task, the agent restarts the request on the local model.
Legacy settings (a cloud provider selected without its key) migrate to local on load.

## 4. Voice and Talk mode

Talk (tray or Draw bar) toggles continuous listening: each utterance ends on 1.3 s of silence, is
transcribed (Windows recognizer by default), and runs as a request; listening resumes when Bigfoot is
idle again, so it never hears its own speech. While waiting, silence is discarded every 30 s so
memory stays flat and the microphone isn't reopened. Talk ends on the Talk button, Esc, or "stop
listening"/"that's all"/"goodbye". Hands-free listening never captures the mouse; only hold-to-talk
enables drag-to-highlight.

## 5. Tool tray, Draw, and Math

- **Tray trigger**: a low-level mouse hook in the native helper recognizes physical (not injected)
  double-clicks using the system double-click time and distance, then checks off the hook thread,
  via the window class (`Progman`/`WorkerW`) and UI Automation, that the point is empty desktop and
  not an icon. Verified live.
- **Draw** (`overlay-ink.js`): vector strokes on a committed canvas with a live canvas for the stroke
  in progress, so undo, redo, and the eraser are exact. Pointer mode makes the overlay click-through
  while hover still reaches the toolbar. The overlay takes keyboard focus only while a tool is open.
- **AI and the drawing**: screen capture can't see Bigfoot's overlay, so the drawing is exported and
  composited onto every screenshot and zoom the model receives. The `edit_drawing` tool adds strokes
  and shapes, erases a region, or clears; edits are recorded in the user's undo history. During a
  request the overlay passes clicks through so the AI's actions reach the apps below. Verified live:
  a hand-drawn stroke appeared in the model's screenshot and zoom, and the tool erased it and drew a
  clean labelled ellipse.
- **Math** (`overlay-math.js`, `mathink.js`, `math.js`): strokes are grouped into expressions by
  proximity and read ~0.9 s after the pen lifts; the model transcribes, and a recursive-descent
  evaluator (no `eval`) computes arithmetic exactly. Equations with variables are solved by the model.

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
- Settings › Models: the on-PC model first (switch size, remove), then optional cloud models behind a
  warning that they need internet and are replaced by the local model offline.
- The main window shows a download banner on every page with Pause, Resume, Retry, and Cancel.

## 8. Installer (`package.json` build, `build/installer.nsh`)

Assisted NSIS installer, per-user (no admin), selectable folder, Start menu and desktop shortcuts,
runs Bigfoot when done. Additions in this release:

- Stops Bigfoot's own `input-helper.exe` and `llama-server.exe` (matched by path) before install and
  uninstall, so crashed leftovers can't lock files.
- Uninstall removes the login entry and asks whether to delete settings and the downloaded model
  (default: keep). Updates never ask. Silent uninstalls keep data.
- The plugin validator's child script is unpacked from the archive so it can run in node mode.
- Not signed: SmartScreen warns until `CSC_LINK`/`CSC_KEY_PASSWORD` are set for the build.

## 9. Verification

`npm test`: 40 tests across four suites, all passing.

| Suite | Covers |
|---|---|
| core | costs, key mapping, coordinate mapping, plugin registry, provider resolution, settings |
| agent | the real agent loop with a scripted model: actions, approvals, file tools, stop, bounds checks, traced regions |
| local | recommendation, pinned URLs, registry parsing, streamed replies, batch screenshot trimming, hardware tuning, keep-loaded, resumable download (drop mid-file, Range ignored, 404), manager corruption/retry/cancel and pause persistence, grid conversion, `edit_drawing`, math evaluation and reading |
| plugins | template passes; syntax errors, clashes, schema errors, missing run, hanging and throwing plugins rejected; install, update, remove |

Live checks in the running app (separate profile): all download URLs; runtime download, hash, and
unpack; onboarding flow; Settings pages; desktop double-click → tray → tool; Draw tools, undo/redo,
eraser, pointer mode; drawing composited into model screenshots; `edit_drawing` on a real drawing;
Talk mode on inside Draw and Esc ordering; plugin validator inside Electron.

**Not yet verified end to end:** a real Qwen3-VL model answering, pointing, reading handwriting, and
editing a drawing, because no model has been fully downloaded on the test machine. The pipeline around
the model is verified; the model's own quality is not.

## 10. Performance expectations (estimates, not measured)

With the latency measures in 3.5 (model kept loaded, smaller images on small machines, warm cache):

| Hardware | Model | Each step with a screenshot |
|---|---|---|
| Laptop without GPU (i5-8350U, 8 GB) | 2B | ~5–15 s; the first words appear sooner |
| RTX 4060 8 GB | 8B | ~1–3 s |
| RTX 4090 | 8B | under 1 s |
| Claude (cloud) | — | ~2–6 s |

"Real-time" (well under a second) for a model that reads a full screenshot needs a graphics card;
on CPU-only machines the vision encoder alone takes seconds, whatever the software around it does.

Pointing: dependable on labelled buttons, menus, and links; unreliable on targets under ~20 px.
Bigfoot's own coordinate mapping adds no error (unit-tested).

## 11. Known limitations and risks

1. Local model quality and speed on low-end hardware; long multi-app tasks (e.g. video editing) are
   beyond small local models and only partly within reach of cloud models.
2. Offline speech recognition is Windows' built-in recognizer; accuracy is modest. An offline Whisper
   option would improve it.
3. The tray opens only on empty desktop by design (double-click elsewhere belongs to the app under it).
4. Plugins run with full access once installed; the validator informs, it doesn't sandbox.
5. The installer is unsigned.
6. `BIGFOOT_DEMO=qa` exposes internals for QA automation; it is off unless that variable is set.

## 12. Recommended next steps

1. Benchmark on real hardware (2B on the test laptop, 8B on a mid-range GPU): latency per step and
   pointing error by target size, to tune the image-token budgets in 3.5.
2. A single-request fast path for "where is X" questions, and zoom-to-refine for small targets.
3. Offline Whisper speech recognition as an optional download.
4. Code-sign the installer.
