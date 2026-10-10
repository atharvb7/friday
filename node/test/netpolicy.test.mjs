import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivateAddress, hostIsPrivate } from '../netpolicy.mjs';
import { isPrivateAddress as serverPolicy } from '../../src/web.mjs';
import { isPrivateHost, checkFile, checkUrl } from '../browser.mjs';

const VECTORS = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '8.8.8.8', '::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::', 'fec0::1', 'ff02::1', 'fd00::1', 'fe80::1', '2001:db8::1', '2606:4700:4700::1111', '::', 'junk', '203.0.113.5'];

test('node address policy matches the server policy on every vector and blocks IPv6-mapped loopback/metadata', async () => {
  for (const v of VECTORS) assert.equal(isPrivateAddress(v), serverPolicy(v), v);
  for (const v of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', 'fec0::1', '::']) assert.equal(isPrivateAddress(v), true, v);
  assert.equal(isPrivateHost('[::ffff:7f00:1]'), true);
  assert.equal(isPrivateHost('[::]'), true);
  assert.throws(() => checkUrl('http://[::ffff:7f00:1]/'), /private_address_blocked/);
  assert.equal(await hostIsPrivate('localhost'), true);
  assert.equal(await hostIsPrivate('router.lan'), true);
  assert.equal(await hostIsPrivate('does-not-exist.invalid'), true, 'unresolvable names are refused');
});

test('file policy: Friday data, token-looking and sqlite files are blocked even inside allowed dirs', () => {
  const d = mkdtempSync(join(tmpdir(), 'fn-pol-'));
  try {
    const docs = join(d, 'Documents'); mkdirSync(join(docs, 'friday', 'data'), { recursive: true }); mkdirSync(join(docs, 'notes'));
    writeFileSync(join(docs, 'friday', 'data', 'access-token'), 'x'); writeFileSync(join(docs, 'friday', 'data', 'friday.sqlite'), 'x'); writeFileSync(join(docs, 'friday', 'data', 'report.pdf'), 'x');
    writeFileSync(join(docs, 'notes', 'api-key-backup.txt'), 'x'); writeFileSync(join(docs, 'notes', 'cv.pdf'), 'x'); writeFileSync(join(docs, 'notes', 'wallet.dat'), 'x');
    assert.ok(checkFile(join(docs, 'notes', 'cv.pdf'), [docs]));
    assert.throws(() => checkFile(join(docs, 'friday', 'data', 'access-token'), [docs]), /sensitive_file_blocked/);
    assert.throws(() => checkFile(join(docs, 'friday', 'data', 'friday.sqlite'), [docs]), /sensitive_file_blocked/);
    assert.throws(() => checkFile(join(docs, 'friday', 'data', 'report.pdf'), [docs]), /inside_friday_data_blocked/, 'siblings of Friday data are blocked too');
    assert.throws(() => checkFile(join(docs, 'notes', 'wallet.dat'), [docs]), /sensitive_file_blocked/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
