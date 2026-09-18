import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, hash } from '../../server/app.js';
import { openStore } from '../../server/store.js';

describe('private API', () => {
  let app: FastifyInstance;
  let dir: string;
  const secret = 'p'.repeat(64);
  const adminToken = 'a'.repeat(64);
  const viewerToken = 'v'.repeat(64);
  const headers = (session = adminToken, ip = '100.80.0.1') => ({
    origin: 'https://test.example.ts.net', 'x-vault-request': '1',
    'x-vault-proxy-secret': secret, 'x-vault-client-ip': ip,
    cookie: `__Host-stillroom=${session}`,
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'stillroom-api-'));
    app = await buildApp({ origin: 'https://test.example.ts.net', rpID: 'test.example.ts.net', dataDir: dir, production: true, proxySecret: secret, bootstrapToken: 'b'.repeat(64) });
    const db = openStore(dir);
    for (const [id, role, ip, session] of [['admin', 'admin', '100.80.0.1', adminToken], ['viewer', 'viewer', '100.80.0.2', viewerToken]]) {
      db.prepare('INSERT INTO credentials (id,public_key,counter,transports,label,role,ip,created) VALUES (?,?,0,?,?,?, ?,?)').run(id, Buffer.from([1]), '[]', id, role, ip, Date.now());
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(hash(session), id, Date.now(), Date.now(), ip);
    }
    db.close();
  });
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const box = { iv: 'A'.repeat(16), data: 'A'.repeat(64) };
  function vault() {
    const vaultId = randomUUID();
    return { envelope: { v: 1, vaultId, kdf: { algorithm: 'argon2id', salt: 'A'.repeat(24), memory: 67108864, ops: 3 }, passphrase: box, recovery: box },
      catalog: { v: 1, ref: { id: randomUUID(), vaultId, purpose: 'catalog', iv: box.iv, key: box }, data: 'A'.repeat(64) } };
  }
  it('rejects proxy bypass and non-tailnet sources', async () => {
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/status', headers: headers(adminToken, '192.168.1.2') })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/status', headers: { ...headers(), 'x-vault-proxy-secret': 'bad' } })).statusCode).toBe(403);
  });
  it('requires a session for vault and direct object access', async () => {
    for (const url of ['/api/vault', `/api/objects/${randomUUID()}`, '/api/devices']) {
      expect((await app.inject({ url, headers: headers('invalid') })).statusCode).toBe(401);
    }
  });
  it('binds sessions to the enrolled device', async () => {
    expect((await app.inject({ url: '/api/devices', headers: headers(adminToken, '100.80.0.2') })).statusCode).toBe(401);
  });
  it('rejects cross-origin mutations and requests without the CSRF header', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers(), origin: 'https://attacker.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers(), 'x-vault-request': '' } })).statusCode).toBe(403);
  });
  it('enforces viewer permissions on every mutation', async () => {
    const h = headers(viewerToken, '100.80.0.2');
    for (const [method, url] of [['POST', '/api/vault'], ['PUT', '/api/catalog'], ['PUT', '/api/vault/envelope'], ['POST', '/api/invitations'], ['DELETE', '/api/devices/admin'], ['PUT', `/api/objects/${randomUUID()}`]] as const) {
      expect((await app.inject({ method, url, headers: h })).statusCode).toBe(403);
    }
  });
  it('blocks initial enrollment after the first credential', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/auth/register/options', headers: headers(), payload: { token: 'b'.repeat(64), label: 'Another admin' } });
    expect(result.statusCode).toBe(403);
  });
  it('binds invitations to the intended device and rejects ceremony replay', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invitations', headers: headers(), payload: { role: 'viewer', ip: '100.80.0.3' } });
    expect(invite.statusCode).toBe(200);
    const options = { method: 'POST' as const, url: '/api/auth/register/options', payload: { token: invite.json().token, label: 'Phone' } };
    expect((await app.inject({ ...options, headers: headers('', '100.80.0.4') })).statusCode).toBe(403);
    const result = await app.inject({ ...options, headers: headers('', '100.80.0.3') });
    expect(result.statusCode).toBe(200);
    const cookie = (result.headers['set-cookie'] as string).split(';')[0];
    const verify = { method: 'POST' as const, url: '/api/auth/register/verify', headers: { ...headers('', '100.80.0.3'), cookie }, payload: {} };
    expect((await app.inject(verify)).statusCode).toBe(400);
    expect((await app.inject(verify)).json().error).toContain('expired');
  });
  it('stores immutable objects and rejects missing references and stale catalog writes', async () => {
    const initial = vault();
    expect((await app.inject({ method: 'POST', url: '/api/vault', headers: headers(), payload: initial })).statusCode).toBe(200);
    const id = randomUUID();
    const update = { revision: 1, catalog: initial.catalog, objects: [id] };
    expect((await app.inject({ method: 'PUT', url: '/api/catalog', headers: headers(), payload: update })).statusCode).toBe(400);
    const upload = { method: 'PUT' as const, url: `/api/objects/${id}`, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(64, 7) };
    expect((await app.inject(upload)).statusCode).toBe(201);
    expect((await app.inject(upload)).statusCode).toBe(409);
    expect((await app.inject({ url: `/api/objects/${id}`, headers: headers() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/catalog', headers: headers(), payload: update })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/catalog', headers: headers(), payload: update })).statusCode).toBe(409);
    const image = await app.inject({ url: `/api/objects/${id}`, headers: headers(viewerToken, '100.80.0.2') });
    expect(image.rawPayload).toEqual(Buffer.alloc(64, 7));
    expect(image.headers['cache-control']).toBe('no-store');
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
  });
  it('revokes active sessions immediately and protects the current admin', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/admin', headers: headers() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/viewer', headers: headers() })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/vault', headers: headers(viewerToken, '100.80.0.2') })).statusCode).toBe(401);
  });
  it('expires idle sessions and adds security headers', async () => {
    const db = openStore(dir);
    db.prepare('UPDATE sessions SET touched=0').run(); db.close();
    const res = await app.inject({ url: '/api/vault', headers: headers() });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
