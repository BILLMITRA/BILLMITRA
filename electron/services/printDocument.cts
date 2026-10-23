import type { PrintDocument, PrinterSettings, PrintKind } from '../../shared/printing.js'

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const money = (value: number) => `Rs ${(value / 100).toFixed(2)}`
export function printDocument(kind: PrintKind, document: PrintDocument, settings: PrinterSettings): string {
  const order = document.order
  const kot = kind === 'kot'
  const rows = order.items.map(item => `<tr><td>${item.quantity} × ${escape(item.productName)}${item.note ? `<br><b>Note: ${escape(item.note)}</b>` : ''}</td>${kot ? '' : `<td>${money(item.quantity * item.unitPricePaise)}</td>`}</tr>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${kot ? 'KOT' : 'Bill'} ${order.orderNumber}</title><style>
    @page{margin:4mm}body{font:13px Arial,sans-serif;color:#000;margin:0}h1{font-size:20px;margin:4px 0}h2{font-size:17px}p{margin:5px 0}header{text-align:center}table{border-collapse:collapse;width:100%;margin:10px 0}td{padding:6px 0;vertical-align:top;border-bottom:1px dashed #999}td+td{text-align:right;white-space:nowrap}footer{border-top:1px dashed #000;margin-top:10px;padding-top:6px}tr{break-inside:avoid}.totals{text-align:right}.total{font-size:18px;font-weight:bold}
    </style></head><body><header><h1>${escape(settings.restaurant || 'BillMitra')}</h1><p>${escape(settings.branch)}</p><h2>${kot ? 'KITCHEN ORDER TICKET' : 'UNPAID BILL'}${document.copy ? ' · COPY' : ''}</h2></header>
    <p>Order #${order.orderNumber} · Table ${escape(document.tableName)} · ${escape(document.floor)}</p><p>Opened: ${escape(order.createdAt)} UTC</p><p>Waiter: ${escape(document.requestedBy)}</p>
    ${kot ? `<p>Batch: ${escape(document.ticketId)}<br>${escape(document.ticketCreatedAt)} UTC</p>${document.copy ? '<b>COPY — check before preparing again</b>' : ''}` : '<p>Saved items only · Payment not recorded by printing</p>'}
    <table><tbody>${rows}</tbody></table>${kot ? '' : `<div class="totals"><p>Subtotal: ${money(order.subtotalPaise)}</p><p>Discount: ${money(order.discountPaise)}</p><p>Tax: ${money(order.taxPaise)}</p><p class="total">Total: ${money(order.totalPaise)}</p></div>`}<footer>${kot ? 'Prepare this batch only.' : 'Please pay at the cashier.'}<br>BillMitra</footer></body></html>`
}
