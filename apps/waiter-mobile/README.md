# BillMitra Waiter mobile app

This is a separate Expo/React Native application for Android and iPhone. It uses the BillMitra HTTPS mobile API. The mobile code is separate from the desktop/web UI and has its own dependencies and lockfile.

## Current features

- Waiter sign-in to an existing branch account. Owners and managers who have waiter permission can also sign in.
- Separate Ground Floor and Floor 1 table tabs (additional configured floors appear automatically), with Ground Floor first.
- Occupied-table elapsed timers: blue before one hour, red from exactly one hour. Timers survive refresh/reopening because they use the saved order timestamp.
- Print saved bills and selected KOT batches through configured desktop printers, with durable request retries and visible queue/submission status. See [printer setup](../../docs/waiter-printing.md).
- Browse the menu, search/filter categories, and use minus/quantity/plus controls directly on each item. Reducing a draft quantity to zero removes that draft item. Already-sent kitchen items are unchanged. Edit kitchen notes and review additions before sending.
- Send a dine-in order to the kitchen using the same server-side billing/order service. The app saves an immutable request ID and payload before sending and retries that exact request after a timeout or app restart.
- Save per-table drafts in on-device SQLite. The opaque session token is held in platform secure storage. The app polls the menu/table data while open and on resume.

The server adds `/api/mobile/login`, `/api/mobile/menu`, `/api/mobile/order`, `/api/mobile/print` and `/api/mobile/logout`. Mobile requests use a bearer session. The browser API continues to use its existing cookie and Origin checks.

## Development

From this folder, run `npm install`, `npm run typecheck`, then `npm start`. Use an Android emulator or iOS simulator with an Expo development build. The login screen requires a reachable **HTTPS** BillMitra server, an existing branch ID (currently `main` for Vengara), and a waiter account created by an owner. A phone cannot reach your Windows machine through `localhost`. The existing web server is loopback-only until deliberately configured with HTTPS and network hosting. An Expo development server alone does not provide a restaurant backend.

`npx expo export --platform android` and `npx expo export --platform ios` check bundling. `eas build --profile preview --platform android` is configured to produce an installable Android APK. An installable iPhone build requires an Apple Developer account and iOS signing through TestFlight or registered-device distribution. No signing credentials or cloud build account are stored here.

## Remaining release work

- Enable connected Electron mode by setting `BILLMITRA_DESKTOP_SERVER` to the same HTTPS origin and `BILLMITRA_DESKTOP_BRANCH=main` before launching desktop. In this mode cashier/kitchen operations use the same branch backend as the phone. Existing desktop local data is not migrated or synchronized. Test connected mode and target printer workflows on the actual Windows installation before restaurant use.
- Implement full offline desktop synchronization, waiter ticket-level kitchen progress and audited service actions.
- Extend server order idempotency with payload fingerprint checks and a direct acknowledgement lookup. The current app retries an unchanged persisted payload, but the server does not yet reject altered payloads with a reused request ID.
- Harden native session persistence/revocation across server restart and complete authentication/load testing. Test real Android/iPhone devices, app upgrade and interrupted network cases.
- Replace Expo template artwork with reviewed BillMitra icons and launch artwork, then produce signed test builds. MySQL remains a proposed future central database; this app currently uses the existing SQLite server backend.

See [the product plan](../../docs/waiter-phone-plan.md).
