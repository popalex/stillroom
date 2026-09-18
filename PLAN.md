Private image viewer implementation plan

This plan defines the intended design. A first implementation now exists; [README.md](README.md) records its behavior and limitations. It has not undergone an independent security review. One designated PC uploads images; other PCs, laptops, and mobile devices view them. Browsers encrypt images on the upload PC and decrypt them on viewing devices. Hosting location remains an open decision.

Both uploading and viewing happen through the same responsive website. On the upload PC, open the site, authenticate, unlock the vault, and select images through a file picker or drag and drop. The website's code running in that browser creates previews and encrypts the files before sending them to the server. No separate uploader application or command-line import is required. On another PC, laptop, or phone, open the same site, authenticate, unlock the vault, and browse the gallery. A VPN client is still required by the proposed private-network deployment.

The data flow is upload browser, local encryption, HTTPS upload, encrypted server storage, HTTPS download, and local decryption in a viewing browser. After an upload and its catalog update finish, the upload PC can be turned off if the server runs on a separate machine. The server must remain available for online viewing. If the upload PC also hosts the server, it must remain on.

1. Define what privacy means for this application.

   Protect image contents and descriptive metadata against network interception, unauthorized access, and theft of server storage or backups. Keep the website reachable only through a private network. Store no plaintext originals, thumbnails, filenames, category names, or EXIF data on the server.

   Absolute privacy is not achievable. An infected or unlocked client device can expose displayed images and keys. Screenshots and deliberate downloads create copies outside the application. The server can observe ciphertext sizes, request timing, and access patterns. A compromised server that supplies the website can change its JavaScript to steal secrets during a later unlock. Browser encryption does not remove that trust dependency. Strong protection against a malicious website host requires an independently distributed, verified client, which expands the scope beyond a simple website. See the [Web Crypto security considerations](https://www.w3.org/TR/webcrypto-2/#security-considerations).

2. Keep the product small.

   Build one responsive website for desktop and mobile browsers. Include a category list, thumbnail grid, full-screen preview, zoom, swipe navigation, keyboard navigation, and search over decrypted names and categories. Give the designated upload PC batch upload, category assignment, rename, and delete controls. Give viewing devices read-only access by default, with an explicit original download option. Read-only access prevents changes to the server collection; it cannot prevent a device that displays an image from copying it. Load thumbnails first and fetch larger images on demand.

   Start with JPEG, PNG, and WebP. Test file type, dimensions, and size before decoding on the upload PC, and limit viewing decode concurrency on phones. Exclude SVG and other active content. Defer HEIC, RAW, video, editing, sharing, public links, multiple users, and offline image storage. Determine collection size and maximum image size before choosing upload limits and pagination targets.

3. Restrict access before login.

   Use the owner's existing Tailscale network. Enroll the image server, upload PC, and viewing devices. Restrict access to the server's HTTPS port to explicitly approved devices using the tailnet policy. Review existing broad allow rules because an additional restrictive grant does not cancel other grants. Keep the website, API, storage, and administrative access private. No separate WireGuard installation is required. See [Tailscale grants](https://tailscale.com/docs/features/access-control/grants).

   Tailscale encrypts device traffic, including relayed traffic, but its provider handles coordination metadata. Keep browser-side image encryption as a separate layer. Do not expose the gallery through Tailscale Funnel or share the server with other users. If adopting Tailnet Lock, account for its signing and recovery procedures; it cannot be enabled together with device approval. Review the current tailnet setup before changing either feature. See [Tailscale encryption](https://tailscale.com/docs/concepts/tailscale-encryption) and [Tailnet Lock](https://tailscale.com/docs/features/tailnet-lock).

   Use HTTPS inside Tailscale, a stable MagicDNS hostname, and valid certificate verification. Prefer TLS 1.3. Use Caddy's Tailscale certificate integration for the server's full .ts.net hostname. Certificate issuance publishes that hostname in certificate-transparency logs, so choose a neutral machine name before requesting it. If hostname disclosure is unacceptable, use a private CA instead. Never require bypassing browser certificate warnings. See [Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).

4. Use one owner account with public-key authentication.

   Prefer WebAuthn passkeys with user verification for the everyday login. Register the upload PC's administrative credential through a local administrative bootstrap, then close enrollment. Require that administrative credential or a local recovery procedure to approve additional credentials and their permissions. Viewing credentials cannot enroll devices or grant write access. Keep a spare administrative hardware security key offline and test it. Use separate device-bound credentials and VPN device identities when enforcing different permissions per device; a shared or synchronized credential cannot identify one physical PC. See [WebAuthn](https://www.w3.org/TR/webauthn-3/).

   Certificate authentication is a valid alternative. Issue a separate client certificate per device from an offline private CA. Configure the HTTPS proxy to require and verify the certificate, then authorize only explicitly enrolled certificates. Test installation, selection, renewal, revocation, and logout behavior on the actual desktop and mobile browsers before choosing it. Maintain a server-side device allowlist checked on requests so removing a device does not rely solely on certificate expiry. Caddy supports [TLS client authentication](https://caddyserver.com/docs/caddyfile/directives/tls).

   Do not require both passkeys and client certificates by default. A certificate authenticates possession of a device credential; it does not guarantee a fresh biometric check or provide the vault's decryption key. With passkeys, use short server-side sessions, Secure/HttpOnly/SameSite cookies, origin checks, CSRF protection, login rate limits, and session revocation. Every storage endpoint requires authorization, including previews and uploads. The backend must not be reachable around the proxy.

   Maintain one owner with separate enrolled device credentials. Enforce upload/admin and viewer permissions on the server, including object writes, catalog changes, deletion, and device management. Hiding upload buttons on viewing devices is insufficient. Revoking a viewing device must not disable the other devices.

5. Encrypt originals, previews, and metadata on the client.

   Generate a random vault key on the upload PC. Use reviewed cryptographic libraries and authenticated encryption. The proposed format uses AES-256-GCM, fresh per-object keys, and a unique nonce for every encryption under a given key. Bind each object's ID, type, and format version into authenticated data. Protect object keys with the vault key. Document and review the format before using real images.

   During import through the website, create thumbnails and a viewing preview in the upload PC's browser. Encrypt those, the original, and descriptive metadata in the browser before any image content leaves the device. Show preparation and upload progress in the website, with retry controls for failed uploads. Preserve original EXIF only inside the encrypted original; exclude it from derived previews. Use random server object IDs. Keep names, categories, sort information, and object-key envelopes in an encrypted catalog. Viewing devices decrypt the catalog for browsing and search; category changes happen through the website on the upload PC. Use version-checked catalog writes to avoid stale tabs or upload retries overwriting newer updates. Commit catalog references only after their encrypted objects are available.

   Start with a strong vault passphrase, processed locally with Argon2id and a random salt, to protect the vault key. Store only the encrypted key envelope and its derivation parameters on the server. Benchmark derivation settings on the phone. Never send the passphrase or unwrapped vault key to the server. See [libsodium password hashing](https://doc.libsodium.org/password_hashing).

   To add a viewing device, approve its VPN and login credentials using the upload PC's administrative access. On the new device, sign in, retrieve the encrypted vault-key envelope, and enter the vault passphrase locally to unlock it. The same vault key makes images uploaded on one PC readable on every approved viewing device. Authentication alone does not give the device that key. Keep the unlocked key in memory for the viewing session and unlock again after locking. This baseline requires no plaintext key transfer through email, URLs, or the server. Defer persistent device unlock and automatic key pairing until their storage and recovery design has been reviewed.

   Original files already on the upload PC and any copies in its backups remain outside the website's storage controls. Protect that PC and its backups with encryption. Do not automatically remove the source images after upload.

   Login and vault unlock remain separate operations in this baseline. Evaluate WebAuthn PRF for a later combined login and unlock flow, but only after testing every intended browser and authenticator, including recovery. Ordinary WebAuthn authentication does not itself supply an encryption key. See [WebAuthn extensions](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions).

   Add full-disk encryption on the server and clients as another protection for local files, swap, and administrative data. It does not protect data from a running, compromised server. See [OWASP cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html).

6. Limit browser and server retention.

   Keep decrypted images and vault keys in application memory only. Do not persist plaintext in localStorage, IndexedDB, service-worker caches, or application logs. Use Cache-Control: no-store for sensitive responses. Lock after a configurable idle interval, initially five minutes, and blank the viewer when backgrounded. Recheck elapsed time on resume because mobile browsers suspend timers. On lock, release image URLs, discard keys and decrypted state, and stop pending work. JavaScript cannot guarantee physical erasure of browser memory or prevent operating-system snapshots. See [MDN caching controls](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).

   Serve scripts, fonts, and styles locally. Include no analytics, advertising, remote image processing, or third-party runtime scripts. Apply a restrictive Content Security Policy, prohibit framing, and avoid logging filenames, categories, credentials, or request bodies. Keep short-lived operational logs with only what is needed to diagnose failures.

7. Keep deployment and recovery manageable.

   Use a static TypeScript frontend, a small backend, SQLite for authentication and opaque object records, and a directory of encrypted objects. Put Caddy in front for HTTPS. Final framework and authentication-library choices follow a maintenance and compatibility check. One server is sufficient; no distributed services are required. Run without root privileges, restrict filesystem permissions, pin dependencies, and maintain an update procedure.

   Generate a separate random recovery secret on the client and use it to protect another copy of the vault key. Keep that recovery secret offline, separately from server backups. Back up the encrypted objects, catalog, key envelopes, and authentication/configuration data as a consistent versioned set. Keep a second copy off the server and perform an actual restore before importing the full collection. Account recovery and vault decryption recovery must both be documented and tested. Losing every means of unwrapping the vault key means losing the images.

   On device loss, revoke its VPN key, login credential, and active sessions. If it may have exposed the vault key, rotate the vault and object keys and re-encrypt retained data. Revocation cannot erase files or keys already copied by an attacker. Document how long deleted images remain in backups and how expired backups are removed. Versioned backups also provide recovery from malicious deletion; authenticated encryption alone does not detect every rollback to an older valid catalog.

8. Build and validate in this order.

   First, confirm hosting, PC and phone operating systems, browsers, collection size, and image formats. Inspect the existing Tailscale policy and enroll any missing devices. Test passkeys and, if desired, client certificates on those exact devices. Decide whether the website-host trust limitation is acceptable.

   Next, build a small encryption prototype with synthetic images. Demonstrate upload from the designated PC and viewing from a second PC or laptop and a phone. Verify encrypted previews and categories, first-time viewer unlock, wrong-key rejection, modified-ciphertext rejection, and recovery from backup. Verify viewing with the upload PC turned off when hosting is separate. Review key generation, nonce handling, key envelopes, and the object format before continuing.

   Then implement the private deployment, owner enrollment, authentication, sessions, and device revocation. Verify that unauthenticated requests and direct object URLs cannot return stored data, and that the backend is inaccessible outside the intended route. Verify viewer credentials cannot upload, overwrite, delete, change categories, or enroll another device, even through direct API requests.

   Build the gallery and import workflow after those foundations work. Test touch interaction, large-image memory use, interrupted uploads, catalog write conflicts, and lock/resume behavior.

   Before real use, inspect server files, database, logs, browser storage, network requests, and restored backups for unintended plaintext. Test credential replay, CSRF, metadata injection, stolen-device revocation, and recovery with the spare credential. Confirm no third-party requests occur. Have someone qualified review the authentication and encryption design before relying on it for highly sensitive images.

The simpler alternative is a trusted home server that decrypts images itself, with full-disk encryption, HTTPS, private VPN access, and a passkey or client certificate. That removes client-side key handling and simplifies thumbnail generation. It also lets a compromised running server read the collection, so it requires an explicit change to the privacy assumption above.
