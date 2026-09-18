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

   Open thumbnails to view previews, use arrow keys or swipe to navigate, and download the original when needed. Preview zoom uses the generated preview; it does not fetch a full-resolution original automatically. Administrators can rename images, change their category, and remove them from the gallery. Empty categories can be created, but category rename/removal is not implemented yet.

   Locking or backgrounding the page discards the gallery state and signs out. Five minutes without interaction also locks it. No plaintext images or keys are intentionally stored in browser storage. Browser memory, device screenshots, source images on the upload PC, and downloaded originals remain outside any secure-erasure guarantee.

3. Deploy behind Tailscale.

   Install Tailscale and Caddy on a Linux host and join your existing tailnet. Use a neutral machine name before requesting its HTTPS certificate. Choose the full `.ts.net` hostname before creating production passkeys. Changing the origin later can require credential re-enrollment.

   Enable MagicDNS and HTTPS certificates in Tailscale. Caddy can obtain and renew the node's certificate through the local daemon. Configure Tailscale's certificate access for the Caddy service user, following the [official Caddy integration](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates). Certificate issuance publishes the hostname in public certificate logs. Images and website access remain private.

   Create `.env` from `.env.example`, set `APP_ORIGIN`, and generate a random `PROXY_SECRET` of at least 32 characters. Set `DATA_DIR` to storage on an encrypted volume. Compose does not create full-disk encryption. Create the host directory with owner UID 1000, matching the container's node user, and mode 0700. Protect `.env` with mode 0600.

   ```sh
   docker compose build
   docker compose up -d
   ```

   Configure Caddy with `deploy/Caddyfile`. Give its service the three variables shown in `deploy/caddy-environment.example`, with the same proxy secret as the application. Keep the service environment file readable only by its administrator. Caddy binds only to the configured Tailscale IPv4 address and overwrites the proxy authentication headers. The app's Docker port binds only to host loopback. Serve the whole application through this route. Do not publish port 3000 on a public or LAN interface, and do not enable Tailscale Funnel for the gallery.

   The production app fails closed without HTTPS configuration and a proxy secret. It also rejects non-Tailscale source addresses. Verify the actual listener and firewall configuration on the host, including IPv6. Local host processes are trusted within this deployment boundary.

   Restrict HTTPS access to your selected devices using your tailnet policy. Review existing broad rules before adding grants; permissions are additive. Do not replace the entire existing tailnet policy with a gallery-only example. No Tailscale account settings are changed by this repository.

4. Enroll another device.

   On the upload PC, open Manage devices, enter the new device's Tailscale IP address, choose viewing access, and create an enrollment code. On the new device, open the same website, select Set up a new device, and enter that code within ten minutes. Register a passkey and enter your vault passphrase locally.

   Sessions and credentials are bound to the enrolled source address. The provided Caddy configuration uses Tailscale IPv4. If a device is removed and re-enrolled in Tailscale with a different address, enroll its app credential again. Keep a second administrative credential available, ideally backed by a spare hardware key. To enroll it, issue an administrative invitation for the intended device address.

   Revoke a lost device's passkey from another administrative session and remove the device from Tailscale. A copied decryption key or already-downloaded images cannot be revoked. Full key rotation and collection re-encryption are not automated in this version. Suspected vault-key exposure requires creating a new vault and importing from trusted originals.

5. Back up and recover.

   ```sh
   pnpm backup /path/on/encrypted-storage/new-backup-directory
   ```

   Set `DATA_DIR` when using a different source directory. The command uses SQLite's backup API, copies the current catalog's immutable encrypted objects, removes sessions and pending enrollment codes from the snapshot, and writes a SHA-256 manifest. A complete snapshot has `manifest.json`. An interrupted snapshot should be discarded and recreated at a new destination. Do not prune source objects during a backup.

   Images and catalog contents in the snapshot are encrypted. Credential public keys, device labels, roles, addresses, and object sizes are not application-encrypted. Keep the entire backup on encrypted storage, or encrypt it separately before sending it offsite. The manifest detects accidental corruption; it is not a signature against an attacker replacing the backup.

   For restoration, stop the app, verify the snapshot's hashes, and copy `vault.sqlite` and `objects/` into a new empty data directory. Do not overlay an old SQLite WAL. Restore ownership and permissions, retain the original HTTPS origin, and restart. Use a saved administrative passkey and your vault passphrase or recovery secret. Test this process before deleting any source images.

   Removing an image updates the live catalog. Ciphertext remains in the server object directory and older backups. Automatic garbage collection and backup retention are intentionally not enabled in this first version. Do not treat gallery removal as immediate physical deletion.

6. Verify changes.

   ```sh
   pnpm build
   pnpm test
   pnpm exec playwright install chromium
   pnpm test:e2e
   ```

   Unit tests cover access boundaries, session revocation, catalog conflicts, ciphertext authentication, key recovery, and KDF bounds. The browser test uses virtual authenticators with Chromium, uploads an image, opens it from a separate mobile-sized browser context, downloads the original, and recovers the vault. It does not replace testing your actual PC, phone, passkey provider, or Tailscale deployment.

The server delivers the website's JavaScript. A compromised server could modify that code to capture keys during a future unlock. Browser encryption protects stored content, but it cannot remove this trust in the website host. The architecture and its limits are recorded in [PLAN.md](PLAN.md) and [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md).
