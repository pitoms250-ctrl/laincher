import { Activity, Check, X } from "lucide-react";
import { summarizeSales } from "./modules/analytics_sales.js";
import { priceSeries } from "./modules/price_chart.js";
import type { ShopItem } from "./ShopManager";

export type ShopOrder = {
  id: string;
  uid: string;
  email?: string | null;
  nickname?: string | null;
  itemName: string;
  itemId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  status: string;
  createdAt: number;
  receiptCode?: string;
  receiptHash?: string;
  receiptReceivedAt?: number;
  completedAt?: number;
  cryptoInvoiceId?: string;
  telegramUserId?: string;
};

type SalesDashboardProps = {
  orders: ShopOrder[];
  items: ShopItem[];
  onReview: (orderId: string, action: "complete" | "reject" | "revoke") => Promise<void>;
};

const money = (value: number, currency: string) => `${Number(value || 0).toFixed(2)} ${currency === "UAH" ? "₴" : currency}`;
const dateLabel = (value?: number) => value ? new Date(value).toLocaleString("ru-RU") : "—";

function PriceChart({ items }: { items: ShopItem[] }) {
  const points = priceSeries(items);
  if (points.length < 2) return <div className="price-empty">Історія цін з’явиться після перших продажів.</div>;
  const values = points.map((point) => point.price);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const coordinates = points.map((point, index) => `${(index / (points.length - 1)) * 100},${94 - ((point.price - min) / span) * 82}`).join(" ");
  return <div className="price-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Історія зміни цін тегів"><polyline points={coordinates} fill="none" stroke="#236b49" strokeWidth="1.7" vectorEffect="non-scaling-stroke" /></svg><div className="price-chart-labels"><span>{money(min, points.at(0)?.currency || "UAH")}</span><span>{money(Math.max(...values), points.at(-1)?.currency || "UAH")}</span></div></div>;
}

export function SalesDashboard({ orders, items, onReview }: SalesDashboardProps) {
  const summary = summarizeSales(Object.fromEntries(orders.map((order) => [order.id, order])));
  const reviewable = orders.filter((order) => ["pending", "under_review"].includes(order.status));
  const recent = [...orders].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  return (
    <div className="sales-dashboard">
      <div className="sales-metrics">
        <section><small>Підтверджені продажі</small><strong>{summary.count}</strong></section>
        <section><small>Дохід за добу</small><strong>{money(summary.day.UAH || 0, "UAH")}</strong><span>{money(summary.day.USDT || 0, "USDT")}</span></section>
        <section><small>Дохід за 7 днів</small><strong>{money(summary.week.UAH || 0, "UAH")}</strong><span>{money(summary.week.USDT || 0, "USDT")}</span></section>
        <section><small>На перевірці</small><strong>{reviewable.length}</strong></section>
      </div>
      <div className="sales-columns">
        <section className="sales-panel"><header><h2><Activity size={16} /> Продажі за товарами</h2></header>
          {summary.topItems.length ? summary.topItems.map((item) => <div className="top-item" key={item.name}><span>{item.name}</span><strong>{item.count}</strong></div>) : <p className="price-empty">Поки що немає продажів.</p>}
        </section>
        <section className="sales-panel"><header><h2>Історія цін тегів</h2></header><PriceChart items={items} /></section>
      </div>
      <section className="sales-panel orders-panel"><header><h2>Замовлення</h2><small>{orders.length} останніх записів</small></header>
        <div className="shop-table-wrap"><table className="shop-table"><thead><tr><th>Замовлення</th><th>Користувач</th><th>Квитанція / час</th><th>Сума</th><th>Статус</th><th>Дії</th></tr></thead>
          <tbody>{recent.map((order) => <tr key={order.id}>
            <td><strong>{order.itemName}</strong><small>{order.id} · создано {dateLabel(order.createdAt)}</small></td>
            <td><strong>{order.nickname || order.uid}</strong><small>{order.email || "Email не вказаний"} · UID {order.uid}{order.telegramUserId ? ` · Telegram ${order.telegramUserId}` : ""}</small></td>
            <td><strong>{order.receiptCode || order.cryptoInvoiceId || "—"}</strong><small>{order.receiptReceivedAt ? `Получена ${dateLabel(order.receiptReceivedAt)}` : order.completedAt ? `Подтверждена ${dateLabel(order.completedAt)}` : "Ожидает оплату"}{order.receiptHash ? ` · ${order.receiptHash.slice(0, 12)}` : ""}</small></td>
            <td>{money(order.amount, order.currency)}<small>{order.paymentMethod === "crypto" ? "Crypto Pay" : "Переказ UAH"}</small></td>
            <td><span className={`shop-status ${order.status === "completed" ? "enabled" : ""}`}>{order.status}</span></td>
            <td className="shop-actions">{["pending", "under_review"].includes(order.status) && <>
              <button className="icon-button" title="Підтвердити після перевірки платежу" onClick={() => void onReview(order.id, "complete")}><Check size={15} /></button>
              <button className="icon-button" title="Відхилити" onClick={() => void onReview(order.id, "reject")}><X size={15} /></button>
            </>}{order.status === "completed" && <button className="icon-button" title="Відкликати покупку" onClick={() => void onReview(order.id, "revoke")}><X size={15} /></button>}</td>
          </tr>)}
          {!recent.length && <tr><td colSpan={6} className="shop-empty">Замовлень ще немає.</td></tr>}</tbody>
        </table></div>
      </section>
    </div>
  );
}