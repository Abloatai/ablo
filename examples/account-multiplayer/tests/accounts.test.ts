import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantAccount, grantWriter, grantAgent } from '../src/accounts/index.js';

test('membership selects both browser and server authority', () => {
  assert.equal(grantAccount('bob', 'beta'), null);
  assert.equal(grantWriter('bob', 'beta'), null);
  assert.deepEqual(grantAccount('alice', 'alpha')?.groups, ['account:alpha']);
  assert.deepEqual(grantAccount('alice', 'beta')?.groups, ['account:beta']);
  assert.deepEqual(grantWriter('bob', 'alpha')?.groups, ['account:alpha']);
  assert.deepEqual(grantAgent('alpha', 'assistant-test').can.conversations, ['read', 'update']);
});
