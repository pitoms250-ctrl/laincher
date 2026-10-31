# Shop and FL Coins

## Data layout

The catalog is seeded from the repository root files:

- `shop_items.seed.json`
- `case_drops.seed.json`
- `shop_config.seed.json`

The launcher and CRM read live Realtime Database data. The seed files are the reviewed source for the initial 69 products; they do not automatically overwrite the live database.

## First catalog publication from CRM

The launcher has no Admin credentials and never writes catalog data. Deploy the owner+MFA rules in `src/Launcher.UI/database.rules.json` to the `furry-launcher` RTDB:

```powershell
firebase deploy --only database --project furry-launcher
```

Then sign in to CRM as an owner with MFA. In **Магазин**, select the three repository seed files and publish them. The CRM validates the 69 products and 8 drop tables, updates only `shop_items`, `case_drops`, `shop_config`, and the audit log, and does not change `orders` or delete other catalog records. Invalid pre-existing test items are disabled rather than removed.

After publication, opening the launcher shop fetches the catalog automatically and keeps it synchronized through the RTDB stream; the refresh button is not required for normal updates. The profile uses the current Microsoft/local launcher session and live wallet/inventory functions.

This workspace has no configured Firebase Admin credential, so a repository-side process cannot publish to the live database. Do not copy a service-account key into the launcher or CRM bundle.

## Validate

Node.js 20 or newer is required. Validate the local catalog without Firebase credentials:

```powershell
node tools/seed-shop/seed-shop.mjs --validate-only
node --test tools/seed-shop/seed-shop.test.mjs
```

## Preview and seed

Install Functions dependencies first so the Admin SDK is available:

```powershell
cd functions
npm install
cd ..
```

Set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file stored outside this repository. Never commit or paste that file. Then preview:

```powershell
node tools/seed-shop/seed-shop.mjs --dry-run
```

Write only the reviewed nodes with:

```powershell
node tools/seed-shop/seed-shop.mjs
```

The script updates `shop_items`, `case_drops`, and `shop_config` only. It preserves sales counts, price history, and existing `createdAt` values, and does not change `orders`. Removal is disabled unless `--prune` is explicitly supplied.

## Payments and currency

Card and USDT orders continue through the existing `createLauncherOrder` Cloud Function and Telegram payment bot. Do not edit the existing `orders` security rule. FL Coins, inventory delivery, gifts, and case results must be performed by authenticated server functions; never accept a client-supplied wallet balance or random case result. Payment provider secrets and service-account credentials belong only in the server secret environment.

The supplied configuration deliberately sets `usdtPerUah: 1`, matching the requested seed values. This makes the numeric USDT price equal to the UAH price; review the economic impact before enabling the catalog for real payments.
