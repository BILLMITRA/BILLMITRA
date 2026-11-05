# Delivery bills on WhatsApp

After a delivery order's customer details are confirmed with **Done**, BillMitra queues one itemized bill summary for that HD order if the cashier records the customer's WhatsApp consent. Dine-in and parcel orders are excluded. Saving a customer profile alone does not send an unfinished bill.

Set up the official Meta WhatsApp Cloud API for the restaurant. Obtain a phone number ID, a server-side access token with `whatsapp_business_messaging`, and an approved **utility** template. The template language must match the configured language code. Its body must have exactly four variables in this order:

1. Customer name
2. HD reference and bill number
3. Total in INR
4. Itemized lines with quantities and amounts

Example template body: `Hello {{1}}, your delivery bill {{2}} is ready. Total: {{3}}. Items: {{4}}. Thank you.` Have Meta approve the template before enabling sending. Configure the `BILLMITRA_WHATSAPP_*` values shown in `.env.example` as environment variables **on the restaurant server** and restart it. Never put the access token in a browser, mobile app, repository file, or chat.

The server keeps a pending outbox entry when credentials are absent. With credentials configured, the worker submits it to Meta. `accepted` means Meta returned a message ID; it does not prove phone delivery. A failed or ambiguous HTTP request is marked `needs_review` and is not automatically retried, to avoid duplicate WhatsApp bills. Review the `delivery_whatsapp_outbox` table and Meta's message status before any manual retry. The outbox has one entry per order; later order edits do not automatically resend a changed bill.

The current template sends the itemized bill **as text**, not as a PDF attachment. A later document-template integration can attach a PDF if required.
