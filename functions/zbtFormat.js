"use strict";

/** 32 символа, без 0/O/1/I — меньше опечаток при ручном вводе. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";
const FL_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PREFIX = "FZBT";

function alphabetIndex(ch) {
  return ALPHABET.indexOf(ch);
}

function checksumChar(payload15) {
  let sum = 0;
  for (let i = 0; i < payload15.length; i++) {
    const v = alphabetIndex(payload15[i]);
    if (v < 0) return null;
    sum += (i + 1) * (v + 1);
  }
  return ALPHABET[sum % ALPHABET.length];
}

function normalizeKey(raw) {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]/gu, "");
}

function parseKey(raw) {
  const compact = normalizeKey(raw);
  if (compact.startsWith("FL")) {
    const payload = compact.slice(2);
    if (payload.length !== 12 || [...payload].some((ch) => !FL_ALPHABET.includes(ch))) {
      return { ok: false, reason: "format" };
    }
    return { ok: true, compact };
  }
  if (!compact.startsWith(PREFIX) || compact.length !== PREFIX.length + 17) {
    return { ok: false, reason: "format" };
  }
  const body = compact.slice(PREFIX.length);
  for (const ch of body) {
    if (alphabetIndex(ch) < 0) return { ok: false, reason: "alphabet" };
  }
  const payload = body.slice(0, 16);
  const check = body[16];
  if (checksumChar(payload) !== check) return { ok: false, reason: "checksum" };
  return { ok: true, compact: `${PREFIX}${body}` };
}

function formatDisplay(compact) {
  if (compact.startsWith("FL")) {
    const payload = compact.slice(2);
    return `FL-${payload.slice(0, 4)}-${payload.slice(4, 8)}-${payload.slice(8, 12)}`;
  }
  const body = compact.slice(PREFIX.length);
  return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body[16]}`;
}

function randomPayload12(randomBytes) {
  let out = "";
  while (out.length < 12) {
    for (const byte of randomBytes(16)) {
      if (byte >= 252) continue;
      out += FL_ALPHABET[byte % FL_ALPHABET.length];
      if (out.length === 12) break;
    }
  }
  return out;
}

function generateKey(randomBytes) {
  const compact = `FL${randomPayload12(randomBytes)}`;
  return { compact, display: formatDisplay(compact) };
}

module.exports = {
  ALPHABET,
  PREFIX,
  parseKey,
  generateKey,
  formatDisplay,
  checksumChar,
};
