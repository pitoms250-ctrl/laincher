export function summarizeSales(orders, now = Date.now()) {
  const completed = Object.values(orders || {}).filter((order) => order.status === "completed" || order.status === "revoked");
  const dayStart = now - 24 * 60 * 60 * 1000;
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;
  const totals = (items) => items.reduce((result, order) => {
    result[order.currency] = (result[order.currency] || 0) + Number(order.amount || 0);
    return result;
  }, {});
  const byItem = new Map();
  for (const order of completed) {
    if (order.status === "revoked") continue;
    const item = byItem.get(order.itemId) || { name: order.itemName || order.itemId, count: 0 };
    item.count += 1;
    byItem.set(order.itemId, item);
  }
  return {
    count: completed.filter((order) => order.status === "completed").length,
    day: totals(completed.filter((order) => order.status === "completed" && Number(order.completedAt || order.createdAt) >= dayStart)),
    week: totals(completed.filter((order) => order.status === "completed" && Number(order.completedAt || order.createdAt) >= weekStart)),
    topItems: [...byItem.values()].sort((left, right) => right.count - left.count).slice(0, 5),
  };
}