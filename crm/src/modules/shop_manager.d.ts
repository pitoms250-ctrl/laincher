export function normalizeShopItems<T extends object>(records: Record<string, T> | null | undefined): Array<T & { id: string }>;
export function isTagItem(item: { type?: string }): boolean;