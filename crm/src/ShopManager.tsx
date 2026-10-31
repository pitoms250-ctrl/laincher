import { useState, type FormEvent } from "react";
import { Check, Eye, EyeOff, Pencil, Plus, Save, Upload, X } from "lucide-react";
import { isTagItem } from "./modules/shop_manager.js";
import { nextDynamicPrice } from "./modules/tags_exchange.js";

export type ShopItem = {
  id: string;
  name: string;
  description?: string;
  type: string;
  priceUah: number;
  priceUsdt: number;
  iconUrl?: string | null;
  assets?: { icon?: string; iconOpen?: string };
  enabled: boolean;
  rarity?: "common" | "rare" | "epic" | "legendary";
  category?: string;
  sortOrder?: number;
  giftable?: boolean;
  limited?: boolean;
  stock?: number | null;
  priceCoins?: number;
  dynamicPrice?: boolean;
  priceStepUah?: number;
  priceStepUsdt?: number;
  salesCount?: number;
  priceHistory?: Record<string, { price: number; currency: string; at: number }>;
  createdAt?: number;
  updatedAt?: number;
  metadata?: { coinAmount?: number; includes?: unknown[]; grants?: Array<{ itemId?: string }>; [key: string]: unknown };
};

export type ShopTag = { tag: string; uid: string; itemId: string; orderId: string; status: string; reservedAt?: number; activatedAt?: number };
export type ShopSeedCatalog = {
  items: Record<string, Omit<ShopItem, "id">>;
  drops: Record<string, Array<{ kind: "item" | "coins"; itemId?: string; amount?: number; weight: number }>>;
  config: { minPriceUah: number; usdtPerUah: number; coinsPerUah: number; [key: string]: unknown };
};

type ShopManagerProps = {
  items: ShopItem[];
  tags: ShopTag[];
  onSave: (item: Omit<ShopItem, "id">, itemId?: string) => Promise<void>;
  onPublishCatalog: (catalog: ShopSeedCatalog) => Promise<void>;
};

const emptyItem: Omit<ShopItem, "id"> = {
  name: "", description: "", type: "tag", priceUah: 0, priceUsdt: 0,
  enabled: true, rarity: "common", category: "tags", sortOrder: 100, giftable: true,
  limited: false, stock: null, dynamicPrice: false, priceStepUah: 0, priceStepUsdt: 0,
};

const categories = ["premium", "tags", "capes", "frames", "nick", "badges", "banners", "themes", "emoji", "cases", "gifts", "bundles", "currency"];

