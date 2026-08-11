import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Wrangler config declares the five-minute scheduled KV mirror without a fake namespace id', () => {
  const config = JSON.parse(fs.readFileSync(path.join(WORKER_ROOT, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.main, 'src/index.js');
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.triggers.crons, ['*/5 * * * *']);
  assert.equal(config.kv_namespaces.length, 1);
  assert.equal(config.kv_namespaces[0].binding, 'DATA_MIRROR');
  assert.match(config.kv_namespaces[0].id, /^[a-f0-9]{32}$/u);
  assert.doesNotMatch(config.kv_namespaces[0].id, /^REPLACE_WITH_/u);
  assert.deepEqual(config.durable_objects.bindings, [{
    name: 'REFRESH_COORDINATOR',
    class_name: 'RefreshCoordinator',
  }]);
  assert.deepEqual(config.migrations, [{
    tag: 'v1',
    new_sqlite_classes: ['RefreshCoordinator'],
  }]);
});

test('Wrangler is pinned to one exact version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(WORKER_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(WORKER_ROOT, 'package-lock.json'), 'utf8'));
  assert.match(manifest.devDependencies.wrangler, /^\d+\.\d+\.\d+$/u);
  assert.equal(
    lock.packages[''].devDependencies.wrangler,
    manifest.devDependencies.wrangler,
  );
});
