# F Launcher payment bot

The folder contains both the original Node.js bot and a Python port. Both use Firebase Admin credentials only on the bot host; no service key or payment token belongs in the launcher or CRM bundle.

## Python hosting

Use a persistent Python worker/service (for example, Render Background Worker or Railway), not a serverless function that stops between requests. Set the service root to `bot`, install with `pip install -r requirements.txt`, and use `python main.py` as the start command. Python 3.10 or newer is required.

Configure the same environment variables listed below in the host's secret settings. Set either `FIREBASE_SERVICE_ACCOUNT_JSON` to the complete service-account JSON or `FIREBASE_SERVICE_ACCOUNT_FILE` to the absolute path of a privately uploaded JSON key file. The bot stores each upload briefly under `bot/temp`, OCRs images and up to three PDF pages with Tesseract/PDFium, and removes the file after processing. The host needs Tesseract plus `eng`/`ukr` language data; if unavailable, receipts still go to an administrator for manual review, without an OCR hint.

OCR compares the receipt code/order ID, a positive payment-status phrase, and the expected amount with a default 2% tolerance. The code defaults `AUTO_APPROVE_RECEIPTS` to `false`; this project's `.env.example` enables it as requested. When enabled, the bot posts the receipt for admin review and starts `RECEIPT_REVIEW_TIMEOUT_MINUTES` (15 by default) after the post is sent. An admin can approve/reject during that window; otherwise matching OCR completes the order, while an unreadable or non-matching receipt is rejected and the buyer is told how to request manual support. The deadline is stored in Firebase and restored after a bot restart. A receipt image is not proof that funds reached the account, so OCR approval carries payment-fraud risk.

Local run:

```sh
python -m pip install -r requirements.txt
python main.py
```

## Node.js hosting

The original Node.js 20+ entrypoint remains available as `main.js`.

## Configure

Copy `.env.example` to `.env` for local runs, then set:

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` from BotFather. The token pasted into chat should be revoked and replaced before use.
- `ADMIN_CHAT_ID` to the administration group ID. If `ADMIN_TELEGRAM_IDS` is empty, the bot checks Telegram group administrator/creator membership before accepting approval callbacks; otherwise only listed IDs can approve.
- `CRYPTO_PAY_API_TOKEN` from Crypto Pay.
- `FIREBASE_SERVICE_ACCOUNT_JSON` as a hosting secret containing the complete Firebase service-account JSON, or `FIREBASE_SERVICE_ACCOUNT_FILE` as a path to a private key file. Application Default Credentials are also supported. Never commit the key.
- `CARD_RECIPIENT_NAME`, `CARD_IBAN`, `CARD_TAX_ID`, `CARD_BANK_NAME`, and `CARD_PAYMENT_PURPOSE` as hosting secrets/settings. The bot intentionally does not store bank details in source control.
- `AUTO_APPROVE_RECEIPTS`, `RECEIPT_AMOUNT_TOLERANCE_PERCENT`, and `RECEIPT_OCR_LANGUAGE` for OCR review behavior.
- `RECEIPT_REVIEW_TIMEOUT_MINUTES` for the admin response window before the automatic OCR verdict.
- `FIREBASE_DATABASE_URL` if the project database URL changes.
- `HTTPS_PROXY` only when the host requires it. Do not send payment credentials through an untrusted free proxy.

Set the same `TELEGRAM_BOT_USERNAME` as a Cloud Functions runtime parameter/environment value so launcher-created orders receive a valid deep-link.
For Firebase Functions, copy `functions/.env.example` to `functions/.env`, set the actual bot username, and deploy Functions. Keep the actual `.env` local and uncommitted.

## Node.js run

```sh
npm install
npm start
```

The bot polls Telegram, creates Crypto Pay invoices, and checks invoice state every 20 seconds. Card receipt uploads are temporarily stored, SHA-256 deduplicated, OCR-reviewed, forwarded to administrators, then removed. Each approval writes the order, player entitlement, `/analytics/sales`, and `/auditLog` with the launcher UID and available email.

## Node.js hosting

Deploy this folder as a Node.js 20 worker/service on Render, Railway, or another always-on host. Set the environment values in the host's secret settings, use `npm install` as the build command and `npm start` as the start command. Do not use a serverless sleep-prone/free tier for payment polling unless it guarantees a continuously running worker. Configure Firebase RTDB rules and deploy Cloud Functions before enabling the launcher shop.