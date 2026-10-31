# F Launcher: Data and Subscriptions

## SQL Connect model

The initial schema is in `dataconnect/schema/schema.gql`. Firebase SQL Connect maps these GraphQL types to PostgreSQL tables.

- `Player`: Firebase Authentication UID, Minecraft identity, nickname, locale, and account timestamps.
- `PlayerSession`: launcher session and heartbeat. Treat a session as active only while its heartbeat is recent; a client can crash without sending a clean sign-out.
- `PlayerEvent`: allowlisted analytics events such as `auth.login_success`, `game.launch`, `server.connect`, and `achievement.unlocked`.
- `ErrorReport`: player, time, launcher area, title, description, error fingerprint, locale, app/game versions, and a coarse hardware snapshot.
- `Achievement` and `PlayerAchievement`: achievement catalog and per-player unlocks.
- `PlanCatalog` and `PlanPrice`: subscription offers and server-controlled regional prices.
- `PlayerSubscription`: payment-provider record verified by a backend webhook, never by the launcher itself.

`installId` is a random per-install identifier, not a hardware fingerprint. Hardware fields are limited to OS family/version, architecture, RAM range, Java major version, and optionally GPU vendor. Do not collect serial numbers, MAC addresses, Windows product IDs, raw access tokens, or full local paths. Explain the diagnostics collection in the app and ask consent before transmitting it.

Error descriptions and stack traces must be scrubbed of tokens, usernames where not required, and local paths. Queue reports locally if the player is not authenticated, then submit after successful sign-in; cap queue size and retention. Use `locale` values such as `ru-RU` and `uk-UA` so support can triage the language.

## Access rules

- Use Firebase Authentication UID as the player key via server expression `auth.uid`; never accept a client-supplied player ID as authority.
- A player may read their own profile and achievements. Profile mutations are limited to approved fields.
- The client may submit its own error report and allowlisted activity events. It cannot set report status, admin notes, subscription state, payment references, or achievement unlocks.
- Admin-only operations read and triage error reports. Grant admin via trusted custom claims or a server-side role check, not a client setting.
- Subscription entitlements are changed only after the payment provider's signed webhook has been verified by a trusted backend. The launcher displays server-verified entitlements but never grants them.
- Rate-limit error submissions and cap field lengths in a trusted endpoint. Do not expose an unrestricted admin connector.

## Account and device identity

Microsoft/Minecraft sign-in and Firebase Authentication are separate identities. The existing launcher flow can prove the Minecraft profile to Microsoft's services, but SQL Connect still needs a Firebase ID token. A trusted backend must validate the Minecraft identity and mint a Firebase custom token. The launcher then uses that Firebase session for SQL Connect operations.

Do not put a service-account JSON key or signing secret in the WPF application. Firebase web configuration and project identifiers are public client configuration; database permissions must come from authenticated operations and authorization rules, not from hiding a URL. Microsoft refresh tokens remain in the existing Windows DPAPI store and must never be sent to analytics.

## Subscription proposal

Prices below are launch hypotheses, not commitments. Store actual amounts in `PlanPrice` as integer minor currency units and load them from the backend. Do not hard-code USD prices or infer a player's country from an IP address. Confirm payment fees, taxes, refunds, regional availability, and store rules before selling subscriptions.

| Plan | Initial offer | Entitlements |
|---|---|---|
| Free | $0 | Current launcher features, three profiles, standard themes, basic skin editor, server list, mod search, and crash diagnostics. |
| Supporter | Proposed $1.99/month or $17.99/year; regional prices configured separately | Themes and animated backgrounds, more profiles, Skin Studio Pro, optional cloud-world backups, Discord status, and early feature access. |
| Patron | Proposed $4.99/month | Supporter benefits, roadmap voting, Hall of Fame listing with consent, and prioritized bug triage. Avoid promising guaranteed response or resolution times. |
| Early-bird Lifetime 1.x | One-time purchase, first 100 verified purchases | Supporter/Patron benefits explicitly limited to the F Launcher 1.x branch. No promise of lifetime access to later major versions or third-party services. |

Recommended launch sequence: ship Free first; add Supporter and Patron only after a payment provider, cancellation/refund flow, tax handling, and webhook verification are ready. Keep cloud backups opt-in and obtain the separate Google Drive/OneDrive consent/scopes when implementing that feature. Add Lifetime only as a finite offer with server-side transactional enforcement of the 100-purchase cap.

## Not deployed yet

This is the data model and product proposal, not a live database integration. Deployment still needs the Firebase SQL Connect service ID/location, connector operations, Firebase Authentication setup, and a trusted backend for Microsoft-to-Firebase token exchange, report throttling, admin access, and payment webhooks. Validate and deploy from the Firebase SQL Connect tooling after those project-specific values are configured.