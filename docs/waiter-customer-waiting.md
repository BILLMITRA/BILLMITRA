# Waiter phone customer waiting alert (simulation)

This first stage is available only in the **Dining** workspace of the BillMitra waiter phone app. It does not display an alert or play a sound on the cashier desktop or Kitchen workspace.

## Try it

1. Sign in to the Dining workspace on a waiter phone. An owner or manager can use the same Dining workspace to run the test.
2. On **Tables**, the owner or manager taps **Table name: Confirm seated** under **Seating simulation**. The table must have no open order.
3. After five full minutes, connected Dining phones show one compact **Customer waiting · Table 01** Android notification. It appears as a top banner while the app is open, and as a phone notification when the app is minimized or locked. It uses the staff alert sound and vibration channel. Allow notifications when Android asks. Use an installed Android APK; Expo Go cannot receive this push.
4. Tap **Open table** to take the order, or **Acknowledge** to mark the alert acknowledged for all connected Dining phones. Acknowledging leaves the alert visible until the order is placed or the customer leaves.
5. An accepted dine-in order resolves the alert automatically. The manager can tap **Confirm left** if the seating simulation was wrong or the customer left. A later **Confirm seated** starts a new session and timer.

The server stores seating sessions and alerts in the branch SQLite database, with one alert per session. It evaluates the five-minute threshold every five seconds even if no phone is open, using the server clock. The server checks for an order in the same transaction as alert generation, and accepted orders resolve the active session in their order transaction. Sound playback is tracked locally on each phone, so a refresh or app restart does not replay an already heard alert.

This is a **tap-based trial**, not CCTV detection. The camera or DVR model and its authorized RTSP/ONVIF connection are still needed for real seating detection. Android renders the heads-up card using BillMitra branding and the phone's notification style; it cannot copy WhatsApp's private layout. Push delivery requires the restaurant server, its public mobile API, Expo push credentials, an installed APK, Android notification permission, and a signed-in Dining session. The in-app alert remains visible even if push delivery fails. Physical-phone delivery has not yet been verified.
