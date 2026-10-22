# BillMitra Architecture Audit

Audit date: 2026-10-14

## Current architecture and data flow

The application is a Windows Electron desktop app with a React 19 and TypeScript renderer built by Vite. The renderer starts at `src/main.tsx` and currently renders the cashier page directly. It calls typed wrappers in `src/services/pos.ts`, which use the narrow `window.pos` API declared in `src/types/pos.d.ts`. `electron/preload.cts` exposes that API with `contextBridge`; each method invokes a named IPC channel. `electron/main.cts` registers those handlers, validates request payloads with Zod, performs business operations, and owns a synchronous SQLite connection using Node's built-in `node:sqlite`.

The local database is `harbor-pos.sqlite` under Electron's per-user `userData` directory. SQLite enables WAL and foreign keys. Versioned migrations and demo seeding currently run in `electron/main.cts` during application startup. Order and payment writes use transactions. Order creation and payment requests carry unique request IDs to prevent duplicate writes on retry. Money is represented as integer paise; tax rates and percentage discounts use integer basis points.

There is no MySQL connection, central API, offline synchronization queue, multi-branch synchronization, or database credential configuration. The local SQLite database is the working offline persistence mechanism and must not be replaced by a remote-only store.

## Feature status

### Implemented, with stated MVP/demo limitations