function validateCatalog(catalog: ShopSeedCatalog): string[] {
  const errors: string[] = [];
  if (!catalog || !catalog.items || typeof catalog.items !== "object" || Array.isArray(catalog.items)) return ["Файл товаров должен содержать JSON-объект."];
  if (!catalog.config || typeof catalog.config !== "object" || Array.isArray(catalog.config) ||
    !catalog.drops || typeof catalog.drops !== "object" || Array.isArray(catalog.drops)) return ["Не удалось прочитать config или таблицы дропа."];
  const itemEntries = Object.entries(catalog.items);
  if (!Number.isFinite(catalog.config?.minPriceUah) || catalog.config.minPriceUah < 50) errors.push("Минимальная цена должна быть не ниже 50 UAH.");
  if (!Number.isFinite(catalog.config?.usdtPerUah) || catalog.config.usdtPerUah <= 0) errors.push("Некорректный курс USDT.");
  if (!Number.isFinite(catalog.config?.coinsPerUah) || catalog.config.coinsPerUah <= 0) errors.push("Некорректный курс FL Coins.");
  if (itemEntries.length !== 69) errors.push(`Ожидалось 69 товаров, получено ${itemEntries.length}.`);
  if (Object.keys(catalog.drops || {}).length !== 8) errors.push(`Ожидалось 8 таблиц дропа, получено ${Object.keys(catalog.drops || {}).length}.`);

  for (const [itemId, item] of itemEntries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${itemId}: запись товара должна быть объектом.`);
      continue;
    }
    if (!/^[a-z0-9_]+$/.test(itemId)) errors.push(`${itemId}: некорректный ID.`);
    if (typeof item.enabled !== "boolean" || typeof item.type !== "string" || !item.type.trim() ||
      typeof item.name !== "string" || !item.name.trim()) errors.push(`${itemId}: обязательны enabled, type и name.`);
    if (!Number.isFinite(item.priceUah) || item.priceUah < catalog.config.minPriceUah) errors.push(`${itemId}: цена ниже минимальной.`);
    if (item.priceUsdt !== item.priceUah * catalog.config.usdtPerUah) errors.push(`${itemId}: цена USDT не совпадает с курсом.`);
    if (!item.category?.trim() || !item.rarity) errors.push(`${itemId}: обязательны category и rarity.`);
    if (item.type === "coins") {
      if (item.priceCoins !== undefined || !Number.isInteger(item.metadata?.coinAmount)) errors.push(`${itemId}: неверный пакет FL Coins.`);
    } else if (item.priceCoins !== item.priceUah * catalog.config.coinsPerUah) errors.push(`${itemId}: неверная цена в FL Coins.`);

    const metadata = item.metadata || {};
    const references = [
      ...(Array.isArray(metadata.includes) ? metadata.includes : []),
      ...(Array.isArray(metadata.grants) ? metadata.grants.map((grant) => grant?.itemId) : []),
    ].filter((reference): reference is string => typeof reference === "string");
    for (const reference of references) if (!Object.hasOwn(catalog.items, reference)) errors.push(`${itemId}: отсутствует связанный товар ${reference}.`);
  }

  for (const [caseId, entries] of Object.entries(catalog.drops || {})) {
    if (catalog.items[caseId]?.type !== "case" || !Array.isArray(entries) || entries.length === 0) errors.push(`${caseId}: отсутствует кейс или таблица дропа.`);
    const dropEntries = Array.isArray(entries) ? entries : [];
    for (const entry of dropEntries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${caseId}: запись награды должна быть объектом.`);
        continue;
      }
      if (!Number.isInteger(entry.weight) || entry.weight <= 0) errors.push(`${caseId}: каждый вес должен быть положительным целым числом.`);
    }
    const total = dropEntries.reduce((sum, entry) => sum + (Number.isInteger(entry.weight) ? entry.weight : 0), 0);
    if (total !== 10000) errors.push(`${caseId}: сумма шансов должна быть 10000.`);
    for (const entry of dropEntries) {
      if (entry.kind === "item" && (!entry.itemId || !catalog.items[entry.itemId] || ["case", "bundle", "gift", "coins"].includes(catalog.items[entry.itemId].type))) errors.push(`${caseId}: предмет дропа отсутствует или запрещён.`);
      if (entry.kind === "coins" && (!Number.isInteger(entry.amount) || Number(entry.amount) <= 0)) errors.push(`${caseId}: некорректная награда FL Coins.`);
      if (entry.kind !== "item" && entry.kind !== "coins") errors.push(`${caseId}: неизвестный тип награды.`);
    }
  }
  return errors;
}

