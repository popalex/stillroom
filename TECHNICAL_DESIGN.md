Proposed technical solution

This design implements [PLAN.md](PLAN.md). Upload and viewing both happen through one website. This document selects the implementation stack; no application has been built yet. Server location, actual client platforms, and library patch versions must be confirmed before deployment.

| Component | Choice | Responsibility |
| --- | --- | --- |
| Website | React, TypeScript, Vite | Upload, categories, gallery, and device management |
| Browser cryptography | Web Crypto AES-256-GCM; libsodium-wrappers-sumo for Argon2id | Encrypt before upload; decrypt after download |
| Authentication | SimpleWebAuthn browser and server packages | Passkey enrollment and login |
| API | Node.js 24 LTS and Fastify 5 | Authentication, permissions, encrypted object transfer, and catalog versioning |
| Database | SQLite with better-sqlite3 and SQL migrations | Credentials, sessions, device permissions, object inventory, encrypted catalog, and key envelopes |
| Image storage | Files on an encrypted Linux volume | Encrypted originals, thumbnails, and viewing previews |
| HTTPS | Caddy with Tailscale certificate integration | Serve the built website and proxy the API on the same origin |
| Private network | The owner's existing Tailscale network | Allow approved devices to reach the website |
| Deployment | Docker Compose for the API; Caddy and Tailscale on the Linux host | Repeatable application builds and persistent storage mounts |

