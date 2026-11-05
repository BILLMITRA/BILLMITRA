const { DatabaseSync } = require('node:sqlite')
const { createHash } = require('node:crypto')
const { resolve } = require('node:path')
const { loadMySqlSettings, connectMySql } = require('../../electron-dist/electron/mysqlConnection.cjs')

const uuid = value => {
  const hex = createHash('sha256').update(`billmitra:mysql-import:${value}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const json = value => {
  if (value == null || value === '') return '{}'
  if (typeof value !== 'string') return JSON.stringify(value)
  try { return JSON.stringify(JSON.parse(value)) } catch { return JSON.stringify({ original: value }) }
}

async function syncBranch({ source, branchId, branchName, pool, commit = false }) {
  const db = new DatabaseSync(resolve(source), { readOnly: true })
  const mysql = await pool.getConnection()
  const rows = table => db.prepare(`SELECT * FROM "${table}"`).all()
  const counts = {}
  const put = async (table, value) => {
    const columns = Object.keys(value)
    const updates = columns.filter(column => !['id', 'request_id', 'branch_id', 'staff_id', 'item_id', 'financial_year', 'document_type'].includes(column))
    await mysql.execute(`INSERT INTO \`${table}\` (${columns.map(column => `\`${column}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE ${updates.length ? updates.map(column => `\`${column}\` = ?`).join(',') : `\`${columns[0]}\` = \`${columns[0]}\``}`,
      [...columns.map(column => value[column] ?? null), ...updates.map(column => value[column] ?? null)])
    counts[table] = (counts[table] || 0) + 1
  }
  const restaurantId = uuid(`restaurant:${branchId}`)
  const unknownStaffId = uuid(`historical-actor:${branchId}`)
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('SQLite source failed integrity checks.')
    }
    await mysql.beginTransaction()
    await mysql.execute('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = ?)', [branchId])
    await mysql.execute('DELETE FROM delivery_assignments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = ?)', [branchId])
    const profile = rows('business_profile')[0]
    await put('restaurants', {
      id: restaurantId, legal_name: profile.legal_name, trading_name: profile.trading_name,
      gstin: profile.gstin, fssai_number: profile.fssai_number, phone: profile.phone,
      email: profile.email, created_at: profile.created_at,
    })
    await put('branches', {
      id: branchId, restaurant_id: restaurantId, name: branchName, address: profile.address,
      timezone: profile.timezone, currency_code: profile.currency_code,
      invoice_prefix: profile.invoice_prefix, created_at: profile.created_at,
    })
    const staff = rows('staff_users')
    const staffByUsername = new Map(staff.map(item => [item.username.toLowerCase(), item.id]))
    for (const user of staff) {
      await put('staff_users', {
        id: user.id, restaurant_id: restaurantId, username: user.username,
        display_name: user.display_name, role: user.role, password_salt: user.password_salt,
        password_hash: user.password_hash, active: user.active,
        failed_login_attempts: user.failed_login_attempts, locked_until: user.locked_until,
        created_at: user.created_at,
      })
      await put('staff_branch_access', { staff_id: user.id, branch_id: branchId })
    }
    // Historical tenders do not store a cashier ID. Never attribute them to the owner.
    await put('staff_users', {
      id: unknownStaffId, restaurant_id: restaurantId, username: `_historical_${branchId}`,
      display_name: 'Historical cashier unknown', role: 'accountant',
      password_salt: uuid(`salt:${branchId}`), password_hash: uuid(`hash:${branchId}`), active: 0,
    })
    for (const customer of rows('customer_profiles')) {
      await put('customers', {
        id: customer.id, restaurant_id: restaurantId, name: customer.display_name,
        normalized_phone: customer.normalized_phone, phone: customer.normalized_phone,
        email: customer.email, created_at: customer.created_at, updated_at: customer.updated_at,
      })
    }
    for (const address of rows('customer_addresses')) await put('customer_addresses', {
      id: address.id, customer_id: address.customer_id, address: address.address,
      area: address.area, landmark: address.landmark, instructions: address.instructions,
      created_at: address.created_at,
    })
    for (const category of rows('categories')) await put('menu_categories', {
      id: category.id, restaurant_id: restaurantId, name: category.name, sort_order: category.sort_order,
    })
    const products = rows('products')
    for (const product of products) {
      await put('menu_items', {
        id: product.id, restaurant_id: restaurantId, category_id: product.category_id,
        name: product.name, description: product.description, tax_rate_bps: product.tax_rate_bps,
      })
      await put('branch_menu_prices', {
        branch_id: branchId, item_id: product.id, price_paise: product.price_paise,
        available: product.available,
      })
    }
    const tables = rows('restaurant_tables')
    const floorNames = [...new Set(tables.map(table => table.floor))]
    for (const [index, name] of floorNames.entries()) await put('floors', {
      id: uuid(`floor:${branchId}:${name}`), branch_id: branchId, name, sort_order: index,
    })
    for (const table of tables) await put('dining_tables', {
      id: table.id, branch_id: branchId, floor_id: uuid(`floor:${branchId}:${table.floor}`),
      label: table.name, capacity: table.capacity,
    })
    const linkedCustomer = new Map(rows('customer_order_links').map(link => [link.order_id, link.customer_id]))
    const productIds = new Set(products.map(product => product.id))
    const orders = rows('orders')
    for (const order of orders) await put('orders', {
      id: order.id, branch_id: branchId, display_number: order.display_number,
      request_id: order.request_id, order_type: order.type,
      status: order.voided_at ? 'voided' : order.joined_at ? 'joined' : order.paid_at ? 'paid' : order.status,
      table_id: order.table_id, service_slot: order.type === 'delivery' ? order.delivery_number : order.type === 'parcel' ? order.parcel_number : null,
      customer_id: linkedCustomer.get(order.id) || null,
      customer_name: order.customer_name, contact_number: order.contact_number,
      delivery_address: order.delivery_address, delivery_area: order.delivery_area,
      delivery_landmark: order.delivery_landmark, delivery_instructions: order.delivery_instructions,
      subtotal_paise: order.subtotal_paise, discount_paise: order.discount_paise,
      tax_paise: order.tax_paise, total_paise: order.total_paise,
      created_at: order.created_at, updated_at: order.created_at,
      paid_at: order.paid_at, voided_at: order.voided_at, void_reason: order.voided_reason || '',
    })
    for (const item of rows('order_items')) await put('order_items', {
      id: item.id, order_id: item.order_id,
      menu_item_id: productIds.has(item.product_id) ? item.product_id : null,
      item_name: item.product_name, unit_price_paise: item.unit_price_paise,
      tax_rate_bps: item.tax_rate_bps, quantity: item.quantity, note: item.note,
    })
    for (const tender of rows('payment_tenders')) await put('payment_tenders', {
      id: tender.id, order_id: tender.order_id, request_id: tender.request_id,
      method: tender.method, amount_paise: tender.amount_paise,
      received_by: unknownStaffId, created_at: tender.created_at,
    })
    for (const refund of rows('payment_refunds')) await put('payment_refunds', {
      id: refund.id, tender_id: refund.tender_id, request_id: refund.request_id,
      amount_paise: refund.amount_paise, reason: refund.reason,
      approved_by: staffByUsername.get(refund.actor.toLowerCase()) || unknownStaffId,
      created_at: refund.created_at,
    })
    for (const rider of rows('delivery_riders')) await put('delivery_riders', {
      id: rider.id, branch_id: branchId, name: rider.name,
      phone: rider.contact_number, active: rider.active,
    })
    for (const order of orders.filter(order => order.type === 'delivery' && order.delivery_rider_id)) await put('delivery_assignments', {
      id: uuid(`assignment:${order.id}:${order.delivery_rider_id}`), order_id: order.id,
      rider_id: order.delivery_rider_id, assigned_by: unknownStaffId,
      assigned_at: order.dispatched_at || order.created_at,
    })
    for (const item of rows('inventory_items')) await put('inventory_items', {
      id: item.id, branch_id: branchId, name: item.name, unit: item.unit,
      quantity_milli: item.quantity_milli, reorder_at_milli: item.reorder_milli,
    })
    for (const movement of rows('stock_movements')) await put('stock_movements', {
      id: movement.id, item_id: movement.item_id, request_id: movement.request_id,
      delta_milli: movement.delta_milli, reason: movement.reason,
      actor_id: staffByUsername.get(movement.actor.toLowerCase()) || unknownStaffId,
      created_at: movement.created_at,
    })
    for (const sequence of rows('document_sequences')) await put('document_sequences', {
      branch_id: branchId, financial_year: sequence.financial_year,
      document_type: sequence.document_kind === 'tax_invoice' ? 'invoice' : 'credit_note',
      next_number: sequence.next_number,
    })
    for (const document of rows('sales_documents')) await put('sales_documents', {
      id: document.id, branch_id: branchId, order_id: document.order_id,
      document_type: document.document_type === 'tax_invoice' ? 'invoice' : 'credit_note',
      document_number: document.document_number, issued_at: document.issued_at,
      issued_by: staffByUsername.get(document.issued_by.toLowerCase()) || unknownStaffId,
      business_snapshot: json(document.business_snapshot_json), customer_snapshot: json(document.customer_snapshot_json),
      totals_snapshot: json(document.totals_snapshot_json), items_snapshot: json(document.items_snapshot_json),
    })
    for (const audit of rows('audit_log')) await put('audit_events', {
      id: audit.id, branch_id: branchId,
      actor_id: staffByUsername.get(audit.actor.toLowerCase()) || null,
      event_type: audit.action, entity_type: audit.entity_type, entity_id: audit.entity_id,
      reason: audit.reason, details: json(audit.details_json), created_at: audit.created_at,
    })
    const [mysqlTotals] = await mysql.execute('SELECT COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS total FROM orders WHERE branch_id = ?', [branchId])
    const sqliteTotal = db.prepare('SELECT COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS total FROM orders').get()
    const [mysqlTenderTotals] = await mysql.execute('SELECT COUNT(*) AS count, COALESCE(SUM(t.amount_paise),0) AS total FROM payment_tenders t JOIN orders o ON o.id = t.order_id WHERE o.branch_id = ?', [branchId])
    const sqliteTenderTotals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_paise),0) AS total FROM payment_tenders').get()
    if (Number(mysqlTotals[0].orders) !== sqliteTotal.orders || Number(mysqlTotals[0].total) !== sqliteTotal.total
      || Number(mysqlTenderTotals[0].count) !== sqliteTenderTotals.count || Number(mysqlTenderTotals[0].total) !== sqliteTenderTotals.total
      || counts.order_items !== rows('order_items').length) {
      throw new Error('Imported order, item, tender or total counts differ from SQLite.')
    }
    const mappedTables = new Set([
      'business_profile', 'staff_users', 'customer_profiles', 'customer_addresses', 'categories',
      'products', 'restaurant_tables', 'customer_order_links', 'orders', 'order_items',
      'payment_tenders', 'payment_refunds', 'delivery_riders', 'inventory_items', 'stock_movements',
      'document_sequences', 'sales_documents', 'audit_log', 'schema_migrations',
    ])
    const remainingHistory = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all().filter(row => !mappedTables.has(row.name)).map(row => ({
        table: row.name,
        count: db.prepare(`SELECT COUNT(*) AS count FROM "${row.name}"`).get().count,
      })).filter(row => row.count > 0)
    if (commit) await mysql.commit()
    else await mysql.rollback()
    return { mode: commit ? 'committed' : 'dry-run', branchId, orders: counts.orders,
      items: counts.order_items, tenders: counts.payment_tenders, customers: counts.customers || 0,
      auditEvents: counts.audit_events || 0, totalPaise: sqliteTotal.total,
      tenderTotalPaise: sqliteTenderTotals.total,
      remainingHistory }
  } catch (error) {
    await mysql.rollback()
    throw error
  } finally {
    mysql.release()
    db.close()
  }
}

module.exports = { syncBranch }

if (require.main === module) {
  const main = async () => {
    if (process.argv.includes('--commit')) throw new Error('Committed import is managed by the server after MySQL sync is enabled.')
    const settings = loadMySqlSettings()
    if (!settings) throw new Error('Local MySQL app connection is missing.')
    const pool = await connectMySql(settings)
    try {
      const result = await syncBranch({
        source: process.argv[2] || 'web-data/mobile-test/billmitra-web.sqlite',
        branchId: process.env.BILLMITRA_IMPORT_BRANCH || 'main',
        branchName: process.env.BILLMITRA_IMPORT_BRANCH_NAME || 'Vengara',
        pool,
      })
      console.log(JSON.stringify(result))
    } finally { await pool.end() }
  }
  main().catch(error => {
    console.error('MySQL branch import failed:', error instanceof Error ? error.message : 'unknown error')
    process.exitCode = 1
  })
}
