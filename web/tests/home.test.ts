import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeLiveState } from '../src/home.ts';

test('home distinguishes a pending request from successful live or empty responses', () => {
  for (const status of ['', 'Connecting to Live RTS', 'GPS accuracy ±150 m · Connecting to Live RTS']) {
    assert.equal(homeLiveState(status), 'connecting', status);
  }
  for (const status of ['Live RTS · 4 buses · data 3s old', 'No nearby buses', 'GPS accuracy ±150 m · No nearby buses · data 0s old']) {
    assert.equal(homeLiveState(status), 'live', status);
  }
  for (const status of ['LIVE DATA TEMPORARILY UNAVAILABLE', 'GPS accuracy ±150 m · LIVE DATA TEMPORARILY UNAVAILABLE · data 30s old']) {
    assert.equal(homeLiveState(status), 'unavailable', status);
  }
});
