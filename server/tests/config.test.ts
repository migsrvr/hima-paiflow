import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('hosted config fails closed without postgres and a stable session secret', () => {
  const names = ['RENDER', 'STORAGE_BACKEND', 'DATABASE_URL', 'SESSION_SECRET'] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.RENDER = 'true';
    process.env.STORAGE_BACKEND = 'file';
    process.env.SESSION_SECRET = 'x'.repeat(32);
    assert.throws(() => loadConfig(), /Render requires STORAGE_BACKEND=postgres/);
    process.env.STORAGE_BACKEND = 'postgres';
    process.env.SESSION_SECRET = '';
    assert.throws(() => loadConfig(), /stable SESSION_SECRET/);
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.DATABASE_URL = '';
    assert.throws(() => loadConfig(), /DATABASE_URL/);
    process.env.DATABASE_URL = 'postgresql://server:placeholder@localhost:5432/hima';
    assert.equal(loadConfig().storage.backend, 'postgres');
    process.env.RENDER = 'false';
    delete process.env.STORAGE_BACKEND;
    process.env.SESSION_SECRET = '';
    assert.equal(loadConfig().storage.backend, 'file');
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
