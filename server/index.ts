import { buildApp } from './app.js';
import { configFromEnv } from './config.js';

process.umask(0o077);
const config = configFromEnv();
const app = await buildApp(config);
await app.listen({ host: config.host, port: Number(process.env.PORT || 3000) });
console.log(
  `Stillroom listening at ${config.origin}. Initial enrollment code, if needed: ${config.dataDir}/bootstrap-token`,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
