# BillMitra native waiter application plan

Planning date: 23 October 2026. Confirmed: an installed application for both Android and iPhone. The supplied MySQL screenshot is treated as a proposed central-database direction, not authorization to replace existing data. The first pilot branch is Vengara (`main`). Keep that branch ID stable.

Implementation update: `apps/waiter-mobile` now contains native login, floor tabs, menu quantity controls, review, on-device drafts, pending-order retry, occupied-table timers, and desktop-mediated bill/KOT requests. The backend has token-authenticated mobile routes and a durable print queue, and Electron has connected mode and configurable Windows printer routes. See [waiter-printing.md](waiter-printing.md) for setup and validation. The remaining sections describe the target release; ticket progress, service acknowledgements, MySQL migration, offline desktop synchronization, signed installers and permanent hosting are still outstanding.

## Product direction

Build a native waiter application using React Native, Expo and TypeScript, with a shared mobile codebase for Android and iPhone. Deliver signed applications with their own app icon and bundled screens; the restaurant trial must not depend on Expo Go or a developer's running bundler. Reuse portable types, validation and billing arithmetic from this repository. Build the mobile UI with native components; the existing React DOM components and CSS cannot simply become native screens.

Retain the Electron desktop application for cashier/kitchen work and connect the applications through an authenticated API. The server is shared infrastructure, not a requirement for waiters to open a website. Begin with English and INR as design assumptions; Malayalam labels can follow after staff review. Both Android and iOS are release targets, not an assumed Android-only rollout.

The first release should make taking an order quick and unambiguous: choose table, add items, review, send, follow preparation, mark served, request the bill. The cashier retains payment collection and final billing.

## What exists today

| Area | Existing implementation | Planned extension |
| --- | --- | --- |
| Waiter access | Branch-local staff accounts; waiter role; backend permission checks | Native sign-in, device sessions and account/device view |
| Table ordering | Table selector, existing sent items and dine-in additions | Floor filter, table tiles, current progress and saved drafts per table |
| Menu | Available items, search, quantities and notes | Category filter, touch quantity controls and separate lines for different notes |
| Submission | Request IDs and transactional order/kitchen writes | Durable immutable submissions, payload checks and explicit confirmation recovery |
| Kitchen | Separate tickets for additions; kitchen preparation workflow | Waiter-readable ticket status, service acknowledgements and ready list |
| Layout | Generic management screen, stacked below 850px | Phone navigation, review screen and accessible touch layout |
| Connection | Browser HTTP adapter and local desktop IPC backend | Authenticated native API, desktop connected mode and phone draft recovery |

Relevant current files: `src/features/management/WaiterScreen.tsx`, `src/features/management/management.css`, `src/pages/BranchGateway.tsx`, `src/services/pos.ts`, `src/services/browserPos.ts`, `shared/staffPermissions.ts`, `electron/backend.cts`, and `electron/services/restaurantOperations.test.ts`.

## Shared data and rollout boundary

For the first coherent trial, the installed waiter apps, kitchen application and Electron cashier must use the **same branch and authoritative backend**. The desktop currently owns a separate SQLite database. Orders from phones will not automatically appear there. Implement and test a desktop connected mode before calling the phone-to-cashier flow complete.

```text
Android waiter app --------+
iPhone waiter app ---------+--> authenticated HTTPS API --> Vengara branch database
Electron cashier ---------+
Kitchen app workspace ----+

Desktop local database <--> durable synchronization (later gate) <--> shared API
```

Use a staging HTTPS API or a properly configured restaurant-local HTTPS service for the trial. The current development server binds to loopback by default; network access and TLS must be configured. A phone's `localhost` is the phone, not the cashier PC. Do not bypass TLS validation to connect. A setup QR code can identify the approved API address and branch; it must not contain staff passwords, owner setup tokens or permanent access credentials.

The current browser API requires matching Origin headers and cookie sessions. Add a native authentication/API boundary with explicit device/staff/branch sessions; do not remove the browser protections or assume a phone can use `browserPos.ts` unchanged. Start with a short-lived opaque session token, secure on-device storage, server-side expiry/revocation, login throttling and explicit reauthentication. Introduce refresh-token rotation only if longer sessions are needed. The server authorizes the branch from the authenticated session and verifies every requested operation. Centralize authenticated request-context allocation: the current backend uses numeric sender IDs and the browser allocates its own IDs. A second independent native counter against the same backend could collide with browser/desktop identities; use explicit principal contexts or one shared allocator.

