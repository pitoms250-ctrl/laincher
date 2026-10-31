export function priceSeries(items: Array<{ name: string; priceHistory?: Record<string, { price?: number; currency?: string; at?: number }> }>): Array<{
  itemName: string;
  price: number;
  currency: string;
  at: number;
}>;