Node.js 24 is an LTS release. SimpleWebAuthn currently documents Node LTS 22 and above. Use the current patched Node 24 release and compatible package versions, locked at implementation time and updated through tested rebuilds. See [Node.js releases](https://nodejs.org/en/about/previous-releases), [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server), and [Fastify support policy](https://fastify.dev/docs/latest/Reference/LTS/). Vite builds the static frontend; its development server is not part of production. See [Vite](https://vite.dev/guide/).

1. Deploy one server with one website origin.

   Run the server independently of the upload PC so the collection remains available when that PC is off. A home Linux machine or a rented Linux server can run the same application. Install Tailscale on the host and join the owner's existing tailnet. Hosting is not yet selected.

   Bind Caddy's HTTPS listener only to the server's Tailscale address and block direct public access to the website, API, and SSH. Publish the API container port only on host loopback for Caddy to reach. Validate both IPv4 and IPv6 exposure with Docker enabled. Caddy serves the built frontend and forwards /api requests to Fastify on the same host. The encrypted object directory is not a static web root. Do not enable Funnel for this application or share the server with external users.

   Choose a neutral, stable machine name before issuing certificates or registering passkeys. Use the server's full MagicDNS .ts.net hostname as the website origin. Enable MagicDNS and HTTPS certificates as needed. Caddy's Tailscale integration obtains and renews the certificate through the local Tailscale daemon; grant only the required local certificate access. This avoids installing a private CA on every viewing device. The issued hostname becomes public through certificate transparency, while access to the website remains private. Use a private CA if disclosing the hostname is unacceptable. Never disable HTTPS certificate verification. See [Caddy certificates on Tailscale](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates) and [HTTPS configuration](https://tailscale.com/docs/how-to/set-up-https-certificates).

   Restrict TCP 443 on this server to the approved upload and viewing devices in the tailnet policy. Review overlapping ACLs and grants so a broad existing rule cannot grant unintended access. Keep other tailnet services working when editing policy. Tailscale controls network access; the API still enforces upload and viewer permissions. See [Tailscale grants](https://tailscale.com/docs/features/access-control/grants).

2. Authenticate the owner and authorize each device.

   Use SimpleWebAuthn with required user verification, fixed expected origin and RP ID, and single-use challenges with short expiry. Store public credentials on the server. Create the first administrative credential using a temporary bootstrap available only during controlled initial setup. Disable bootstrap after enrollment.

   Administrative access on the upload PC approves additional viewing credentials. Require fresh authentication to enroll or revoke devices. Use separate device credentials and explicitly approved Tailscale node addresses. Enforce permissions using the enrolled credential and its enrolled Tailscale source address, with source addresses preserved through Caddy. Handle IPv4 and IPv6 explicitly; deny unrecognized addresses. Re-enroll the device association if its Tailscale identity changes. Trust forwarded identity headers only from Caddy, which must overwrite client-supplied values. Test that a viewing device cannot obtain administrative access using a synchronized or moved credential. Tailnet membership alone does not grant administrative access.

   Keep opaque server-side sessions in SQLite and send only a random session token in a Secure, HttpOnly, SameSite=Strict cookie. Store token hashes in the database. Apply CSRF and origin checks to state-changing requests. Check expiry, revocation, device identity, and permissions on every protected request. Use a five-minute idle timeout and an eight-hour absolute session limit initially. Client vault locking is separate and may occur sooner.

   Certificate authentication remains an alternative implementation at Caddy, with one certificate per device and explicit authorization. Do not implement two login systems in version one. The recommended version uses passkeys and keeps the certificate option for a device-compatibility decision.

3. Keep decryption keys on the clients.

   On initial setup, the upload browser generates a random 256-bit vault key. A strong vault passphrase, processed through Argon2id with a random salt, produces a wrapping key. AES-GCM encrypts the vault key under that wrapping key. The server stores only this encrypted envelope, nonce, salt, algorithm version, and derivation parameters.

   Derive the wrapping key in a browser worker using the sumo build of libsodium.js, which exposes password hashing. Benchmark memory and time requirements on the weakest supported phone; impose bounds on downloaded parameters before using them. Load the library and WebAssembly locally. See [libsodium.js](https://github.com/jedisct1/libsodium.js) and [Argon2id support](https://doc.libsodium.org/password_hashing).

   An approved viewing browser downloads the envelope after login. The owner enters the same vault passphrase locally, and the browser unwraps the vault key. The passphrase and plaintext keys never become API parameters. A separate random offline recovery secret protects a second vault-key envelope. Authentication recovery uses a spare administrative credential or controlled local bootstrap recovery; it cannot replace the vault recovery secret.

   Use a fresh random 256-bit data key for each immutable encrypted object. Encrypt with AES-GCM, a fresh 96-bit nonce, and a 128-bit authentication tag. Include object identity, purpose, vault identity, and format version as authenticated data. Wrap object keys with the vault key using fresh nonces. A catalog revision is also a fresh encrypted object with a fresh data key. Document byte encoding, nonce handling, key separation, limits, and error behavior before implementation, and validate with test vectors and tamper tests. The application defines a storage format, not a new cryptographic algorithm.

   Passphrase changes rewrap the vault key. They do not revoke old envelopes already copied with an old passphrase. Suspected key exposure requires the re-encryption procedure described in PLAN.md. One-touch passkey decryption remains deferred until WebAuthn PRF compatibility and recovery have been demonstrated on all intended devices.

4. Upload through the website.

   The owner chooses files or drops them onto the upload page, then assigns categories. The browser validates supported raster formats and proposed initial limits of 25 MiB and 40 megapixels per original. Validate these limits against the actual collection and phone memory before release. Start with one image preparation job at a time.

   The browser uses image decoding and canvas APIs to create an approximately 320-pixel thumbnail and a viewing preview with a maximum 2048-pixel long edge. It encrypts the original, thumbnail, and preview independently. Original metadata stays inside the encrypted original. The derived images omit original EXIF. The browser uploads encrypted binary objects with progress and retry controls.

   The API limits request size, validates opaque identifiers, streams ciphertext to temporary files, and commits complete objects atomically. Retries may resend the identical ciphertext; regenerating an object uses a fresh data key. The server cannot validate the underlying image format because it cannot decrypt it. Only the authorized upload role can write objects.

   After uploading the objects, the browser submits a new encrypted catalog revision with the previously read revision number. A database transaction rejects stale writes and publishes the new revision only when referenced objects exist. Interrupted uploads leave unreferenced ciphertext eligible for cleanup after a retention window.

5. Browse through the same website.

   The viewing browser authenticates, unlocks the vault, and decrypts the catalog in memory. The catalog contains category names, image names, sort fields, object references, and wrapped object keys. The server sees opaque IDs, sizes, and request activity, but not those descriptive fields.

   Start with one encrypted catalog for simplicity, subject to a collection-size benchmark. Split it into encrypted pages if measured startup time or memory use requires that. Render only the visible portion of the thumbnail grid and fetch thumbnails on demand. Fetch the viewing preview when an image opens; fetch the original for explicit full-resolution access or download. Search and category filtering run locally.

   Use temporary browser object URLs for decrypted images. Release URLs and decrypted state when leaving the viewer or locking. Keep plaintext out of persistent application storage, apply no-store to sensitive responses, and omit offline image caching. Use a restrictive Content Security Policy, with only the narrow WebAssembly permission needed for Argon2id. Host all assets locally. Automatic memory erasure and suppression of operating-system screenshots cannot be guaranteed.

6. Keep the API and storage small.

   The API needs authentication options/verification, logout, administrative credential enrollment and revocation, key-envelope retrieval, catalog retrieval and conditional update, and encrypted object upload/download/deletion. Apply read permissions to viewing endpoints and administrative permissions to all mutations. Session and encryption material must never appear in URLs or logs.

   SQLite stores credentials, VPN peer associations, roles, challenge/session records, encrypted key envelopes, encrypted catalog revisions, and object inventory. Image ciphertext lives in a private directory using random IDs as filenames. Do not store plaintext image names or category associations in database columns. Protect database journals, temporary ciphertext, and operational files with the host's encrypted volume too.

   Back up a consistent SQLite snapshot and all referenced immutable objects. Pause deletion during backup and define a retention period for removed objects. Keep encrypted backups off the server and recovery secrets separately offline. Test restoration onto a clean instance, including authentication re-enrollment when necessary. Full-disk encryption requires an explicit boot-unlock procedure; unattended unlock changes its protection against physical theft.

7. Implement a small working path first.

   First deliver website login, vault creation, one browser upload, and decryption on a second browser. Include encrypted thumbnails, wrong-key and tamper rejection, server-enforced viewer permissions, and recovery. Then add categories, batch upload, responsive navigation, device administration, backups, and deployment hardening. Use real desktop and mobile browsers for the compatibility checks.

   The server still delivers the executable website. A malicious host or compromised frontend deployment could steal secrets on a future unlock, even though stored files are encrypted. This design protects stored content and transport without claiming to solve that website trust limitation. See [Web Crypto security considerations](https://www.w3.org/TR/webcrypto-2/#security-considerations).
