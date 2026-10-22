# BillMitra

Restaurant billing software built with React, TypeScript, Electron, Node.js and SQLite. It runs as a Windows desktop application or a browser application served by Node.js. This remains a development build; visual end-to-end checks, production load testing, invoice requirements, and deployment verification are outstanding.

## Run

Use Node.js 24 and npm. Install dependencies with `npm install` if needed.

```powershell
npm run dev       # Windows desktop development
npm run web       # Build and start the browser application
```

Open **http://127.0.0.1:3000** for browser access. After a build, `npm run start:web` starts the server directly. Vite preview does not supply the API. The browser server binds only to this computer by default.

Create the owner account on first launch, then use **Staff** to create manager, cashier, waiter, kitchen, inventory, or accountant accounts. Passwords require at least 12 characters. Roles are enforced in the backend. Owner-password recovery, password reset, and account editing/deactivation are not implemented.

## Available workflows

| Workspace | Features |
| --- | --- |
| Cashier | Dine-in tables, 100 takeaway slots, 100 delivery slots, item search, quantities, kitchen notes, discounts, invoice/KOT previews and system printing, bill history, PIN-approved voids |
| Payments | Full or partial payments, split methods, payment/refund ledger, manager/owner refund records, retry protection and overpayment/refund limits |
| Menu management | Owner/manager category creation/editing, item creation/editing, prices, configured tax rates and availability; historical invoice line snapshots stay unchanged |
| Sales reports | Date-filtered paid sales, discounts, tax, collections, refunds, net collections, open balances, item quantities and CSV export; dates use UTC |
| Inventory | Inventory items, units, reorder levels, signed stock adjustments, low-stock indicators and movement history |
| Cash closing | Cash collections minus cash refunds since the last close, opening cash, counted cash, variance explanations and audited closings |
| Kitchen | Live preparation tickets, separate batches for newly added items, preparing/ready/handed-over transitions; paid tickets remain visible until handed over |
| Waiter | Dedicated table/menu view, item quantities and notes, new-order or existing-order additions; no payment, discount, refund or void access |
| Delivery | Recipient details, saved-customer lookup, schedules, rider workload/capacity, assignment/reassignment and delivery lifecycle/history |
| Backups | Owner-only manual snapshots, startup snapshots for existing databases, automatic snapshots every 24 hours while running, integrity verification and an offline restore command |
| Branches | Configurable browser branches with separate databases and staff sessions; branch selection before sign-in |

Cashier owners/managers open **Management** for menu, reports, inventory, kitchen, cash closing and backups. Kitchen, inventory and accountant accounts open their permitted workspace after sign-in. Waiter accounts open the table-ordering screen; owners/managers can also open it with **Waiter**. Open a saved bill and choose **Split payment / refunds** to inspect or record payments and refunds.

Payments and refunds are records of money processed elsewhere. There is no payment gateway or settlement verification, and no card details are collected. Refunds preserve the original invoice; automatic credit-note/tax adjustment documents are not implemented. Bills with unrefunded payments cannot be edited or voided. A fully settled invoice stays settled after a refund.

Inventory movements are manual; recipes, purchasing, suppliers, stock valuation, inter-branch transfers, and automatic ingredient deduction are not implemented. Cash closing does not track drawer expenses, bank withdrawals, or individual cashier shifts. Kitchen tickets do not provide station routing or printer hardware integration. The staff-call button remains unavailable.

## Branch configuration and data

`branches.json` currently configures **Vengara** with the stable ID `main`. Add branches to this file, or override the web server list through the environment:

```powershell
$env:BILLMITRA_BRANCHES = '[{"id":"main","name":"Main branch"},{"id":"north","name":"North branch"}]'
npm run start:web
```

Branch IDs are stable lowercase slugs. Each branch has independent owner/staff accounts, menu, stock, bills, closings and backups. The default `main` database is `web-data/billmitra-web.sqlite`; other branches use `web-data/branch-<id>.sqlite`. Change the storage directory with `BILLMITRA_WEB_DATA_DIR` and the port with `BILLMITRA_WEB_PORT`. Accounts and sessions cannot be reused across branches. There is no organization-wide staff administration or consolidated branch report yet.

The desktop database remains `harbor-pos.sqlite` under Electron's per-user `userData` directory. **Desktop and browser databases are not synchronized.** Desktop billing continues locally without internet; the browser requires its server. Offline desktop/cloud synchronization remains unfinished and must be completed before a unified multi-branch release.

Browser sessions use HttpOnly, SameSite cookies and expire after eight hours without activity or on server restart. API requests enforce same-origin checks, JSON limits and role permissions. Public/network hosting requires an HTTPS origin and a server setup token. See [deployment preparation](docs/deployment.md); no online deployment has been made.

## Backup and restore

Snapshots are saved under `backups/` beside the relevant database. They contain accounts and business data. Keep a separate secure copy outside the computer/server; snapshots on the same disk do not protect against disk loss. Backups are not automatically deleted or exported offsite.

To restore, stop all desktop/server processes that use the target database, then run:

```powershell
npm run restore -- "C:\path\to\database.sqlite" "C:\path\to\backup.sqlite"
```

The command verifies SQLite integrity, foreign keys and supported migration versions, rejects an active database lease, restores through a staging file, and retains the previous database as a `.before-restore-*.sqlite` recovery file. Run the application again and verify the restored records before returning to work. Restore has been tested using temporary databases; no existing business database was restored during development.

## Verification and packaging

```powershell
npm test
npm run lint
npm run build
npm run package:win
```

Tests cover billing arithmetic, staff permissions, delivery, browser sessions and branch isolation, migrations, menu snapshots, inventory rollback/retries, kitchen batches, waiter restrictions, split payments, refunds, cash reconciliation and backup/restore. The Windows installer is written to `release/`; verify it on a clean Windows machine before distributing it.

The backend uses integer paise, SQLite WAL/foreign keys, transactions, Zod validation, scrypt password hashes, idempotent payment/stock request IDs and audit records. New operations are in `electron/services/`; both Electron IPC and the browser API invoke `electron/backend.cts`. Migrations currently run through version 15.

Tax rates and invoices remain demo configuration and are not tax-certified. Receipt/printer requirements, business timezone, payment integrations, synchronization, hosting, monitoring, recovery and release testing remain part of the [product plan](docs/restaurant-product-plan.md).