- Cashier menu/category selection, item quantities and notes, floor/table views, takeaway `P-1` through `P-100`, and delivery `HD-1` through `HD-100`.
- Local order creation and history, order snapshots of sold item names/prices/tax rates, GST-demo calculations, invoice-level fixed/percentage discounts, and full-bill local payment records for cash, UPI, or externally processed card payments.
- Invoice preview and system print dialog; KOT preview and system print dialog.
- Local delivery management with searchable/date-filtered schedules, managed riders and workload limits, promised pickup/delivery times, assignment and permission-checked reassignment, ready/dispatch/deliver/fail/cancel transitions, and timestamped event/audit history.
- Device-local manager PIN setup and approval for bill voids, including a hashed PIN, attempt lockout, reason, and local audit entry.
- Local owner setup, username/password sign-in, staff account creation/listing, fixed role permissions, in-memory per-window sessions, and main-process authorization for cashier operations.
- Electron renderer has `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. The preload exposes named operations rather than raw IPC or database access. The main window denies popups and navigation away from its expected renderer URL.

These features do not constitute legal/tax certification, payment-gateway settlement, integrated printer discovery, a kitchen display, configurable per-permission roles, centralized staff identity, or server synchronization.

### Partial or unavailable

- Staff accounts are local to one Windows user. Role permissions are fixed in code. The owner can create/list accounts, but account editing, deactivation, password reset, and owner recovery are not implemented.
- Kitchen, inventory, and accountant roles can sign in but their workspaces are not implemented; they are not granted cashier access.
- Payments are full-bill local records only. There are no partial/split payments, refunds, cash change calculation, or gateway verification.
- KOT printing is a preview/system print request. There is no kitchen display, station routing, or integrated printer driver.
- The staff-call control is explicitly unavailable. Delivery management is device-local; it does not provide rider logins, GPS tracking, route optimization, push notifications, or cloud synchronization.
- `src/pages/CashierPage.tsx` is the only application screen. There are no working destinations for dashboard, product administration, inventory, customers, reports, shifts/day closing, expenses, branch management, or settings.
- Feature folders for customers, inventory, products, reports, and settings are not evidence of implemented workflows. Existing feature code is limited to cashier-related billing, delivery, kitchen-ticket preview, payment/history, and manager-action dialogs.

## Database, offline, and security risks

1. Migrations, seed data, SQL repositories/business operations, and IPC registration are concentrated in `electron/main.cts`. Extraction without integration tests could break existing local data or financial workflows.
2. Staff and delivery schemas have temporary in-memory SQLite migration tests, and delivery lifecycle tests exercise transactions, capacity, permissions, history, and rollback. There is still no full migration-chain test against a copy of a real user database or live Electron IPC/window integration test.
3. There is no in-app backup/restore workflow documented as verified. Before structural DB changes or new financial tables, establish a consistent backup/restore path and test it against a copy of an existing database.
4. The app is offline-capable for local billing, but it has no pending/synced/failed operation states or conflict resolution. Do not claim synchronization works.
5. The manager PIN is local approval for voids, separate from staff authentication. The owner password and manager PIN have no recovery flow. Sessions are held in memory per Electron window and are not centralized across computers.
6. The workspace is not a Git repository. A Git checkpoint and diff cannot be produced here. No source files or local database files were copied as a backup during this audit.
7. Direct MySQL access from the desktop client would expose credentials and couple client availability to the network. Any central MySQL deployment should be accessed through a separately secured API, while retaining local SQLite for offline operation.

## Proposed structure and migration plan

No source files are moved in the audit stage. Keep these entry points and compatibility surfaces:

- `src/main.tsx`, `src/pages/CashierPage.tsx`, and the existing styling remain the renderer entry and current UI.
- `electron/main.cts`, `electron/preload.cts`, and `electron/tsconfig.json` remain Electron entry points/configuration.
- `src/services/pos.ts`, `src/types/pos.d.ts`, and `shared/` remain the renderer API and shared domain contract.
- Keep the existing SQLite file name, location, migration ledger, and stored data format unless a separately tested migration explicitly changes them.

Recommended incremental sequence:

1. Establish a backup/restore procedure for a copied SQLite database and verify it before changing the live schema.
2. Add focused SQLite migration, repository transaction, and IPC contract tests using temporary databases and test-only data.
3. Extract migration/schema code and repositories from `electron/main.cts` into `electron/database/` without changing query behavior or IPC contracts; retain `main.cts` as bootstrap.
4. Implement cashier shifts/day closing next, now that local authenticated staff identities and permission checks are in place. Link payments and cash movements to the authenticated staff/shift transactionally.
5. Add customers, inventory, reports, and other operational areas only with their data model, transaction rules, authorization, functional UI, and tests.
6. Design a central API, MySQL schema, and explicit synchronization/conflict handling as a separate connected-platform stage. Do not put MySQL credentials in the renderer or expose MySQL directly to cashier computers.

Do not create empty modules, fake report data, decorative navigation destinations, or automatic destructive migrations.

## Verification recorded for this audit

Commands executed against the existing project during the audit and staff-foundation stage:

- `npm.cmd test` — passed, 10 test files and 44 tests, including billing calculations, staff authentication/permissions, delivery lifecycle and schedule helpers, and temporary in-memory SQLite schema tests.
- `npm.cmd run lint` — passed.
- `npm.cmd run build` — passed, including TypeScript, Vite, and Electron TypeScript builds.

## Staff-authentication foundation implemented after the audit

- Added migration 10, which creates local staff accounts without altering existing bill, payment, or product rows. The schema is in `electron/database/staffSchema.cts` and is applied transactionally by the existing migration runner.
- First launch requires an owner username, display name, and password (12–128 characters). There are no seeded credentials. Passwords are scrypt-hashed with a random salt in the Electron main process; five failed attempts lock an account for five minutes.
- The owner can create and list local manager, cashier, kitchen, inventory, and accountant accounts. Role permissions are a fixed code-defined matrix, not yet editable per permission. Account editing, deactivation, and password reset are not implemented.
- IPC sessions are held in memory per Electron window and are cleared when its web contents are destroyed. Sign-out clears renderer order/customer state. Restarting the app requires staff sign-in again.
- The Electron main process requires role permissions for POS access, order writes, discount changes, payments, voids, manager-PIN setup, duplicate KOT requests, and staff administration. Order, payment, void, PIN setup, and staff account creation events now record the authenticated username in the local audit log.
- Kitchen/inventory/accountant role identities can be created and authenticated, but this build has no corresponding workspace; those roles receive an explicit unavailable-module message rather than cashier access.

The build and unit/schema tests pass, but no live-window end-to-end sign-in test has been run. Existing databases will show owner setup until an owner account is created. Protect the Windows user account and keep the owner password safe; there is no local owner-password recovery flow. This is single-device authentication, not centralized production identity management.

## Delivery-management foundation implemented

- Added additive migration 11 for rider records, dedicated delivery status/timestamps, promised pickup time, customer area/landmark/instructions, and delivery-event history. Existing free-text courier names remain visible as unverified legacy data; the app does not automatically convert them into managed riders.
- Added an Electron-main delivery service and narrow validated IPC for schedule/history reads, rider management, schedule updates, rider assignment, and delivery lifecycle operations. Writes use SQLite transactions; rider capacity is rechecked in the assignment transaction. The existing cashier screen remains in place, with a dedicated delivery-schedule workspace.
- Assignment requires a ready, non-void delivery order and an active, available rider below capacity. Dispatch requires an assigned rider and customer name/address. Completion does not settle payment. Paid delivery cancellation is blocked because refunds are not implemented.
- Cashiers can view, assign, mark ready, dispatch, complete, or report a failed delivery. Reassignment, rider management, and cancellation require manager/owner permissions; reassignment and cancellation require a reason. Delivery changes are retained in both delivery history and the existing audit log.
- Unit tests cover schema preservation, schedule filtering/delay, permissions, default rider capacity, assignment and reassignment, lifecycle timestamps/history, retries after failure, payment independence, and rollback. These tests use temporary in-memory databases. The existing user database has not been opened or migrated during development, and no live Electron end-to-end test has been run.
- No cloud synchronization, rider accounts, GPS/routing, return-to-store workflow, business-timezone setting, or dedicated kitchen dispatch is implemented.
