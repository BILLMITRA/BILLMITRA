const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, mkdtempSync, rmSync } = require('node:fs')
const { resolve, join, sep } = require('node:path')
const { randomUUID } = require('node:crypto')
const { createPosBackend } = require('../electron-dist/electron/backend.cjs')
const { posChannels } = require('../electron-dist/shared/posChannels.js')
const { validateManifest, importMenu } = require('./import-menu.cjs')
const raw = JSON.parse(readFileSync(resolve(__dirname, '../data/menus/chick-buck-vengara.json'), 'utf8'))

async function fixture(run) {
  const tempRoot = resolve(__dirname, '../tmp')
  const directory = mkdtempSync(join(tempRoot, 'menu-import-check-'))
  if (!directory.startsWith(tempRoot + sep)) throw new Error('Unexpected fixture directory.')
  const backend = createPosBackend(join(directory, 'test.sqlite'))
  backend.invoke('staff:setup-owner', 1, { username:'owner',displayName:'Owner',password:randomUUID() })
  const call = async (method, input) => backend.invoke(posChannels[method], 1, input)
  try { await run(backend, call) }
  finally {
    backend.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

test('all menu pages reconcile with visually checked counts and prices', () => {
  const menu = validateManifest(raw)
  const byPage = {}
  for (const category of menu.categories) for (const item of category.items) {
    const page = item.page ?? category.page
    byPage[page] ??= { count:0, totalRupees:0 }
    byPage[page].count++; byPage[page].totalRupees += item.priceRupees
  }
  assert.equal(menu.categories.length, 19)
  assert.deepEqual(byPage, {2:{count:10,totalRupees:4386},3:{count:6,totalRupees:624},4:{count:5,totalRupees:1055},
    5:{count:5,totalRupees:815},6:{count:29,totalRupees:1915},7:{count:26,totalRupees:1680},8:{count:23,totalRupees:2080},9:{count:21,totalRupees:1780}})
})

test('import backs up, preserves existing bills and supports safe repeat imports', async () => fixture(async (backend, call) => {
  const originalMenu = await call('loadMenu')
  const old = await call('createOrder', { requestId:randomUUID(),type:'dine_in',tableId:originalMenu.tables[0].id,
    customerName:'',deliveryAddress:'',discount:null,items:[{productId:originalMenu.products[0].id,quantity:2,note:'Existing order'}] })
  const first = await importMenu(raw, call, { apply:true })
  assert.equal(first.activeProducts, 125)
  assert.equal(first.after.categories.length, 19)
  assert.equal(first.archivedProducts, 13)
  assert.ok(first.backup.sizeBytes > 0)
  assert.deepEqual(await call('getOrder', old.id), old)
  const second = await importMenu(raw, call, { apply:true })
  assert.equal(second.savedProducts, 0)
  assert.equal(second.archivedProducts, 0)
  assert.equal(second.after.products.length, first.after.products.length)
  const available = second.after.products.filter(item => item.available)
  const combo = available.find(item => item.name === 'M1 Chicken Combo (Quarter)')
  const khubz = available.find(item => item.name === 'Khubz')
  backend.invoke('staff:create', 1, { username:'waiter',displayName:'Waiter',role:'waiter',password:randomUUID() })
  const order = await call('createOrder', {requestId:randomUUID(),type:'dine_in',tableId:originalMenu.tables[1].id,
    customerName:'',deliveryAddress:'',discount:null,items:[{productId:combo.id,quantity:1,note:''},{productId:khubz.id,quantity:1,note:''}]})
  assert.equal(order.totalPaise, 17900)
  assert.equal(order.taxPaise, 0)
  assert.equal((await call('getWaiterMenu')).products.filter(item=>item.available).length, 125)
}))

test('an interrupted import can resume without duplicate products', async () => fixture(async (_backend, call) => {
  let saves = 0
  await assert.rejects(importMenu(raw, async (method,input) => {
    if (method === 'saveProduct' && ++saves === 8) throw new Error('Simulated connection interruption')
    return call(method,input)
  }, {apply:true}), /interruption/)
  const resumed = await importMenu(raw, call, {apply:true})
  assert.equal(resumed.activeProducts, 125)
  assert.equal(resumed.after.products.length, 138)
}))

test('invalid and duplicate menu records fail before any database operation', async () => {
  for (const mutate of [menu => menu.categories[0].items.push(menu.categories[0].items[0]), menu => {menu.categories[0].items[0].priceRupees=1.001}]) {
    const invalid = structuredClone(raw); mutate(invalid)
    let calls = 0
    await assert.rejects(importMenu(invalid, async () => { calls++; return null }, {apply:true}))
    assert.equal(calls, 0)
  }
})
