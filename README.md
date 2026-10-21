# BillMitra

BillMitra is an original restaurant point-of-sale MVP built with React, TypeScript, Electron, and SQLite. The current milestone covers the local cashier workflow: floor/table selection, a searchable sample menu, dine-in/takeaway/delivery drafts, quantities and item notes, GST-aware bill totals, and saving an open order to the cashier computer.

This is a development/demo build, not a production-ready or tax-certified POS. On first launch, create a local owner account; the owner can create local staff accounts with one of the fixed roles. Passwords are scrypt-hashed in the main process, and privileged IPC operations enforce role permissions. Manager/owner roles can apply discounts and void bills; voiding also requires a device-local manager PIN and a reason. Five failed PIN attempts lock voiding for five minutes. The manager PIN is set once and has no recovery/reset screen, so keep it safe. The cashier can apply permitted fixed or percentage invoice discounts, with tax recalculated on discounted item amounts; saved invoices can be previewed and printed through the system print dialog. Cashiers can record full-bill Cash, UPI, or external-terminal Card payments locally and search bill history. A saved bill can produce a duplicate kitchen ticket in the system print dialog; this is a local print request, not a kitchen display or printer integration. The local Delivery Schedule manages real saved delivery orders, rider capacity and availability, assignment/reassignment, pickup readiness, dispatch, completion, failure and cancellation history. Delivery completion never records payment. Delivery operations remain on this device and do not provide GPS tracking, rider logins, routing, cloud synchronization, or a configured business timezone. The staff-call control remains unavailable until the waiter workflow is implemented. Payments are records only; no payment gateway, settlement verification, partial payment, refund, or card-data collection is implemented. Staff roles for kitchen, inventory, and accounting are defined, but their respective workspaces are not implemented. Real payment processing, printer integration, kitchen and waiter clients, reports, inventory workflows, and cloud/multi-branch synchronization are not implemented. No payment-card data is collected or stored. Local accounts are device-specific and are not a substitute for a centrally managed identity system.

## Architecture and library choices

- React 19 and TypeScript implement the cashier renderer; Vite 8 serves it in development and produces the packaged web assets.
- Electron 44 hosts the Windows desktop app. Its renderer has context isolation enabled, Node integration disabled, and accesses only a small preload API.
- Electron's bundled Node 24 `node:sqlite` API provides local SQLite without an extra native-addon compiler/rebuild requirement. The main process applies a versioned schema migration, enables WAL/foreign keys, and commits order writes transactionally.
- Zod validates order and staff payloads at the IPC boundary. Shared TypeScript order types and integer-paise billing functions keep totals consistent across the UI and main process.
- Local username/password authentication uses scrypt hashes, in-memory Electron-window sessions, a five-attempt account lockout, and a fixed role/permission matrix enforced in the main process. Staff sessions end when the app process exits.
- The local delivery workflow is isolated in `electron/services/deliveryManagement.cts`, exposed through validated, permission-checked IPC, and persisted in additive SQLite migration 11. Rider capacity is rechecked inside `BEGIN IMMEDIATE` transactions at assignment time.
- Vitest 5 covers billing arithmetic, staff permissions/authentication, delivery lifecycle and search/delay rules, and SQLite schemas; Oxlint checks source. Electron Builder creates the Windows NSIS installer.

## Project structure

```text
src/
  assets/       Renderer images and static assets
  components/   Reusable interface components (table cards)
  features/     Feature modules (billing, delivery schedule and rider assignment, kitchen tickets, payments, security, staff)
  pages/        Application pages (cashier)
  services/     Renderer-to-Electron API calls
  styles/       Global and cashier stylesheets
  types/        Renderer and cart types
  utils/        Presentation and formatting helpers
electron/       Desktop main process and preload bridge
shared/         Types and billing logic used by both processes
public/         Static files copied by Vite
```

The current application still has one cashier page. Staff management supports creating and listing accounts, but does not yet support account editing, password reset, or account deactivation. Role permissions are fixed in code rather than configurable per permission. Dedicated inventory, customer, report, hook, and layout modules will be introduced alongside those features rather than as empty folders. SQLite and migration ownership remains in Electron's main process.

## Table ordering

