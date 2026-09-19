import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env'))
  throw new Error(
    '.env already exists. Update APP_ORIGIN there to the container hostname, or move it aside before running setup again.',
  );
let status;
try {
  status = JSON.parse(
    execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'tailscale', 'tailscale', 'status', '--json'],
      { encoding: 'utf8' },
    ),
  );
} catch {
  throw new Error('Start and authorize the Tailscale container first. See the README.');
}
const hostname = status.Self?.DNSName?.replace(/\.$/, '');
if (status.BackendState !== 'Running' || !hostname || !/^[a-z0-9.-]+\.ts\.net$/.test(hostname))
  throw new Error('Authorize the Tailscale container and enable MagicDNS first.');
writeFileSync('.env', `APP_ORIGIN=https://${hostname}\nDATA_DIR=./data-tailscale\n`, {
  mode: 0o600,
  flag: 'wx',
});
console.log(`Configuration saved for https://${hostname}`);
console.log(
  'Run docker compose up -d --build, then open that address on a device connected to Tailscale.',
);
