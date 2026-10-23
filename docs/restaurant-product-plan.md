# Restaurant billing: desktop and web

## Product direction

The requested product supports multiple branches from the first unified release, shared online data, and offline desktop billing. No hosting account is available yet. The browser application supports separately configured branch databases and staff sessions. The desktop now has an explicit connected mode against the same branch server; its original local database stays separate. A separate Android/iPhone waiter application has initial native screens and API integration. Desktop/cloud offline synchronization and actual internet deployment are not implemented.

## Implemented foundation

- Added menu/category editing, UTC sales reports with CSV export, manual inventory and stock history, cash reconciliation, partial/split payments, bounded refund records, kitchen batches and a dedicated waiter role/screen.
- Added verified startup/manual/daily database snapshots, active-database leases and an offline restore command tested on temporary data.
- Added browser branch selection and per-branch database/session isolation. This is not yet consolidated organization administration or desktop synchronization.
- Prepared Docker/Caddy deployment files; Docker is unavailable here, so those files are unexecuted and not deployment-verified.

- Shared backend operations extracted into `electron/backend.cts`; the desktop retains main-frame checks at the IPC boundary.
- Browser HTTP adapter and local server reuse existing billing, payment, delivery, staff permissions, and migrations.
- Browser API integration tests cover sign-in/session isolation, permission denial, owner setup, order/payment retries, validation, cross-origin rejection, and reopening a database.
- Packaged assets use relative paths, and utility tests are included in the test runner.

## Shared architecture

- Reuse the React interface and shared billing arithmetic, domain types, validation, and permission definitions.
- The renderer uses desktop IPC or browser HTTP adapters against the same service contract.
- Transactional operations live in the shared backend and feature services. Preserve existing SQLite migrations and historical bills during further extraction.
- Enforce authentication, restaurant boundaries, permissions, validation, and financial invariants on the server for every browser operation.
- Retain local SQLite for offline desktop operation. Synchronization requires durable operation IDs, retries, conflict handling, and an explicit source of truth. Do not connect independent writable desktop and server databases without these rules.
- Keep printer integrations in the desktop adapter; use browser-supported printing for the web client.

## Delivery sequence and acceptance

1. **Stable desktop baseline:** verify packaged startup, sign-in, table orders, takeaway, delivery, discounts, payments, voids, and receipt/KOT printing. Include all existing source tests in automated checks.
2. **Data protection:** implement consistent database backup and restore; validate recovery using a temporary database and preserve financial history across migrations.
3. **Shared services and browser API:** extract order/payment services, introduce adapters, implement authenticated browser access, and verify permission and transaction behavior through integration tests.
4. **Restaurant operations:** add menu and pricing administration, restaurant receipt settings, daily sales and cash closing, staff lifecycle management, and audited corrections/refunds with explicit financial rules.
5. **Desktop/web synchronization:** define restaurant/device identities, invoice numbering, retry semantics, offline capabilities, and conflict resolution; test disconnections and repeated requests before enabling production synchronization.
6. **Release readiness:** verify installer upgrades, restored backups, representative printer workflows, multi-user access, monitoring, and the full order-to-payment flow on both clients.

## Outstanding product decisions

- Confirmed: multiple branches, shared online data, and offline desktop billing.
- Which browser operations must work without internet.
- Receipt sizes/printer models, payment integrations, business timezone, currency, and applicable tax/invoice requirements.
- Hosting, account recovery, data retention, and backup ownership.

This plan describes intended development; it does not mark unimplemented features as available or production-ready.

## Synchronization still required

The cloud must own organization, branch, device, staff membership and catalog identities. Every order, payment, refund, stock movement and audit event needs stable IDs and a durable operation ID. Invoice numbering must remain unique across offline devices without rewriting issued invoice references.

Implement a persisted desktop outbox and server inbox, authorized operation replay, acknowledgements, incremental downloads and visible pending/failed states. The server must recheck staff permissions and branch membership for every operation. Conflicting table occupancy, stale menu prices, stock changes, overpayments and revoked staff access need explicit resolution rules; never silently overwrite financial records.

Before enabling replication, test two devices creating orders offline, reconnecting out of order, repeating requests after a lost response, conflicting table orders, simultaneous payments/refunds, catalog changes during an outage, revoked permissions, clock differences and restoring a previously synchronized backup. Raw database uploads or SQLite file sharing are not an acceptable synchronization mechanism.
