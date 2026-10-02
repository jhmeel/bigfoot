'use strict';
// Telling female and male Windows voice names apart. Windows' voice is only a fallback now:
// Bigfoot speaks with its own voice (./kokoro).

const FEMALE = /\b(zira|hazel|susan|aria|jenny|sonia|libby|michelle|ava|emma|clara|natasha|catherine|linda|heera|eva|elsa|hortense|julie|helena|laura|sabina|paulina|hedda|katja|irina|sarah|salli|joanna|kendra|kimberly|ivy|amy|nicole|olivia|female)\b/i;
const MALE = /\b(david|mark|george|guy|ryan|christopher|eric|james|brian|andrew|william|liam|thomas|richard|sean|ravi|male)\b/i;
const isFemaleVoice = (name) => FEMALE.test(String(name || ''));
const isMaleVoice = (name) => MALE.test(String(name || '')) && !isFemaleVoice(name);

module.exports = { isFemaleVoice, isMaleVoice };
