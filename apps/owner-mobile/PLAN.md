# BillMitra Owner implementation plan

The repository uses React/TypeScript for the cashier, Electron with a Node HTTP server, Expo/React Native for the waiter phone, and a MySQL 8.4 branch projection. The cashier still writes some operational records to SQLite and synchronizes mapped orders, tenders, menu, inventory and audit records to MySQL. There is no customer ordering website, realtime socket, recipe model, sales target, product image, modifier, or AI provider integration in this repository.

1. Reuse Expo for one separate owner mobile app. Keep the existing cashier and waiter apps intact.
2. Add owner-only, authenticated HTTP endpoints to the existing server. Authorize each branch in MySQL using `staff_branch_access`; never connect the phone directly to MySQL.
3. Build real read-only dashboard, orders, products, inventory, reports and typed business questions from the existing MySQL projection. Label unavailable data clearly.
4. Add management writes only through existing POS validation and synchronize them back to MySQL; do not write menu or order changes to the projection alone.
5. Add voice, push, and AI model integration after their native build, hosting, permissions, and server-side provider configuration are available.

Financial definitions: paid sales use non-voided orders with `paid_at` in the selected business date; discounts and tax are the stored components of those bills. Net collections are tenders received in the selected business date less refunds issued in that date. Unpaid and voided bills are not sales. Profit is hidden because reliable costs and expenses are unavailable.
