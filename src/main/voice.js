'use strict';
// Speech-to-text and cloud text-to-speech. The built-in "System" voices are played in the
// renderer with the Web Speech API and need no key.

// Female voices first: Bigfoot speaks with a female voice unless the user picks another.
const OPENAI_VOICES = ['coral', 'nova', 'shimmer', 'sage', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse']
  .map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));

const FEMALE = /\b(zira|hazel|susan|aria|jenny|sonia|libby|michelle|ava|emma|clara|natasha|catherine|linda|heera|eva|elsa|hortense|julie|helena|laura|sabina|paulina|hedda|katja|irina|sarah|salli|joanna|kendra|kimberly|ivy|amy|nicole|olivia|coral|nova|shimmer|sage|female)\b/i;
const MALE = /\b(david|mark|george|guy|ryan|christopher|eric|james|brian|andrew|william|liam|thomas|richard|sean|ravi|onyx|echo|ash|male)\b/i;
const isFemaleVoice = (name) => FEMALE.test(String(name || ''));
const isMaleVoice = (name) => MALE.test(String(name || '')) && !isFemaleVoice(name);

class VoiceError extends Error {
  constructor(message, title = 'Voice problem') {
    super(message);
    this.title = title;
  }
}

async function request(url, options, provider) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
  } catch (err) {
    throw new VoiceError(`Couldn’t reach ${provider}. Check your internet connection.`, 'You’re offline');
  }
  if (res.ok) return res;
  let detail = '';
  try {
    const body = await res.json();
    detail = (body.error && (body.error.message || body.error)) || (body.detail && (body.detail.message || body.detail)) || '';
  } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) {
    throw new VoiceError(`Your ${provider} API key was rejected. Check it in Settings.`, `${provider} key rejected`);
  }
  if (res.status === 429) throw new VoiceError(`${provider} is rate limiting requests or your quota is used up.`, `${provider} limit reached`);
  throw new VoiceError(`${provider} returned an error (${res.status})${detail ? `: ${String(detail).slice(0, 160)}` : ''}.`);
}

// ---------------------------------------------------------------- speech to text
async function transcribe({ provider, key, audio, mimeType }) {
  if (!key) {
    throw new VoiceError(
      `Add your ${provider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'} API key in Settings › Voice to talk to me. You can also type in the panel.`,
      'Voice input needs a key');
  }
  const ext = /ogg/.test(mimeType) ? 'ogg' : /mp4/.test(mimeType) ? 'mp4' : 'webm';
  const file = new Blob([audio], { type: mimeType || 'audio/webm' });
  const form = new FormData();
  if (provider === 'elevenlabs') {
    form.append('file', file, `speech.${ext}`);
    form.append('model_id', 'scribe_v1');
    const res = await request('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': key }, body: form,
    }, 'ElevenLabs');
    return String((await res.json()).text || '').trim();
  }
  form.append('file', file, `speech.${ext}`);
  form.append('model', 'gpt-4o-mini-transcribe');
  const res = await request('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
  }, 'OpenAI');
  return String((await res.json()).text || '').trim();
}

// ---------------------------------------------------------------- text to speech
/** Returns MP3 bytes. */
async function synthesize({ provider, key, voice, text, speed = 1 }) {
  if (provider === 'elevenlabs') {
    if (!key) throw new VoiceError('Add your ElevenLabs API key in Settings › Voice, or switch to a System voice.', 'Voice needs a key');
    if (!voice) throw new VoiceError('Pick an ElevenLabs voice in Settings › Voice.', 'No voice selected');
    const res = await request(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { speed: Math.min(1.2, Math.max(0.7, speed)) } }),
      }, 'ElevenLabs');
    return Buffer.from(await res.arrayBuffer());
  }
  if (provider === 'openai') {
    if (!key) throw new VoiceError('Add your OpenAI API key in Settings › Voice, or switch to a System voice.', 'Voice needs a key');
    const res = await request('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: voice || 'coral', input: text, response_format: 'mp3', speed: Math.min(4, Math.max(0.25, speed)) }),
    }, 'OpenAI');
    return Buffer.from(await res.arrayBuffer());
  }
  throw new VoiceError(`Unknown voice provider ${provider}`);
}

async function listVoices(provider, key) {
  if (provider === 'openai') return OPENAI_VOICES;
  if (provider === 'elevenlabs') {
    if (!key) return [];
    const res = await request('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } }, 'ElevenLabs');
    const body = await res.json();
    const female = (v) => (v.labels && v.labels.gender === 'female') || isFemaleVoice(v.name);
    return (body.voices || []).sort((a, b) => Number(female(b)) - Number(female(a)) || a.name.localeCompare(b.name))
      .map((v) => ({ id: v.voice_id, name: v.name }));
  }
  return []; // system voices are listed in the renderer
}

module.exports = { transcribe, synthesize, listVoices, VoiceError, OPENAI_VOICES, isFemaleVoice, isMaleVoice };
