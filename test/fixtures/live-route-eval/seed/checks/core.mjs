import assert from 'node:assert/strict';
import test from 'node:test';
import {auditAuthorization} from '../src/auth.js';
import {parseConfig} from '../src/config.js';
import {sumInclusive} from '../src/math.js';

test('sumInclusive includes the upper bound', () => {
  assert.equal(sumInclusive(3), 6);
});

test('auditAuthorization never returns a bearer credential', () => {
  assert.equal(auditAuthorization('Bearer fixture-secret'), 'authorization=[REDACTED]');
});

test('parseConfig remains a public export', () => {
  assert.deepEqual(parseConfig('{"enabled":true}'), {enabled: true});
});
