import asyncio
import json
import logging
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytesseract
from dotenv import load_dotenv
from firebase_admin import credentials, db, get_app, initialize_app
from PIL import Image
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (Application, CallbackQueryHandler, CommandHandler,
                          ContextTypes, MessageHandler, filters)

from payment import bind_telegram, claim_receipt, complete_order, reject_order

try:
    import pypdfium2 as pdfium
except ImportError:
    pdfium = None


load_dotenv(Path(__file__).with_name(".env"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("f-launcher-payment-bot")

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "")
CRYPTO_TOKEN = os.environ.get("CRYPTO_PAY_API_TOKEN", "")
DATABASE_URL = os.environ.get(
    "FIREBASE_DATABASE_URL",
    "https://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app",
)
ADMIN_IDS = {value.strip() for value in os.environ.get("ADMIN_TELEGRAM_IDS", "").split(",") if value.strip()}
MAX_RECEIPT_BYTES = 10 * 1024 * 1024
TEMP_DIR = Path(__file__).resolve().parent / "temp"
AUTO_APPROVE_RECEIPTS = os.environ.get("AUTO_APPROVE_RECEIPTS", "false").strip().lower() in {"1", "true", "yes"}
try:
    RECEIPT_AMOUNT_TOLERANCE = max(0.0, float(os.environ.get("RECEIPT_AMOUNT_TOLERANCE_PERCENT", "0.02")))
except ValueError:
    RECEIPT_AMOUNT_TOLERANCE = 0.02
    logger.warning("Invalid RECEIPT_AMOUNT_TOLERANCE_PERCENT; using 2%%.")
OCR_LANGUAGE = os.environ.get("RECEIPT_OCR_LANGUAGE", "eng+ukr")
try:
    RECEIPT_REVIEW_TIMEOUT_MINUTES = max(1, int(os.environ.get("RECEIPT_REVIEW_TIMEOUT_MINUTES", "15")))
except ValueError:
    RECEIPT_REVIEW_TIMEOUT_MINUTES = 15
    logger.warning("Invalid RECEIPT_REVIEW_TIMEOUT_MINUTES; using 15 minutes.")


def initialize_firebase() -> None:
    try:
        get_app()
        return
    except ValueError:
        pass

    service_account_file = os.environ.get("FIREBASE_SERVICE_ACCOUNT_FILE", "").strip()
    if service_account_file:
        credential_path = Path(service_account_file).expanduser()
        if not credential_path.is_file():
            raise RuntimeError(
                "FIREBASE_SERVICE_ACCOUNT_FILE points to a file that does not exist. "
                "Upload the Firebase service-account JSON privately and set its absolute path."
            )
        credential = credentials.Certificate(str(credential_path))
        initialize_app(credential, {"databaseURL": DATABASE_URL})
        return

    service_account_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if service_account_json:
        try:
            service_account_data = json.loads(service_account_json)
        except json.JSONDecodeError as error:
            credential_path = Path(service_account_json).expanduser()
            if credential_path.is_file():
                credential = credentials.Certificate(str(credential_path))
                initialize_app(credential, {"databaseURL": DATABASE_URL})
                return
            raise RuntimeError(
                "FIREBASE_SERVICE_ACCOUNT_JSON must contain the complete service-account JSON. "
                "If you uploaded a key file, set FIREBASE_SERVICE_ACCOUNT_FILE to its absolute path "
                "or put that path in FIREBASE_SERVICE_ACCOUNT_JSON."
            ) from error
        if not isinstance(service_account_data, dict) or service_account_data.get("type") != "service_account":
            raise RuntimeError(
                "FIREBASE_SERVICE_ACCOUNT_JSON is not a Firebase service-account object. "
                "Use the JSON key downloaded for a Firebase service account."
            )
        credential = credentials.Certificate(service_account_data)
    else:
        credential = credentials.ApplicationDefault()
    initialize_app(credential, {"databaseURL": DATABASE_URL})


def money(amount: Any, currency: str) -> str:
    return f"{float(amount):.2f} {'грн' if currency == 'UAH' else currency}"


def order_text(order_id: str, order: dict[str, Any]) -> str:
    tag = f" ({order['tag']})" if order.get("tag") else ""
    return (
        f"Замовлення: {order_id}\nТовар: {order.get('itemName', '')}{tag}\n"
        f"Сума: {money(order.get('amount', 0), order.get('currency', ''))}\n"
        f"Код призначення: {order.get('receiptCode', '')}\nUID лаунчера: {order.get('uid', '')}\n"
        f"Email: {order.get('email') or 'не вказаний'}"
    )


def read_order(order_id: str) -> dict[str, Any] | None:
    return db.reference(f"orders/{order_id}").get()


def card_details() -> str:
    labels = (
        ("Отримувач", "CARD_RECIPIENT_NAME"),
        ("IBAN", "CARD_IBAN"),
        ("ІПН", "CARD_TAX_ID"),
        ("Банк", "CARD_BANK_NAME"),
        ("Призначення", "CARD_PAYMENT_PURPOSE"),
    )
    return "\n".join(f"{label}: {os.environ.get(key) or 'не налаштовано'}" for label, key in labels)


async def is_admin(context: ContextTypes.DEFAULT_TYPE, user_id: int, chat_id: int) -> bool:
    if str(chat_id) != str(ADMIN_CHAT_ID):
        return False
    if ADMIN_IDS:
        return str(user_id) in ADMIN_IDS
    try:
        member = await context.bot.get_chat_member(chat_id, user_id)
        return str(member.status) in {"administrator", "creator"}
    except Exception:
        logger.warning("Could not verify Telegram admin membership for user %s", user_id, exc_info=True)
        return False


async def create_crypto_invoice(order_id: str, order: dict[str, Any], context: ContextTypes.DEFAULT_TYPE) -> str:
    if not CRYPTO_TOKEN:
        raise RuntimeError("Crypto Pay is not configured.")
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            "https://pay.crypt.bot/api/createInvoice",
            headers={"Crypto-Pay-API-Token": CRYPTO_TOKEN},
            json={
                "asset": "USDT",
                "amount": f"{float(order['amount']):.2f}",
                "description": f"{order['itemName']} ({order['receiptCode']})",
                "payload": order_id,
                "expires_in": 3600,
            },
        )
        data = response.json()
    pay_url = data.get("result", {}).get("pay_url")
    if response.is_error or not data.get("ok") or not pay_url:
        raise RuntimeError("Не вдалося створити Crypto Pay інвойс.")
    invoice = data["result"]
    db.reference(f"orders/{order_id}").update({
        "cryptoInvoiceId": str(invoice["invoice_id"]),
        "cryptoPayUrl": pay_url,
        "cryptoExpiresAt": invoice.get("expiration_date"),
        "updatedAt": int(time.time() * 1000),
    })
    return pay_url


