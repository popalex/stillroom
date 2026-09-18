Stillroom is a private image gallery for one owner. Upload through the website on one PC and browse on your other PCs, laptop, or phone. Browsers encrypt originals, thumbnails, previews, filenames, and categories before upload.

The first implementation includes passkey enrollment and login, device permissions, browser encryption, recovery secrets, batch upload, categories, search, preview navigation, original download, and backup snapshots. It has not undergone an independent security review. Test it with disposable images before relying on it for sensitive material.

1. Run locally with Node.js 24 and pnpm 11.5.2.

   ```sh
   pnpm install --frozen-lockfile
   pnpm dev
   ```

   Open http://localhost:5173. The initial enrollment code is in `data/bootstrap-token`. Read that file locally, enter its contents on the setup page, name the upload device, and create a passkey. The code becomes unusable after the first enrollment. Server output does not print the code.

   Choose a vault passphrase of at least 20 characters, preferably several randomly chosen words, and save the recovery secret offline. The passkey authenticates access; the passphrase decrypts the vault. An enrolled administrative passkey is still required to use vault recovery. The server cannot recover the images if every vault-unlock method is lost.

   Development binds to loopback. Use `localhost`, matching the configured WebAuthn origin. It is not a remote-access deployment. Local development clients share the loopback identity; production checks Tailscale device addresses.

2. Upload and browse.

   Add a category, then choose images or drag them onto the gallery. JPEG, PNG, and non-animated WebP are supported, up to 25 MiB and 40 megapixels per original. Uploads run sequentially. Each completed image gets its own catalog commit, so earlier images survive a later failure. Retry a failed file by selecting it again. This version does not resume partial file uploads.

   Open thumbnails to view previews, use arrow keys or swipe to navigate, and download the original when needed. Preview zoom uses the generated preview; it does not fetch a full-resolution original automatically. Administrators can rename images and change their category through Edit details. Delete sits beside Edit details; the form also has a Permanently delete button. Confirm permanent deletion to delete the original, preview, and thumbnail from the live server. Empty categories can be created, but category rename/removal is not implemented yet.

   Locking or backgrounding the page discards the gallery state and signs out. Five minutes without interaction also locks it. No plaintext images or keys are intentionally stored in browser storage. Browser memory, device screenshots, source images on the upload PC, and downloaded originals remain outside any secure-erasure guarantee.

