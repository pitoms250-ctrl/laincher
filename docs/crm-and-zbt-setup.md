# CRM and ZBT setup

## What is in this repository

- `crm/` is the React + TypeScript staff console. ZBT campaigns and key records use Realtime Database (RTDB); writes require an owner session with MFA.
- `src/Launcher.UI/` uses an anonymous Firebase session for catalog reads and read-only ZBT key preview. ZBT activation requires Microsoft sign-in to be exchanged for a Firebase user session; the activation is an ETag-conditional RTDB update bound to that Firebase UID and install ID.
- `functions/` contains optional server-side integrations but is not called by the launcher or CRM for the current RTDB workflows. These workflows do not require the Blaze plan.
- The canonical ZBT paths are `/zbtCampaigns/{campaignId}`, `/keys/{sha256}`, and `/players/{firebaseUid}`. Open key strings are only shown/downloaded by CRM and are not stored in RTDB.
- Staff authorization is read from `/staff/{firebaseAuthUid}` in RTDB. Custom claims are not the source of truth for CRM roles.

## Firebase Console prerequisites

1. Select the `furry-launcher` project. In Authentication → Sign-in method, enable **Anonymous** and **Microsoft** for the launcher, and **Google** for CRM staff.
2. In Firebase Microsoft provider settings, enter the Azure Application (client) ID and client secret **Value**. Keep the secret in Firebase only; never put it in `appsettings.json` or the WPF binary.
3. In Azure App Registration, allow personal Microsoft accounts, enable public client flows, and add `http://localhost` under **Mobile and desktop applications**. Add `https://furry-launcher.firebaseapp.com/__/auth/handler` under **Web** redirect URIs. In Firebase Authentication → Settings → Authorized domains, include `localhost`.
4. Enable Firebase Authentication multi-factor authentication with Phone as a factor. CRM access requires a Google session with the Firebase second-factor claim; Google account 2-step verification alone is not enough.
5. Create/enable Realtime Database in `europe-west1` and deploy `src/Launcher.UI/database.rules.json` using the Firebase CLI or paste its `rules` object into Realtime Database → Rules.
6. Create the first owner record in Realtime Database at `/staff/{firebaseAuthUid}`. The value must include `email` (exact Google email), `role: "owner"`, and optionally `displayName`, `createdAt`, and `invitedBy`.
7. Sign in to the CRM with that Google account, enroll Phone MFA, then sign in again. CRM rules permit campaign/key writes only to an owner with MFA; support can read key records but cannot create or revoke them.
8. Do not enable public writes. Authenticated launcher accounts may read a specific known key hash. Only a signed-in Firebase UID can activate one unused key once for that UID/device with the unchanged record fields; the player cannot list `/keys` or create/change campaigns.

### What the RTDB rules enforce

- `/zbtCampaigns`: any authenticated Firebase user can read campaign metadata; only an owner with MFA can create or change a campaign.
- `/keys`: only owner/support with MFA can list the collection. A launcher user can read a specific known hash only while it is unused, or read its own activated record.
- `/keys/{hash}`: a normal user cannot create, revoke, edit, or reuse a key. The only allowed player write is an ETag-conditional transition from `used: false` to `used: true`, with `status: ACTIVATED`, their Firebase UID, an install ID, and the original campaign/hash/creation fields unchanged. The campaign must still be active.
- `/players/{uid}`: a user can read and write only their own profile; owner/support can read player profiles for CRM. Profile data includes the Firebase UID, email when available, nickname, Minecraft UUID, install ID, and a coarse device snapshot.
- `/playerEvents/{uid}` and `/errorReports/{uid}`: a player can append only their own entries; owner/support can read them. Error text is scrubbed client-side before upload.

Rules do not make a client-controlled hardware snapshot tamper-proof. They protect the RTDB records and one-time key transition; they are not a substitute for a trusted game server or anti-cheat service.

For ZBT activation, `FirebaseApiKey` and `FirebaseDatabaseUrl` in the launcher configuration must point to this same Firebase project. Anonymous sign-in must be enabled or activation will fail with a Firebase Auth configuration error.

## Local development

Free disk space first if npm reports `ENOSPC`.

```powershell
npm --prefix functions install
npm --prefix functions test
npm --prefix crm install
npm --prefix crm run dev
```

The public Firebase web configuration is in `crm/src/firebase.ts` and can be overridden with `VITE_FIREBASE_*` variables. The Firebase API key is a public client identifier, not a server secret; restrict it in Google Cloud to the expected websites and APIs. Do not put Admin SDK credentials, mail tokens, bot tokens, or AI provider keys in `crm/` or the launcher.

Staff roles are stored in RTDB `/staff` and checked against the signed-in email. The CRM has no hardcoded owner email and cannot create its own first owner. A project administrator must seed the first owner record manually as described above.

## Deploy to Firebase Hosting

The existing `firebase.json` publishes `crm/dist` and rewrites SPA routes to `index.html`. The default project is `furry-launcher`.

```powershell
npm --prefix crm run build
firebase deploy --only database,hosting --project furry-launcher
```

ZBT campaign/key creation, activation, status changes, revocation, profile writes, player events, and error reports use direct RTDB operations and work on the Spark plan. No Cloud Functions deployment is required. Do not make database paths publicly writable.

## Deploy the CRM to Vercel instead

Set the Vercel project root to `crm`, build command to `npm run build`, and output directory to `dist`. Add the public `VITE_FIREBASE_*` values in Vercel project environment variables, then enable the Vercel domain in Firebase Authentication's authorized domains. The CRM uses Firebase Auth and RTDB directly.

## Not deploy-ready yet

- Firebase Console changes are not deployed automatically. Enable Anonymous Auth and deploy the RTDB rules after reviewing them; no Cloud Functions deployment is needed for ZBT.
- `crm/package-lock.json` is out of sync with `crm/package.json`; `npm ci` fails until the lock file is regenerated. A local production build was verified using the declared dependencies with legacy peer resolution.
- Gmail, Telegram, Claude drafting, and outbound delivery are not implemented. They require owner-controlled OAuth/bot credentials and reviewable server workflows; no credentials were supplied. Add them later as Secret Manager-backed Functions, never as browser SDK calls.
- Signed download URLs and game-server whitelist enforcement need a real artifact bucket and game-server integration. A client-side ZBT gate is not a security boundary by itself.
- App Check needs an app attestation provider configured for each client. Do not claim it protects the WPF launcher until a supported provider is implemented and enforced server-side.
- Explicit contact email consent is stored separately from Microsoft identity email. Automated newsletter sending is not enabled.