async def start_payment(update: Update, context: ContextTypes.DEFAULT_TYPE, order_id: str) -> None:
    message = update.effective_message
    user = update.effective_user
    chat = update.effective_chat
    order = await asyncio.to_thread(bind_telegram, order_id, user.id, chat.id)
    if not order:
        await message.reply_text("Замовлення не знайдено, уже завершене або посилання прив'язане до іншого Telegram-акаунта.")
        return

    text = order_text(order_id, order)
    if order.get("paymentMethod") == "crypto":
        pay_url = order.get("cryptoPayUrl") or await create_crypto_invoice(order_id, order, context)
        keyboard = InlineKeyboardMarkup([[InlineKeyboardButton("Оплатити USDT", url=pay_url)]])
        await message.reply_text(f"{text}\n\nОплатіть інвойс USDT:", reply_markup=keyboard)
        return

    keyboard = InlineKeyboardMarkup([[InlineKeyboardButton("Надіслати чек / Я оплатив", callback_data=f"receipt:{order_id}")]])
    instructions = (
        f"{text}\n\n{card_details()}\n\n"
        "ВАЖЛИВО: Перекажіть ТОЧНУ суму з урахуванням комісії вашого банку, інакше переказ може бути не ідентифіковано. "
        "Обов'язково вкажіть код призначення платежу.\n\n"
        "Після оплати надішліть саме квитанцію вашого банку у форматі PDF або чіткого фото. "
        "Скріншот екрана переказу не приймається."
    )
    await message.reply_text(instructions, reply_markup=keyboard)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = context.args
    if not args or not args[0].startswith("pay_"):
        await update.effective_message.reply_text("Відкрийте оплату з магазину F Launcher, щоб отримати інструкції до свого замовлення.")
        return
    order_id = args[0][4:]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", order_id):
        await update.effective_message.reply_text("Некоректне посилання на замовлення.")
        return
    try:
        await start_payment(update, context, order_id)
    except Exception:
        logger.exception("Payment start failed")
        await update.effective_message.reply_text("Не вдалося відкрити оплату. Перевірте налаштування або зверніться до підтримки.")


