import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocal, classifyIntent, assessRisk } from '../src/intent.mjs';

test('safe phrasings never lecture', () => {
  assert.equal(classifyLocal('send me the summary').riskScore, 1);
  assert.equal(classifyLocal('send me the file contents').riskScore, 1);
  assert.equal(classifyLocal('find xyz.pdf').intent, 'file_search');
  assert.equal(classifyLocal('read note.txt').intent, 'file_read');
  assert.equal(classifyLocal('hello').intent, 'chitchat');
  assert.equal(classifyLocal('yoo').intent, 'chitchat');
  assert.equal(classifyLocal('yo sup').intent, 'chitchat');
  assert.equal(classifyLocal('good morning').intent, 'chitchat');
  assert.equal(classifyIntent('remind me tomorrow'), 'schedule');
});

test('genuinely consequential acts require approval', () => {
  const wa = classifyLocal('send xyz.pdf to Rohan on WhatsApp');
  assert.equal(wa.needsApproval, true);
  assert.ok(wa.riskScore >= 3);
  const del = classifyLocal('delete everything in downloads');
  assert.equal(del.riskScore, 5);
  assert.equal(assessRisk('post it to twitter').needsApproval, true); // publishing outward
  assert.equal(assessRisk('post the letter on my desk').needsApproval, false);
  assert.equal(classifyLocal('blargle wibble').intent, 'unknown');
});
