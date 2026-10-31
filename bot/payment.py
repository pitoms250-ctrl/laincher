import hashlib
import time
from typing import Any
from uuid import uuid4

from firebase_admin import db


def _database():
    return db.reference()


def bind_telegram(order_id: str, telegram_user_id: int, chat_id: int) -> dict[str, Any] | None:
    reference = db.reference(f"orders/{order_id}")

    def update(order: dict[str, Any] | None) -> dict[str, Any] | None:
        if not order or order.get("status") not in {"pending", "under_review"}:
            return order
        bound_user = order.get("telegramUserId")
        if bound_user and str(bound_user) != str(telegram_user_id):
            return order
        return {
            **order,
            "telegramUserId": str(telegram_user_id),
            "telegramChatId": str(chat_id),
            "updatedAt": int(time.time() * 1000),
        }

    result = reference.transaction(update)
    if not result or result.get("status") not in {"pending", "under_review"}:
        return None
    if str(result.get("telegramUserId")) != str(telegram_user_id):
        return None
    return result


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _credit_coins(uid: str, operation_id: str, amount: int, reason: str, reference: str) -> None:
    if not isinstance(amount, int) or amount <= 0:
        raise ValueError("Invalid FL Coin reward amount.")
    wallet_ref = db.reference(f"wallets/{uid}")

    def update_wallet(current: dict[str, Any] | None) -> dict[str, Any]:
        wallet = _as_dict(current)
        operations = _as_dict(wallet.get("operations"))
        if operation_id in operations:
            return wallet
        balance_after = int(wallet.get("coins", 0)) + amount
        return {**wallet, "coins": balance_after, "updatedAt": int(time.time() * 1000),
                "operations": {**operations, operation_id: {"status": "completed", "delta": amount,
                    "reason": reason, "reference": reference, "at": int(time.time() * 1000), "balanceAfter": balance_after}}}

    result = wallet_ref.transaction(update_wallet) or {}
    operation = _as_dict(_as_dict(result.get("operations")).get(operation_id))
    db.reference(f"ledger/{uid}/{operation_id}").transaction(lambda current: current or {
        "delta": int(operation.get("delta", amount)), "reason": reason, "ref": reference,
        "balanceAfter": int(operation.get("balanceAfter", result.get("coins", 0))),
        "ts": int(operation.get("at", time.time() * 1000)),
    })


def _grant_case(uid: str, case_id: str, quantity: int, delivery_id: str) -> None:
    reference = db.reference(f"case_inventory/{uid}/{case_id}")

    def update_case(current: Any) -> dict[str, Any]:
        inventory = {"count": current} if isinstance(current, int) else _as_dict(current)
        deliveries = _as_dict(inventory.get("deliveries"))
        if delivery_id in deliveries:
            return inventory
        return {**inventory, "count": int(inventory.get("count", 0)) + quantity,
                "updatedAt": int(time.time() * 1000),
                "deliveries": {**deliveries, delivery_id: {"quantity": quantity, "at": int(time.time() * 1000)}}}

    reference.transaction(update_case)


def _grant_owned(uid: str, item_id: str, item: dict[str, Any], order_id: str, quantity: int) -> None:
    reference = db.reference(f"owned/{uid}/{item_id}")

    def update_owned(current: dict[str, Any] | None) -> dict[str, Any]:
        owned = _as_dict(current)
        deliveries = _as_dict(owned.get("deliveries"))
        if order_id in deliveries:
            return owned
        days = max(0, int(_as_dict(item.get("metadata")).get("days", 0))) if item.get("type") == "premium" else 0
        updated = {**owned, "itemId": item_id, "source": owned.get("source") or f"order:{order_id}",
                   "acquiredAt": owned.get("acquiredAt") or int(time.time() * 1000),
                   "deliveries": {**deliveries, order_id: {"quantity": quantity, "at": int(time.time() * 1000)}}}
        if days:
            updated["expiresAt"] = max(int(time.time() * 1000), int(owned.get("expiresAt", 0))) + days * 24 * 60 * 60 * 1000
        return updated

    reference.transaction(update_owned)


def _deliver_item(uid: str, item_id: str, order_id: str, quantity: int = 1, visited: set[str] | None = None) -> None:
    visited = set() if visited is None else visited
    if item_id in visited:
        raise ValueError(f"Cyclic bundle reference: {item_id}")
    visited.add(item_id)
    item = db.reference(f"shop_items/{item_id}").get()
    if not isinstance(item, dict):
        raise ValueError(f"Purchased catalog item is missing: {item_id}")
    metadata = _as_dict(item.get("metadata"))
    delivery_id = f"order_{order_id}_{item_id}"
    if item.get("type") == "coins":
        _credit_coins(uid, delivery_id, int(metadata.get("coinAmount", 0)), "money_purchase", item_id)
        return
    if item.get("type") == "case":
        _grant_case(uid, item_id, quantity, delivery_id)
        return
    grants = metadata.get("grants")
    if not isinstance(grants, list) and isinstance(metadata.get("includes"), list):
        grants = [{"itemId": value, "quantity": 1} for value in metadata["includes"]]
    if item.get("type") == "bundle" and isinstance(grants, list):
        for grant in grants:
            grant = _as_dict(grant)
            grant_id = str(grant.get("itemId") or "")
            if not grant_id:
                raise ValueError(f"Bundle {item_id} contains an invalid grant.")
            _deliver_item(uid, grant_id, order_id, max(1, int(grant.get("quantity", 1))), set(visited))
        return
    _grant_owned(uid, item_id, item, delivery_id, quantity)


