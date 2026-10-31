import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateShopSeeds } from "./seed-shop.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [items, drops, config] = await Promise.all([
  "shop_items.seed.json", "case_drops.seed.json", "shop_config.seed.json",
].map(async (name) => JSON.parse(await readFile(path.join(repoRoot, name), "utf8"))));

test("seed catalog has 69 valid items and eight complete drop tables", () => {
  assert.equal(Object.keys(items).length, 69);
  assert.equal(Object.keys(drops).length, 8);
  assert.deepEqual(validateShopSeeds(items, drops, config), []);
});

test("validator rejects low prices and USDT conversion mismatches", () => {
  const changed = structuredClone(items);
  changed.tag_custom.priceUah = 49;
  changed.tag_custom.priceUsdt = 49;
  assert.ok(validateShopSeeds(changed, drops, config).some((message) => message.includes("priceUah")));
  changed.tag_custom.priceUah = 99;
  changed.tag_custom.priceUsdt = 98;
  assert.ok(validateShopSeeds(changed, drops, config).some((message) => message.includes("priceUsdt")));
});

test("validator rejects bad drop totals and unknown item references", () => {
  const changed = structuredClone(drops);
  changed.case_basic[0].weight++;
  changed.case_basic[2].itemId = "missing_item";
  const errors = validateShopSeeds(items, changed, config);
  assert.ok(errors.some((message) => message.includes("сумма weight")));
  assert.ok(errors.some((message) => message.includes("missing_item")));
});

test("validator rejects coins in case drop item references", () => {
  const changed = structuredClone(drops);
  changed.case_basic[2].itemId = "coins_50";
  assert.ok(validateShopSeeds(items, changed, config).some((message) => message.includes("type=coins")));
});