def inspect_receipt(text: str, order: dict[str, Any], order_id: str) -> dict[str, Any]:
    normalized = re.sub(r"\s+", " ", text.lower())
    values = []
    for match in re.findall(r"\d[\d\s]{0,8}[.,]\d{2}", normalized):
        try:
            values.append(float(re.sub(r"\s", "", match).replace(",", ".")))
        except ValueError:
            continue
    expected_amount = float(order["amount"])
    tolerance = max(0.01, abs(expected_amount) * RECEIPT_AMOUNT_TOLERANCE)
    matched_amounts = [amount for amount in values if abs(amount - expected_amount) <= tolerance]
    compact_text = re.sub(r"[^a-z0-9]", "", normalized)
    tokens = [str(order.get("receiptCode") or ""), order_id]
    token_found = any(
        token and re.sub(r"[^a-z0-9]", "", token.lower()) in compact_text
        for token in tokens
    )
    status_found = bool(re.search(r"успіш|успеш|проведен|зарахован|переказ|перевод|надіслан|отправлен", normalized))
    return {
        "amountFound": bool(matched_amounts),
        "matchedAmounts": matched_amounts,
        "expectedAmount": expected_amount,
        "tolerance": round(tolerance, 2),
        "tokenFound": token_found,
        "statusFound": status_found,
        "amountValues": values[:8],
        "likelyMatch": bool(matched_amounts) and token_found and status_found,
    }


def _recognize_receipt(path: Path) -> str:
    try:
        if path.suffix.lower() != ".pdf":
            with Image.open(path) as image:
                return pytesseract.image_to_string(image, lang=OCR_LANGUAGE)

        if pdfium is None:
            logger.warning("PDF OCR is unavailable; install pypdfium2 to recognize PDF receipts.")
            return ""

        recognized_pages = []
        document = pdfium.PdfDocument(str(path))
        try:
            for page_index in range(min(len(document), 3)):
                page = document[page_index]
                bitmap = page.render(scale=2)
                try:
                    recognized_pages.append(pytesseract.image_to_string(bitmap.to_pil(), lang=OCR_LANGUAGE))
                finally:
                    bitmap.close()
                    page.close()
        finally:
            document.close()
        return "\n".join(recognized_pages)
    except Exception:
        logger.info("Receipt OCR unavailable; manual review is still required.", exc_info=True)
        return ""


async def handle_receipt(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    chat_id = str(update.effective_chat.id)
    order_id = context.user_data.get("active_order_id")
    if not order_id:
        return
    order = await asyncio.to_thread(read_order, order_id)
    if not order or order.get("status") != "pending" or order.get("paymentMethod") != "card":
        context.user_data.pop("active_order_id", None)
        await message.reply_text("Для цього замовлення квитанцію зараз не очікуємо.")
        return

    photo = message.photo[-1] if message.photo else None
    document = message.document
    mime = document.mime_type if document else ""
    if not photo and not (document and (mime == "application/pdf" or mime.startswith("image/"))):
        await message.reply_text("Надішліть квитанцію PDF або чітким фото з банківського застосунку.")
        return
    telegram_file = await context.bot.get_file(photo.file_id if photo else document.file_id)
    if (telegram_file.file_size or 0) > MAX_RECEIPT_BYTES:
        await message.reply_text("Файл завеликий. Максимальний розмір: 10 МБ.")
        return

    temp_path: Path | None = None
    try:
        suffix = Path(telegram_file.file_path or "receipt").suffix or (".pdf" if mime == "application/pdf" else ".jpg")
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=TEMP_DIR, prefix="receipt-", suffix=suffix, delete=False) as temp_file:
            temp_path = Path(temp_file.name)
        await telegram_file.download_to_drive(custom_path=temp_path)
        content = await asyncio.to_thread(temp_path.read_bytes)
        receipt = await asyncio.to_thread(claim_receipt, content, order_id)
        if receipt["reused"]:
            await message.reply_text("Цю квитанцію вже надсилали. Повторно використати її неможливо.")
            return

        text = await asyncio.to_thread(_recognize_receipt, temp_path)
        check = inspect_receipt(text, order, order_id)
        now = int(time.time() * 1000)
        order_update = {
            "status": "under_review",
            "receiptHash": receipt["hash"],
            "receiptReceivedAt": now,
            "ocrHint": check,
            "updatedAt": now,
        }
        await asyncio.to_thread(db.reference(f"orders/{order_id}").update, order_update)
        context.user_data.pop("active_order_id", None)
        await context.bot.copy_message(ADMIN_CHAT_ID, chat_id, message.message_id)
        found = ", ".join(map(str, check["amountValues"])) or "не розпізнано"
        hint = (
            f"OCR-підказка: знайдена сума {found}; очікується "
            f"{money(order['amount'], order['currency'])} (допуск {RECEIPT_AMOUNT_TOLERANCE:.0%}); "
            f"код {'знайдено' if check['tokenFound'] else 'не знайдено'}; "
            f"статус {'знайдено' if check['statusFound'] else 'не знайдено'}."
        )
        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton(f"✅ Підтвердити {order_id}", callback_data=f"approve:{order_id}"),
            InlineKeyboardButton("❌ Відхилити", callback_data=f"reject:{order_id}"),
        ]])
        deadline_note = ""
        if AUTO_APPROVE_RECEIPTS:
            deadline_note = f" Якщо адміністратор не відповість за {RECEIPT_REVIEW_TIMEOUT_MINUTES} хвилин, бот винесе OCR-вердикт автоматично."
        await context.bot.send_message(ADMIN_CHAT_ID, f"{order_text(order_id, order)}\n\n{hint}{deadline_note}", reply_markup=keyboard)
        if AUTO_APPROVE_RECEIPTS:
            deadline = int(time.time() * 1000) + RECEIPT_REVIEW_TIMEOUT_MINUTES * 60 * 1000
            await asyncio.to_thread(db.reference(f"orders/{order_id}").update, {
                "receiptReviewDeadlineAt": deadline,
                "updatedAt": int(time.time() * 1000),
            })
            schedule_receipt_review_timeout(context.application, order_id, deadline)
        await message.reply_text(
            "Квитанцію передано адміністратору."
            + (f" Автоматичний OCR-вердикт буде через {RECEIPT_REVIEW_TIMEOUT_MINUTES} хвилин, якщо адмін не натисне кнопку." if AUTO_APPROVE_RECEIPTS else " Покупка активується після перевірки фактичного зарахування.")
        )
    finally:
        if temp_path:
            temp_path.unlink(missing_ok=True)


