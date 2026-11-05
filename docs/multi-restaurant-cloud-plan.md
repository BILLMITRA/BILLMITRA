# BillMitra cloud plan for multiple restaurants and outlets

## Target

BillMitra serves independent restaurant companies. Each company owns one or more outlets; one early customer has about nine outlets. The cloud must support company-wide owners and reports while isolating each company's staff, customers, menu, orders, payments, and reports. An outlet can have its own prices, tables, printers, staff access, and invoice sequence.

```text
Cashier / waiter / owner apps at each outlet
                 |
              HTTPS
                 |
        BillMitra cloud API
                 |
       Managed MySQL 8.4 LTS

Outlet receipt and KOT printers remain on the outlet's local network.
```

The cloud API is the only component with database credentials. No app connects directly to MySQL. The API chooses the company and outlet from the authenticated session and checks membership on every operation. The owner app can request totals for all authorized outlets and drill into one outlet.

## Current implementation gaps

- `electron/web.cts` opens a SQLite database per configured branch. `database/mysql/import-branch.cjs` copies each SQLite branch into MySQL after writes. MySQL is a projection, not the transaction source for orders or payments.
- The importer derives `restaurantId` from `branchId`. That creates a different restaurant for each branch, even when several outlets belong to one company. A migration must assign a stable restaurant ID and map all its branches to it.
- The importer deletes and rebuilds some dependent MySQL rows during sync. It is not a multi-writer cloud synchronization protocol. Do not have nine independent outlet servers write to the same central MySQL tables using this importer.
- Browser sessions and staff checks live in the current web process and local branch backend. Cloud deployment needs persistent authentication/session handling and company and outlet authorization across restarts and multiple API instances.
- The existing owner listener and Cloudflare Tunnel guide serve a single restaurant PC. They are not the production host for all restaurants.
- Current desktop printing can remain local. Cloud orders need a secure outlet print bridge or a browser/desktop client that receives only its own outlet's jobs, with retry and duplicate-print handling.

## Delivery stages

1. **Identity and data model:** assign stable restaurant, branch, staff, device, and customer IDs. Add a company-to-branch migration, explicit branch membership, branch-scoped invoice numbers, and cross-company isolation tests.
2. **Central write API:** move order, item, payment, refund, void, and delivery writes into MySQL transactions behind authenticated HTTPS endpoints. Use durable request IDs so retries cannot create duplicate bills or payments. Remove the SQLite-to-MySQL full-copy path from live sales only after reconciliation against existing data.
3. **Pilot:** migrate a copied outlet database, reconcile bill counts and amounts, then run one outlet against the cloud while retaining its original database backup. Verify cashier, waiter, owner reporting, KOT, receipt, and payment flows.
4. **Nine outlets:** register each outlet under the same company, migrate outlets one by one, verify unique document numbering and branch-specific permissions, and compare owner totals with outlet closing reports.
5. **Multiple companies:** onboard a second test company and prove no staff, customer, menu, bill, or report can cross company boundaries.
6. **Operations:** automatic backups with restore rehearsal, monitoring, audit logs, deployment rollback, service startup, and load testing for peak concurrent devices.

## Domain and hosting

- Domain purchased: `billmitra.shop` through GoDaddy. Proposed service names are `api.billmitra.shop` for the cloud API and `app.billmitra.shop` for the browser app. Create DNS records only after the cloud host provides their targets. The domain did not resolve from the restaurant PC on 29 October 2026; verify its registration and nameservers in GoDaddy.
- A cloud API host and a managed MySQL 8.4 database in a suitable region. AWS ECS/Fargate plus RDS MySQL 8.4 is one supported option; choose capacity and pricing after a pilot load estimate. Keep MySQL on a private network, with the API as its only client.
- HTTPS termination, secret storage, backups, and monitoring. Avoid putting a database password in desktop or phone packages.

An outlet PC is not the central production server. A domain and Cloudflare Tunnel to one restaurant PC would only solve remote access to that one PC.

## Decision before live rollout

The current chosen policy requires MySQL for sales. With a cloud database as the source of truth, an internet outage would stop new sales at an outlet. Confirm whether that is acceptable for all outlets. If sales must continue during outages, build a durable local outbox with conflict rules and branch-reserved invoice numbering before rollout; simply enabling local SQLite writes and replaying the importer is unsafe.
