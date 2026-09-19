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

   A line under the upload strip fills as the batch runs, weighted by the bytes each step moves, and the text names the file and the phase it is in. The same strip and line report a thumbnail rebuild.

   Use Sort by to choose filename A to Z or Z to A, or date added newest or oldest first. Date added is the upload time, not the original photo capture date. Each enrolled device keeps its own preference on the server, including viewing devices. Sorting, search, categories, and preview navigation use the same order. The browser sorts decrypted metadata; filenames remain encrypted on the server.

   Open thumbnails to view previews, use arrow keys or swipe to navigate, and download the original when needed. Zoom with the scroll wheel, a pinch, a double click or double tap, the `+` and `-` keys, or the toolbar buttons, and drag to move around a zoomed image. Press `0` or the percentage button to fit the image to the window again. Zooming uses the generated preview; it does not fetch a full-resolution original automatically.

   Administrators can rename images and change their category through Edit details. Choose New category there to create a category and move the image into it with Save details.

   Each upload stores three encrypted files: the original, a 2048px preview, and a 640px thumbnail for the grid. Images uploaded before thumbnails grew to 640px still have 320px ones, and the gallery offers Rebuild thumbnails while any remain. That runs in the browser: it decrypts each preview, renders a new thumbnail, uploads it, and deletes the file it replaced. Leave the tab open until it finishes, and run it from the upload PC, since viewing devices cannot write to the collection.

   Delete category removes a category and every image in it. On Uncategorized the same button reads Delete uncategorized and removes every image without a category, leaving the categories alone. Both include images hidden by the current search.

   Delete sits beside Edit details; the form also has a Permanently delete button. Confirm permanent deletion to delete the original, preview, and thumbnail from the live server.

   When a category is selected, Delete category sits beside Upload images. Confirm to permanently delete the category and all its images, including images hidden by search. Other categories and uncategorized images are kept. Empty categories can also be deleted. Category renaming is not implemented yet.

   Locking or backgrounding the page discards the gallery state and signs out. Five minutes without interaction also locks it. No plaintext images or keys are intentionally stored in browser storage. Browser memory, device screenshots, source images on the upload PC, and downloaded originals remain outside any secure-erasure guarantee.

3. Run with Docker Compose and Tailscale Serve.

   Docker Compose runs the gallery and Tailscale together. You do not need Caddy, a host reverse proxy, or certificate files. The Tailscale container joins your tailnet as its own device, named `stillroom`. Your existing host Tailscale installation can keep running. Viewing devices need Tailscale and a browser.

   In the [Tailscale DNS admin page](https://login.tailscale.com/admin/dns), enable MagicDNS and HTTPS certificates. Tailscale Serve obtains and renews the certificate. Certificate issuance makes the hostname public, while website access stays inside your tailnet. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

   From this repository, start Tailscale:

   ```sh
   docker compose up -d tailscale
   docker compose logs tailscale
   ```

   Open the login URL in the logs and authorize `stillroom` in your Tailscale account. This is a one-time browser login; no auth key needs to be stored in `.env`. If your tailnet requires device approval, approve the new node in the admin console too. Check that login has completed:

   ```sh
   docker compose exec tailscale tailscale status
   ```

   Generate the app configuration and start the gallery:

   ```sh
   pnpm setup:tailscale
   sudo install -d -m 700 -o 1000 -g 1000 data-tailscale
   docker compose up -d --build
   ```

   The setup command reads the container's actual Tailscale hostname and writes `.env` with mode 0600. It prints the HTTPS address to open, usually `https://stillroom.<your-tailnet>.ts.net`. Use that exact address on every device. It is different from the host PC's previous address. The command refuses to overwrite an existing `.env`; if one exists from the earlier setup, move it aside or update its `APP_ORIGIN` to the container's hostname. `PROXY_SECRET` is no longer used.

   The gallery stores its encrypted collection in `data-tailscale/`. Local development data stays in `data/`. Passkeys created at `localhost` or the host PC's old hostname cannot authenticate at the new hostname. For a fresh test collection, use a new empty `DATA_DIR` and enroll again. Keep any existing data you intend to migrate. For sensitive images, put `DATA_DIR` on an encrypted volume; Compose does not configure disk encryption.

   Read the initial enrollment code locally:

   ```sh
   cat data-tailscale/bootstrap-token
   ```

   Enter it on the website, create your upload PC's passkey, choose a vault passphrase, and save the recovery secret. The code file disappears after enrollment. Follow step 4 to add your laptop or phone.

   No container ports are published to the host. The gallery listens only on loopback inside Tailscale's network namespace. Serve forwards HTTPS requests there and overwrites client address headers; the API checks that address against the enrolled device. Funnel is disabled in `deploy/serve.json`, and the API rejects requests marked as Funnel traffic. This setup requires a Linux Docker host with `/dev/net/tun`. Only the Tailscale container receives `NET_ADMIN` for its network namespace. The gallery drops all capabilities. Keep `TS_USERSPACE=false`: userspace mode forwards incoming ports to loopback and would bypass this listener isolation. Docker administrators and the Tailscale container are trusted within this deployment boundary. The container settings follow [Tailscale's Docker configuration](https://tailscale.com/docs/features/containers/docker/docker-params).

   Restrict access to this node's HTTPS port to your own devices in your tailnet policy. Existing broad grants remain effective because permissions are additive. Device credentials and viewer/admin permissions are still enforced by the app.

   If the site does not open, inspect:

   ```sh
   docker compose ps
   docker compose logs --tail=50 tailscale viewer
   docker compose exec tailscale tailscale status
   docker compose exec tailscale tailscale serve status
   ```

   A pending login or device approval prevents startup. Missing HTTPS support usually means MagicDNS or HTTPS certificates need enabling in Tailscale. An origin error means `.env` does not match the container's actual hostname. After changing `.env`, recreate the viewer with `docker compose up -d viewer`.

   On later starts and after application changes, use `docker compose up -d --build`. Tailscale's identity persists in the `tailscale-state` Docker volume; keep that volume when stopping the stack. `docker compose down` preserves it, while `docker compose down -v` deletes it and requires a new Tailscale login. The image is pinned by digest; update the digest when upgrading Tailscale, then recreate both services together.

   If you followed the old Caddy instructions solely for this gallery, stop that unused service with `sudo systemctl disable --now caddy`. Leave it running if it serves other sites. The new containers do not depend on its files or the old certificate-permission setting.

   The gallery Docker build uses better-sqlite3's packaged native binary and tests it during installation. It does not install GCC, G++, binutils, make, or Python. Unsupported platforms fail that check instead of compiling a binary. Only esbuild's installation script is enabled in pnpm's build allowlist.

4. Enroll another device.

   On the upload PC, open Manage devices, enter the new device's Tailscale IP address, choose viewing access, and create an enrollment code. On the new device, open the same website, select Set up a new device, and enter that code within ten minutes. Register a passkey and enter your vault passphrase locally.

   Sessions and credentials are bound to the enrolled source address. Use the device address shown by Tailscale. Both Tailscale IPv4 and IPv6 addresses are accepted, but enrollment and subsequent access must use the same address. If a device is removed and re-enrolled in Tailscale with a different address, enroll its app credential again. Keep a second administrative credential available, ideally backed by a spare hardware key. To enroll it, issue an administrative invitation for the intended device address.

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
