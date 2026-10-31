export function priceSeries(items) {
  return (items || []).flatMap((item) => Object.values(item.priceHistory || {}).map((point) => ({
    itemName: item.name,
    price: Number(point.price || 0),
    currency: point.currency || "UAH",
    at: Number(point.at || 0),
  }))).sort((left, right) => left.at - right.at).slice(-40);
}