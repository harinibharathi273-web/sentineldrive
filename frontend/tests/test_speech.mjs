import assert from 'node:assert/strict'
import { parseSpokenNumber as p } from '../src/lib/speech.js'
assert.equal(p('seven'), 7)
assert.equal(p('it is 12'), 12)
assert.equal(p('twenty three'), 23)
assert.equal(p('what is 15 minus 8 seven'), 7)
assert.equal(p('I think it is to'), 2)
assert.equal(p('for'), 4)
assert.equal(p('hello'), null)
console.log('speech ok')
