export function normalizeShopItems(records) {
  return Object.entries(records || {}).map(([id, item]) => ({ id, ...item }));
}

export function isTagItem(item) {
  return String(item?.type || "").toLowerCase() === "tag";
}