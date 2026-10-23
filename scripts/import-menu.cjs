const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')
const { request } = require('node:http')
const { z } = require('zod')

const itemSchema = z.object({ name: z.string().trim().min(1).max(120), priceRupees: z.number().positive().max(1000000),
  description: z.string().max(500).default(''), page: z.number().int().positive().optional() })
const manifestSchema = z.object({ restaurant: z.string().min(1), branchId: z.string().min(1), currency: z.literal('INR'),
  additionalTaxRateBps: z.number().int().min(0).max(10000), categories: z.array(z.object({
    name: z.string().trim().min(1).max(80), page: z.number().int().positive(),
    reuseDemoCategory: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
    items: z.array(itemSchema).min(1),
  })).min(1) })
const key = value => value.trim().toLowerCase()

function validateManifest(raw) {
  const manifest = manifestSchema.parse(raw)
  const names = new Set()
  for (const category of manifest.categories) {
    if (names.has(key(category.name))) throw new Error(`Duplicate category: ${category.name}`)
    names.add(key(category.name))
    const products = new Set()
    for (const item of category.items) {
      if (products.has(key(item.name))) throw new Error(`Duplicate product in ${category.name}: ${item.name}`)
      products.add(key(item.name))
      if (Math.abs(item.priceRupees * 100 - Math.round(item.priceRupees * 100)) > 0.000001) throw new Error(`Price has fractional paise: ${item.name}`)
    }
  }
  return manifest
}

async function importMenu(raw, call, { apply = false } = {}) {
  const manifest = validateManifest(raw)
  const before = await call('getMenuCatalog')
  const plan = { categories: manifest.categories.length, products: manifest.categories.reduce((sum, group) => sum + group.items.length, 0),
    existingCategories: before.categories.length, existingProducts: before.products.length, additionalTaxRateBps: manifest.additionalTaxRateBps }
  if (!apply) return { plan, before }
  const backup = await call('createBackup')
  const ids = new Map()
  for (const [sortOrder, category] of manifest.categories.entries()) {
    const existing = before.categories.find(row => key(row.name) === key(category.name))
      ?? before.categories.find(row => category.reuseDemoCategory && row.id === category.reuseDemoCategory.id && key(row.name) === key(category.reuseDemoCategory.name))
    const saved = existing && existing.name === category.name && existing.sortOrder === sortOrder ? existing
      : await call('saveCategory', { ...(existing ? { id: existing.id } : {}), name: category.name, sortOrder })
    ids.set(category.name, saved.id)
  }
  const catalog = await call('getMenuCatalog')
  const importedIds = new Set()
  let savedProducts = 0
  for (const category of manifest.categories) {
    const categoryId = ids.get(category.name)
    for (const item of category.items) {
      const existing = catalog.products.find(row => row.categoryId === categoryId && key(row.name) === key(item.name))
      const input = { ...(existing ? { id: existing.id } : {}), categoryId, name: item.name, description: item.description,
        pricePaise: Math.round(item.priceRupees * 100), taxRateBps: manifest.additionalTaxRateBps, available: true }
      const unchanged = existing && Object.entries(input).every(([field, value]) => existing[field] === value)
      const saved = unchanged ? existing : await call('saveProduct', input)
      if (!unchanged) savedProducts++
      importedIds.add(saved.id)
    }
  }
  let archivedProducts = 0
  for (const product of catalog.products) {
    if (product.available && !importedIds.has(product.id)) {
      await call('saveProduct', { ...product, available: false })
      archivedProducts++
    }
  }
  const result = await call('getMenuCatalog')
  const active = result.products.filter(product => product.available)
  if (active.length !== plan.products) throw new Error('Menu count verification failed. Re-run the same import to resume safely.')
  for (const category of manifest.categories) for (const item of category.items) {
    const saved = active.find(product => product.categoryId === ids.get(category.name) && product.name === item.name)
    if (!saved || saved.pricePaise !== Math.round(item.priceRupees * 100) || saved.taxRateBps !== manifest.additionalTaxRateBps) {
      throw new Error(`Menu price verification failed: ${item.name}`)
    }
  }
  return { plan, backup, savedProducts, archivedProducts, activeProducts: active.length, before, after: result }
}

function localClient(origin, port, branchId) {
  const host = new URL(origin).host
  let cookie = ''
  return async (method, input) => {
    const body = JSON.stringify({ input })
    return new Promise((resolve, reject) => {
      // Credentials never leave this computer: the public origin is only the expected Host/Origin header.
      const req = request({ hostname: '127.0.0.1', port, path: `/api/pos/${method}`, method: 'POST',
        headers: { Host: host, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'X-Billmitra-Branch': branchId, ...(cookie ? { Cookie: cookie } : {}) },
      }, response => {
        if (response.headers['set-cookie']?.[0]) cookie = response.headers['set-cookie'][0].split(';')[0]
        let text = ''
        response.setEncoding('utf8'); response.on('data', chunk => { text += chunk })
        response.on('end', () => {
          try {
            const payload = JSON.parse(text)
            if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`${method}: ${payload.error ?? response.statusCode}`)
            resolve(payload.result)
          } catch (error) { reject(error) }
        })
      })
      req.setTimeout(20000, () => req.destroy(new Error('Local menu request timed out.')))
      req.on('error', reject); req.end(body)
    })
  }
}

async function main() {
  const [manifestFile, origin, credentialsFile, flag] = process.argv.slice(2)
  if (!manifestFile || !origin || !credentialsFile || (flag && flag !== '--apply')) throw new Error('Usage: node scripts/import-menu.cjs <menu.json> <https-origin> <local-credentials.json> [--apply]')
  const raw = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'))
  const manifest = validateManifest(raw)
  const credentials = JSON.parse(readFileSync(resolve(credentialsFile), 'utf8'))
  if (credentials.branchId !== manifest.branchId) throw new Error('Branch mismatch. Import stopped.')
  const call = localClient(origin, 3017, manifest.branchId)
  const staff = await call('loginStaff', credentials.owner)
  if (staff.role !== 'owner') throw new Error('Owner access is required for this import.')
  try {
    const result = await importMenu(raw, call, { apply: flag === '--apply' })
    const directory = resolve('web-data/menu-import')
    mkdirSync(directory, { recursive: true })
    const reportPath = resolve(directory, `chick-buck-${flag === '--apply' ? 'applied' : 'preview'}-${Date.now()}.json`)
    writeFileSync(reportPath, JSON.stringify({ source: manifestFile, ...result }, null, 2))
    console.log(JSON.stringify({ ...result.plan, applied: flag === '--apply', activeProducts: result.activeProducts,
      savedProducts: result.savedProducts, archivedProducts: result.archivedProducts, backup: result.backup, reportPath }, null, 2))
  } finally { await call('logoutStaff') }
}

module.exports = { validateManifest, importMenu, localClient }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
