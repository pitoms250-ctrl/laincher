"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertCatalogItemAvailable,
  getCoinPrice,
  listGrantedItemIds,
  normalizeRequestId,
  selectWeightedDrop,
} = require("../shopEconomy");

const config = { coinsPerUah: 1 };

test("request IDs are bounded and path-safe", () => {
  assert.equal(normalizeRequestId("shop_123456"), "shop_123456");
  assert.throws(() => normalizeRequestId("../wallet"));
  assert.throws(() => normalizeRequestId("tiny"));
});

test("shop purchase checks enabled, time window, stock and server price", () => {
  const item = { enabled: true, type: "frame", priceUah: 99, priceCoins: 99, stock: 2 };
  assert.doesNotThrow(() => assertCatalogItemAvailable(item, 100));
  assert.equal(getCoinPrice(item, config), 99);
  assert.throws(() => assertCatalogItemAvailable({ ...item, stock: 0 }, 100), /закончился/);
  assert.throws(() => assertCatalogItemAvailable({ ...item, availableFrom: 101 }, 100), /не началась/);
  assert.throws(() => getCoinPrice({ ...item, priceCoins: 98 }, config), /не совпадает/);
  assert.throws(() => getCoinPrice({ ...item, type: "coins" }, config), /нельзя покупать/);
});

test("weighted case drops use server integer roll boundaries", () => {
  const entries = [
    { kind: "coins", amount: 10, weight: 3500 },
    { kind: "item", itemId: "frame_fl_emerald", weight: 6500 },
  ];
  assert.equal(selectWeightedDrop(entries, 0).amount, 10);
  assert.equal(selectWeightedDrop(entries, 3499).amount, 10);
  assert.equal(selectWeightedDrop(entries, 3500).itemId, "frame_fl_emerald");
  assert.throws(() => selectWeightedDrop(entries, 10000), /0 до 9999/);
  assert.throws(() => selectWeightedDrop([{ kind: "coins", amount: 10, weight: 9999 }], 10), /10000/);
});

test("bundle grants are resolved from server catalog metadata", () => {
  assert.deepEqual(listGrantedItemIds({ metadata: { includes: ["frame_fl_emerald", "badge_fox"] } }), ["frame_fl_emerald", "badge_fox"]);
  assert.deepEqual(listGrantedItemIds({ metadata: { grants: [{ itemId: "case_basic", quantity: 5 }] } }), ["case_basic"]);
  assert.deepEqual(listGrantedItemIds({}), []);
});
