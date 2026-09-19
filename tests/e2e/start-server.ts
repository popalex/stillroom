import { buildApp, CONTENT_SECURITY_POLICY } from '../../server/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'stillroom-browser-'));
const app = await buildApp({
  origin: 'http://localhost:4173',
  rpID: 'localhost',
  production: false,
  host: '127.0.0.1',
  dataDir,
  staticDir: resolve('dist'),
  bootstrapToken: 'e'.repeat(64),
});
app.addHook('onSend', async (_req, reply) => {
  reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
});
await app.listen({ host: '127.0.0.1', port: 4173 });
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