The cashier opens on an **All tables** view for dine-in across every floor. Use the floor selector to narrow the list, or select a physical table card to open its order workflow. Takeaway has a dedicated screen with 100 selectable cards, `P-1` through `P-100`; home delivery has a separate set of 100 cards, `HD-1` through `HD-100`. Available cards start an order; active cards reopen it. A slot is released when its bill is paid or voided and can then be reused. Historical bills keep their original P/HD reference in history, invoices, and kitchen tickets. For a new delivery, add items and press **Done** to save the food order first. BillMitra then opens a full-screen recipient-details step; contact number and delivery address are required, while name, area, landmark, and rider instructions are optional. Entering a phone number used on a previous delivery looks up the latest saved delivery details on this device and fills them in; the current order's recipient details are stored with its bill. The right panel previews recipient details, ordered items, and the total before saving and opening the KOT print dialog. Use **Print KOT** to send the ticket to the selected system printer. **Print bill** opens the invoice/receipt preview for printing after the order is saved. The delivery bill includes a persistent **Delivery Schedules** and **Assign Delivery** toolbar. A promised delivery time can be selected before saving or edited in the saved Delivery Schedule. Use the **Delivery schedule** workspace for live persisted orders, date/status filters, rider workload, assignment/reassignment, order details, and event history. Managers/owners add and maintain riders; the default concurrent-delivery capacity is one. A cashier can mark an order ready, assign an available rider, dispatch, complete, or report failure. Reassignment and cancellation require manager/owner permission and a reason. Each transition is saved locally and audited. The delivery lifecycle is separate from food preparation and bill payment; completing delivery never settles an unpaid invoice. Existing free-text courier names from older orders remain visible as unverified legacy values until a real rider is assigned. After selecting a takeaway or delivery slot, the left side switches to the compact menu, with the bill and customer details on the right. In an open table order, the left side switches directly to a compact category-and-product tile menu inspired by the quick selection workflow in the reference; the table selector, bill, and cashier actions remain on the right. Use **Find a menu item** in the bill panel (or Ctrl+K) to search all available products, then select a result or press Enter to add it to the bill. Use **All tables** to return to the dine-in floor overview. Table cards show their floor, availability/order status, elapsed time, and current order amount where applicable.

## Requirements

- Windows 10/11 (for desktop use and Windows packaging)
- Node.js 22.12 or newer and npm
- Internet access for the first dependency install; local billing runs without internet after installation

## Install and run

```powershell
npm install
npm run dev
```

`npm run dev` builds the Electron main/preload TypeScript, starts Vite, then opens the desktop app. The development window uses the same local SQLite database as the packaged app.

On first launch, create the owner username, display name, and password (minimum 12 characters). Then use the **Staff** action to create cashier, manager, kitchen, inventory, or accountant accounts. Staff should sign out before handing the workstation to someone else. No default credentials are installed. No `.env` file, API key, or cloud service is required. All data for this milestone is local to the current Windows user.

## Build, test, and package

```powershell
npm test
npm run lint
npm run build
npm run package:win
```

The Windows installer is written to `release/`. SQLite uses Node's built-in `node:sqlite` API, so there is no separate native-addon rebuild step. Test the installer on a clean Windows machine before distributing it.

## Local data, migrations, and backup

The Electron main process owns SQLite through Node's built-in `node:sqlite` API and accepts only validated requests over a context-isolated preload bridge. The database is created at Electron's per-user `app.getPath('userData')` location as `harbor-pos.sqlite`. That filename is retained for compatibility with existing installations. It is local to this Windows user and is not synchronized or shared between devices.

Versioned migrations are in `electron/main.cts`; schema definitions are in `electron/database/`. Migration 11 adds local delivery riders, execution status, schedule/pickup/dispatch/completion timestamps, customer area/landmark/instructions, and delivery event history without deleting existing orders. Earlier free-text courier names are retained as legacy values and are not treated as verified rider assignments. The complete schema also includes the migration ledger, demo categories/products/tables, orders, immutable order-item price/tax snapshots, idempotency records, persisted invoice discounts/history, full-payment records, manager PIN credentials, void markers, audit records, reusable active takeaway (P-1 to P-100) and home-delivery (HD-1 to HD-100) slots, delivery metadata, and local staff accounts. Paid and voided bills are retained in history and released from active floor/table/service lists. If an existing database has more than 100 active orders of either numbered service type when upgrading, migration stops with an explicit error rather than hiding or reassigning some open bills. Back up the database, use the previous BillMitra version to pay or void enough active orders, then restart the upgrade. SQLite foreign keys and write-ahead logging are enabled. The first run seeds sample dishes and two floors; subsequent runs reuse the existing database.

For a manual backup or restore, exit BillMitra completely first, then copy `harbor-pos.sqlite` from the app's user-data directory to a secure backup location. Restore by closing the app and replacing that file with the backup. Keep backups access-controlled; do not copy a live database. Verify restored bills and totals before returning to service. There is no in-app backup/restore screen in this milestone.

## Tax and payment notes

Prices are stored as integer paise and the demo catalog uses illustrative per-product GST basis-point values. Discounts are applied to the invoice subtotal before tax, proportionally across line items when fixed-amount discounts are used. GST is calculated in the application and shown separately; the rates, invoice format, rounding, discount treatment, and tax configuration have not been reviewed for any restaurant's legal or tax obligations. The invoice preview is explicitly marked as a demo and not tax-certified. Validate those details with a qualified adviser before real use. There are no real card payments or payment credentials in this build.

## Next milestones

1. Cashier shifts and day closing attributed to authenticated staff accounts, followed by waiter tablet/mobile ordering with a durable submission queue.
2. Kitchen display with accepted/preparing/ready state transitions reflected in cashier and waiter views, plus the staff-call workflow.
3. Delivery address correction from schedule details, shift-based schedule filters, retry/return policies, configured business timezone, and rider accounts/mobile workflow.
4. Split/merge bills, account editing/deactivation and password reset, configurable granular permissions, manager PIN recovery, and printer adapters.
5. Product/category and tax configuration, inventory records, sales summaries, and verified backup/restore UX.
6. Secure multi-branch cloud service, authenticated synchronization, conflict resolution, and tested offline-to-online recovery.

Cloud sync is not present. Do not treat demo tax settings, local single-device staff accounts, or test orders as operational compliance or production-grade centralized security.