3. Run through Tailscale on Ubuntu or Debian.

   The server stays on and stores the encrypted collection. Install Tailscale on every viewing device and sign in to your tailnet. Install Docker with Compose on the server, and [install Caddy using its official package instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

   You do not need to buy a certificate or supply certificate files. In the [Tailscale DNS admin page](https://login.tailscale.com/admin/dns), enable MagicDNS and HTTPS certificates. Caddy obtains the certificate through the local Tailscale daemon. Use a neutral machine name before enabling certificates, since the hostname appears in public certificate logs. The website remains accessible only through your tailnet. See [Tailscale's HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates) and [Caddy integration](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates).

   Stop `pnpm dev` with Ctrl+C to free port 3000. From this repository, generate the deployment settings:

   ```sh
   pnpm setup:tailscale
   sudo install -d -m 700 -o 1000 -g 1000 data-tailscale
   docker compose up -d --build
   ```

   The setup command reads your machine's Tailscale hostname and IPv4 address, generates a shared proxy secret, and writes `.env` and `deploy/.env.caddy` with mode 0600. It prints the HTTPS address and refuses to overwrite existing configuration. It does not change Tailscale settings or start services. Both generated files are ignored by Git.

   This uses a fresh collection in `data-tailscale/`. Create a new passkey and vault at the HTTPS address, then upload your images there. Passkeys enrolled at `localhost` will not work at the new hostname. The development collection remains in `data/`; these steps do not migrate it. For sensitive images, put `DATA_DIR` on an encrypted volume. Compose does not configure disk encryption.

   Allow Caddy to request the certificate. Open this file:

   ```sh
   sudoedit /etc/default/tailscaled
   ```

   Add or update this line, preserving other settings:

   ```text
   TS_PERMIT_CERT_UID=caddy
   ```

   Install the Caddy configuration and restart the services. These commands assume a dedicated Caddy instance; if it already serves other sites, merge the gallery configuration first.

   ```sh
   sudo install -m 600 deploy/.env.caddy /etc/caddy/stillroom.env
   sudo install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
   sudo install -d /etc/systemd/system/caddy.service.d
   sudo install -m 644 deploy/caddy.service.conf /etc/systemd/system/caddy.service.d/stillroom.conf
   sudo systemctl daemon-reload
   sudo systemctl restart tailscaled
   sudo systemctl enable caddy
   sudo systemctl restart caddy
   ```

   Restarting Tailscale briefly interrupts its connections. Caddy handles HTTPS on port 443 bound to the Tailscale IPv4 address, then forwards to the app on loopback port 3000. It supplies the proxy secret and the requesting device's Tailscale address, which the app checks at login and on every session request. This configuration does not use `tailscale serve` or Funnel. Proxying the development server directly would bypass the production deployment setup.

   Open the `https://...ts.net` address printed by the setup command, with no port suffix. Use the full hostname on the upload PC and on every other device. For the first enrollment, read the generated code locally:

   ```sh
   cat data-tailscale/bootstrap-token
   ```

   Enter the code on the setup page, register your upload PC's passkey, choose the vault passphrase, and save the recovery secret. The code file disappears after enrollment. Follow step 4 to enroll your laptop or phone.

   If the page does not open, check the services:

   ```sh
   docker compose ps
   docker compose logs --tail=50 viewer
   sudo journalctl -u caddy -n 50 --no-pager
   tailscale status
   ```

   Certificate errors usually mean HTTPS certificates are disabled or Caddy cannot access the local Tailscale daemon. A proxy-authentication error means the two generated environment files have different secrets. A port-3000 conflict usually means the development server is still running. If the host firewall blocks HTTPS, allow TCP 443 on `tailscale0`. Restrict tailnet HTTPS access to your own devices; existing broad grants remain effective because permissions are additive. Keep port 3000 on loopback and leave Funnel disabled.

   After code changes, run `docker compose up -d --build`. Use `sudo systemctl restart caddy` after changing its configuration. The provided Caddyfile disables its administration endpoint, so `caddy reload` is unavailable.

   The Docker build uses better-sqlite3's packaged native binary and tests it during installation. It does not install GCC, G++, binutils, make, or Python. Unsupported platforms fail that check instead of compiling a binary. Only esbuild's installation script is enabled in pnpm's build allowlist.

4. Enroll another device.

   On the upload PC, open Manage devices, enter the new device's Tailscale IP address, choose viewing access, and create an enrollment code. On the new device, open the same website, select Set up a new device, and enter that code within ten minutes. Register a passkey and enter your vault passphrase locally.

   Sessions and credentials are bound to the enrolled source address. The provided Caddy configuration uses Tailscale IPv4. If a device is removed and re-enrolled in Tailscale with a different address, enroll its app credential again. Keep a second administrative credential available, ideally backed by a spare hardware key. To enroll it, issue an administrative invitation for the intended device address.

   Revoke a lost device's passkey from another administrative session and remove the device from Tailscale. A copied decryption key or already-downloaded images cannot be revoked. Full key rotation and collection re-encryption are not automated in this version. Suspected vault-key exposure requires creating a new vault and importing from trusted originals.

5. Back up and recover.

   ```sh
   pnpm backup /path/on/encrypted-storage/new-backup-directory
   ```

   For the Tailscale deployment, run `DATA_DIR=./data-tailscale pnpm backup /path/on/encrypted-storage/new-backup-directory`. The backup command does not load `.env` automatically. Set `DATA_DIR` when using another source directory. The command uses SQLite's backup API, copies the current catalog's immutable encrypted objects, removes sessions and pending enrollment codes from the snapshot, and writes a SHA-256 manifest. A complete snapshot has `manifest.json`. An interrupted snapshot should be discarded and recreated at a new destination. Backups and permanent deletion share a lock so files cannot disappear while a snapshot copies them. A concurrent deletion asks you to retry.

   Images and catalog contents in the snapshot are encrypted. Credential public keys, device labels, roles, addresses, and object sizes are not application-encrypted. Keep the entire backup on encrypted storage, or encrypt it separately before sending it offsite. The manifest detects accidental corruption; it is not a signature against an attacker replacing the backup.

   For restoration, stop the app, verify the snapshot's hashes, and copy `vault.sqlite` and `objects/` into a new empty data directory. Do not overlay an old SQLite WAL. Restore ownership and permissions, retain the original HTTPS origin, and restart. Use a saved administrative passkey and your vault passphrase or recovery secret. Test this process before deleting any source images.

   Permanent deletion updates the encrypted catalog and removes the selected image files from live storage. Failed file cleanup stays queued and retries every 30 seconds and at startup; the admin gallery shows a warning while files remain. Existing backups, downloads, source files, and storage snapshots are separate copies. File deletion does not guarantee forensic erasure from an SSD. Unreferenced files from interrupted uploads are not automatically pruned.

   An interrupted backup or deletion can leave `DATA_DIR/maintenance.lock`. If operations keep reporting that maintenance is running, stop the app and all backup processes, remove that empty directory with `rmdir`, then restart. For the deployment above, the path is `data-tailscale/maintenance.lock`. Do not remove the lock while either process is active.

6. Verify changes.

   ```sh
   pnpm build
   pnpm test
   pnpm exec playwright install chromium
   pnpm test:e2e
   ```

   Unit tests cover access boundaries, session revocation, catalog conflicts, ciphertext authentication, key recovery, and KDF bounds. The browser test uses virtual authenticators with Chromium, uploads an image, opens it from a separate mobile-sized browser context, downloads the original, and recovers the vault. It does not replace testing your actual PC, phone, passkey provider, or Tailscale deployment.

The server delivers the website's JavaScript. A compromised server could modify that code to capture keys during a future unlock. Browser encryption protects stored content, but it cannot remove this trust in the website host. The architecture and its limits are recorded in [PLAN.md](PLAN.md) and [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md).
