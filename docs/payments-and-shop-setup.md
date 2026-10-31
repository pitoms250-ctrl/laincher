# Payments and shop setup

## Deploy order

1. Revoke the Crypto Pay token pasted in the implementation request and create a replacement. Store only the replacement in the bot host's secret settings as `CRYPTO_PAY_API_TOKEN`.
2. Configure the environment variables from `bot/.env.example`. `FIREBASE_SERVICE_ACCOUNT_JSON`, Telegram tokens, admin chat IDs, and bank details are server secrets; do not put them in the launcher, CRM bundle, or source control.
3. Set `TELEGRAM_BOT_USERNAME` in `functions/.env` and `bot/.env` (or hosting settings). Configure the bank fields using the recipient details supplied by the project owner.
4. Deploy RTDB rules and Cloud Functions: `firebase deploy --only database,functions`.
5. Deploy the always-on Node.js bot from `bot/` with `npm install` and `npm start`.
6. Deploy the CRM and launcher. Create products in the CRM; tag products use `type: tag`, and price growth is enabled per product with a UAH/USDT step.

## Payment controls

The launcher cannot set an amount or mark an order paid. Cloud Functions derives the current price and authenticated Firebase UID. Crypto purchases activate only after Crypto Pay reports a paid invoice with matching payload, asset, and amount. Bank receipts are hash-deduplicated and OCR results are advisory; an administrator must verify the bank's actual credit before approving. Every approved order writes `/orders`, `/entitlements`, `/analytics/sales`, and `/auditLog` with the launcher UID and available email.

Unique tags are reserved while an order is pending, become active on approval, and are released when the order is rejected or revoked. An abandoned tag reservation should be rejected from CRM after checking that no payment arrived.

The bot's OCR uses Tesseract.js for images. PDFs are forwarded for manual review. A receipt image is removed from the bot's temporary directory after processing; Telegram and its configured administration group still retain their own messages according to Telegram's retention behavior.
