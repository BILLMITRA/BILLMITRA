# BillMitra Owner

One owner-focused Expo mobile app connected to the existing BillMitra server. It never connects to MySQL from the phone. The backend verifies the owner role and permitted branches for every request.

## Run

1. Start the BillMitra web server with its configured MySQL connection.
2. From this folder, run `npm ci` and `npm start`.
3. Sign in with an existing owner username and password. The app uses `https://owner.billmitra.shop` automatically for the current Vengara test.

For the current same-Wi-Fi Expo Go or preview APK test, follow [Test on phone](TEST-ON-PHONE.md). These test modes allow a private Wi-Fi HTTP address; the permanent owner app requires HTTPS.

For a permanent phone address, follow [owner remote access](../../docs/owner-remote-access.md). It uses a separate owner-only listener so the tunnel does not publish the cashier or waiter routes.

## Current working scope

- Home: real paid sales, paid bills, collections, refunds, discounts, tax and branch comparison.
- The owner app uses BillMitra's red and white colors and symbol. Home shows the last sales update and a manual refresh action; changing the branch or date clears the old summary while the new data loads.
- Orders: branch/date/status/search filters, server-side pagination and order details.
- Products: branch menu, prices and availability. Owners with a matching POS branch sign-in can add/edit products through the existing POS validation and sync them to MySQL.
- Inventory: current quantities, low-stock flags and confirmed stock adjustments through the existing POS movement workflow. A timed-out adjustment keeps the same request ID for safe retry.
- Reports: selected business date and branch financial summary, product leaders, latest paid bills and a shareable CSV summary. The report refreshes every 15 seconds while open and shows its last update time.
- Ask: controlled, read-only answers for sales, bill counts, branch and product leaders, active orders, average bill, payment methods and refunds. No arbitrary SQL or invented figures.
- Notifications: low-stock alerts derived from real inventory records. Staff: assigned active staff directory. Settings: owner session and accessible branches.

The POS still uses SQLite for some operational tables and synchronizes a projection to MySQL. Therefore kitchen timelines, delivery settlement, product variants/images, profit, supplier data, sales targets, push alerts, native speech and remote order write actions are not represented as finished owner features. Do not treat the current app as a production release until those integrations, remote HTTPS hosting, Android device QA, and backups are verified.

Sales definitions are in [PLAN.md](PLAN.md).
