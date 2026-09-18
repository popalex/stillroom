import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

for (const file of ['.env', 'deploy/.env.caddy']) {
  if (existsSync(file))
    throw new Error(`${file} already exists. Edit it instead of regenerating secrets.`);
}
const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
const hostname = status.Self?.DNSName?.replace(/\.$/, '');
const ipv4 = status.Self?.TailscaleIPs?.find((ip) => /^100\.\d+\.\d+\.\d+$/.test(ip));
if (
  status.BackendState !== 'Running' ||
  !hostname ||
  !/^[a-z0-9.-]+\.ts\.net$/.test(hostname) ||
  !ipv4
)
  throw new Error('Connect this machine to Tailscale and enable MagicDNS first.');
const secret = randomBytes(32).toString('hex');
writeFileSync(
  '.env',
  `APP_ORIGIN=https://${hostname}\nPROXY_SECRET=${secret}\nDATA_DIR=./data-tailscale\n`,
  { mode: 0o600, flag: 'wx' },
);
writeFileSync(
  'deploy/.env.caddy',
  `TAILSCALE_HOSTNAME=${hostname}\nTAILSCALE_IPV4=${ipv4}\nPROXY_SECRET=${secret}\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  `Configuration saved. After completing the README deployment steps, open https://${hostname}`,
);
console.log(
  'This setup uses a fresh collection in data-tailscale/. Local development data stays in data/.',
);
