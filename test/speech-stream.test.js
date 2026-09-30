'use strict';

require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioService } = require('../src/main/audio');

function audio() {
  const a = new AudioService({ windows: {}, settings: { get: (k) => (k === 'speakResponses' ? true : undefined) }, logger: {} });
  a.said = [];
  a.speak = async (text) => { a.said.push(text); return 'system'; };
  return a;
}

test('sentences are spoken while the reply is still being written, none twice', async () => {
  const a = audio();
  a.beginStream();
  a.feedStream('Sure');
  a.feedStream('Sure, 3.5 is');
  assert.deepEqual(a.said, []); // no finished sentence yet ("3.5" is not an ending)
  a.feedStream('Sure, 3.5 is the answer. Anything');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.said, ['Sure, 3.5 is the answer.']);
  assert.equal(await a.finishStream('Sure, 3.5 is the answer. Anything else?'), 'system');
  assert.deepEqual(a.said, ['Sure, 3.5 is the answer.', 'Anything else?']);
});

test('a new message after an action starts over; stopping drops what is queued', async () => {
  const a = audio();
  a.beginStream();
  a.feedStream('Let me open Notepad. ');
  a.feedStream('Done! I wrote the haiku. It');
  await a.finishStream('Done! I wrote the haiku. It is saved.');
  // Sentences may be spoken in chunks; what matters is every word once, in order.
  assert.equal(a.said.join(' ').replace(/\s+/g, ' '), 'Let me open Notepad. Done! I wrote the haiku. It is saved.');

  const b = audio();
  b.call = async () => true; // no audio engine in tests
  b.beginStream();
  b.feedStream('One. Two. ');
  b.stopSpeaking(); // Esc before the queue got to it
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.said, []);
});
