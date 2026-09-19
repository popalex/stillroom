import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, hash } from '../../server/app.js';
import { drainDeletions } from '../../server/deletions.js';
import { withMaintenanceLock } from '../../server/maintenance.js';
import { openStore } from '../../server/store.js';

describe('private API', () => {
  let app: FastifyInstance;
  let dir: string;
  const adminToken = 'a'.repeat(64);
  const viewerToken = 'v'.repeat(64);
  const headers = (session = adminToken, ip = '100.80.0.1') => ({
    origin: 'https://test.example.ts.net',
    'x-vault-request': '1',
    'x-forwarded-for': ip,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'test.example.ts.net',
    cookie: `__Host-stillroom=${session}`,
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'stillroom-api-'));
    app = await buildApp({
      origin: 'https://test.example.ts.net',
      rpID: 'test.example.ts.net',
      dataDir: dir,
      production: true,
      host: '127.0.0.1',
      bootstrapToken: 'b'.repeat(64),
    });
    const db = openStore(dir);
    for (const [id, role, ip, session] of [
      ['admin', 'admin', '100.80.0.1', adminToken],
      ['viewer', 'viewer', '100.80.0.2', viewerToken],
    ]) {
      db.prepare(
        'INSERT INTO credentials (id,public_key,counter,transports,label,role,ip,created) VALUES (?,?,0,?,?,?, ?,?)',
      ).run(id, Buffer.from([1]), '[]', id, role, ip, Date.now());
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(
        hash(session),
        id,
        Date.now(),
        Date.now(),
        ip,
      );
    }
    db.close();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const box = { iv: 'A'.repeat(16), data: 'A'.repeat(64) };
  function vault() {
    const vaultId = randomUUID();
    return {
      envelope: {
        v: 1,
        vaultId,
        kdf: { algorithm: 'argon2id', salt: 'A'.repeat(24), memory: 67108864, ops: 3 },
        passphrase: box,
        recovery: box,
      },
      catalog: {
        v: 1,
        ref: { id: randomUUID(), vaultId, purpose: 'catalog', iv: box.iv, key: box },
        data: 'A'.repeat(64),
      },
    };
  }
  it('rejects proxy bypass and non-tailnet sources', async () => {
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/api/status', headers: headers(adminToken, '192.168.1.2') }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/status',
          headers: headers(),
          remoteAddress: '172.18.0.2',
        })
      ).statusCode,
    ).toBe(403);
  });
  it('requires a session for vault and direct object access', async () => {
    for (const url of [
      '/api/vault',
      `/api/objects/${randomUUID()}`,
      '/api/devices',
      '/api/preferences',
    ]) {
      expect((await app.inject({ url, headers: headers('invalid') })).statusCode).toBe(401);
    }
  });
  it('rejects ambiguous forwarded addresses, wrong HTTPS hosts, and Funnel traffic', async () => {
    for (const overrides of [
      { 'x-forwarded-for': '100.80.0.1, 100.80.0.2' },
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-for': 'fd00::1' },
      { 'x-forwarded-for': '' },
      { 'x-forwarded-host': 'attacker.example' },
      { 'x-forwarded-proto': 'http' },
      { 'tailscale-funnel-request': '?1' },
    ]) {
      expect(
        (await app.inject({ url: '/api/status', headers: { ...headers(), ...overrides } }))
          .statusCode,
      ).toBe(403);
    }
    expect(
      (await app.inject({ url: '/api/status', headers: headers('', 'fd7a:115c:a1e0::1') }))
        .statusCode,
    ).toBe(200);
  });
  it('ignores client-supplied identity headers when binding a session', async () => {
    expect(
      (
        await app.inject({
          url: '/api/vault',
          headers: {
            ...headers(adminToken, '100.80.0.2'),
            'x-vault-client-ip': '100.80.0.1',
            forwarded: 'for=100.80.0.1;proto=https',
            'tailscale-user-login': 'admin@example.com',
          },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('binds sessions to the enrolled device', async () => {
    expect(
      (await app.inject({ url: '/api/devices', headers: headers(adminToken, '100.80.0.2') }))
        .statusCode,
    ).toBe(401);
  });
  it('rejects cross-origin mutations and requests without the CSRF header', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { ...headers(), origin: 'https://attacker.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { ...headers(), 'x-vault-request': '' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('enforces viewer permissions on collection and device mutations', async () => {
    const h = headers(viewerToken, '100.80.0.2');
    for (const [method, url] of [
      ['POST', '/api/vault'],
      ['PUT', '/api/catalog'],
      ['PUT', '/api/vault/envelope'],
      ['POST', '/api/invitations'],
      ['DELETE', '/api/devices/admin'],
      ['PUT', `/api/objects/${randomUUID()}`],
    ] as const) {
      expect((await app.inject({ method, url, headers: h })).statusCode).toBe(403);
    }
  });
  it('blocks initial enrollment after the first credential', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      headers: headers(),
      payload: { token: 'b'.repeat(64), label: 'Another admin' },
    });
    expect(result.statusCode).toBe(403);
  });
  it('persists sort preferences per credential without changing the encrypted catalog', async () => {
    const initial = vault();
    await app.inject({ method: 'POST', url: '/api/vault', headers: headers(), payload: initial });
    const before = (await app.inject({ url: '/api/vault', headers: headers() })).json();
    const viewerHeaders = headers(viewerToken, '100.80.0.2');
    expect((await app.inject({ url: '/api/preferences', headers: viewerHeaders })).json()).toEqual({
      sortOrder: 'date-desc',
    });
    for (const sortOrder of ['name-asc', 'name-desc', 'date-asc', 'date-desc']) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/preferences',
        headers: viewerHeaders,
        payload: { sortOrder },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ sortOrder });
    }
    await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      headers: viewerHeaders,
      payload: { sortOrder: 'name-asc' },
    });
    expect((await app.inject({ url: '/api/preferences', headers: headers() })).json()).toEqual({
      sortOrder: 'date-desc',
    });
    expect((await app.inject({ url: '/api/vault', headers: headers() })).json()).toEqual(before);
    await app.close();
    app = await buildApp({
      origin: 'https://test.example.ts.net',
      rpID: 'test.example.ts.net',
      dataDir: dir,
      production: true,
      host: '127.0.0.1',
    });
    expect((await app.inject({ url: '/api/preferences', headers: viewerHeaders })).json()).toEqual({
      sortOrder: 'name-asc',
    });
  });
  it('validates preference writes and enforces session and origin checks', async () => {
    for (const payload of [
      { sortOrder: 'unknown' },
      {},
      { sortOrder: 'name-asc', credential_id: 'viewer' },
    ]) {
      expect(
        (await app.inject({ method: 'PUT', url: '/api/preferences', headers: headers(), payload }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/preferences',
          headers: headers('invalid'),
          payload: { sortOrder: 'name-asc' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/preferences',
          headers: { ...headers(), origin: 'https://attacker.example' },
          payload: { sortOrder: 'name-asc' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('binds invitations to the intended device and rejects ceremony replay', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/invitations',
      headers: headers(),
      payload: { role: 'viewer', ip: '100.80.0.3' },
    });
    expect(invite.statusCode).toBe(200);
    const options = {
      method: 'POST' as const,
      url: '/api/auth/register/options',
      payload: { token: invite.json().token, label: 'Phone' },
    };
    expect((await app.inject({ ...options, headers: headers('', '100.80.0.4') })).statusCode).toBe(
      403,
    );
    const result = await app.inject({ ...options, headers: headers('', '100.80.0.3') });
    expect(result.statusCode).toBe(200);
    const cookie = (result.headers['set-cookie'] as string).split(';')[0];
    const verify = {
      method: 'POST' as const,
      url: '/api/auth/register/verify',
      headers: { ...headers('', '100.80.0.3'), cookie },
      payload: {},
    };
    expect((await app.inject(verify)).statusCode).toBe(400);
    expect((await app.inject(verify)).json().error).toContain('expired');
  });
  it('stores immutable objects and rejects missing references and stale catalog writes', async () => {
    const initial = vault();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/vault',
          headers: headers(),
          payload: initial,
        })
      ).statusCode,
    ).toBe(200);
    const id = randomUUID();
    const update = { revision: 1, catalog: initial.catalog, objects: [id] };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/catalog',
          headers: headers(),
          payload: update,
        })
      ).statusCode,
    ).toBe(400);
    const upload = {
      method: 'PUT' as const,
      url: `/api/objects/${id}`,
      headers: { ...headers(), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(64, 7),
    };
    expect((await app.inject(upload)).statusCode).toBe(201);
    expect((await app.inject(upload)).statusCode).toBe(409);
    expect((await app.inject({ url: `/api/objects/${id}`, headers: headers() })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/catalog',
          headers: headers(),
          payload: update,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/catalog',
          headers: headers(),
          payload: update,
        })
      ).statusCode,
    ).toBe(409);
    const image = await app.inject({
      url: `/api/objects/${id}`,
      headers: headers(viewerToken, '100.80.0.2'),
    });
    expect(image.rawPayload).toEqual(Buffer.alloc(64, 7));
    expect(image.headers['cache-control']).toBe('no-store');
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
  });
  async function imageForDeletion(count = 4, removeCount = 3) {
    const initial = vault();
    await app.inject({ method: 'POST', url: '/api/vault', headers: headers(), payload: initial });
    const ids = Array.from({ length: count }, () => randomUUID());
    for (const id of ids) {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/objects/${id}`,
            headers: { ...headers(), 'content-type': 'application/octet-stream' },
            payload: Buffer.alloc(64, 7),
          })
        ).statusCode,
      ).toBe(201);
    }
    await app.inject({
      method: 'PUT',
      url: '/api/catalog',
      headers: headers(),
      payload: { revision: 1, catalog: initial.catalog, objects: ids },
    });
    return {
      ids,
      initial,
      payload: {
        revision: 2,
        catalog: initial.catalog,
        objects: ids.slice(removeCount),
        deleteObjects: ids.slice(0, removeCount),
      },
    };
  }
  it('allows four simultaneous uploads and refuses a fifth', async () => {
    const initial = vault();
    await app.inject({ method: 'POST', url: '/api/vault', headers: headers(), payload: initial });
    const send = (id: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/objects/${id}`,
        headers: { ...headers(), 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(2 * 1024 * 1024, 5),
      });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(randomUUID()).then((r) => r.statusCode)),
    );
    expect(results.filter((code) => code === 201).length).toBeGreaterThanOrEqual(4);
    expect(results.filter((code) => code === 429).length).toBeLessThanOrEqual(1);
    // and one more on its own still works
    expect((await send(randomUUID())).statusCode).toBe(201);
  });
  it('sweeps stale uploaded files when it starts', async () => {
    const store = openStore(dir);
    const orphan = randomUUID(),
      recent = randomUUID();
    for (const [id, age] of [
      [orphan, 5 * 3_600_000],
      [recent, 30_000],
    ] as const) {
      writeFileSync(join(dir, 'objects', id), Buffer.alloc(16, 3));
      store.prepare('INSERT INTO objects VALUES (?,?,?)').run(id, 16, Date.now() - age);
    }
    store.close();
    await app.close();
    app = await buildApp({
      origin: 'https://test.example.ts.net',
      rpID: 'test.example.ts.net',
      dataDir: dir,
      production: true,
      host: '127.0.0.1',
      bootstrapToken: 'b'.repeat(64),
    });
    expect(existsSync(join(dir, 'objects', orphan))).toBe(false);
    expect(existsSync(join(dir, 'objects', recent))).toBe(true);
  });
  it('accepts a catalog far larger than the default body limit', async () => {
    const initial = vault();
    await app.inject({ method: 'POST', url: '/api/vault', headers: headers(), payload: initial });
    const commit = (length: number) =>
      app.inject({
        method: 'PUT',
        url: '/api/catalog',
        headers: headers(),
        payload: {
          revision: 1,
          catalog: { ...initial.catalog, data: 'A'.repeat(length) },
          objects: [],
        },
      });
    // a collection of a few thousand images lands around here
    expect((await commit(4_000_000)).statusCode).toBe(200);
    // and the schema still bounds it
    expect((await commit(5_600_004)).statusCode).toBe(400);
  });
  it('swaps a rebuilt thumbnail in and deletes only the file it replaced', async () => {
    const { ids, initial } = await imageForDeletion(3, 0);
    const replacement = randomUUID();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/objects/${replacement}`,
          headers: { ...headers(), 'content-type': 'application/octet-stream' },
          payload: Buffer.alloc(64, 9),
        })
      ).statusCode,
    ).toBe(201);
    const swap = {
      method: 'PUT' as const,
      url: '/api/catalog',
      headers: headers(),
      payload: {
        revision: 2,
        catalog: initial.catalog,
        objects: [ids[0], replacement, ids[2]],
        deleteObjects: [ids[1]],
      },
    };
    // the replaced file is still in use here, so this one must be refused
    expect(
      (
        await app.inject({
          ...swap,
          payload: { ...swap.payload, objects: ids, deleteObjects: [ids[1]] },
        })
      ).statusCode,
    ).toBe(400);
    const done = await app.inject(swap);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ revision: 3, pending: 0 });
    expect(readdirSync(join(dir, 'objects')).sort()).toEqual([ids[0], replacement, ids[2]].sort());
    expect(
      (await app.inject({ url: `/api/objects/${ids[1]}`, headers: headers() })).statusCode,
    ).toBe(404);
  });
  it('deletes multiple images together and rejects incomplete or duplicate deletion lists', async () => {
    const { ids, payload } = await imageForDeletion(9, 6);
    const request = { method: 'PUT' as const, url: '/api/catalog', headers: headers(), payload };
    for (const deleteObjects of [ids.slice(0, 3), [...ids.slice(0, 5), ids[0]], ids.slice(0, 7)]) {
      expect(
        (await app.inject({ ...request, payload: { ...payload, deleteObjects } })).statusCode,
      ).toBe(400);
    }
    expect(
      (await app.inject({ ...request, headers: headers(viewerToken, '100.80.0.2') })).statusCode,
    ).toBe(403);
    expect(readdirSync(join(dir, 'objects'))).toHaveLength(9);
    const deleted = await app.inject(request);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ revision: 3, pending: 0 });
    expect(readdirSync(join(dir, 'objects')).sort()).toEqual(ids.slice(6).sort());
    expect((await app.inject(request)).statusCode).toBe(409);
    for (const id of ids.slice(0, 6))
      expect((await app.inject({ url: `/api/objects/${id}`, headers: headers() })).statusCode).toBe(
        404,
      );
  });
  it('permanently deletes only the selected files and rejects stale or unauthorized deletion', async () => {
    const { ids, payload } = await imageForDeletion();
    const request = { method: 'PUT' as const, url: '/api/catalog', headers: headers(), payload };
    expect(
      (await app.inject({ ...request, headers: headers(viewerToken, '100.80.0.2') })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ ...request, payload: { ...payload, revision: 1 } })).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          ...request,
          payload: { ...payload, deleteObjects: [ids[0], ids[1], ids[3]] },
        })
      ).statusCode,
    ).toBe(400);
    expect(readdirSync(join(dir, 'objects'))).toHaveLength(4);
    mkdirSync(join(dir, 'maintenance.lock'));
    expect((await app.inject(request)).statusCode).toBe(409);
    rmdirSync(join(dir, 'maintenance.lock'));
    const deleted = await app.inject(request);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ revision: 3, pending: 0 });
    expect(readdirSync(join(dir, 'objects'))).toEqual([ids[3]]);
    for (const id of ids.slice(0, 3))
      expect((await app.inject({ url: `/api/objects/${id}`, headers: headers() })).statusCode).toBe(
        404,
      );
    expect(
      (await app.inject({ url: `/api/objects/${ids[3]}`, headers: headers() })).rawPayload,
    ).toEqual(Buffer.alloc(64, 7));
    expect(
      (
        await app.inject({
          ...request,
          payload: { revision: 3, catalog: payload.catalog, objects: ids },
        })
      ).statusCode,
    ).toBe(400);
    const db = openStore(dir);
    expect(db.prepare('SELECT * FROM objects').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM pending_deletions').all()).toHaveLength(0);
    db.close();
  });
  it('keeps failed file deletions queued and retries safely after restart', async () => {
    const { ids, payload } = await imageForDeletion();
    // A directory in place of one object forces unlink to fail on every platform.
    const blocked = join(dir, 'objects', ids[0]);
    rmSync(blocked);
    mkdirSync(blocked);
    const result = await app.inject({
      method: 'PUT',
      url: '/api/catalog',
      headers: headers(),
      payload,
    });
    expect(result.json()).toEqual({ revision: 3, pending: 1 });
    expect((await app.inject({ url: '/api/deletions', headers: headers() })).json()).toEqual({
      pending: 1,
    });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/catalog',
          headers: headers(),
          payload: {
            revision: 3,
            catalog: payload.catalog,
            objects: [ids[0], ids[3]],
          },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
    rmdirSync(blocked);
    app = await buildApp({
      origin: 'https://test.example.ts.net',
      rpID: 'test.example.ts.net',
      dataDir: dir,
      production: true,
      host: '127.0.0.1',
    });
    expect((await app.inject({ url: '/api/deletions', headers: headers() })).json()).toEqual({
      pending: 0,
    });
    expect(existsSync(blocked)).toBe(false);
    const db = openStore(dir);
    expect(await withMaintenanceLock(dir, () => drainDeletions(db, dir))).toBe(0);
    db.close();
  });
  it('revokes active sessions immediately and protects the current admin', async () => {
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/devices/admin', headers: headers() }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/devices/viewer', headers: headers() }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/vault', headers: headers(viewerToken, '100.80.0.2') }))
        .statusCode,
    ).toBe(401);
  });
  it('expires idle sessions and adds security headers', async () => {
    const db = openStore(dir);
    db.prepare('UPDATE sessions SET touched=0').run();
    db.close();
    const res = await app.inject({ url: '/api/vault', headers: headers() });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
