# BillMitra Staff mobile app

This is a separate Expo/React Native application for Android and iPhone. It uses the BillMitra HTTPS mobile API. The mobile code is separate from the desktop/web UI and has its own dependencies and lockfile.

## Current features

- Choose Dining or Kitchen before sign-in. The server enforces the staff role for the selected workspace.
- Kitchen staff can view KOTs, move each batch through preparing and ready, mark menu items unavailable or available, and send a 5- or 10-minute table delay with a reason. Dining has a separate Kitchen notifications page where each waiter can acknowledge these notices.
- Kitchen orders show counts by stage, search by table/order/item, and list oldest KOTs first. Stock can be searched or filtered to unavailable items. Quick delay reasons reduce typing during rushes.
- Dining and Kitchen have a Messages page with recent text and voice messages. Tap once to record (up to 15 seconds), tap again to send, or type a message. The recipient's phone vibrates and plays a chime for new messages while the app is open. New KOTs alert Kitchen; new Kitchen notices alert Dining. Each phone remembers alerts it has already played.
- Dining phones show customer waiting alerts after five minutes of confirmed simulated seating with no order. An owner or manager can start and end a test seating session on the Tables screen. The Android APK receives a heads-up push notification when registered; physical delivery still needs verification. See [waiting alert test](../../docs/waiter-customer-waiting.md). CCTV detection is pending.
- Dining and Kitchen refresh while the app is open. Background push notifications and live streaming audio are later work. The phone's silent mode and notification settings can affect sound and vibration.
- Waiter sign-in to an existing branch account. Owners and managers who have waiter permission can also sign in.
- Separate Ground Floor and Floor 1 table tabs (additional configured floors appear automatically), with Ground Floor first.
- Occupied-table elapsed timers: blue before one hour, red from exactly one hour. Timers survive refresh/reopening because they use the saved order timestamp.
- Print saved bills and selected KOT batches through configured desktop printers, with durable request retries and visible queue/submission status. See [printer setup](../../docs/waiter-printing.md).
- Browse the menu, search/filter categories, and use minus/quantity/plus controls directly on each item. Reducing a draft quantity to zero removes that draft item. Already-sent kitchen items are unchanged. Edit kitchen notes and review additions before sending.
- Send a dine-in order to the kitchen using the same server-side billing/order service. The app saves an immutable request ID and payload before sending and retries that exact request after a timeout or app restart.
- Save per-table drafts in on-device SQLite. The opaque session token is held in platform secure storage. The app polls the menu/table data while open and on resume.

The server provides role-scoped `/api/mobile/` routes for Dining and Kitchen. Mobile requests use a bearer session. The browser API continues to use its existing cookie and Origin checks.

## Development

From this folder, run `npm install`, `npm run typecheck`, then `npm start`. Use an Android emulator or iOS simulator with an Expo development build. The Dining and Kitchen app has `https://mobile.billmitra.shop` built in; staff enter only the branch ID (currently `main` for Vengara), username, and password. The restaurant PC and its HTTPS tunnel must be running for phone access. An Expo development server alone does not provide a restaurant backend. App upgrades copy saved drafts and pending requests from an older server-address scope before using the fixed address.

`npx expo export --platform android` and `npx expo export --platform ios` check bundling. `eas build --profile preview --platform android` is configured to produce an installable Android APK. An installable iPhone build requires an Apple Developer account and iOS signing through TestFlight or registered-device distribution. No signing credentials or cloud build account are stored here.

## Remaining release work

- Enable connected Electron mode by setting `BILLMITRA_DESKTOP_SERVER` to the same HTTPS origin and `BILLMITRA_DESKTOP_BRANCH=main` before launching desktop. In this mode cashier/kitchen operations use the same branch backend as the phone. Existing desktop local data is not migrated or synchronized. Test connected mode and target printer workflows on the actual Windows installation before restaurant use.
- Implement full offline desktop synchronization, background push alerts, and audited waiter service actions.
- Extend server order idempotency with payload fingerprint checks and a direct acknowledgement lookup. The current app retries an unchanged persisted payload, but the server does not yet reject altered payloads with a reused request ID.
- Harden native session persistence/revocation across server restart and complete authentication/load testing. Test real Android/iPhone devices, app upgrade and interrupted network cases.
- Replace Expo template artwork with reviewed BillMitra icons and launch artwork, then produce signed test builds. The branch server currently writes operational data to SQLite and copies a projection to MySQL; the cloud MySQL migration is separate work.

See [the product plan](../../docs/waiter-phone-plan.md).
