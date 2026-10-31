"use strict";

const { getDatabase } = require("firebase-admin/database");

const database = () => getDatabase();
const asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

async function creditCoins(uid, operationId, amount, reason, reference) {
  const coinAmount = Number(amount);
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) throw new Error("Invalid FL Coin reward amount.");
  const walletRef = database().ref(`wallets/${uid}`);
  await walletRef.transaction((current) => {
    const wallet = asObject(current);
    const operations = asObject(wallet.operations);
    if (operations[operationId]) return wallet;
    const balanceAfter = Number(wallet.coins || 0) + coinAmount;
    return { ...wallet, coins: balanceAfter, updatedAt: Date.now(), operations: {
      ...operations, [operationId]: { status: "completed", delta: coinAmount, reason, reference, at: Date.now(), balanceAfter },
    } };
  });
  const operation = asObject((await walletRef.child(`operations/${operationId}`).get()).val());
  await database().ref(`ledger/${uid}/${operationId}`).transaction((current) => current || {
    delta: Number(operation.delta || coinAmount), reason, ref: reference || null,
    balanceAfter: Number(operation.balanceAfter || 0), ts: Number(operation.at || Date.now()),
  });
}

async function grantCase(uid, caseId, quantity, operationId) {
  const ref = database().ref(`case_inventory/${uid}/${caseId}`);
  await ref.transaction((current) => {
    const inventory = Number.isSafeInteger(current) ? { count: current } : asObject(current);
    const deliveries = asObject(inventory.deliveries);
    if (deliveries[operationId]) return inventory;
    return { ...inventory, count: Number(inventory.count || 0) + quantity, updatedAt: Date.now(),
      deliveries: { ...deliveries, [operationId]: { quantity, at: Date.now() } } };
  });
}

async function grantOwned(uid, item, quantity, orderId) {
  const ref = database().ref(`owned/${uid}/${item.id}`);
  await ref.transaction((current) => {
    const owned = asObject(current);
    const deliveries = asObject(owned.deliveries);
    if (deliveries[orderId]) return owned;
    const days = item.type === "premium" ? Math.max(0, Number(item.metadata?.days || 0)) : 0;
    const next = { ...owned, itemId: item.id, source: owned.source || `order:${orderId}`,
      acquiredAt: owned.acquiredAt || Date.now(), deliveries: { ...deliveries, [orderId]: { quantity, at: Date.now() } } };
    if (days) next.expiresAt = Math.max(Date.now(), Number(owned.expiresAt || 0)) + days * 24 * 60 * 60 * 1000;
    return next;
  });
}

async function deliverPurchasedItem(uid, itemId, orderId, quantity = 1, visited = new Set()) {
  if (visited.has(itemId)) throw new Error(`Cyclic bundle reference: ${itemId}`);
  visited.add(itemId);
  const item = (await database().ref(`shop_items/${itemId}`).get()).val();
  if (!item) throw new Error(`Purchased catalog item is missing: ${itemId}`);

  if (item.type === "coins") {
    const amount = Number(item.metadata?.coinAmount);
    await creditCoins(uid, `order_${orderId}_${itemId}`, amount, "money_purchase", orderId);
    return;
  }
  if (item.type === "case") {
    await grantCase(uid, itemId, quantity, `order_${orderId}_${itemId}`);
    return;
  }

  const bundleGrants = Array.isArray(item.metadata?.grants) ? item.metadata.grants :
    Array.isArray(item.metadata?.includes) ? item.metadata.includes.map((includedItemId) => ({ itemId: includedItemId, quantity: 1 })) : null;
  if (item.type === "bundle" && bundleGrants) {
    for (const grant of bundleGrants) {
      const grantId = String(grant.itemId || "");
      if (!grantId) throw new Error(`Bundle ${itemId} contains an invalid grant.`);
      await deliverPurchasedItem(uid, grantId, orderId, Math.max(1, Number(grant.quantity || 1)), new Set(visited));
    }
    return;
  }
  await grantOwned(uid, item, quantity, `order_${orderId}_${itemId}`);
}

async function deliverCompletedOrder(order, orderId) {
  if (!order?.uid || !order?.itemId) throw new Error("Completed order lacks its player or item id.");
  await deliverPurchasedItem(order.uid, order.itemId, orderId, 1);
}

module.exports = { deliverCompletedOrder };
