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
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.said, ['Sure,']); // the opening is said at once; "3.5" is not an ending
  a.feedStream('Sure, 3.5 is the answer. Anything');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.said, ['Sure,', '3.5 is the answer.']);
  assert.equal(await a.finishStream('Sure, 3.5 is the answer. Anything else?'), 'system');
  assert.deepEqual(a.said, ['Sure,', '3.5 is the answer.', 'Anything else?']);
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

test('the final reply never repeats what was already spoken', async () => {
  const a = audio();
  a.beginStream();
  a.feedStream('Opening Chrome now.\nHere it is . ');
  await a.finishStream('Opening Chrome now.  Here it is.');
  assert.deepEqual(a.said, ['Opening Chrome now.', 'Here it is .']);
});

test('placeholder user folders point at the real home', () => {
  const os = require('os');
  const path = require('path');
  const { resolvePath } = require('../src/main/plugins/lib/paths');
  assert.equal(resolvePath('C:\\Users\\YourUsername\\Desktop\\a.txt'), path.join(os.homedir(), 'Desktop', 'a.txt'));
  assert.equal(resolvePath('C:\\Users\\<user>\\Documents'), path.join(os.homedir(), 'Documents'));
  assert.equal(resolvePath('C:\\Users\\Public\\x'), 'C:\\Users\\Public\\x');
});

test('a phrase is spoken as soon as it is written, before its sentence ends, and only once', async () => {
  const a = audio();
  a.beginStream();
  a.feedStream('I opened Chrome and searched for the best songs');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.said, []); // the phrase may still grow
  a.feedStream('I opened Chrome and searched for the best songs, and the top');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.said, ['I opened Chrome and searched for the best songs,']);
  await a.finishStream('I opened Chrome and searched for the best songs, and the top one is Essence.');
  assert.deepEqual(a.said, ['I opened Chrome and searched for the best songs,', 'and the top one is Essence.']);
});