export function ShopManager({ items, tags, onSave, onPublishCatalog }: ShopManagerProps) {
  const [form, setForm] = useState(emptyItem);
  const [editingId, setEditingId] = useState<string>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [seedItemsFile, setSeedItemsFile] = useState<File | null>(null);
  const [seedDropsFile, setSeedDropsFile] = useState<File | null>(null);
  const [seedConfigFile, setSeedConfigFile] = useState<File | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedMessage, setSeedMessage] = useState("");

  function edit(item?: ShopItem) {
    setEditingId(item?.id);
    setForm(item ? { ...emptyItem, ...item } : { ...emptyItem });
    setOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      await onSave(form, editingId);
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не вдалося зберегти товар.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(item: ShopItem) {
    const { id, ...payload } = item;
    setSaveError("");
    try {
      await onSave({ ...payload, enabled: !item.enabled }, id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не вдалося змінити статус товару.");
    }
  }

  async function publishCatalog() {
    if (!seedItemsFile || !seedDropsFile || !seedConfigFile) return;
    setSeedBusy(true);
    setSeedMessage("");
    try {
      const [itemsSeed, dropsSeed, configSeed] = await Promise.all(
        [seedItemsFile, seedDropsFile, seedConfigFile].map(async (file) => JSON.parse(await file.text())),
      );
      const catalog = { items: itemsSeed, drops: dropsSeed, config: configSeed } as ShopSeedCatalog;
      const errors = validateCatalog(catalog);
      if (errors.length) throw new Error(errors.slice(0, 8).join("\n"));
      await onPublishCatalog(catalog);
      setSeedMessage(`Опубликовано: ${Object.keys(catalog.items).length} товаров, ${Object.keys(catalog.drops).length} таблиц дропа.`);
    } catch (error) {
      setSeedMessage(error instanceof Error ? error.message : "Не удалось загрузить каталог.");
    } finally {
      setSeedBusy(false);
    }
  }

  return (
    <div className="shop-manager">
      <div className="shop-toolbar">
        <p>{items.length} товарів · {items.filter((item) => item.enabled).length} активних</p>
        <button className="button primary" onClick={() => edit()}><Plus size={15} /> Додати товар</button>
      </div>
      <details className="sales-panel" style={{ marginBottom: 16 }}>
        <summary style={{ cursor: "pointer", padding: 14, fontWeight: 700 }}><Upload size={15} /> Загрузить каталог и экономику из seed JSON</summary>
        <div className="shop-form-grid" style={{ padding: 14 }}>
          <label>shop_items.seed.json<input type="file" accept="application/json,.json" onChange={(event) => setSeedItemsFile(event.target.files?.[0] || null)} /></label>
          <label>case_drops.seed.json<input type="file" accept="application/json,.json" onChange={(event) => setSeedDropsFile(event.target.files?.[0] || null)} /></label>
          <label>shop_config.seed.json<input type="file" accept="application/json,.json" onChange={(event) => setSeedConfigFile(event.target.files?.[0] || null)} /></label>
          <button className="button primary" disabled={seedBusy || !seedItemsFile || !seedDropsFile || !seedConfigFile} onClick={() => void publishCatalog()}>
            <Upload size={14} /> {seedBusy ? "Публикация…" : "Опубликовать в RTDB"}
          </button>
          {seedMessage && <p className={seedMessage.startsWith("Опубликовано:") ? "shop-editing" : "shop-form-error"} style={{ whiteSpace: "pre-line" }}>{seedMessage}</p>}
        </div>
      </details>
      {saveError && !open && <p className="shop-form-error">{saveError}</p>}
      <div className="shop-table-wrap">
        <table className="shop-table">
          <thead><tr><th>Товар</th><th>Тип</th><th>Ціна</th><th>Продажі</th><th>Статус</th><th aria-label="Дії" /></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.name}</strong><small>{item.description || item.id}</small></td>
                <td>{item.type}{isTagItem(item) && item.dynamicPrice ? " · динамічна" : ""}</td>
                <td>{Number(item.priceUah).toFixed(2)} ₴<small>{Number(item.priceUsdt).toFixed(2)} USDT</small>
                  {isTagItem(item) && item.dynamicPrice && <small>Наступна: {nextDynamicPrice(item, "UAH").toFixed(2)} ₴</small>}
                </td>
                <td>{item.salesCount || 0}</td>
                <td><span className={item.enabled ? "shop-status enabled" : "shop-status"}>{item.enabled ? "Активний" : "Прихований"}</span></td>
                <td className="shop-actions">
                  <button className="icon-button" title="Редагувати товар" onClick={() => edit(item)}><Pencil size={15} /></button>
                  <button className="icon-button" title={item.enabled ? "Приховати товар" : "Показати товар"} onClick={() => void toggle(item)}>
                    {item.enabled ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={6} className="shop-empty">Каталог порожній.</td></tr>}
          </tbody>
        </table>
      </div>
      <section className="sales-panel exchange-panel">
        <header><h2>Міні-біржа тегів</h2><small>{tags.length} зарезервованих або активних</small></header>
        <div className="shop-table-wrap"><table className="shop-table"><thead><tr><th>Тег</th><th>Гравець UID</th><th>Замовлення</th><th>Стан</th><th>Створено</th></tr></thead>
          <tbody>{tags.map((tag) => <tr key={tag.tag}><td><strong>{tag.tag}</strong></td><td>{tag.uid}</td><td>{tag.orderId}</td><td><span className={`shop-status ${tag.status === "active" ? "enabled" : ""}`}>{tag.status}</span></td><td>{new Date(tag.activatedAt || tag.reservedAt || 0).toLocaleString()}</td></tr>)}
            {!tags.length && <tr><td colSpan={5} className="shop-empty">Тегів ще немає.</td></tr>}</tbody>
        </table></div>
      </section>
      {open && (
        <div className="shop-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <form className="shop-modal" onSubmit={(event) => void submit(event)}>
            <header><h2>{editingId ? "Редагувати товар" : "Новий товар"}</h2><button className="icon-button" type="button" title="Закрити" onClick={() => setOpen(false)}><X size={17} /></button></header>
            <label>Назва<input required maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label>Опис<textarea maxLength={400} rows={2} value={form.description || ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
            <div className="shop-form-grid">
              <label>Тип<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                <option value="coins">FL Coins</option><option value="premium">FL Premium</option><option value="tag">Тег</option>
                <option value="cape">Плащ</option><option value="frame">Рамка</option><option value="nick_color">Цвет ника</option>
                <option value="nick_effect">Эффект ника</option><option value="badge">Значок</option><option value="banner">Баннер</option>
                <option value="theme">Тема</option><option value="emoji_pack">Набор эмодзи</option><option value="case">Кейс</option>
                <option value="gift">Подарок</option><option value="bundle">Набор</option>
              </select></label>
              <label>Категория<select value={form.category || "other"} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                {categories.map((category) => <option value={category} key={category}>{category}</option>)}
              </select></label>
              <label>Редкость<select value={form.rarity || "common"} onChange={(event) => setForm({ ...form, rarity: event.target.value as ShopItem["rarity"] })}>
                <option value="common">Обычная</option>
                <option value="rare">Редкая</option>
                <option value="epic">Эпическая</option>
                <option value="legendary">Легендарная</option>
              </select></label>
              <label>Порядок<input type="number" min="0" step="1" value={form.sortOrder || 0} onChange={(event) => setForm({ ...form, sortOrder: Number(event.target.value) })} /></label>
              <label>Иконка / путь<input maxLength={500} value={form.assets?.icon || form.iconUrl || ""} onChange={(event) => setForm({ ...form, assets: { ...form.assets, icon: event.target.value } })} /></label>
              <label>Цена, UAH<input type="number" min="50" step="0.01" required value={form.priceUah} onChange={(event) => setForm({ ...form, priceUah: Number(event.target.value) })} /></label>
              <label>Цена, USDT<input type="number" min="50" step="0.01" required value={form.priceUsdt} onChange={(event) => setForm({ ...form, priceUsdt: Number(event.target.value) })} /></label>
              {form.type !== "coins" && <label>Цена, FL Coins<input type="number" min="50" step="1" value={form.priceCoins ?? form.priceUah} onChange={(event) => setForm({ ...form, priceCoins: Number(event.target.value) })} /></label>}
              {form.limited && <label>Остаток<input type="number" min="0" step="1" value={form.stock ?? ""} onChange={(event) => setForm({ ...form, stock: event.target.value === "" ? null : Number(event.target.value) })} /></label>}
            </div>
            {form.type === "tag" && <>
              <label className="shop-checkbox"><input type="checkbox" checked={Boolean(form.dynamicPrice)} onChange={(event) => setForm({ ...form, dynamicPrice: event.target.checked })} /> Автоматично підвищувати ціну після продажу</label>
              {form.dynamicPrice && <div className="shop-form-grid">
                <label>Крок, UAH<input type="number" min="0" step="0.01" value={form.priceStepUah || 0} onChange={(event) => setForm({ ...form, priceStepUah: Number(event.target.value) })} /></label>
                <label>Крок, USDT<input type="number" min="0" step="0.01" value={form.priceStepUsdt || 0} onChange={(event) => setForm({ ...form, priceStepUsdt: Number(event.target.value) })} /></label>
              </div>}
            </>}
            <label className="shop-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> Доступний у лаунчері</label>
            <label className="shop-checkbox"><input type="checkbox" checked={Boolean(form.limited)} onChange={(event) => setForm({ ...form, limited: event.target.checked })} /> Лимитированный товар</label>
            <label className="shop-checkbox"><input type="checkbox" checked={form.giftable !== false} onChange={(event) => setForm({ ...form, giftable: event.target.checked })} /> Можно подарить</label>
            {saveError && <p className="shop-form-error">{saveError}</p>}
            <footer><button type="button" className="button secondary" onClick={() => setOpen(false)}>Скасувати</button><button className="button primary" disabled={saving}><Save size={14} /> {saving ? "Збереження" : "Зберегти"}</button></footer>
            {editingId && <span className="shop-editing"><Check size={12} /> Зміни одразу синхронізуються через Firebase</span>}
          </form>
        </div>
      )}
    </div>
  );
}
