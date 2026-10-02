'use strict';
// Makes each voice's preview ahead of time (vendor/voice/previews), so pressing ▶ in setup and on
// the Voice page plays at once instead of waiting for the voice to speak it. Run by fetch-speech.js;
// does nothing when the previews are already there.

const fs = require('fs');
const path = require('path');
const { Kokoro, VOICES, previewText, PREVIEW_NAME, ACK_TEXT } = require('../src/main/kokoro');

async function makePreviews(dir) {
  const out = path.join(dir, 'previews');
  const missing = VOICES.filter((v) => !fs.existsSync(path.join(out, `${v.id}.wav`)) || !fs.existsSync(path.join(out, `ack-${v.id}.wav`)));
  if (!missing.length) return;
  fs.mkdirSync(out, { recursive: true });
  const kokoro = new Kokoro();
  try {
    for (const v of missing) {
      process.stdout.write(`Making the ${v.name} preview… `);
      fs.writeFileSync(path.join(out, `${v.id}.wav`), await kokoro.say(previewText(PREVIEW_NAME), v.id, 1));
      fs.writeFileSync(path.join(out, `ack-${v.id}.wav`), await kokoro.say(ACK_TEXT, v.id, 1));
      console.log('done');
    }
  } finally {
    kokoro.stop();
  }
}

module.exports = { makePreviews };

if (require.main === module) {
  makePreviews(path.join(__dirname, '..', 'vendor', 'voice')).catch((err) => { console.error(`Voice previews failed: ${err.message}`); process.exit(1); });
}
