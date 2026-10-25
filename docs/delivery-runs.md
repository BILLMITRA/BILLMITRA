# Delivery runs and rider settlement

Open **Delivery schedule** from the cashier. Create and save HD orders. Select **Assign multiple**, choose a rider, tick HD-1, HD-5, or other orders, and press **Done**. A rider must be available and have enough active-delivery capacity. A failed assignment leaves the entire selection unassigned. Managers can edit rider capacity under the rider details. Mark food **Ready** before pressing **Dispatch**.

The schedule shows the assigned rider, staff phone, assignment time, customer phone, location, delivery state, and bill amount. Open an HD reference for its items and complete delivery history. Mark **Dispatch** when the rider leaves and **Delivered** when confirmed. Delivery completion never records payment.

Tick several unpaid HD rows and select **Print selected bills** in the desktop app. Each bill enters the existing desktop bill-printer queue separately. Check printer settings and the queue if a request fails or its status is unknown; a spooler acknowledgement does not prove paper came out.

Select **Rider settlement** to choose a staff member and optional assignment-date range. The report lists each assigned bill and its current delivery and payment status, bill value, recorded net payments, and remaining balance. **Export all bills (CSV)** saves the list.

When the rider hands cash to the cashier, enter the amount actually received beside each **delivered** bill and press **Confirm cash handover**. The full handover is saved atomically with a separate cash payment on each selected bill. Partial amounts leave the remaining bill balance open. An exact retry returns the existing handover instead of recording cash twice. The history shows the date, cashier, bill references, amounts and any later refunds. UPI and card payments must be recorded through the regular payment flow. Do not select unpaid bills as cash received until the rider actually hands over the money.
