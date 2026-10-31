"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ALPHABET, generateKey, parseKey, formatDisplay, checksumChar } = require("../zbtFormat");

test("generated key uses the FL display format", () => {
  const generated = generateKey((size) => Buffer.from(Array.from({ length: size }, (_, i) => i)));
  assert.equal(generated.compact.length, 14);
  assert.match(generated.display, /^FL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(parseKey(generated.display), { ok: true, compact: generated.compact });
});

test("parser accepts FL keys with U and rejects malformed FL keys", () => {
  assert.deepEqual(parseKey("FL-23UU-ZUFN-3MBR"), { ok: true, compact: "FL23UUZUFN3MBR" });
  assert.deepEqual(parseKey("FL–BSV5–UYNK–9WTF"), { ok: true, compact: "FLBSV5UYNK9WTF" });
  assert.equal(parseKey("FL-23UU-ZUFN-3MB" ).ok, false);
  assert.equal(parseKey("FL-23UU-ZUFN-3MB@").ok, false);
});

test("parser keeps support for valid FZBT keys and rejects altered checksums", () => {
  const payload = "2".repeat(16);
  const compact = `FZBT${payload}${checksumChar(payload)}`;
  const changed = `${compact.slice(0, -1)}${ALPHABET[(ALPHABET.indexOf(compact.at(-1)) + 1) % ALPHABET.length]}`;
  assert.equal(parseKey(formatDisplay(compact)).ok, true);
  assert.equal(parseKey(changed).ok, false);
  assert.equal(parseKey("FZBT-0000-0000-0000-0000-0").ok, false);
});