import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { SavedOrder } from '../../shared/domain.js'

type OutboxRow = { id: string; orderId: string; phone: string; payload: string }
type Receipt = { customer: string; reference: string; total: string; totalPaise: number; items: string }

function phoneForWhatsApp(value: string, countryCode: string): string | null {
  const digits = value.replace(/\D/g, '')
  const normalized = digits.length === 10 ? `${countryCode}${digits}` : digits
  return /^[1-9]\d{10,14}$/.test(normalized) ? normalized : null
}

export class DeliveryWhatsAppService {
  private timer: ReturnType<typeof setInterval> | undefined
  private sending = false

  constructor(private database: DatabaseSync, private settings = process.env) {}

  migrate(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS delivery_whatsapp_outbox (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','needs_review')),
      provider_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`)
    // A process crash during the HTTP request has an unknown send outcome.
    this.database.prepare("UPDATE delivery_whatsapp_outbox SET status = 'needs_review', last_error = 'Send outcome unknown after server restart' WHERE status = 'sending'").run()
  }

  queue(order: SavedOrder): boolean {
    if (order.type !== 'delivery' || !order.contactNumber || !order.deliveryAddress || !order.items.length) return false
    const phone = phoneForWhatsApp(order.contactNumber, this.settings.BILLMITRA_WHATSAPP_COUNTRY_CODE || '91')
    if (!phone) throw new Error('Enter the customer phone number with its country code before sending a WhatsApp bill.')
    const receipt: Receipt = {
      customer: order.customerName.trim() || 'Customer',
      reference: `HD-${order.deliveryNumber ?? order.orderNumber} / Bill #${order.orderNumber}`,
      total: `INR ${(order.totalPaise / 100).toFixed(2)}`,
      totalPaise: order.totalPaise,
      items: order.items.map(item => `${item.quantity} x ${item.productName} - INR ${(item.quantity * item.unitPricePaise / 100).toFixed(2)}`).join('\n').slice(0, 900),
    }
    const result = this.database.prepare(`INSERT OR IGNORE INTO delivery_whatsapp_outbox(id, order_id, phone, payload_json)
      VALUES (?, ?, ?, ?)`).run(randomUUID(), order.id, phone, JSON.stringify(receipt))
    return result.changes === 1
  }

  start(): void {
    if (!this.settings.BILLMITRA_WHATSAPP_ACCESS_TOKEN || !this.settings.BILLMITRA_WHATSAPP_PHONE_NUMBER_ID
      || !this.settings.BILLMITRA_WHATSAPP_TEMPLATE_NAME || !this.settings.BILLMITRA_WHATSAPP_API_VERSION) return
    const tick = () => { void this.flush().catch(error => console.error('WhatsApp outbox could not be processed:', error instanceof Error ? error.message : 'unknown error')) }
    tick()
    this.timer = setInterval(tick, 15_000)
    this.timer.unref?.()
  }

  stop(): void { if (this.timer) clearInterval(this.timer) }

  async flush(): Promise<void> {
    if (this.sending) return
    const { BILLMITRA_WHATSAPP_ACCESS_TOKEN: token, BILLMITRA_WHATSAPP_PHONE_NUMBER_ID: phoneId,
      BILLMITRA_WHATSAPP_TEMPLATE_NAME: templateName, BILLMITRA_WHATSAPP_API_VERSION: version } = this.settings
    if (!token || !phoneId || !templateName || !version) return
    this.sending = true
    try {
      const row = this.database.prepare(`SELECT id, order_id AS orderId, phone, payload_json AS payload
        FROM delivery_whatsapp_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 1`).get() as OutboxRow | undefined
      if (!row) return
      const current = this.database.prepare('SELECT total_paise AS totalPaise, voided_at AS voidedAt FROM orders WHERE id = ?')
        .get(row.orderId) as { totalPaise: number; voidedAt: string | null } | undefined
      const receipt = JSON.parse(row.payload) as Receipt
      if (!current || current.voidedAt || current.totalPaise !== receipt.totalPaise) {
        this.database.prepare(`UPDATE delivery_whatsapp_outbox SET status = 'needs_review',
          last_error = 'Bill changed or was voided before sending', updated_at = datetime('now') WHERE id = ?`).run(row.id)
        return
      }
      this.database.prepare("UPDATE delivery_whatsapp_outbox SET status = 'sending', updated_at = datetime('now') WHERE id = ?").run(row.id)
      try {
        const parameters = [receipt.customer, receipt.reference, receipt.total, receipt.items]
          .map(text => ({ type: 'text', text }))
        const response = await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(phoneId)}/messages`, {
          method: 'POST', signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: row.phone,
            type: 'template', template: { name: templateName,
              language: { code: this.settings.BILLMITRA_WHATSAPP_TEMPLATE_LANGUAGE || 'en' },
              components: [{ type: 'body', parameters }] } }),
        })
        const body = await response.json() as { messages?: Array<{ id?: string }> }
        const messageId = body.messages?.[0]?.id
        if (!response.ok || !messageId) throw new Error(`WhatsApp API returned HTTP ${response.status}`)
        this.database.prepare(`UPDATE delivery_whatsapp_outbox SET status = 'accepted', provider_message_id = ?,
          last_error = NULL, updated_at = datetime('now') WHERE id = ?`).run(messageId, row.id)
      } catch (error) {
        // A timed-out POST may have succeeded. Never silently retry and send twice.
        const reason = error instanceof Error ? error.message.slice(0, 200) : 'Unknown send result'
        this.database.prepare(`UPDATE delivery_whatsapp_outbox SET status = 'needs_review', last_error = ?,
          updated_at = datetime('now') WHERE id = ?`).run(reason, row.id)
        console.error(`WhatsApp delivery bill ${row.orderId} needs review: ${reason}`)
      }
    } finally { this.sending = false }
  }
}
