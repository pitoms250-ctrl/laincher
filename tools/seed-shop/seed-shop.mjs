import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const seedPaths = {
  items: path.join(repoRoot, "shop_items.seed.json"),
  drops: path.join(repoRoot, "case_drops.seed.json"),
  config: path.join(repoRoot, "shop_config.seed.json"),
};
const databaseUrl = process.env.FIREBASE_DATABASE_URL ||
  "https://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app";
const flags = new Set(process.argv.slice(2));

export function validateShopSeeds(items, drops, config) {
  const errors = [];
  const itemEntries = Object.entries(items || {});
  const validRarities = new Set(["common", "rare", "epic", "legendary"]);

  if (!Number.isFinite(config?.minPriceUah) || config.minPriceUah < 50)
    errors.push("shop_config.minPriceUah должен быть не меньше 50.");
  if (!Number.isFinite(config?.usdtPerUah) || config.usdtPerUah <= 0)
    errors.push("shop_config.usdtPerUah должен быть положительным числом.");
  if (!Number.isFinite(config?.coinsPerUah) || config.coinsPerUah <= 0)
    errors.push("shop_config.coinsPerUah должен быть положительным числом.");
  if (itemEntries.length !== 69)
    errors.push(`Ожидалось 69 товаров, найдено ${itemEntries.length}.`);
  if (Object.keys(drops || {}).length !== 8)
    errors.push(`Ожидалось 8 таблиц дропа, найдено ${Object.keys(drops || {}).length}.`);

  for (const [itemId, item] of itemEntries) {
    const prefix = `shop_items/${itemId}`;
    if (!/^[a-z0-9_]+$/.test(itemId)) errors.push(`${prefix}: ключ должен соответствовать [a-z0-9_]+.`);
    if (typeof item.enabled !== "boolean") errors.push(`${prefix}: enabled должен быть boolean.`);
    if (typeof item.type !== "string" || !item.type.trim()) errors.push(`${prefix}: type обязателен.`);
    if (typeof item.name !== "string" || !item.name.trim()) errors.push(`${prefix}: name обязателен.`);
    if (!Number.isFinite(item.priceUah) || item.priceUah < config.minPriceUah)
      errors.push(`${prefix}: priceUah должен быть не меньше ${config.minPriceUah}.`);
    if (!Number.isFinite(item.priceUsdt) || item.priceUsdt !== item.priceUah * config.usdtPerUah)
      errors.push(`${prefix}: priceUsdt должен быть равен priceUah * usdtPerUah.`);
    if (!validRarities.has(item.rarity)) errors.push(`${prefix}: неизвестная rarity «${item.rarity}».`);
    if (typeof item.category !== "string" || !item.category) errors.push(`${prefix}: category обязателен.`);
    if (item.assets?.icon && typeof item.assets.icon !== "string") errors.push(`${prefix}: assets.icon должен быть строкой.`);
    if (item.type === "coins") {
      if (item.priceCoins !== undefined) errors.push(`${prefix}: пакеты FL Coins нельзя покупать за FL Coins.`);
      if (!Number.isInteger(item.metadata?.coinAmount) || item.metadata.coinAmount <= 0)
        errors.push(`${prefix}: metadata.coinAmount должен быть положительным целым числом.`);
    } else if (item.priceCoins !== item.priceUah * config.coinsPerUah) {
      errors.push(`${prefix}: priceCoins должен быть равен priceUah * coinsPerUah.`);
    }

    const references = [
      ...(Array.isArray(item.metadata?.includes) ? item.metadata.includes : []),
      ...(Array.isArray(item.metadata?.grants) ? item.metadata.grants.map((grant) => grant?.itemId) : []),
    ].filter(Boolean);
    for (const reference of references) {
      if (!Object.hasOwn(items, reference)) errors.push(`${prefix}: отсутствует связанный itemId «${reference}».`);
    }
  }

  for (const [caseId, entries] of Object.entries(drops || {})) {
    const prefix = `case_drops/${caseId}`;
    if (items[caseId]?.type !== "case") errors.push(`${prefix}: item должен существовать и иметь type=case.`);
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push(`${prefix}: таблица должна быть непустым массивом.`);
      continue;
    }
    let totalWeight = 0;
    for (const [index, entry] of entries.entries()) {
      if (!Number.isInteger(entry.weight) || entry.weight <= 0)
        errors.push(`${prefix}[${index}]: weight должен быть положительным целым числом.`);
      else totalWeight += entry.weight;
      if (entry.kind === "item") {
        const item = items[entry.itemId];
        if (!item) errors.push(`${prefix}[${index}]: отсутствует itemId «${entry.itemId}».`);
        else if (["case", "bundle", "gift", "coins"].includes(item.type))
          errors.push(`${prefix}[${index}]: type=${item.type} нельзя включать в дроп.`);
        if (items[caseId]?.metadata?.only && item?.type !== items[caseId].metadata.only)
          errors.push(`${prefix}[${index}]: предмет не соответствует фильтру only=${items[caseId].metadata.only}.`);
      } else if (entry.kind === "coins") {
        if (!Number.isInteger(entry.amount) || entry.amount <= 0)
          errors.push(`${prefix}[${index}]: amount монет должен быть положительным целым числом.`);
      } else errors.push(`${prefix}[${index}]: kind должен быть item или coins.`);
    }
    if (totalWeight !== 10000) errors.push(`${prefix}: сумма weight должна быть 10000, получено ${totalWeight}.`);
  }
  return errors;
}