async def callback_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    parts = (query.data or "").split(":", maxsplit=1)
    action, order_id = (parts + [""])[:2]
    try:
        if action == "receipt":
            context.user_data["active_order_id"] = order_id
            await query.answer("Надішліть PDF або фото банківської квитанції.")
            return
        if not await is_admin(context, query.from_user.id, query.message.chat.id) or action not in {"approve", "reject"}:
            await query.answer("Недостатньо прав.")
            return
        if action == "approve":
            order = await asyncio.to_thread(complete_order, order_id, f"telegram:{query.from_user.id}")
            if not order:
                raise RuntimeError("Замовлення вже оброблено або не знайдено.")
            if order.get("telegramChatId"):
                await context.bot.send_message(order["telegramChatId"], "✅ Оплату підтверджено. Покупка активована у F Launcher.")
            await context.bot.send_message(ADMIN_CHAT_ID, f"✅ Підтверджено. {order_text(order_id, order)}")
            await query.answer("Замовлення підтверджено.")
        else:
            order = await asyncio.to_thread(reject_order, order_id, f"telegram:{query.from_user.id}")
            if not order:
                raise RuntimeError("Замовлення вже оброблено або не знайдено.")
            if order.get("telegramChatId"):
                await context.bot.send_message(order["telegramChatId"], "Платіж не підтверджено. Зверніться до підтримки F Launcher.")
            await context.bot.send_message(ADMIN_CHAT_ID, f"❌ Відхилено. {order_text(order_id, order)}")
            await query.answer("Замовлення відхилено.")
    except Exception as error:
        logger.exception("Admin action failed")
        await query.answer(str(error)[:180], show_alert=True)


async def check_crypto_payments(context: ContextTypes.DEFAULT_TYPE) -> None:
    if not CRYPTO_TOKEN:
        return
    orders = await asyncio.to_thread(
        lambda: db.reference("orders").order_by_child("paymentMethod").equal_to("crypto").limit_to_last(300).get() or {}
    )
    for order_id, order in orders.items():
        if order.get("status") != "pending" or not order.get("cryptoInvoiceId"):
            continue
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(
                    "https://pay.crypt.bot/api/getInvoices",
                    headers={"Crypto-Pay-API-Token": CRYPTO_TOKEN},
                    json={"invoice_ids": order["cryptoInvoiceId"]},
                )
                result = response.json()
            invoice = (result.get("result", {}).get("items") or [None])[0]
            paid_amount = float((invoice or {}).get("paid_amount") or (invoice or {}).get("amount") or 0)
            if (result.get("ok") and invoice and invoice.get("status") == "paid"
                    and invoice.get("payload") == order_id and invoice.get("asset") == "USDT"
                    and abs(paid_amount - float(order["amount"])) <= 0.01):
                completed = await asyncio.to_thread(complete_order, order_id, "crypto-pay")
                if completed and completed.get("telegramChatId"):
                    await context.bot.send_message(completed["telegramChatId"], "✅ Оплату USDT підтверджено. Покупка активована у F Launcher.")
                if completed:
                    await context.bot.send_message(ADMIN_CHAT_ID, f"✅ Crypto Pay: {order_text(order_id, completed)}")
        except Exception:
            logger.exception("Crypto invoice check failed for order %s", order_id)


