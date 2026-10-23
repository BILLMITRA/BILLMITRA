# Waiter timers and desktop printing

Waiter app 1.0.2 (Android versionCode 3) adds an elapsed HH:MM:SS timer for each occupied table. Cards are blue before one hour and red from exactly one hour. The timer uses the saved order creation time in UTC, so adding items or reopening the app does not restart it. Closing the order frees the table at the next refresh. Floor tabs remain separate.

The installed desktop table board now uses the same timer and colour thresholds, updating every second. Each occupied card has **Print Bill** and **Print KOT** buttons. These open a saved-order print dialog; KOT printing lets the cashier choose a batch. Requests use the configured desktop printer routes, carry durable retry IDs across desktop restarts, and appear in the same branch print queue as phone requests. Card print buttons leave any unsaved cashier draft untouched. Available tables have no timer or print buttons. Browser table cards show the timers/colours; automatic printer routing belongs to the installed desktop application.

## Shop setup

1. Install the B POS printer's Windows driver on the cashier/kitchen computer. Print a Windows test page and set its default roll width (for example 80 mm or 58 mm) in printer preferences.
2. Open the updated **BillMitra Vengara** desktop shortcut, check **CONNECTED**, and sign in as owner, manager, or cashier. A kitchen staff account can operate KOTs only.
3. Choose **Desktop printers**. Select the installed **Cashier bill printer** and **Kitchen KOT printer**, enter the restaurant and branch names printed on paper, and save. The same installed printer can serve both routes. A blank selection leaves that kind of request queued.
4. Install waiter app 1.0.2 over the previous APK. Open a saved table, then use **Print bill** or select a **KOT batch** and use **Print KOT**. Unsent phone draft items are excluded.
5. Keep the desktop open, signed in, and connected to the same branch/server as the phones. Browsers do not run the automatic printer worker. A USB/Bluetooth printer must be installed in Windows; this release does not connect the phone directly to the printer.

The pilot HTTPS tunnel is temporary. Its address and an online desktop are still needed; this feature does not introduce offline synchronization or permanent hosting.

## What the statuses mean

- **queued**: Saved on the branch server, waiting for a configured, signed-in desktop.
- **printing**: Claimed by one desktop; submission is in progress.
- **submitted**: The Windows/Electron print callback accepted the submission. Physical output, paper supply and printer health are not confirmed by this callback.
- **failed**: Submission was rejected, or the queued bill became stale because its saved items changed or payment closed it. Resolve the cause and request again.
- **unknown**: The desktop interrupted printing or did not confirm in time. Check the printer before requesting a copy; the software does not automatically repeat uncertain jobs.

A phone retry uses its durable original request ID. Multiple desktops claim jobs transactionally. The desktop journals the print attempt before handing it to the spooler and retries only acknowledgement after a network failure. An abandoned claim becomes unknown after two minutes. Reprints are marked **COPY**, including a KOT warning to avoid preparing the same batch again. Printer settings and pending acknowledgements are scoped to the server and branch in Electron user data.

KOTs contain only the chosen immutable kitchen ticket batch, quantities and notes, without prices. Bills show all saved items and saved totals and are marked **UNPAID BILL**. Printing never records a payment. Voided orders are not dispatched, and stale queued bills fail rather than printing outdated totals. All requests/results are audited. Existing bill snapshots and menu data are preserved.

The backend migration adds `print_jobs` at schema version 16. Backup restore accepts versions 1–16. Deploy the updated backend and desktop along with the mobile app. Automatic startup snapshots protect existing on-disk data before migration.

## Validation

Run `npm run build`, `npm test`, and `npm run lint` at the root. In `apps/waiter-mobile`, run `npm test`, `npm run typecheck`, and Expo exports for Android/iOS. Queue, role checks, KOT batches, idempotent retries, stale bills, late acknowledgement, HTML escaping, restart recovery, and the one-hour timer boundary have automated coverage. A physical B POS print remains a shop acceptance check once its driver is installed and its route is selected.

For the shop acceptance check, take a small test order and confirm its table turns blue with a running timer. Add another item later and confirm the timer keeps its original start. Print the first and second KOT batches separately and check that each contains only that batch's items and notes. Print the bill and compare its saved quantities and total with the cashier. Reopen the phone app and confirm the timer continues; after closing the bill, confirm the table becomes available. Only a physical printer check can confirm paper width, margins, legibility, and whether output reaches the intended cashier/kitchen station.
