'use strict';
// Downloads the speech recognizer that ships inside the app (whisper.cpp and its English model)
// into vendor/speech, and the handwritten-math reader into vendor/math, verifying each file's SHA-256. Runs before `npm start` and `npm run dist`;
// does nothing when the files are already there.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SPEECH, MATH } = require('../src/main/local/catalog');

const DEST = path.join(__dirname, '..', 'vendor', 'speech');
const SERVER = path.join(DEST, 'whisper', 'whisper-server.exe');
const model = SPEECH.find((f) => f.speech);
const MODEL = path.join(DEST, model.name);
const MATH_DEST = path.join(__dirname, '..', 'vendor', 'math');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fetchVerified(f, file) {
  process.stdout.write(`Downloading ${f.name} (${(f.size / 1024 ** 2).toFixed(0)} MB)… `);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.url} returned ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const hash = sha256(file);
  if (hash !== f.sha256) { fs.rmSync(file, { force: true }); throw new Error(`${f.name} failed verification (${hash})`); }
  console.log('verified');
}

async function main() {
  if (process.platform !== 'win32') return;
  fs.mkdirSync(DEST, { recursive: true });
  if (!fs.existsSync(MODEL) || fs.statSync(MODEL).size !== model.size) await fetchVerified(model, MODEL);
  fs.mkdirSync(MATH_DEST, { recursive: true });
  for (const f of MATH) {
    const file = path.join(MATH_DEST, f.name);
    if (!fs.existsSync(file) || fs.statSync(file).size !== f.size) await fetchVerified(f, file);
  }
  if (!fs.existsSync(SERVER)) {
    const runtime = SPEECH.find((f) => f.speechRuntime);
    const zip = path.join(DEST, runtime.name);
    await fetchVerified(runtime, zip);
    const tmp = path.join(DEST, 'tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]);
    // Keep only what the server needs: the server itself and the libraries beside it.
    const release = path.join(tmp, 'Release');
    const out = path.join(DEST, 'whisper');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out);
    for (const name of fs.readdirSync(release)) {
      if (name === 'whisper-server.exe' || name.endsWith('.dll')) fs.copyFileSync(path.join(release, name), path.join(out, name));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
}

main().catch((err) => { console.error(`Speech recognizer download failed: ${err.message}`); process.exit(1); });
