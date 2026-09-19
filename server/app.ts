import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  createReadStream,
} from 'node:fs';
import { link, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  envelopeSchema,
  packetSchema,
  idSchema,
  preferencesSchema,
  type SortOrder,
  type Role,
} from '../shared/protocol.js';
import { openStore } from './store.js';
import { drainDeletions } from './deletions.js';
import { withMaintenanceLock } from './maintenance.js';
import type { Config } from './config.js';

type Credential = {
  id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
  label: string;
  role: Role;
  ip: string;
  created: number;
  revoked: number;
};
type Session = Credential & { authenticated: number };
type Challenge = { kind: string; challenge: string; context: string; ip: string; expires: number };
type Invitation = { hash: string; role: Role; ip: string; expires: number; issuer: string };
type Vault = { envelope: string; catalog: string; revision: number };
declare module 'fastify' {
  interface FastifyRequest {
    owner: Session | null;
    deviceIP: string;
  }
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: number, message: string): never => {
  throw new HttpError(code, message);
};
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const normalizeIP = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);
const tailnetIP = (ip: string) => {
  if (isIP(ip) === 6) return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
  const octets = ip.split('.').map(Number);
  return isIP(ip) === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
};
const MAX_OBJECT = 25 * 1024 * 1024 + 16;
const IDLE = 5 * 60_000;
const ABSOLUTE = 8 * 60 * 60_000;
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; worker-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export async function buildApp(config: Config) {
  const app = Fastify({ logger: false, bodyLimit: 3_000_000, requestTimeout: 120_000 });
  const db = openStore(config.dataDir);
  let cleanup: Promise<unknown> | undefined;
  const retryDeletions = () => {
    if (cleanup || !db.prepare('SELECT 1 FROM pending_deletions LIMIT 1').get()) return;
    cleanup = withMaintenanceLock(config.dataDir, () => drainDeletions(db, config.dataDir))
      .catch(() => {})
      .finally(() => {
        cleanup = undefined;
      });
  };
  retryDeletions();
  await cleanup;
  const cleanupTimer = setInterval(retryDeletions, 30_000);
  cleanupTimer.unref();
  const registered = () => !!db.prepare('SELECT 1 FROM credentials LIMIT 1').get();
  const bootstrapFile = join(config.dataDir, 'bootstrap-token');
  let bootstrapToken = config.bootstrapToken || '';
  if (!registered() && !bootstrapToken) {
    if (!existsSync(bootstrapFile))
      writeFileSync(bootstrapFile, token(), { mode: 0o600, flag: 'wx' });
    bootstrapToken = readFileSync(bootstrapFile, 'utf8').trim();
  }
  const cookieName = config.production ? '__Host-stillroom' : 'stillroom';
  const challengeCookie = config.production ? '__Host-ceremony' : 'ceremony';
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: config.production,
    sameSite: 'strict' as const,
  };
  app.decorateRequest('owner', null);
  app.decorateRequest('deviceIP', '');
  await app.register(cookie);
  await app.register(rateLimit, { global: false, keyGenerator: (req) => req.deviceIP });
  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
    await cleanup;
    db.close();
  });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    const code = error instanceof z.ZodError ? 400 : error.statusCode || 500;
    reply.code(code).send({
      error:
        code >= 500
          ? 'The server could not complete the request.'
          : error instanceof z.ZodError
            ? 'Invalid request.'
            : error.message,
    });
  });
  app.addHook('onSend', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (config.production)
      reply
        .header('Strict-Transport-Security', 'max-age=31536000')
        .header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  });
  app.addHook('onRequest', async (req) => {
    if (config.production) {
      // Serve overwrites these headers. Only its shared container loopback is trusted.
      const peer = normalizeIP(req.raw.socket.remoteAddress || '');
      const ip = req.headers['x-forwarded-for'];
      if (
        peer !== '127.0.0.1' ||
        typeof ip !== 'string' ||
        req.headers['x-forwarded-proto'] !== 'https' ||
        req.headers['x-forwarded-host'] !== new URL(config.origin).host ||
        req.headers['tailscale-funnel-request'] !== undefined
      )
        fail(403, 'Use the private HTTPS address.');
      req.deviceIP = normalizeIP(ip as string);
      if (!tailnetIP(req.deviceIP)) fail(403, 'This device is not on the private network.');
    } else req.deviceIP = normalizeIP(req.ip);
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== config.origin || req.headers['x-vault-request'] !== '1')
        fail(403, 'Request origin rejected.');
    }
  });
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const sessionToken = req.cookies[cookieName];
    if (sessionToken) {
      const session = db
        .prepare(
          `SELECT c.*, s.created AS authenticated, s.touched, s.ip AS session_ip
        FROM sessions s JOIN credentials c ON c.id=s.credential_id WHERE s.hash=? AND c.revoked=0`,
        )
        .get(hash(sessionToken)) as (Session & { touched: number; session_ip: string }) | undefined;
      if (
        session &&
        session.ip === req.deviceIP &&
        session.session_ip === req.deviceIP &&
        Date.now() - session.touched < IDLE &&
        Date.now() - session.authenticated < ABSOLUTE
      ) {
        req.owner = session;
        db.prepare('UPDATE sessions SET touched=? WHERE hash=?').run(
          Date.now(),
          hash(sessionToken),
        );
      } else db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(sessionToken));
    }
    if (req.url !== '/api/status' && !req.url.startsWith('/api/auth/') && !req.owner)
      fail(401, 'Sign in to continue.');
  });

  function admin(req: FastifyRequest) {
    if (req.owner?.role !== 'admin') fail(403, 'This device has viewing access only.');
  }
  function freshAdmin(req: FastifyRequest) {
    admin(req);
    if (Date.now() - req.owner!.authenticated > IDLE) fail(401, 'Sign in again to manage access.');
  }
  function issueSession(req: FastifyRequest, reply: FastifyReply, id: string) {
    db.prepare('DELETE FROM sessions WHERE touched<? OR created<?').run(
      Date.now() - IDLE,
      Date.now() - ABSOLUTE,
    );
    if (req.cookies[cookieName])
      db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(req.cookies[cookieName]!));
    const value = token();
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(
      hash(value),
      id,
      Date.now(),
      Date.now(),
      req.deviceIP,
    );
    reply.setCookie(cookieName, value, { ...cookieOptions, maxAge: ABSOLUTE / 1000 });
  }
  function issueChallenge(
    req: FastifyRequest,
    reply: FastifyReply,
    kind: string,
    challenge: string,
    context = {},
  ) {
    db.prepare('DELETE FROM challenges WHERE expires<?').run(Date.now());
    if (req.cookies[challengeCookie])
      db.prepare('DELETE FROM challenges WHERE hash=?').run(hash(req.cookies[challengeCookie]!));
    const value = token();
    db.prepare('INSERT INTO challenges VALUES (?,?,?,?,?,?)').run(
      hash(value),
      kind,
      challenge,
      JSON.stringify(context),
      req.deviceIP,
      Date.now() + IDLE,
    );
    reply.setCookie(challengeCookie, value, { ...cookieOptions, maxAge: IDLE / 1000 });
  }
  function consumeChallenge(req: FastifyRequest, reply: FastifyReply, kind: string): Challenge {
    const key = hash(req.cookies[challengeCookie] || '');
    const c = db.prepare('DELETE FROM challenges WHERE hash=? RETURNING *').get(key) as
      Challenge | undefined;
    reply.clearCookie(challengeCookie, cookieOptions);
    if (!c || c.kind !== kind || c.expires < Date.now() || c.ip !== req.deviceIP)
      fail(400, 'This sign-in request expired. Try again.');
    return c!;
  }
  const authRate = { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };
  app.get('/api/status', async (req) => ({
    registered: registered(),
    user: req.owner
      ? { id: req.owner.id, label: req.owner.label, role: req.owner.role, ip: req.deviceIP }
      : null,
    vaultExists: !!req.owner && !!db.prepare('SELECT 1 FROM vault').get(),
  }));
  app.post('/api/auth/register/options', authRate, async (req, reply) => {
    const input = z
      .object({ token: z.string().min(32).max(128), label: z.string().trim().min(1).max(80) })
      .parse(req.body);
    let role: Role = 'admin';
    const bootstrap = !registered();
    if (bootstrap) {
      if (!bootstrapToken || !equal(input.token, bootstrapToken))
        fail(403, 'Enrollment code is invalid or expired.');
    } else {
      const invite = db
        .prepare(
          `SELECT i.* FROM invitations i JOIN credentials c ON c.id=i.issuer WHERE i.hash=? AND c.revoked=0`,
        )
        .get(hash(input.token)) as Invitation | undefined;
      if (!invite || invite.expires < Date.now() || invite.ip !== req.deviceIP)
        fail(403, 'Enrollment code is invalid or expired for this device.');
      role = invite!.role;
    }
    const options = await generateRegistrationOptions({
      rpName: 'Stillroom',
      rpID: config.rpID,
      userName: 'owner',
      userDisplayName: input.label,
      supportedAlgorithmIDs: [-7, -257],
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: db.prepare('SELECT id FROM credentials WHERE revoked=0').all() as {
        id: string;
      }[],
    });
    issueChallenge(req, reply, 'register', options.challenge, {
      label: input.label,
      role,
      bootstrap,
      tokenHash: hash(input.token),
    });
    return options;
  });
  app.post('/api/auth/register/verify', authRate, async (req, reply) => {
    const c = consumeChallenge(req, reply, 'register');
    const context = JSON.parse(c.context) as {
      label: string;
      role: Role;
      bootstrap: boolean;
      tokenHash: string;
    };
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body as RegistrationResponseJSON,
        expectedChallenge: c.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true,
      });
    } catch {
      fail(400, 'Passkey registration failed. Try again.');
    }
    if (!verification?.verified) fail(400, 'Passkey registration failed.');
    const credential = verification!.registrationInfo!.credential;
    db.transaction(() => {
      if (context.bootstrap) {
        if (registered() || !equal(context.tokenHash, hash(bootstrapToken)))
          fail(409, 'Initial enrollment has already completed.');
      } else {
        const result = db
          .prepare(
            `DELETE FROM invitations WHERE hash=? AND expires>? AND ip=? AND issuer IN (SELECT id FROM credentials WHERE revoked=0)`,
          )
          .run(context.tokenHash, Date.now(), req.deviceIP);
        if (result.changes !== 1) fail(403, 'Enrollment code has expired or was used.');
      }
      db.prepare(
        'INSERT INTO credentials (id,public_key,counter,transports,label,role,ip,created) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports || []),
        context.label,
        context.role,
        req.deviceIP,
        Date.now(),
      );
    })();
    if (context.bootstrap) {
      bootstrapToken = '';
      await unlink(bootstrapFile).catch(() => {});
    }
    issueSession(req, reply, credential.id);
    return { ok: true };
  });
  app.post('/api/auth/login/options', authRate, async (req, reply) => {
    const credentials = db
      .prepare('SELECT id, transports FROM credentials WHERE ip=? AND revoked=0')
      .all(req.deviceIP) as Credential[];
    if (!credentials.length) fail(403, 'Enroll this device before signing in.');
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      userVerification: 'required',
      allowCredentials: credentials.map((c) => ({
        id: c.id,
        transports: JSON.parse(c.transports),
      })),
    });
    issueChallenge(req, reply, 'login', options.challenge);
    return options;
  });
  app.post('/api/auth/login/verify', authRate, async (req, reply) => {
    const c = consumeChallenge(req, reply, 'login');
    const body = req.body as AuthenticationResponseJSON;
    if (!body || typeof body.id !== 'string') fail(400, 'Invalid passkey response.');
    const credential = db
      .prepare('SELECT * FROM credentials WHERE id=? AND ip=? AND revoked=0')
      .get(body.id, req.deviceIP) as Credential | undefined;
    if (!credential) fail(403, 'This passkey is not enrolled for this device.');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: c.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        credential: {
          id: credential!.id,
          publicKey: new Uint8Array(credential!.public_key),
          counter: credential!.counter,
          transports: JSON.parse(credential!.transports),
        },
        requireUserVerification: true,
      });
    } catch {
      fail(400, 'Passkey verification failed. Try again.');
    }
    if (!verification?.verified) fail(400, 'Passkey verification failed.');
    const updated = db
      .prepare('UPDATE credentials SET counter=? WHERE id=? AND counter=? AND revoked=0')
      .run(verification!.authenticationInfo.newCounter, credential!.id, credential!.counter);
    if (!updated.changes) fail(409, 'Passkey state changed. Sign in again.');
    issueSession(req, reply, credential!.id);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(req.cookies[cookieName] || ''));
    reply.clearCookie(cookieName, cookieOptions).clearCookie(challengeCookie, cookieOptions);
    return { ok: true };
  });
  app.get('/api/devices', async (req) => {
    admin(req);
    return db
      .prepare('SELECT id,label,role,ip,created FROM credentials WHERE revoked=0 ORDER BY created')
      .all();
  });
  app.post('/api/invitations', async (req) => {
    freshAdmin(req);
    const input = z
      .object({ role: z.enum(['admin', 'viewer']), ip: z.string().max(64) })
      .parse(req.body);
    const ip = normalizeIP(input.ip.trim());
    if (!isIP(ip) || (config.production && !tailnetIP(ip)))
      fail(400, "Enter the device's Tailscale IP address.");
    const value = token();
    db.prepare('DELETE FROM invitations WHERE expires<?').run(Date.now());
    db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?)').run(
      hash(value),
      input.role,
      ip,
      Date.now() + 10 * 60_000,
      req.owner!.id,
    );
    return { token: value, expiresIn: 600 };
  });
  app.delete('/api/devices/:id', async (req) => {
    freshAdmin(req);
    const id = (req.params as { id: string }).id;
    if (id === req.owner!.id)
      fail(400, 'Use another administrative device to revoke this passkey.');
    db.transaction(() => {
      db.prepare('UPDATE credentials SET revoked=1 WHERE id=?').run(id);
      db.prepare('DELETE FROM sessions WHERE credential_id=?').run(id);
      db.prepare('DELETE FROM invitations WHERE issuer=?').run(id);
    })();
    return { ok: true };
  });

  app.get('/api/preferences', async (req) => {
    const row = db
      .prepare('SELECT sort_order FROM device_preferences WHERE credential_id=?')
      .get(req.owner!.id) as { sort_order: SortOrder } | undefined;
    return { sortOrder: row?.sort_order ?? 'date-desc' };
  });
  app.put('/api/preferences', async (req) => {
    const preferences = preferencesSchema.parse(req.body);
    db.prepare(
      'INSERT INTO device_preferences (credential_id,sort_order) VALUES (?,?) ON CONFLICT(credential_id) DO UPDATE SET sort_order=excluded.sort_order',
    ).run(req.owner!.id, preferences.sortOrder);
    return preferences;
  });
  app.get('/api/vault', async () => {
    const v = db.prepare('SELECT * FROM vault').get() as Vault | undefined;
    if (!v) fail(404, 'Create the vault from your upload device first.');
    return {
      envelope: JSON.parse(v!.envelope),
      catalog: JSON.parse(v!.catalog),
      revision: v!.revision,
    };
  });
  app.post('/api/vault', async (req) => {
    admin(req);
    const input = z.object({ envelope: envelopeSchema, catalog: packetSchema }).parse(req.body);
    if (
      input.catalog.ref.purpose !== 'catalog' ||
      input.catalog.ref.vaultId !== input.envelope.vaultId
    )
      fail(400, 'Invalid vault catalog.');
    if (db.prepare('SELECT 1 FROM vault').get()) fail(409, 'A vault already exists.');
    db.prepare('INSERT INTO vault VALUES (1,?,?,1)').run(
      JSON.stringify(input.envelope),
      JSON.stringify(input.catalog),
    );
    return { revision: 1 };
  });
  app.put('/api/vault/envelope', async (req) => {
    freshAdmin(req);
    const input = z
      .object({ envelope: envelopeSchema, revision: z.number().int().positive() })
      .parse(req.body);
    const v = db.prepare('SELECT * FROM vault').get() as Vault | undefined;
    if (!v || JSON.parse(v.envelope).vaultId !== input.envelope.vaultId)
      fail(400, 'Invalid vault.');
    const result = db
      .prepare('UPDATE vault SET envelope=?, revision=revision+1 WHERE singleton=1 AND revision=?')
      .run(JSON.stringify(input.envelope), input.revision);
    if (!result.changes) fail(409, 'The vault changed. Reload before saving.');
    return { revision: input.revision + 1 };
  });
  // The global body limit is far below a large collection's encrypted catalog.
  app.put('/api/catalog', { bodyLimit: 6_000_000 }, async (req) => {
    admin(req);
    const input = z
      .object({
        revision: z.number().int().positive(),
        catalog: packetSchema,
        objects: z.array(idSchema).max(30_000),
        deleteObjects: z.array(idSchema).min(1).max(30_000).optional(),
      })
      .parse(req.body);
    const commit = db.transaction(() => {
      const v = db.prepare('SELECT * FROM vault').get() as Vault | undefined;
      if (
        !v ||
        input.catalog.ref.vaultId !== JSON.parse(v.envelope).vaultId ||
        input.catalog.ref.purpose !== 'catalog'
      )
        fail(400, 'Invalid catalog.');
      if (v!.revision !== input.revision)
        fail(409, 'The collection changed in another tab. Reload before saving.');
      const exists = db.prepare(
        'SELECT 1 FROM objects WHERE id=? AND id NOT IN (SELECT id FROM pending_deletions)',
      );
      for (const id of input.objects)
        if (!exists.get(id)) fail(400, 'An image upload has not completed.');
      if (input.deleteObjects) {
        const current = (
          db.prepare('SELECT id FROM current_objects').all() as { id: string }[]
        ).map((o) => o.id);
        const next = new Set(input.objects);
        // Only files this commit drops from the collection may be queued, so a
        // deletion can never reach a file the new catalog still points at.
        const removed = current.filter((id) => !next.has(id));
        const deleted = new Set(input.deleteObjects);
        if (
          deleted.size !== input.deleteObjects.length ||
          removed.length !== deleted.size ||
          removed.some((id) => !deleted.has(id))
        )
          fail(400, 'Deletion must remove exactly the files the collection no longer uses.');
        const queue = db.prepare('INSERT INTO pending_deletions VALUES (?)');
        for (const id of deleted) queue.run(id);
      }
      db.prepare('UPDATE vault SET catalog=?, revision=revision+1 WHERE singleton=1').run(
        JSON.stringify(input.catalog),
      );
      db.prepare('DELETE FROM current_objects').run();
      const insert = db.prepare('INSERT OR IGNORE INTO current_objects VALUES (?)');
      for (const id of input.objects) insert.run(id);
    });
    if (input.deleteObjects)
      return withMaintenanceLock(config.dataDir, async () => {
        commit();
        const pending = await drainDeletions(db, config.dataDir);
        return { revision: input.revision + 1, pending };
      });
    commit();
    return { revision: input.revision + 1 };
  });
  app.get('/api/deletions', async (req) => {
    admin(req);
    return {
      pending: (
        db.prepare('SELECT count(*) AS count FROM pending_deletions').get() as { count: number }
      ).count,
    };
  });
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );
  let activeUploads = 0;
  app.put('/api/objects/:id', { bodyLimit: MAX_OBJECT }, async (req, reply) => {
    admin(req);
    if (!db.prepare('SELECT 1 FROM vault').get()) fail(409, 'Create a vault first.');
    const id = idSchema.parse((req.params as { id: string }).id);
    if (req.headers['content-type'] !== 'application/octet-stream')
      fail(415, 'Expected encrypted binary data.');
    if (activeUploads >= 2) fail(429, 'Wait for the current uploads to finish.');
    const temporary = join(config.dataDir, 'tmp', token());
    const destination = join(config.dataDir, 'objects', id);
    let bytes = 0;
    activeUploads++;
    try {
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, cb) {
          bytes += chunk.length;
          cb(
            bytes > MAX_OBJECT ? new HttpError(413, 'Image exceeds the upload limit.') : null,
            chunk,
          );
        },
      });
      await pipeline(
        req.body as Readable,
        limit,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true }),
      );
      if (bytes < 16) fail(400, 'Encrypted image is incomplete.');
      try {
        await link(temporary, destination);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST')
          fail(409, 'This object already exists.');
        throw e;
      }
      db.prepare('INSERT INTO objects VALUES (?,?,?)').run(id, bytes, Date.now());
      return reply.code(201).send({ id });
    } finally {
      activeUploads--;
      await unlink(temporary).catch(() => {});
    }
  });
  app.get('/api/objects/:id', async (req, reply) => {
    const id = idSchema.parse((req.params as { id: string }).id);
    if (!db.prepare('SELECT 1 FROM current_objects WHERE id=?').get(id))
      fail(404, 'Image not found.');
    const path = join(config.dataDir, 'objects', id);
    if (!(await stat(path).catch(() => null))) fail(404, 'Image not found.');
    return reply.type('application/octet-stream').send(createReadStream(path));
  });
  app.get('/api/*', async () => fail(404, 'Not found.'));
  if (config.staticDir && existsSync(config.staticDir)) {
    await app.register(serveStatic, { root: config.staticDir, cacheControl: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found.' })
        : reply.header('Cache-Control', 'no-store').sendFile('index.html'),
    );
  }
  return app;
}
