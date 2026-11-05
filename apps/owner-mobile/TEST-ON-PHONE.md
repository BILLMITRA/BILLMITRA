# Test BillMitra Owner on Android

This is a local Wi-Fi test. Keep this PC and phone on the same Wi-Fi. The PC must remain on with the BillMitra server running.

## Install the preview APK

Copy [BillMitra-Owner-Test-0.1.0.apk](builds/BillMitra-Owner-Test-0.1.0.apk) to your Android phone and open it to install `BillMitra Owner Test`. Android may ask you to allow installation from the app you used to open the file. The APK does not need Expo Go or the Expo Metro server. In the sign-in screen, enter the restaurant server address `http://192.168.220.3:3018`, your owner username, and your owner password. Open **Reports** to see today's paid sales, latest paid bills, and the last update time. The report refreshes every 15 seconds while the app is open.

If the PC's Wi-Fi address changes, check `ipconfig` and enter the new address with port `3018` on the sign-in screen. The APK will only connect while the phone is on the same Wi-Fi as this PC.

## Test with Expo Go

Keep Expo Metro running for this method.

1. Install **Expo Go** from the Android Play Store.
2. Open Expo Go and enter `exp://192.168.220.3:8081` (or scan the QR code shown by `npm start` in `apps/owner-mobile`).
3. On the BillMitra Owner sign-in screen, enter the server address `http://192.168.220.3:3018`, your owner username, and your owner password.

If Expo Go cannot load, run `npm start -- --lan --port 8081` in `apps/owner-mobile`, then scan its QR code. The PC's Wi-Fi address can change after reconnecting; check `ipconfig` and replace `192.168.220.3` in both addresses if needed.

If sign-in cannot reach the server, open `http://192.168.220.3:3018/api/health` in the phone's browser. It should show `"ready":true`. If it cannot load, check that both devices share Wi-Fi and allow Node.js on Windows **Private** networks if Windows asks. Do not open MySQL port 3306 or the cashier port 3017 to the internet.

This Wi-Fi HTTP mode is only for Expo Go and the preview APK. A permanent remote owner address requires the HTTPS setup in [owner remote access](../../docs/owner-remote-access.md).