def _deliver_completed_order(order: dict[str, Any], order_id: str) -> None:
    uid = str(order.get("uid") or "")
    item_id = str(order.get("itemId") or "")
    if not uid or not item_id:
        raise ValueError("Completed order lacks its player or item id.")
    _deliver_item(uid, item_id, order_id)


def complete_order(order_id: str, method: str) -> dict[str, Any] | None:
    reference = db.reference(f"orders/{order_id}")
    original = reference.get()
    if not original:
        return None
    if original.get("tag"):
        tag = db.reference(f"tags/{original['tag']}").get()
        if not tag or tag.get("orderId") != order_id:
            raise RuntimeError("Резервацію тегу втрачено; потрібна ручна перевірка.")

    newly_completed = False

    def update(order: dict[str, Any] | None) -> dict[str, Any] | None:
        nonlocal newly_completed
        if order and order.get("status") in {"pending", "under_review"}:
            newly_completed = True
            now = int(time.time() * 1000)
            return {**order, "status": "completed", "completedAt": now,
                    "updatedAt": now, "confirmedBy": method}
        newly_completed = False
        return order

    order = reference.transaction(update)
    if not order or order.get("status") != "completed":
        return None
    _deliver_completed_order(order, order_id)
    if not newly_completed:
        return order

    completed_at = order.get("completedAt") or int(time.time() * 1000)
    sale = {
        "orderId": order_id,
        "uid": order["uid"],
        "email": order.get("email"),
        "nickname": order.get("nickname"),
        "itemId": order["itemId"],
        "itemName": order["itemName"],
        "itemType": order.get("itemType"),
        "tag": order.get("tag"),
        "amount": order["amount"],
        "currency": order["currency"],
        "paymentMethod": order["paymentMethod"],
        "receiptCode": order.get("receiptCode"),
        "receiptHash": order.get("receiptHash"),
        "receiptReceivedAt": order.get("receiptReceivedAt"),
        "telegramUserId": order.get("telegramUserId"),
        "telegramChatId": order.get("telegramChatId"),
        "completedAt": completed_at,
    }
    audit_key = _database().child("auditLog").push().key
    _database().update({
        f"analytics/sales/{order_id}": sale,
        f"entitlements/{order['uid']}/{order_id}": {
            "orderId": order_id,
            "itemId": order["itemId"],
            "itemName": order["itemName"],
            "tag": order.get("tag"),
            "status": "active",
            "activatedAt": completed_at,
        },
        f"auditLog/{audit_key}": {
            "actorUid": "telegram-payment-bot",
            "action": "shop.order.completed",
            "payload": {
                "orderId": order_id,
                "uid": order["uid"],
                "email": order.get("email"),
                "itemId": order["itemId"],
                "amount": order["amount"],
                "currency": order["currency"],
                "method": method,
            },
            "at": int(time.time() * 1000),
        },
    })

    if order.get("tag"):
        db.reference(f"tags/{order['tag']}").update({
            "status": "active", "activatedAt": completed_at,
        })

    item_reference = db.reference(f"shop_items/{order['itemId']}")

    def update_item(item: dict[str, Any] | None) -> dict[str, Any] | None:
        if not item:
            return item
        sales_count = int(item.get("salesCount", 0)) + 1
        now = int(time.time() * 1000)
        if item.get("dynamicPrice") is not True:
            return {**item, "salesCount": sales_count, "updatedAt": now}
        is_uah = order["currency"] == "UAH"
        price_key = "priceUah" if is_uah else "priceUsdt"
        step_key = "priceStepUah" if is_uah else "priceStepUsdt"
        next_price = round((float(item.get(price_key, 0)) + float(item.get(step_key, 0))) * 100) / 100
        history = dict(item.get("priceHistory") or {})
        history_key = item_reference.child("priceHistory").push().key
        history[history_key] = {
            "price": next_price,
            "currency": order["currency"],
            "at": now,
            "orderId": order_id,
        }
        return {**item, price_key: next_price, "salesCount": sales_count,
                "updatedAt": now, "priceHistory": history}

    item_reference.transaction(update_item)
    return order


def reject_order(order_id: str, actor: str) -> dict[str, Any] | None:
    reference = db.reference(f"orders/{order_id}")
    newly_rejected = False

    def update(order: dict[str, Any] | None) -> dict[str, Any] | None:
        nonlocal newly_rejected
        if order and order.get("status") in {"pending", "under_review"}:
            newly_rejected = True
            now = int(time.time() * 1000)
            return {**order, "status": "rejected", "reviewedBy": actor,
                    "reviewedAt": now, "updatedAt": now}
        newly_rejected = False
        return order

    order = reference.transaction(update)
    if not newly_rejected or not order or order.get("status") != "rejected":
        return None
    if order and order.get("status") == "rejected" and order.get("tag"):
        tag_reference = db.reference(f"tags/{order['tag']}")
        tag_reference.transaction(lambda tag: None if tag and tag.get("orderId") == order_id else tag)
    return order


def claim_receipt(content: bytes, order_id: str) -> dict[str, Any]:
    receipt_hash = hashlib.sha256(content).hexdigest()
    claim_id = uuid4().hex
    reference = db.reference(f"processed_receipts/{receipt_hash}")
    new_receipt = {
        "orderId": order_id,
        "receivedAt": int(time.time() * 1000),
        "claimId": claim_id,
    }

    receipt = reference.transaction(lambda current: current or new_receipt)
    return {"hash": receipt_hash, "reused": receipt.get("claimId") != claim_id, "receipt": receipt}