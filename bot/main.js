"use strict";

require("dotenv").config();
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { HttpsProxyAgent } = require("https-proxy-agent");
const TelegramBot = require("node-telegram-bot-api");
const { cert, initializeApp, applicationDefault, getApps } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { bindTelegram, completeOrder, rejectOrder, claimReceipt } = require("./payment");

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const cryptoToken = process.env.CRYPTO_PAY_API_TOKEN;
const databaseURL = process.env.FIREBASE_DATABASE_URL || "https://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app";
if (!token || !adminChatId) throw new Error("Set TELEGRAM_BOT_TOKEN and ADMIN_CHAT_ID in the environment.");

let credential = applicationDefault();
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
if (!getApps().length) initializeApp({ credential, databaseURL });

const proxy = process.env.HTTPS_PROXY ? { agent: new HttpsProxyAgent(process.env.HTTPS_PROXY) } : {};
const bot = new TelegramBot(token, { polling: true, request: proxy });
const adminIds = new Set((process.env.ADMIN_TELEGRAM_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
const activeOrders = new Map();
const tempDir = path.join(os.tmpdir(), "f-launcher-receipts");

function money(amount, currency) {
  return `${Number(amount).toFixed(2)} ${currency === "UAH" ? "грн" : currency}`;
}

function isAdmin(userId, chatId) {
  return String(chatId) === String(adminChatId) && adminIds.has(String(userId));
}

function orderText(orderId, order) {
  return `Замовлення: ${orderId}\nТовар: ${order.itemName}${order.tag ? ` (${order.tag})` : ""}\nСума: ${money(order.amount, order.currency)}\nКод призначення: ${order.receiptCode}\nUID лаунчера: ${order.uid}\nEmail: ${order.email || "не вказаний"}`;
}

async function readOrder(orderId) {
  const snap = await getDatabase().ref(`orders/${orderId}`).get();
  return snap.exists() ? snap.val() : null;
}

async function createCryptoInvoice(orderId, order) {
  if (!cryptoToken) throw new Error("Crypto Pay is not configured.");
  const response = await fetch("https://pay.crypt.bot/api/createInvoice", {
    method: "POST",
    headers: { "Crypto-Pay-API-Token": cryptoToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      asset: "USDT",
      amount: Number(order.amount).toFixed(2),
      description: `${order.itemName} (${order.receiptCode})`,
      payload: orderId,
      expires_in: 3600,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok || !data.result?.pay_url) throw new Error("Не вдалося створити Crypto Pay інвойс.");
  await getDatabase().ref(`orders/${orderId}`).update({
    cryptoInvoiceId: String(data.result.invoice_id),
    cryptoPayUrl: data.result.pay_url,
    cryptoExpiresAt: data.result.expiration_date || null,
    updatedAt: Date.now(),
  });
  activeOrders.set(orderId, true);
  return data.result.pay_url;
}

function cardDetails() {
  return [
    `Отримувач: ${process.env.CARD_RECIPIENT_NAME || "не налаштовано"}`,
    `IBAN: ${process.env.CARD_IBAN || "не налаштовано"}`,
    `ІПН: ${process.env.CARD_TAX_ID || "не налаштовано"}`,
    `Банк: ${process.env.CARD_BANK_NAME || "не налаштовано"}`,
    `Призначення: ${process.env.CARD_PAYMENT_PURPOSE || "не налаштовано"}`,
  ].join("\n");
}

async function startPayment(chatId, telegramUserId, orderId) {
  const order = await bindTelegram(orderId, telegramUserId, chatId);
  if (!order) {
    await bot.sendMessage(chatId, "Замовлення не знайдено, уже завершене або посилання прив'язане до іншого Telegram-акаунта.");
    return;
  }
  if (order.paymentMethod === "crypto") {
    const payUrl = order.cryptoPayUrl || await createCryptoInvoice(orderId, order);
    await bot.sendMessage(chatId, `${orderText(orderId, order)}\n\nОплатіть інвойс USDT:`, {
      reply_markup: { inline_keyboard: [[{ text: "Оплатити USDT", url: payUrl }]] },
    });
    return;
  }
  await bot.sendMessage(chatId,
    `${orderText(orderId, order)}\n\n${cardDetails()}\n\n` +
    "ВАЖЛИВО: Перекажіть ТОЧНУ суму з урахуванням комісії вашого банку, інакше переказ може бути не ідентифіковано. Обов'язково вкажіть код призначення платежу.\n\n" +
    "Після оплати надішліть саме квитанцію вашого банку у форматі PDF або чіткого фото. Скріншот екрана переказу не приймається.", {
      reply_markup: { inline_keyboard: [[{ text: "Надіслати квитанцію", callback_data: `receipt:${orderId}` }]] },
    });
}

async function recognizeReceipt(filePath) {
  try {
    const { createWorker } = require("tesseract.js");
    const worker = await createWorker("eng+ukr");
    try { return (await worker.recognize(filePath)).data.text || ""; }
    finally { await worker.terminate(); }
  } catch (error) {
    console.warn("Receipt OCR unavailable:", error.message);
    return "";
  }
}

function inspectReceipt(text, order) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const amountValues = [...normalized.matchAll(/(?:\d[\d\s]{0,8}[.,]\d{2})/g)]
    .map((match) => Number(match[0].replace(/[\s,]/g, (char) => char === "," ? "." : "")))
    .filter(Number.isFinite);
  const amountFound = amountValues.some((amount) => Math.abs(amount - Number(order.amount)) <= 0.01);
  const tokenFound = normalized.includes(String(order.receiptCode || "").toLowerCase());
  const statusFound = /успіш|успеш|проведен|зарахован|переказ|перевод|надіслан|отправлен/.test(normalized);
  return { amountFound, tokenFound, statusFound, amountValues: amountValues.slice(0, 8), likelyMatch: amountFound && tokenFound && statusFound };
}

async function handleReceipt(message) {
  const chatId = message.chat.id;
  const orderId = activeOrders.get(String(chatId));
  if (!orderId) return;
  const order = await readOrder(orderId);
  if (!order || order.status !== "pending" || order.paymentMethod !== "card") {
    activeOrders.delete(String(chatId));
    await bot.sendMessage(chatId, "Для цього замовлення квитанцію зараз не очікуємо.");
    return;
  }
  const photo = message.photo?.at(-1);
  const document = message.document;
  const mime = document?.mime_type || "";
  if (!photo && !(document && (mime === "application/pdf" || mime.startsWith("image/")))) {
    await bot.sendMessage(chatId, "Надішліть квитанцію PDF або чітким фото з банківського застосунку.");
    return;
  }
  const fileId = photo?.file_id || document.file_id;
  const file = await bot.getFile(fileId);
  if (Number(file.file_size || 0) > 10 * 1024 * 1024) {
    await bot.sendMessage(chatId, "Файл завеликий. Максимальний розмір: 10 МБ.");
    return;
  }
  await fs.mkdir(tempDir, { recursive: true });
  const localPath = path.join(tempDir, `${Date.now()}-${path.basename(file.file_path || "receipt")}`);
  try {
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!response.ok) throw new Error("Could not download receipt.");
    await pipeline(response.body, require("node:fs").createWriteStream(localPath));
    const bytes = await fs.readFile(localPath);
    const receipt = await claimReceipt(bytes, orderId);
    if (receipt.reused) {
      await bot.sendMessage(chatId, "Цю квитанцію вже надсилали. Повторно використати її неможливо.");
      return;
    }
    const text = mime === "application/pdf" ? "" : await recognizeReceipt(localPath);
    const check = inspectReceipt(text, order);
    await getDatabase().ref(`orders/${orderId}`).update({
      status: "under_review",
      receiptHash: receipt.hash,
      receiptReceivedAt: Date.now(),
      ocrHint: check,
      updatedAt: Date.now(),
    });
    activeOrders.delete(String(chatId));
    const hint = check.likelyMatch
      ? "OCR-підказка: сума, код і статус схожі. Потрібна ручна перевірка надходження."
      : `OCR-підказка: знайдені суми ${check.amountValues.join(", ") || "не розпізнано"}; очікується ${money(order.amount, order.currency)}; код ${check.tokenFound ? "знайдено" : "не знайдено"}; статус ${check.statusFound ? "знайдено" : "не знайдено"}.`;
    await bot.copyMessage(adminChatId, chatId, message.message_id);
    await bot.sendMessage(adminChatId, `${orderText(orderId, order)}\n\n${hint}`, {
      reply_markup: { inline_keyboard: [[
        { text: "Підтвердити", callback_data: `approve:${orderId}` },
        { text: "Відхилити", callback_data: `reject:${orderId}` },
      ]] },
    });
    await bot.sendMessage(chatId, "Квитанцію передано адміністратору. Покупка активується після перевірки фактичного зарахування.");
  } finally {
    await fs.rm(localPath, { force: true }).catch(() => {});
  }
}

bot.onText(/\/start(?:\s+pay_([A-Za-z0-9_-]+))?/, async (message, match) => {
  const orderId = match?.[1];
  if (!orderId) {
    await bot.sendMessage(message.chat.id, "Відкрийте оплату з магазину F Launcher, щоб отримати інструкції до свого замовлення.");
    return;
  }
  try { await startPayment(message.chat.id, message.from.id, orderId); }
  catch (error) {
    console.error("Payment start failed:", error.message);
    await bot.sendMessage(message.chat.id, "Не вдалося відкрити оплату. Перевірте налаштування або зверніться до підтримки.");
  }
});

bot.on("callback_query", async (query) => {
  const [action, orderId] = String(query.data || "").split(":");
  try {
    if (action === "receipt") {
      activeOrders.set(String(query.message.chat.id), orderId);
      await bot.answerCallbackQuery(query.id, { text: "Надішліть PDF або фото банківської квитанції." });
      return;
    }
    if (!isAdmin(query.from.id, query.message.chat.id) || !["approve", "reject"].includes(action)) {
      await bot.answerCallbackQuery(query.id, { text: "Недостатньо прав." });
      return;
    }
    if (action === "approve") {
      const order = await completeOrder(orderId, `telegram:${query.from.id}`);
      if (!order) throw new Error("Замовлення вже оброблено або не знайдено.");
      if (order.telegramChatId) await bot.sendMessage(order.telegramChatId, "✅ Оплату підтверджено. Покупка активована у F Launcher.");
      await bot.sendMessage(adminChatId, `✅ Підтверджено. ${orderText(orderId, order)}`);
      await bot.answerCallbackQuery(query.id, { text: "Замовлення підтверджено." });
    } else {
      const order = await rejectOrder(orderId, `telegram:${query.from.id}`);
      if (!order) throw new Error("Замовлення вже оброблено або не знайдено.");
      if (order.telegramChatId) await bot.sendMessage(order.telegramChatId, "Платіж не підтверджено. Зверніться до підтримки F Launcher.");
      await bot.sendMessage(adminChatId, `❌ Відхилено. ${orderText(orderId, order)}`);
      await bot.answerCallbackQuery(query.id, { text: "Замовлення відхилено." });
    }
  } catch (error) {
    console.error("Admin action failed:", error.message);
    await bot.answerCallbackQuery(query.id, { text: error.message.slice(0, 180), show_alert: true });
  }
});

bot.on("photo", (message) => void handleReceipt(message).catch((error) => console.error("Receipt processing failed:", error.message)));
bot.on("document", (message) => void handleReceipt(message).catch((error) => console.error("Receipt processing failed:", error.message)));

async function checkCryptoPayments() {
  if (!cryptoToken) return;
  const snapshot = await getDatabase().ref("orders").orderByChild("paymentMethod").equalTo("crypto").limitToLast(300).get();
  const orders = snapshot.val() || {};
  const due = Object.entries(orders).filter(([, order]) => order.status === "pending" && order.cryptoInvoiceId);
  for (const [orderId, order] of due) {
    const response = await fetch("https://pay.crypt.bot/api/getInvoices", {
      method: "POST",
      headers: { "Crypto-Pay-API-Token": cryptoToken, "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_ids: order.cryptoInvoiceId }),
    });
    const result = await response.json();
    const invoice = result.result?.items?.[0];
    const paidAmount = Number(invoice?.paid_amount || invoice?.amount);
    if (result.ok && invoice?.status === "paid" && invoice?.payload === orderId && invoice?.asset === "USDT" &&
      Math.abs(paidAmount - Number(order.amount)) <= 0.01) {
      const completed = await completeOrder(orderId, "crypto-pay");
      if (completed?.telegramChatId) await bot.sendMessage(completed.telegramChatId, "✅ Оплату USDT підтверджено. Покупка активована у F Launcher.");
      if (completed) await bot.sendMessage(adminChatId, `✅ Crypto Pay: ${orderText(orderId, completed)}`);
    }
  }
}

setInterval(() => void checkCryptoPayments().catch((error) => console.error("Crypto polling failed:", error.message)), 20000);
bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
console.log("F Launcher payment bot started.");