# Waiter table actions and saved bills

The waiter app 1.0.4 uses a normal table tap to show the current saved order and its items. **Add items** opens the menu. The waiter adjusts quantities, reviews the draft, and taps **Done · Send new items**. Once the server accepts it, the current order screen refreshes with the new items. Unsent phone drafts stay local and are never included in a print or saved cashier bill.

Hold a table for two seconds to open **Print Bill**, **Duplicate KOT**, and **Save bill for cashier**. Duplicate KOT prints a clearly marked copy of the chosen kitchen batch. Both print options queue on the branch server for the configured desktop printer. Printer setup still requires an installed B POS driver and a matching printer selection on the desktop.

**Save bill for cashier** requires an open dine-in order and no unsent phone draft for that table. It keeps the original order, prices, kitchen tickets, table name, waiter name and amount due. It releases the table immediately, so another order can start there. Saving does not take payment or mark the bill paid. If the phone loses the response, **Retry saving bill** uses the original order ID and cannot save the next guests' bill.

The cashier app shows a **Saved Bills** count and a payment-due notice. Open **Saved Bills** to review the waiter, former table, items and total, then open the bill and record payment. The saved bill is removed from this list once paid or voided; its history remains. The desktop must be connected to the same branch server and updated to include this feature. The cashier list refreshes from the shared branch server every five seconds while the desktop app is visible.

The server applies SQLite schema version 17 to support saving and table reuse. It creates a database backup before migration. A temporary `trycloudflare.com` address may expire; use the current restaurant address on the phone and keep the server and tunnel running during service.