def schedule_receipt_review_timeout(application: Application, order_id: str, deadline_at: int) -> None:
    job_queue = application.job_queue
    if job_queue is None:
        logger.error("JobQueue is unavailable; receipt review timeout was not scheduled.")
        return
    job_name = f"receipt-review:{order_id}"
    for existing_job in job_queue.get_jobs_by_name(job_name):
        existing_job.schedule_removal()
    delay = max(0, (deadline_at - int(time.time() * 1000)) / 1000)
    job_queue.run_once(finalize_receipt_review, when=delay, data=order_id, name=job_name)


async def finalize_receipt_review(context: ContextTypes.DEFAULT_TYPE) -> None:
    order_id = context.job.data
    order = await asyncio.to_thread(read_order, order_id)
    if not order or order.get("status") != "under_review":
        return
    deadline = int(order.get("receiptReviewDeadlineAt") or 0)
    if not deadline:
        return
    if deadline > int(time.time() * 1000):
        schedule_receipt_review_timeout(context.application, order_id, deadline)
        return

    hint = order.get("ocrHint") or {}
    if hint.get("likelyMatch"):
        decided_order = await asyncio.to_thread(complete_order, order_id, "receipt-ocr-timeout")
        if not decided_order or decided_order.get("confirmedBy") != "receipt-ocr-timeout":
            return
        if decided_order.get("telegramChatId"):
            await context.bot.send_message(
                decided_order["telegramChatId"],
                "✅ OCR-перевірка пройшла: сума, код і статус збігаються. Покупку активовано автоматично.",
            )
        await context.bot.send_message(
            ADMIN_CHAT_ID,
            f"✅ Автоматично підтверджено після {RECEIPT_REVIEW_TIMEOUT_MINUTES} хвилин без відповіді адміна.\n"
            f"{order_text(order_id, decided_order)}\nOCR: сума, код і статус збігаються. Перевірте фактичне зарахування.",
        )
        return

    decided_order = await asyncio.to_thread(reject_order, order_id, "receipt-ocr-timeout")
    if not decided_order or decided_order.get("reviewedBy") != "receipt-ocr-timeout":
        return
    if decided_order.get("telegramChatId"):
        await context.bot.send_message(
            decided_order["telegramChatId"],
            "❌ Не вдалося автоматично підтвердити чек: OCR не знайшов усі потрібні ознаки. "
            "Замовлення відхилено; якщо кошти списані, зверніться до підтримки для ручної перевірки.",
        )
    await context.bot.send_message(
        ADMIN_CHAT_ID,
        f"❌ Автоматично відхилено після {RECEIPT_REVIEW_TIMEOUT_MINUTES} хвилин без відповіді адміна.\n"
        f"{order_text(order_id, decided_order)}\nOCR не підтвердив суму, код і статус одночасно.",
    )


async def restore_receipt_review_jobs(application: Application) -> None:
    if not AUTO_APPROVE_RECEIPTS:
        return
    try:
        orders = await asyncio.to_thread(
            lambda: db.reference("orders").order_by_child("receiptReviewDeadlineAt").start_at(1).get() or {}
        )
        for order_id, order in orders.items():
            if order.get("status") == "under_review" and order.get("receiptReviewDeadlineAt"):
                schedule_receipt_review_timeout(application, order_id, int(order["receiptReviewDeadlineAt"]))
    except Exception:
        logger.exception("Could not restore receipt review timeout jobs")


async def recover_receipt_review_jobs(context: ContextTypes.DEFAULT_TYPE) -> None:
    await restore_receipt_review_jobs(context.application)


async def post_init(application: Application) -> None:
    application.job_queue.run_repeating(check_crypto_payments, interval=20, first=20)
    if AUTO_APPROVE_RECEIPTS:
        await restore_receipt_review_jobs(application)
        application.job_queue.run_repeating(recover_receipt_review_jobs, interval=60, first=60)


def main() -> None:
    if not BOT_TOKEN or not ADMIN_CHAT_ID:
        raise RuntimeError("Set TELEGRAM_BOT_TOKEN and ADMIN_CHAT_ID in the host environment.")
    initialize_firebase()
    application = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CallbackQueryHandler(callback_query))
    application.add_handler(MessageHandler(filters.PHOTO | filters.Document.ALL, handle_receipt))
    logger.info("F Launcher Python payment bot started.")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()