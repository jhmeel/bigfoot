# Bigfoot

An AI assistant that lives next to your cursor on Windows. It sees your screen, talks with you,
points at and draws on things, and operates your computer: opening apps, clicking, typing,
managing files, and running commands. Its AI runs on your PC, so it's private and works offline.

## Install

Run `Bigfoot-Setup-<version>.exe`. It installs for the current user (no admin rights), lets you pick
the folder, adds Start menu and desktop shortcuts, and opens Bigfoot when it finishes. Setup then
walks through naming your assistant, choosing a voice, checking the microphone, and installing the
AI that runs on your PC.

> The installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC".
> Choose **More info › Run anyway**. Sign the build before distributing it (see Releasing).

Uninstalling asks whether to also delete your settings and the downloaded model (kept by default,
so reinstalling doesn't mean downloading it again). Updates never ask.

## The AI on your PC

The last setup step checks your GPU, memory, and disk and recommends a Qwen3-VL size:

| Size | Download | Good for |
|---|---|---|
| 2B | ~1.5 GB | Laptops without a graphics card, 8 GB RAM |
| 4B | ~2.8 GB | 16 GB RAM, or a 4–6 GB graphics card |
| 8B | ~5.4 GB | 8 GB graphics cards (e.g. RTX 4060) |
| 30B | ~18 GB | 20 GB+ graphics cards |

You can keep using Bigfoot while it downloads; a banner in the main window shows progress with
Pause, Resume, and Retry. Losing the connection, going offline, or quitting never restarts the
download: it continues from the bytes already saved. Every file is pinned to an exact upstream
revision and checked against its SHA-256 before it's installed.

| Source | Link |
|---|---|
| Qwen3-VL GGUF models (Apache-2.0) | https://huggingface.co/Qwen |
| llama.cpp runtime b11276 (MIT) | https://github.com/ggml-org/llama.cpp/releases/tag/b11276 |
| whisper.cpp b5130 and its English base model (MIT), bundled in the installer | https://github.com/ggml-org/whisper.cpp |

**Cloud models (optional).** Settings › Models can use Claude or OpenAI with your own API key.
They need an internet connection; whenever you're offline, Bigfoot uses the model on your PC.
Cloud models are stronger at long, multi-step work in other apps.

**Speed.** The model loads when Bigfoot starts and stays loaded (Settings › Models › Keep the AI
loaded), and it's restarted automatically if it ever crashes. Its fixed instructions are read once
and saved to disk, so later starts are ready in about a second; replies appear word by word; and
on PCs without a graphics card it runs on the CPU with smaller screenshots, at lower priority and
one core short, so Windows stays responsive. Measured on an 8 GB laptop without a graphics card
(i5-8350U): a chat answer in about 8 seconds, a question about the screen in about 30. With a
graphics card it's a few seconds per step. It points reliably at labelled buttons, menus, and links,
and less reliably at small unlabelled icons.

## Using it

| | |
|---|---|
| Hold **Ctrl + Alt** | Push to talk; let go when you're done |
| Hold **Ctrl + Alt** and drag | Highlight an area of the screen to ask about |
| Say "Hey Bigfoot" (or the name you chose) | Start talking hands-free |
| The paw next to your cursor | That's Bigfoot: it listens, thinks, and flies to point at things |
| Double-click an empty spot on the desktop | Open the tool tray |
| **Esc** | Stop what Bigfoot is doing, turn Talk off, then close the open tool |
| Tray icon | Open Bigfoot, Settings, or the Terminal |
| Mouse into the top-left corner | Emergency stop while it's controlling the mouse |

### Tool tray

**Talk**, **Point** (ask about an area), **Draw**, **Math**, **Type**, and **Clear**. The tray closes
when you pick a tool, click away, or after a few seconds.

**Talk** stays on: say one request after another. It pauses while Bigfoot works or speaks, then
listens again, until you tap Talk, press Esc, or say "stop listening". It works alongside every
other tool, so you can draw and say "neaten my circle", then "add an arrow to it".

**Draw** annotates the screen: pen (pressure-sensitive with a stylus), highlighter, brush, eraser,
line, arrow, rectangle, and ellipse (Shift constrains), eight colors, four sizes, undo/redo, and
clear. **Pointer** keeps the drawing on screen while your clicks go to your apps. Drag the toolbar by
its grip. The AI sees your drawing and can change it: ask it to correct, neaten, label, or improve
it, and its edits land in your drawing, where Undo works on them.
Shortcuts: V P H B E L A R O for tools, 1–8 for colors, [ ] for size, Ctrl+Z / Ctrl+Y, Delete to
clear, Esc to close.

**Math**: write math anywhere on the screen. Windows' handwriting recognizer reads it in a fraction
of a second and shows the clean reading underneath, so a misread is obvious at once. Press **Solve**
next to an expression (or **Solve all**, or Enter): sums are computed exactly by Bigfoot, a sum with
your own answer is checked (✓, or the right answer), and equations with a letter, like
2x + 1 = 7, are solved by the AI model.

The Home window is a chat with Bigfoot. It stays open while you chat and steps aside only when
Bigfoot starts using the mouse or keyboard.

## Voice

- **Hearing you:** Whisper, running on your PC and bundled with Bigfoot: offline, private, and
  accurate (about 2–5 seconds per sentence on a laptop without a graphics card). OpenAI or
  ElevenLabs can be chosen in Settings › Voice; they're used only while online. The "Hey Bigfoot"
  wake word uses Windows' lightweight keyword spotter.
- **Talking back:** Windows voices (offline, free), or OpenAI and ElevenLabs voices with a key. Bigfoot
  starts speaking each sentence as soon as it's written, while the rest of the reply is still coming,
  and every reply is also typed out next to the cursor. Turn speech off in Settings › Voice.

## Plugins

Plugins give the AI new tools. In Settings › General › Plugins, **Add Plugin…** opens beside a
documented, read-only template to copy and edit, then checks your plugin in a separate process
(syntax, tool definitions, schemas, name clashes), shows what its code can access, and installs it
only when you confirm. See [docs/PLUGINS.md](docs/PLUGINS.md).

## Privacy and safety

- With the local model, screenshots and speech never leave your PC. With a cloud model, screenshots
  are sent to that provider while it works on a request.
- The local model server listens on 127.0.0.1 only, behind a key generated for each session.
- API keys are encrypted with Windows Data Protection (DPAPI) and never shown to the UI.
- Bigfoot's own windows are hidden from screen capture; your drawing is added to the screenshots
  the AI sees only so it can help with it.
- Deleting files always asks and uses the Recycle Bin. Commands ask unless approvals are off.
  System folders can't be written to at all. Windows that look like password managers or banks
  need your permission before Bigfoot acts in them.
- The Bigfoot Terminal and `%APPDATA%\Bigfoot\logs\activity.log` record everything it did.

## Development

```bash
npm install
npm start          # run from source
npm test           # unit, agent-loop, local-AI, and plugin tests
npm run dist       # build dist\Bigfoot-Setup-<version>.exe
```

`node test/live-input.js` runs a live check that opens Notepad, types, and closes it.
`BIGFOOT_DEMO=1` plays every overlay effect once for visual QA; `BIGFOOT_PROFILE_DIR` runs a copy
with a separate profile.

### Layout

```
src/main/             Electron main process
  main.js             startup and wiring
  controller.js       voice and Talk mode, tasks, replies, tool tray, Draw and Math, errors
  agent.js            provider-agnostic agent loop, approvals, offline fallback
  llm/                local Qwen3-VL, Claude, and OpenAI providers
  local/              model catalog, hardware check, resumable downloads, llama.cpp runtime, Whisper
  math.js mathink.js  exact arithmetic and handwriting reading for the math tool
  computer.js         computer actions (click, type, drag, scroll…)
  capture.js          screenshots and coordinate mapping
  plugins/            tool registry, built-in tools, validator, template
  windows.js          window management
  native/             input helper (SendInput, desktop double-click, wake word, offline STT)
src/renderer/         overlay (buddy, Draw, Math), tool tray, main window, onboarding, audio engine
build/installer.nsh   installer additions (uninstall prompt, helper shutdown)
docs/                 plugin guide and technical report
```

The native helper (`src/main/native/InputHelper.cs`) is compiled with the C# compiler that ships
with Windows. `npm start` and `npm run dist` build it automatically when it's missing or out of date, and fetch
the bundled speech recognizer into `vendor/speech` (SHA-256 verified; not committed). To rebuild the
helper by hand:

```bash
npm run build:native -- --force
```

### Releasing

Set `CSC_LINK` and `CSC_KEY_PASSWORD` to your code-signing certificate before `npm run dist` so
electron-builder signs the installer and app. Bump `version` in `package.json` for each release.
See [docs/TECHNICAL_REPORT.md](docs/TECHNICAL_REPORT.md) for architecture, verification, and known
limitations.
