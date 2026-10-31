"use strict";

function normalizeRequestId(value) {
  const requestId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new Error("requestId должен содержать 8–100 латинских букв, цифр, _ или -.");
  return requestId;
}

function assertCatalogItemAvailable(item, currentTime = Date.now()) {
  if (!item || item.enabled !== true) throw new Error("Товар недоступен.");
  if (Number.isFinite(Number(item.availableFrom)) && Number(item.availableFrom) > currentTime)
    throw new Error("Продажа товара ещё не началась.");
  if (Number.isFinite(Number(item.availableUntil)) && Number(item.availableUntil) > 0 && Number(item.availableUntil) <= currentTime)
    throw new Error("Время продажи товара истекло.");
  if (item.stock !== undefined && item.stock !== null && Number(item.stock) <= 0)
    throw new Error("Товар закончился.");
}

function getCoinPrice(item, config) {
  if (!item || item.type === "coins") throw new Error("FL Coins нельзя покупать за FL Coins.");
  const price = Number(item.priceCoins);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Для товара не настроена цена в FL Coins.");
  if (price !== Number(item.priceUah) * Number(config?.coinsPerUah || 1))
    throw new Error("Цена в FL Coins не совпадает с shop_config.");
  return price;
}

function selectWeightedDrop(entries, roll) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Таблица дропа отсутствует.");
  const total = entries.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
  if (total !== 10000) throw new Error("Сумма шансов в таблице дропа должна быть 10000.");
  if (!Number.isInteger(roll) || roll < 0 || roll >= 10000) throw new Error("roll должен быть целым числом от 0 до 9999.");
  let cursor = 0;
  for (const entry of entries) {
    cursor += entry.weight;
    if (roll < cursor) return entry;
  }
  throw new Error("Не удалось выбрать результат открытия кейса.");
}

function listGrantedItemIds(item) {
  const grants = item?.metadata?.grants;
  if (Array.isArray(grants)) return grants.map((grant) => grant?.itemId).filter(Boolean);
  const includes = item?.metadata?.includes;
  if (Array.isArray(includes)) return includes.filter((value) => typeof value === "string");
  return [];
}

module.exports = { assertCatalogItemAvailable, getCoinPrice, listGrantedItemIds, normalizeRequestId, selectWeightedDrop };
