# BillMitra MySQL 8.4 database

This folder contains the central server schema for a new MySQL installation.
The web server imports and reconciles branch records into MySQL before it listens.
Each waiter order and supported cashier order change checks MySQL, then commits
the updated branch projection to MySQL before responding. The cashier backend
still uses SQLite for its live bill view and several history tables; this is a
transition, not a complete MySQL-only conversion.

## Installation sequence

1. Install and configure MySQL Community Server 8.4. Keep the root password private.
2. On Windows, double-click Authorize Local Setup.cmd. Enter the root password
   only at the MySQL prompt. This creates a temporary MySQL login path.
3. Run bootstrap.cjs once. It creates the billmitra database using utf8mb4,
   imports 001_initial.sql if the database is empty, creates a dedicated
   limited application account, writes .env.mysql.local (Git ignored), and
   removes the temporary root login path. The old manual initializer remains
   available but is not needed with this sequence.
4. Run npm run mysql:check. It verifies the dedicated account and schema.
5. Run npm run mysql:preflight. It tests the current branch import in a MySQL
   transaction, compares bill counts and totals, then rolls back without
   changing MySQL. Take a verified backup of every existing branch SQLite
   database before a committed import.
6. Start the server. It imports branches, staff, menu, customers, orders,
   items, tenders, delivery assignments, inventory and audit events into MySQL.
   It checks bill and tender counts and totals on each synchronization.
7. Test browser/phone/desktop activity. Keep SQLite backups for rollback.

The command-line preflight always rolls back and rejects `--commit`. Only the
web server commits the synchronized projection after a successful reconciliation.
Kitchen tickets, print jobs, delivery settlements and some other operational
history still require a MySQL schema and service migration.

## Live cutover requirement

The restaurant chose online sales. The web server starts only after MySQL is
ready and checks MySQL before each waiter order or supported cashier order
change. A response succeeds only after MySQL synchronization. If the first
check fails, no sale is accepted. If synchronization fails after the SQLite
operation, retry with the same request ID; the retry synchronizes that order
without creating another one. The SQLite backend remains the source for the
cashier until the remaining services have a native MySQL implementation.

The schema uses one MySQL database with branch IDs on operational records.
Money is stored as integer paise, timestamps as UTC, and request IDs protect
retries from creating duplicate orders or payments. The desktop SQLite database
remains the offline store until its sync protocol is implemented.

The SQL file creates tables only. It does not create accounts, set passwords,
open MySQL to the internet or change the running BillMitra server.