The first desktop connected mode uses server operations while connected, with authentication/network work behind the Electron main-process bridge. It must not silently fall back to writing a different local database after a failed request. Full production offline desktop billing still depends on the durable synchronization work in `docs/restaurant-product-plan.md`. Merely sharing restaurant Wi-Fi does not synchronize databases. A branch-local service that keeps phones and kitchen operating during an internet outage is a separate deployment/synchronization milestone, with one explicit authority for active table orders and no silent server switching.

## Database direction from the supplied screenshot

Use MySQL with InnoDB as the proposed central relational database. MySQL 8.4 LTS is the version shown in the screenshot; verify the chosen hosting service's supported LTS version and patch policy when provisioning. It is a reasonable option, not uniquely the best database for every POS. Transactions support consistent writes; application code still implements branch permissions, pricing rules, idempotency and synchronization.

| Location | Proposed storage | Purpose |
| --- | --- | --- |
| Central API server | MySQL / InnoDB | Authoritative branches, staff, orders, kitchen events, payments and reports |
| Electron desktop | Existing local SQLite | Offline billing and later durable synchronization queue |
| Android/iPhone | On-device SQLite plus secure token storage | Cached menu, drafts and pending submission records |

Phones and desktop clients communicate with the API; they do not receive MySQL credentials or connect directly to the database. Use branch/organization identity in server authorization, queries, uniqueness constraints and references. Current per-branch SQLite databases are the existing implementation; a shared MySQL schema would need an explicit tenant/branch model and migration.

Do not replace the SQLite file path with a MySQL URL. The backend uses Node SQLite and SQLite-specific queries, migrations, transactions, partial unique indexes, rowid-based cash cutoffs and snapshot tooling. Introduce a storage boundary and MySQL migrations; translate each invariant explicitly. Preserve stable order/payment IDs, invoice references, integer-paise arithmetic and request IDs. Replace rowid-dependent cash cutoffs with explicit durable ledger sequence boundaries, preserving reconciliation behavior. Test constraints, concurrent writes, lock/deadlock retries, operation replay and reporting against MySQL itself.

Rehearse import using copied data: map branches, verify row counts, balance/tax/tender/refund totals, foreign keys and invoice references, and compare reports. Use a deliberate cutover with a write pause, verified backup and rollback procedure; do not maintain two writable authorities during migration. Existing SQLite VACUUM snapshots do not back up MySQL, so add server-appropriate backups and a tested restore procedure. Validate MySQL storage before a live multi-branch rollout. Native sample-data design can proceed before that migration, and a temporary integration test may use the current backend only if clearly identified.

