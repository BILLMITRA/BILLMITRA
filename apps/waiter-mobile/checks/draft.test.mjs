import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjustProduct, productQuantity, tableFloors } from '../src/draft.ts'

test('floor tabs separate floors and put ground floor first', () => {
  assert.deepEqual(tableFloors([{floor:'Floor 1'}, {floor:'Ground Floor'}, {floor:'Floor 1'}]), ['Ground Floor', 'Floor 1'])
  assert.deepEqual(tableFloors([]), [])
})

test('repeated additions and removals keep the draft count and remove zero lines', () => {
  let lines = []
  for (let i = 0; i < 7; i++) lines = adjustProduct(lines, 'tikka', 1)
  assert.equal(productQuantity(lines, 'tikka'), 7)
  for (let i = 0; i < 8; i++) lines = adjustProduct(lines, 'tikka', -1)
  assert.deepEqual(lines, [])
})

test('changing a product preserves other products and kitchen notes', () => {
  const original = [{productId:'tikka',quantity:2,note:'No spice'}, {productId:'tea',quantity:1,note:''}]
  const added = adjustProduct(original, 'tikka', 1)
  assert.equal(productQuantity(added, 'tikka'), 3)
  assert.equal(added[0].note, 'No spice')
  assert.deepEqual(adjustProduct(added, 'tikka', -1), original)
  assert.deepEqual(original, [{productId:'tikka',quantity:2,note:'No spice'}, {productId:'tea',quantity:1,note:''}])
})

test('menu controls enforce the maximum across noted and plain lines', () => {
  const lines = [{productId:'tikka',quantity:98,note:'No spice'}, {productId:'tikka',quantity:1,note:''}]
  assert.equal(productQuantity(adjustProduct(lines, 'tikka', 1), 'tikka'), 99)
  assert.equal(productQuantity(adjustProduct(lines, 'tikka', -1), 'tikka'), 98)
})
