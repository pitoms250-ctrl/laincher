export function summarizeSales(orders: Record<string, any> | null | undefined, now?: number): {
  count: number;
  day: Record<string, number>;
  week: Record<string, number>;
  topItems: Array<{ name: string; count: number }>;
};