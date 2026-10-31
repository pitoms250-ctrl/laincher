# Launcher shop integration

The compiled launcher integration lives in `src/Launcher.Services/ShopService.cs` and `src/Launcher.Core/Models/ShopModels.cs`.

- The Shop view reads enabled products from `/shop_items` using the signed-in Firebase ID token.
- Order creation and status checks call `createLauncherOrder` and `getLauncherOrder` in Cloud Functions. The server validates current catalog price and binds the order to the authenticated Firebase UID.
- Orders remain pending until Crypto Pay reports a paid invoice or an administrator verifies a bank transfer. The launcher polls the authenticated status endpoint and displays the result.
- Approved purchases are written to server-only `/entitlements/{uid}/{orderId}` and `/analytics/sales/{orderId}`. RTDB clients cannot write either path.

Set `TELEGRAM_BOT_USERNAME` in the Functions environment before deploying, and deploy `src/Launcher.UI/database.rules.json` as the project's RTDB rules.