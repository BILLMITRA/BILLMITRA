# Branch Control desktop app

Install `release-manager/BillMitra Manager Setup 0.1.0.exe` on the branch Windows PC. This is a separate **BillMitra Manager** Windows program. Sign in with a manager or owner account. It opens branch management directly, including staff, menu and prices, tables and cards, shortcuts, printer selection, reports, inventory, kitchen, cash closing, backups, and appearance. It uses the same branch data as the cashier and waiter apps.

When opened, BillMitra Manager checks the local server at `127.0.0.1:3017`. If the server is down, it starts the configured branch server from this shop's installation folder and waits for it to become ready. MySQL must be running. The server keeps running if the manager window closes, so waiter and kitchen phones can continue working. On this development PC, `web-data/mobile-test/Open BillMitra Branch Control.cmd` records the server installation folder for the separate program. The manager also checks the default `Desktop/billling sofware` location. For another shop PC, set `BILLMITRA_SERVER_HOME` to its BillMitra server installation folder before the first launch.

Install the bill and KOT printers in Windows first. In **Printers**, select each installed printer and save. Keep this desktop app signed in for phone print requests. Set paper width and automatic cutting in Windows printer preferences as needed.

BillMitra Manager has its own Windows app identity and can run beside the BillMitra cashier. Both connect to the branch server at `http://127.0.0.1:3017`. Printer settings belong to the particular desktop program; set printers in the program that should handle print jobs.
