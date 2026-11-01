import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, mapError } from '../src/http/router.mjs';

test('router matches params, method, and first registered route wins', async () => {
  const r = new Router();
  r.get('/v1/x/:id([a-f0-9]+)', ({ params }) => [200, { id: params.id }]);
  r.get('/v1/x/:id', () => [200, { fallback: true }]);
  r.post('/v1/x/:id', () => [201, {}]);
  assert.deepEqual(await r.dispatch('GET', '/v1/x/abc1', {}), [200, { id: 'abc1' }]);
  assert.deepEqual(await r.dispatch('GET', '/v1/x/ZZ', {}), [200, { fallback: true }]);
  assert.equal((await r.dispatch('POST', '/v1/x/abc', {}))[0], 201);
  assert.equal(await r.dispatch('DELETE', '/v1/x/abc', {}), null);
  assert.equal(await r.dispatch('GET', '/v1/x/abc/extra', {}), null);
});

test('mapError: oversize 413, bad JSON 400, everything else hides detail', () => {
  assert.equal(mapError(new Error('body_too_large'))[0], 413);
  assert.equal(mapError(new SyntaxError('x'))[0], 400);
  assert.deepEqual(mapError(new Error('secret db path')), [500, { error: 'internal_error' }]);
});
