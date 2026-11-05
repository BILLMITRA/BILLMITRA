import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DeliveryWhatsAppService } from './deliveryWhatsApp.cjs'
import type { SavedOrder } from '../../shared/domain.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function setup(settings: NodeJS.ProcessEnv = {}) {
  const database = new DatabaseSync(':memory:')
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE orders (id TEXT PRIMARY KEY, total_paise INTEGER NOT NULL, voided_at TEXT); INSERT INTO orders(id,total_paise) VALUES ('order-1',49800)")
  const service = new DeliveryWhatsAppService(database, settings)
  service.migrate()
  const order = {
    id: 'order-1', type: 'delivery', deliveryNumber: 1, orderNumber: 12,
    customerName: 'Shan', contactNumber: '9656684727', deliveryAddress: 'Vengara', totalPaise: 49800,
    items: [{ id: 'line-1', productName: 'Juice', quantity: 2, unitPricePaise: 24900 }],
  } as SavedOrder
  return { database, service, order }
}

describe('delivery WhatsApp outbox', () => {
  it('queues once only for a completed delivery bill and waits for credentials', async () => {
    const { database, service, order } = setup()
    const send = vi.fn()
    globalThis.fetch = send
    expect(service.queue(order)).toBe(true)
    expect(service.queue(order)).toBe(false)
    expect(service.queue({ ...order, type: 'parcel' })).toBe(false)
    await service.flush()
    expect(send).not.toHaveBeenCalled()
    expect((database.prepare('SELECT status FROM delivery_whatsapp_outbox').get() as { status: string }).status).toBe('pending')
    database.close()
  })

  it('sends the itemized template and records the Meta message ID', async () => {
    const settings = {
      BILLMITRA_WHATSAPP_ACCESS_TOKEN: 'test-token', BILLMITRA_WHATSAPP_PHONE_NUMBER_ID: '12345',
      BILLMITRA_WHATSAPP_TEMPLATE_NAME: 'delivery_bill_v1', BILLMITRA_WHATSAPP_API_VERSION: 'v23.0',
    }
    const { database, service, order } = setup(settings)
    service.queue(order)
    const send = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) })
    globalThis.fetch = send
    await service.flush()
    expect(send).toHaveBeenCalledOnce()
    const [url, request] = send.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v23.0/12345/messages')
    const body = JSON.parse(request.body)
    expect(body.to).toBe('919656684727')
    expect(body.template.components[0].parameters.map((value: { text: string }) => value.text)).toEqual([
      'Shan', 'HD-1 / Bill #12', 'INR 498.00', '2 x Juice - INR 498.00',
    ])
    expect((database.prepare('SELECT status, provider_message_id AS id FROM delivery_whatsapp_outbox').get() as { status: string; id: string })).toEqual({ status: 'accepted', id: 'wamid.1' })
    database.close()
  })

  it('flags an ambiguous send for review without automatic retry', async () => {
    const settings = {
      BILLMITRA_WHATSAPP_ACCESS_TOKEN: 'test-token', BILLMITRA_WHATSAPP_PHONE_NUMBER_ID: '12345',
      BILLMITRA_WHATSAPP_TEMPLATE_NAME: 'delivery_bill_v1', BILLMITRA_WHATSAPP_API_VERSION: 'v23.0',
    }
    const { database, service, order } = setup(settings)
    service.queue(order)
    const send = vi.fn().mockRejectedValue(new Error('Timeout'))
    globalThis.fetch = send
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await service.flush()
    await service.flush()
    expect(send).toHaveBeenCalledOnce()
    expect((database.prepare('SELECT status FROM delivery_whatsapp_outbox').get() as { status: string }).status).toBe('needs_review')
    error.mockRestore()
    database.close()
  })

  it('does not send a bill that changed while waiting for API credentials', async () => {
    const { database, service, order } = setup({
      BILLMITRA_WHATSAPP_ACCESS_TOKEN: 'test-token', BILLMITRA_WHATSAPP_PHONE_NUMBER_ID: '12345',
      BILLMITRA_WHATSAPP_TEMPLATE_NAME: 'delivery_bill_v1', BILLMITRA_WHATSAPP_API_VERSION: 'v23.0',
    })
    service.queue(order)
    database.prepare('UPDATE orders SET total_paise = 50000 WHERE id = ?').run(order.id)
    const send = vi.fn()
    globalThis.fetch = send
    await service.flush()
    expect(send).not.toHaveBeenCalled()
    expect((database.prepare('SELECT status FROM delivery_whatsapp_outbox').get() as { status: string }).status).toBe('needs_review')
    database.close()
  })
})
