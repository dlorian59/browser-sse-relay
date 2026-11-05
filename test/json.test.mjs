import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonRelay } from '../dist/index.js';
import { scope, hello, ready, event, sse } from './helpers.mjs';

test('JSON facade awaits business processing before saving and never commits invalid data', async () => {
  const order = [];
  const client = createJsonRelay({ scope, url: 'https://example.test/events',
    decode(value) { if (typeof value.amount !== 'number') throw new Error('Invalid order'); return value; },
    async onData(value) { await Promise.resolve(); order.push(`apply:${value.amount}`); },
    checkpoint: { async load() {}, async save(_scope, cursor) { order.push(`save:${cursor}`); }, async clear() {} },
    retry: { maxAttempts: 1 },
    fetch: async () => sse(hello('origin', '2') + event('1', '{"amount":42}') + event('2', '{"amount":"invalid"}') + ready('2')),
  });
  const result = await client.start();
  assert.equal(result.state, 'failed'); assert.equal(result.cursor, '1');
  assert.deepEqual(order, ['apply:42', 'save:1']);
});
