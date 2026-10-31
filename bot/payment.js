"use strict";

const crypto = require("node:crypto");
const { getDatabase } = require("firebase-admin/database");
const { deliverCompletedOrder } = require("./paymentRewards");

const database = () => getDatabase();

async function bindTelegram(orderId, telegramUserId, chatId) {
  const ref = database().ref(`orders/${orderId}`);
  let bound = false;
  const result = await ref.transaction((order) => {
    if (!order || !["pending", "under_review"].includes(order.status)) return;
    if (order.telegramUserId && String(order.telegramUserId) !== String(telegramUserId)) return;
    bound = true;
    return { ...order, telegramUserId: String(telegramUserId), telegramChatId: String(chatId), updatedAt: Date.now() };
  });
  return bound && result.committed ? result.snapshot.val() : null;
}

async function completeOrder(orderId, method) {
  const ref = database().ref(`orders/${orderId}`);
  const original = (await ref.get()).val();
  if (!original) return null;
  if (original.tag) {
    const tag = (await database().ref(`tags/${original.tag}`).get()).val();
    if (!tag || tag.orderId !== orderId) throw new Error("Резервацію тегу втрачено; потрібна ручна перевірка.");
  }
  let newlyCompleted = false;
  const result = await ref.transaction((order) => {
    if (!order) return;
    if (["pending", "under_review"].includes(order.status)) {
      newlyCompleted = true;
      return { ...order, status: "completed", completedAt: Date.now(), updatedAt: Date.now(), confirmedBy: method };
    }
    return order;
  });
  const order = result.snapshot.val();
  if (!order || order.status !== "completed") return null;

  await deliverCompletedOrder(order, orderId);

  const sale = {
    orderId,
    uid: order.uid,
    email: order.email || null,
    nickname: order.nickname || null,
    itemId: order.itemId,
    itemName: order.itemName,
    itemType: order.itemType,
    tag: order.tag || null,
    amount: order.amount,
    currency: order.currency,
    paymentMethod: order.paymentMethod,
    receiptCode: order.receiptCode || null,
    receiptHash: order.receiptHash || null,
    receiptReceivedAt: order.receiptReceivedAt || null,
    telegramUserId: order.telegramUserId || null,
    telegramChatId: order.telegramChatId || null,
    completedAt: order.completedAt || Date.now(),
  };
  await database().ref().update({
    [`analytics/sales/${orderId}`]: sale,
    [`entitlements/${order.uid}/${orderId}`]: {
      orderId,
      itemId: order.itemId,
      itemName: order.itemName,
      tag: order.tag || null,
      status: "active",
      activatedAt: sale.completedAt,
    },
    [`auditLog/${database().ref("auditLog").push().key}`]: {
      actorUid: "telegram-payment-bot",
      action: "shop.order.completed",
      payload: { orderId, uid: order.uid, email: order.email || null, itemId: order.itemId, amount: order.amount, currency: order.currency, method },
      at: Date.now(),
    },
  });
  if (order.tag) await database().ref(`tags/${order.tag}`).update({ status: "active", activatedAt: sale.completedAt });

  if (newlyCompleted) {
    const itemRef = database().ref(`shop_items/${order.itemId}`);
    await itemRef.transaction((item) => {
      if (!item) return item;
      const salesCount = Number(item.salesCount || 0) + 1;
      if (item.dynamicPrice !== true) return { ...item, salesCount, updatedAt: Date.now() };
      const step = order.currency === "UAH" ? Number(item.priceStepUah || 0) : Number(item.priceStepUsdt || 0);
      const priceKey = order.currency === "UAH" ? "priceUah" : "priceUsdt";
      const nextPrice = Math.round((Number(item[priceKey] || 0) + step) * 100) / 100;
      const historyKey = database().ref(`shop_items/${order.itemId}/priceHistory`).push().key;
      return { ...item, [priceKey]: nextPrice, salesCount, updatedAt: Date.now(),
        priceHistory: { ...(item.priceHistory || {}), [historyKey]: { price: nextPrice, currency: order.currency, at: Date.now(), orderId } } };
    });
  }
  return order;
}

async function rejectOrder(orderId, actor) {
  const ref = database().ref(`orders/${orderId}`);
  const result = await ref.transaction((order) => {
    if (!order || !["pending", "under_review"].includes(order.status)) return;
    return { ...order, status: "rejected", reviewedBy: actor, reviewedAt: Date.now(), updatedAt: Date.now() };
  });
  const order = result.snapshot.val();
  if (order?.status === "rejected" && order.tag) {
    const tagRef = database().ref(`tags/${order.tag}`);
    await tagRef.transaction((tag) => tag?.orderId === orderId ? null : tag);
  }
  return order;
}

async function claimReceipt(buffer, orderId) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const ref = database().ref(`processed_receipts/${hash}`);
  const result = await ref.transaction((current) => current || { orderId, receivedAt: Date.now() });
  return { hash, reused: !result.committed, receipt: result.snapshot.val() };
}

module.exports = { bindTelegram, completeOrder, rejectOrder, claimReceipt };