Adding MySQL does not require rewriting the backend into NestJS or adding Prisma immediately. Choose those tools only if the implementation benefits justify the migration. See [MySQL InnoDB and the ACID model](https://dev.mysql.com/doc/refman/8.4/en/mysql-acid.html).

## Phone layout and navigation

Use the existing BillMitra green identity, readable neutral backgrounds, labelled icons and restrained status colors. Design around 360-430 logical-unit phone widths, test narrow layouts and adapt to tablets. Target at least 48 logical-unit touch controls, readable native text, screen-reader labels, dynamic text sizing and sufficient contrast. State names must remain understandable without color. Handle Android back navigation, iPhone safe areas, keyboard avoidance and app resume explicitly.

The top bar shows BillMitra, branch name, staff identity and connection state. Bottom navigation has **Tables / Orders / Account**. Menu and Review belong to the selected table; they are steps in taking an order, not extra permanent tabs. Keep the active table visible throughout ordering. In the actual app, a bottom review action stays within thumb reach, accounts for safe-area insets and does not cover content or the software keyboard.

| Screen | Content | Primary action |
| --- | --- | --- |
| Sign in | Branch identity, native username/password form, device session and helpful connection errors | Sign in to assigned branch |
| Tables | Floor selector, table name, seats if configured, occupancy, draft indicator, ready-batch count | Open a table |
| Menu | Table/floor header, search, category chips, item name/price/availability, quantity controls | Review new items |
| Review | New quantities, line-specific kitchen notes, subtotal estimate, already-sent items in a separate section | Send to kitchen |
| Orders | Table/batch history, preparing/ready/served states, last refresh and ready filter | Open ready batch / mark served |
| Account | Staff/branch, pending submissions, app version/device details, sign out | Resolve pending work or sign out |

Show table occupancy separately from preparation and payment. A single table can have one ready batch and another still cooking. Do not reduce that situation to a misleading single table color. An empty table becomes occupied only after server acceptance, not merely because a local draft exists.

Allow the waiter to switch between tables while preserving separate drafts. Show a visible count on tables with drafts. Tapping Add increases a matching draft line, but the same product with different notes must remain separate (for example, one normal and one without chilli). Removing a draft line is local; changing a sent line requires the later correction workflow.

## Feature scope

### First working phone release

- Branch-aware waiter login and role-based landing screen.
- Floor/table browsing, menu category/search and availability indicators.
- Per-table drafts with quantity and per-line kitchen notes.
- Clear separation of already-sent items and new additions.
- Review screen and server-confirmed kitchen submission.
- Durable request identity across timeout, reload and retry.
- Table/order refresh while visible, including return from a locked/backgrounded phone.
- Ticket-level preparation status and ready list through a waiter-safe read endpoint.
- Connection and stale-data messages that do not erase drafts.
- Signed Android and iOS builds with app icons, launch screen, secure login storage and native draft recovery.

### Service workflow extension

- Mark a ready batch served, recording waiter and server time. Kitchen preparation and service acknowledgement have distinct ownership.
- Request the bill; cashier receives a visible acknowledgement/status. This does not create a payment or close the table.
- Explicitly assign/reassign tables, then offer a real "My tables" filter. Do not infer ownership from the last editor.
- Request a correction/cancellation with a reason; manager authorization produces an audited adjustment and kitchen notice. Never silently delete a sent batch.
- Optional in-app sound after user interaction and a persistent visual ready cue. The core flow must work without notifications or sound.

### Later enhancements

- Malayalam interface and separately maintained translated menu names.
- Portions, modifiers, courses and seat-level ordering after menu/pricing contracts support them.
- Push notifications where supported, without relying on background delivery for order correctness.
- Table transfer/merge, customer self-ordering and printer dispatch as distinct, reviewed features.
- Full offline branch operation and desktop synchronization, with explicit conflict handling and restoration tests.

## Submission and offline rules

The first phone release preserves drafts when disconnected and requires a reachable server to submit. A draft never displays "sent to kitchen" until the server has committed the order and kitchen ticket. Cached menu prices are estimates; the server owns current availability and billing calculations.

```text
Draft -> Sending -> Accepted
              \-> Confirming result -> Accepted / Rejected
              \-> Rejected -> Review corrected draft -> new submission
```

1. Store drafts in on-device SQLite, scoped by server identity, branch, authenticated staff, table and active order identity. Retire a draft when its table's old order has closed; never attach it automatically to the next party seated there. Local drafts are not server backups; uninstalling/clearing app data can remove them.
2. Before the first send, persist an immutable operation UUID and canonical payload. Give draft lines their own IDs. Keep the submitted payload separate from the editable draft.
3. Disable duplicate submission while awaiting an answer. A timeout/lost response means "confirming result", not proof of failure. Reconcile/retry that exact operation, including after a reload. Do not permit edits to silently create a new operation until the previous result is known.
4. Backend replay is keyed by branch and operation ID, checked against staff/device context and a payload fingerprint. Identical replay returns the original acknowledgement; different data under the same ID is rejected. Resolve a previously accepted operation after current authorization and fingerprint checks but BEFORE mutable table/payment/menu checks: a lost response must remain recoverable after the table is paid or prices change.
5. Commit order additions, kitchen batch and acknowledgement together. The response includes order ID, batch ID, accepted lines, totals and server time. A later menu/table refresh failure must not undo the accepted state or invite another send.
6. Never silently change a submitted price or product. If the menu changed since review, return a reviewable mismatch and require a fresh confirmation. If another waiter opened the table, show that order and preserve the draft; joining it is explicit.
7. Unsent drafts require the waiter's Send action after reconnection. Only already-submitted, immutable operations are reconciled automatically. Run recovery while the app is active/on resume and provide a visible Retry action. Correctness must not depend on the OS keeping the app alive in the background.
8. Reauthentication is required after session expiry. Pending work remains bound to its original staff and branch. New staff cannot read or replay another staff member's drafts. Sign-out/branch switching must resolve or explicitly handle pending work and clear private views; no replay under a replacement session.
9. Native application updates preserve/migrate the draft and submission database. Cache a limited scoped menu for drafting. Keep the native session token in platform secure storage; never store passwords or embed server secrets in the app. Signing credentials stay outside the repository. Clear or securely isolate private data on sign-out and device revocation.

## Server and permission changes

Add a focused waiter service and DTOs instead of letting the phone submit complete editable bill metadata. Proposed operations (names are provisional):

- `getWaiterWorkspace`: permitted tables, menu, batch summaries, server time and revisions.
- `submitWaiterItems`: operation ID, table/expected order identity, reviewed menu revision and new item lines. Server resolves existing discounts and protected metadata.
- `getWaiterSubmission`: acknowledgement lookup for the authenticated operation context.
- `getWaiterUpdates`: lightweight refresh with a cursor/revision; initially poll every 5 seconds while visible, with backoff on errors and immediate refresh on focus.
- `markWaiterBatchServed` and `requestTableBill`: later, explicit permissions and idempotent audited state transitions.

Preserve existing transactional append logic, table uniqueness checks and historical item snapshots. Extend idempotency with payload matching before moving callers to new commands. Use migrations for submission records, device sessions, service events and bill requests. Update backup compatibility alongside migrations: `electron/services/databaseBackups.cts` currently rejects migration counts above 15. Test old and new snapshots rather than leaving backup/restore validation behind the schema. Keep preparation statuses separate from payment statuses; the current kitchen use of `payment_pending` for handover must be mapped or migrated explicitly without changing historical bill state.

| Action | Waiter | Cashier | Kitchen | Manager/owner |
| --- | --- | --- | --- | --- |
| Add dine-in items | Allowed | Existing POS flow | No | Allowed |
| View relevant preparation state | Planned | Operational view | Allowed | Allowed |
| Set preparing/ready | No | No by default | Allowed | Allowed |
| Mark served / request bill | Planned | Explicit policy if needed | No by default | Planned |
| Record payment | No | Allowed | No | Allowed |
| Refund or authorize sent-item correction | No | No by default | No | Allowed / correction workflow planned |
| Edit menu | No | No | No | Manager and owner |
| Manage staff/settings permissions | No | No | No | Owner only |

Branch definitions currently come from configuration files/environment; there is no existing general branch-administration screen implied by this table.

All checks remain in the backend. Hiding buttons is not authorization. Branch-local accounts remain the first-release model; organization-wide memberships are part of later synchronization work.

## Folder arrangement

Add an isolated native application package under `apps/waiter-mobile`. Keep the existing desktop/web folders working. Expose portable `shared/` types and functions as a small workspace package when connecting the mobile build, with no Node/Electron/DOM dependencies. The native app must not import `Window['pos']`, desktop CSS or Node SQLite. This is the proposed arrangement, not folders already created:

```text
apps/
  waiter-mobile/
    package.json                    # Expo SDK-compatible dependencies
    app.config.ts                   # Android/iOS IDs and native settings
    eas.json                        # Development, preview and release builds
    assets/                         # App icons, splash assets, fonts
    src/
      navigation/                   # Native tabs and ordering stack
      screens/
        LoginScreen.tsx
        TablesScreen.tsx
        MenuScreen.tsx
        ReviewScreen.tsx
        OrdersScreen.tsx
        AccountScreen.tsx
      components/
        TableTile.tsx
        MenuItemRow.tsx
        QuantityStepper.tsx
        OrderBatchCard.tsx
        ConnectionBanner.tsx
      features/
        auth/                       # Device/staff/branch session lifecycle
        orders/                     # Draft, submission and status workflows
      services/
        apiClient.ts                # Native authenticated HTTP transport
        sessionStorage.ts           # Platform secure token storage
      database/
        migrations.ts              # On-device SQLite schema
        draftRepository.ts
        submissionRepository.ts
      hooks/                        # Polling, resume, retry, connectivity
      theme/                        # Native colors, spacing and text styles
      i18n/                         # English first; translated labels later
    tests/                          # Native unit/component tests
    e2e/                            # Android/iOS installed-app flows
src/                                # Existing desktop/web React interface
  pages/CashierPage.tsx
  features/kitchen/
  features/management/              # Existing management and waiter UI retained
  services/pos.ts                    # Renderer calls explicit desktop mode
shared/
  waiter.ts                         # Portable commands, DTOs and schemas
  clientContract.ts                 # Platform-neutral contract, no Window type
  domain.ts
  billing.ts
  posChannels.ts
  staffPermissions.ts
electron/
  main.cts                          # Main-process connected/local adapter
  preload.cts                       # Typed permitted bridge
  web.cts                           # Existing server process/configuration
  webServer.cts                     # Existing browser routes/protections
  nativeApi.cts                     # New authenticated native-client routes
  security/deviceSessions.cts       # Expiry/revocation and branch binding
  services/remotePos.cts            # Connected desktop client, secure credentials
  services/waiterOrders.cts         # Transactional waiter operations
  database/waiterSchema.cts         # Registered backend migrations
docs/
  waiter-phone-plan.md
```

Use native stack/tab navigation and authenticated deep links for app entry. Add npm workspace/build boundaries deliberately: keep Vite desktop builds and native Metro builds separate, choose the React version compatible with the Expo SDK, and check for duplicate runtime dependencies. Give native tests their own configuration; the root Vitest suite is not automatically a React Native renderer. Ignore native build caches, signing material and generated binaries appropriately. Update Electron compiler/packaging paths as native API modules are added. Preserve existing desktop asset handling and database paths. A neutral `server/` extraction is a later refactor, not a prerequisite for the first phone screen.

## Delivery phases and acceptance gates

| Phase | Deliverable | Evidence required before proceeding |
| --- | --- | --- |
| 1. Native design/build foundation | Create mobile package; native navigation/screens; signed test-build setup | Android and iPhone layouts reviewed; sample-data builds launch independently; existing desktop tests/build remain green |
| 2. Shared application integration | Device authentication, waiter API, explicit desktop connected mode and reliable submission | Real phone orders reach cashier/kitchen in Vengara; double tap, timeout, app restart and refresh failure create exactly one batch; two waiters' additions survive |
| 2b. Central database migration | Storage boundary, MySQL schema, invariant checks and import/restore rehearsal | Existing financial totals and invoice identities match; branch isolation, concurrent submissions and backups work on MySQL |
| 3. Live service | Ticket updates, ready view, served acknowledgement and bill-request inbox | Mixed ready/cooking batches remain accurate; cashier receives bill request; waiter cannot collect payment or change kitchen preparation |
| 4. Installation and pilot | Android APK/internal build, iOS TestFlight or registered-device build, upgrade/recovery checks | Both installed apps checked on staff phones; branch isolation, expired sessions, server restart and Wi-Fi loss recover clearly |
| 5. Offline desktop synchronization | Durable operations and conflict UI beyond connected mode | Desktop offline bills reconcile without duplicate invoices/payments or overwritten kitchen state; the full offline requirement remains gated until this passes |

Test functional state and integration behavior, not snapshots that merely mirror component output. Keep existing test/lint/build checks, add native unit/component tests and installed-app end-to-end flows, and verify both real Android and iPhone devices for keyboard overlap, safe areas, scrolling, text scaling and background/resume. The pilot should include waiter phones, the kitchen application and Electron cashier simultaneously, with realistic menu size and staff feedback.

Important scenarios: a table is paid while a draft is open; two waiters start the same available table; unavailable item or changed price at send time; identical product with different notes; accepted send followed by failed refresh; wrong branch; revoked device/staff; submitted operation restored after app restart; app update during confirmation; server restart after commit; app data cleared; one ready batch while another is preparing. Verify that a network error in connected desktop mode never silently writes to its unrelated local database.

## References and remaining choices

React Native recommends a framework such as Expo for new native applications: [React Native setup](https://reactnative.dev/docs/environment-setup). Expo supports [on-device SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/) and [secure credential storage](https://docs.expo.dev/versions/latest/sdk/securestore/); these support the proposed draft/session architecture. This is a design recommendation, not an assertion that those dependencies are installed.

For Android trials, generate a signed release/preview APK rather than an AAB intended for a store or a development-only client: [Expo APK builds](https://docs.expo.dev/build-reference/apk/). For iPhone trials, plan TestFlight or an appropriate signed registered-device distribution; iOS signing/provisioning and developer-account setup are required. See [Expo internal distribution](https://docs.expo.dev/build/internal-distribution/). This Windows workspace requires an appropriate macOS build environment or cloud build service for iOS; choose that service/account before the signed iPhone build milestone. No build-service account, signing credentials, store submission or payment is created by this plan.

Before the staff pilot, collect actual floors/table names, busiest expected phone count, OS versions, menu categories, and preference for shared versus assigned tables. Hosting/domain, developer/build accounts, supported printer flow and full offline phone operation remain separate decisions. These do not block the design work. This plan does not provision hosting, build an APK/IPA, publish an app, reorganize runtime code or claim synchronization is implemented.