function comparable(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function seedMatches(existing, seed) {
  if (!existing) return false;
  for (const [key, value] of Object.entries(seed)) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

async function loadSeeds() {
  const [items, drops, config] = await Promise.all(Object.values(seedPaths).map(async (file) =>
    JSON.parse(await readFile(file, "utf8"))));
  return { items, drops, config };
}

async function run() {
  const { items, drops, config } = await loadSeeds();
  const errors = validateShopSeeds(items, drops, config);
  if (errors.length) {
    console.error("Ошибки каталога:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Проверка успешна: ${Object.keys(items).length} товаров, ${Object.keys(drops).length} таблиц дропа.`);
  if (flags.has("--validate-only")) return;

  const hasServiceCredential = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!hasServiceCredential && flags.has("--dry-run")) {
    console.log("--dry-run: локальная проверка успешна; удалённая база не сравнивалась (нет service-account), записи не выполнялись.");
    return;
  }
  if (!hasServiceCredential)
    throw new Error("Для записи задайте GOOGLE_APPLICATION_CREDENTIALS путём к service-account вне репозитория.");

  const requireFromFunctions = createRequire(path.join(repoRoot, "functions", "package.json"));
  let adminApp;
  let adminDatabase;
  try {
    adminApp = requireFromFunctions("firebase-admin/app");
    adminDatabase = requireFromFunctions("firebase-admin/database");
  } catch {
    throw new Error("Для записи установите зависимости: cd functions; npm install.");
  }

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = adminApp.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else credential = adminApp.applicationDefault();

  const app = adminApp.getApps()[0] || adminApp.initializeApp({ credential, databaseURL });
  const db = adminDatabase.getDatabase(app);
  const serverTimestamp = adminDatabase.ServerValue.TIMESTAMP;
  const [currentItems, currentDrops, currentConfig] = await Promise.all([
    db.ref("shop_items").get(), db.ref("case_drops").get(), db.ref("shop_config").get(),
  ]);
  const oldItems = currentItems.val() || {};
  const oldDrops = currentDrops.val() || {};
  const oldConfig = currentConfig.val() || {};
  const itemUpdates = {};
  const counts = { created: 0, updated: 0, unchanged: 0 };

  for (const [itemId, seed] of Object.entries(items)) {
    const old = oldItems[itemId];
    if (seedMatches(old, seed)) {
      counts.unchanged++;
      continue;
    }
    counts[old ? "updated" : "created"]++;
    itemUpdates[itemId] = {
      ...seed,
      createdAt: old?.createdAt || serverTimestamp,
      updatedAt: serverTimestamp,
      salesCount: old?.salesCount || 0,
      priceHistory: old?.priceHistory || {},
    };
  }

  const extraItemIds = Object.keys(oldItems).filter((itemId) => !Object.hasOwn(items, itemId));
  console.log(`Товары: ${counts.created} создано, ${counts.updated} обновлено, ${counts.unchanged} без изменений.`);
  console.log(`Кейсы: ${Object.keys(drops).length}; конфиг: ${JSON.stringify(config)}.`);
  console.log(`itemId: ${Object.keys(items).join(", ")}`);
  if (flags.has("--dry-run")) {
    if (flags.has("--prune")) console.log(`--prune удалил бы ${extraItemIds.length} отсутствующих в seed товаров.`);
    console.log("--dry-run: изменений в RTDB не записано.");
    return;
  }

  const updates = {};
  for (const [itemId, value] of Object.entries(itemUpdates)) updates[`shop_items/${itemId}`] = value;
  if (flags.has("--prune")) for (const itemId of extraItemIds) updates[`shop_items/${itemId}`] = null;
  if (Object.keys(updates).length) await db.ref().update(updates);
  await db.ref("case_drops").set({ ...drops, updatedAt: serverTimestamp });
  await db.ref("shop_config").set({ ...config, updatedAt: serverTimestamp, createdAt: oldConfig.createdAt || serverTimestamp });
  console.log("Seed записан по узлам shop_items, case_drops и shop_config. Существующие orders не затронуты.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
