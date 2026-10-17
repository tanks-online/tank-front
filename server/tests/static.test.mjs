import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createGameServer } from '../dist/server.js';
import { readConfig } from '../dist/config.js';

const ORIGIN = 'https://tank-front.onrender.com';
function request(base, path = '/', method = 'GET', headers = {}) {
  const url = new URL(base);
  return new Promise((resolveResponse, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tank-front-static-'));
  assert.ok(directory.startsWith(resolve(tmpdir()) + sep + 'tank-front-static-'));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'public');
  const outside = join(directory, 'outside');
  await Promise.all([mkdir(join(root, 'assets'), { recursive: true }), mkdir(join(root, 'src'), { recursive: true }), mkdir(outside)]);
  const index = '<!doctype html><html><body>Tank Front<script type="module" src="/assets/index-AbCd1234.js"></script></body></html>';
  await Promise.all([
    writeFile(join(root, 'index.html'), index),
    writeFile(join(root, 'assets', 'index-AbCd1234.js'), 'console.log("public client");'),
    writeFile(join(root, 'assets', 'index-AbCd1234.css'), 'body{color:white}'),
    writeFile(join(root, 'assets', 'map-AbCd1234.json'), '{"public":true}'),
    writeFile(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    writeFile(join(root, '.env'), 'TOKEN=do-not-expose'),
    writeFile(join(root, 'package.json'), '{"private":true}'),
    writeFile(join(root, 'src', 'index.ts'), 'const SERVER_SECRET = "do-not-expose"'),
    writeFile(join(root, 'assets', 'secret.json'), '{"token":"do-not-expose"}'),
    writeFile(join(root, 'assets', 'index-AbCd1234.js.map'), '{"sourcesContent":["private source"]}'),
    writeFile(join(outside, 'stolen.js'), 'do-not-expose'),
  ]);
  await symlink(outside, join(root, 'assets', 'external'), 'junction');
  app = createGameServer({ port: 0, host: '127.0.0.1', allowedOrigins: [ORIGIN], staticDir: root });
  const address = await app.listen();
  return { app, root, directory, index, base: `http://127.0.0.1:${address.port}` };
}

test('one Node service serves index, static MIME assets, query invitations, HEAD, and APIs', async t => {
  const { base, index } = await fixture(t);
  const page = await request(base, '/?room=ABC234');
  assert.equal(page.status, 200);
  assert.equal(page.body, index);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.headers['content-security-policy'], /wss:\/\/tank-front\.onrender\.com/);
  const head = await request(base, '/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(index));
  assert.equal(head.body, '');
  for (const [path, type] of [
    ['/assets/index-AbCd1234.js', 'text/javascript; charset=utf-8'],
    ['/assets/index-AbCd1234.css', 'text/css; charset=utf-8'],
    ['/assets/map-AbCd1234.json', 'application/json; charset=utf-8'],
  ]) {
    const asset = await request(base, path);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-type'], type);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  }
  const favicon = await request(base, '/favicon.svg');
  assert.equal(favicon.headers['content-type'], 'image/svg+xml');
  assert.equal(favicon.headers['cache-control'], 'public, max-age=3600');
  assert.equal(JSON.parse((await request(base, '/health')).body).ok, true);
  assert.deepEqual(JSON.parse((await request(base, '/rooms')).body), []);
  assert.equal((await request(base, '/health', 'HEAD')).body, '');
  assert.equal((await request(base, '/', 'POST')).status, 405);
});

test('static serving rejects traversal, escaped symlinks, private files, source and unknown routes', async t => {
  const { base } = await fixture(t);
  for (const path of [
    '/../outside/stolen.js', '/%2e%2e/outside/stolen.js', '/%2e%2e%2foutside%2fstolen.js',
    '/%2e%2e%5coutside%5cstolen.js', '/assets/../../outside/stolen.js', '/assets/external/stolen.js',
    '/.env', '/%2eenv', '/.git/config', '/package.json', '/assets/secret.json',
    '/assets/index-AbCd1234.js.map', '/src/index.ts', '/assets/', '/unknown-route', '/ws',
  ]) {
    const response = await request(base, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.includes('do-not-expose'), false, path);
  }
  assert.equal((await request(base, '/assets/%E0%A4%A.js')).status, 400);
});

test('static host limits request headers and refuses missing compiled client at startup', async t => {
  const { base, directory } = await fixture(t);
  assert.equal((await request(base, '/', 'GET', { 'X-Oversized': 'x'.repeat(9_000) })).status, 431);
  assert.throws(() => createGameServer({ allowedOrigins: [ORIGIN], staticDir: join(directory, 'does-not-exist') }), /STATIC_DIR.*index.html/);
  assert.throws(() => createGameServer({ allowedOrigins: [ORIGIN], staticDir: join(directory, 'outside') }), /STATIC_DIR.*index.html/);
});

test('production derives a trusted HTTPS origin from PUBLIC_URL or Render and resolves STATIC_DIR', () => {
  assert.deepEqual(readConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://tank.example/' }).allowedOrigins, ['https://tank.example']);
  assert.deepEqual(readConfig({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: ORIGIN }).allowedOrigins, [ORIGIN]);
  assert.deepEqual(readConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://enzonic.example', RENDER_EXTERNAL_URL: ORIGIN }).allowedOrigins, ['https://enzonic.example']);
  assert.deepEqual(readConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://explicit.example', PUBLIC_URL: 'invalid' }).allowedOrigins, ['https://explicit.example']);
  assert.equal(readConfig({ STATIC_DIR: '../client/dist' }).staticDir, resolve('../client/dist'));
  assert.equal(readConfig({}).staticDir, undefined);
  for (const publicUrl of ['http://insecure.example', 'https://example.com/path', 'https://example.com/?token=secret', 'https://user:pass@example.com', 'https://example.com/#hash', 'bad']) {
    assert.throws(() => readConfig({ NODE_ENV: 'production', PUBLIC_URL: publicUrl }), /PUBLIC_URL/);
  }
  assert.throws(() => readConfig({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'http://insecure.example' }), /RENDER_EXTERNAL_URL/);
  assert.throws(() => readConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: '', PUBLIC_URL: ORIGIN }), /ALLOWED_ORIGINS/);
  assert.throws(() => readConfig({ STATIC_DIR: '' }), /STATIC_DIR/);
});
