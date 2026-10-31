export function nextDynamicPrice(item, currency = "UAH") {
  const priceKey = currency === "UAH" ? "priceUah" : "priceUsdt";
  const stepKey = currency === "UAH" ? "priceStepUah" : "priceStepUsdt";
  const price = Number(item?.[priceKey] || 0);
  const step = item?.dynamicPrice ? Number(item?.[stepKey] || 0) : 0;
  return Math.round((price + step) * 100) / 100;
}