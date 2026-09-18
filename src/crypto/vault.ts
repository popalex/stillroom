import { z } from 'zod';
import { envelopeSchema, packetSchema, refSchema, type Box, type Envelope, type ObjectRef, type Packet, type Catalog } from '../../shared/protocol';

export type VaultKey = { key: CryptoKey; vaultId: string };
export type Derive = (passphrase: string, salt: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(text);
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
export async function deriveInWorker(passphrase: string, salt: Uint8Array) {
  const worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Unlock timed out. Try again on a device with more available memory.')); }, 60_000);
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    worker.onmessage = (event) => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
    worker.onerror = () => { finish(); reject(new Error('Could not start vault encryption.')); };
    worker.postMessage({ passphrase, salt });
  });
}
const importKey = (bytes: Uint8Array) => crypto.subtle.importKey('raw', new Uint8Array(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
const aad = (vaultId: string, purpose: string) => encoder.encode(`stillroom:1:${vaultId}:${purpose}`);
async function seal(key: CryptoKey, bytes: Uint8Array, context: Uint8Array): Promise<Box> {
  const iv = random(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(context), tagLength: 128 }, key, new Uint8Array(bytes));
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}
async function open(key: CryptoKey, box: Box, context: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: new Uint8Array(context), tagLength: 128 }, key, fromBase64(box.data)));
}
export function checkPassphrase(value: string) {
  if (value.length < 20 || value.length > 1024) throw new Error('Use a vault passphrase of at least 20 characters, ideally several random words.');
}
export async function createVault(passphrase: string, derive: Derive = deriveInWorker) {
  checkPassphrase(passphrase);
  const vaultId = crypto.randomUUID();
  const raw = random(32), recoveryBytes = random(32), salt = random(16);
  let wrapping: Uint8Array | undefined;
  try {
    wrapping = await derive(passphrase, salt);
    const envelope: Envelope = { v: 1, vaultId,
      kdf: { algorithm: 'argon2id', salt: toBase64(salt), memory: 67108864, ops: 3 },
      passphrase: await seal(await importKey(wrapping), raw, aad(vaultId, 'passphrase')),
      recovery: await seal(await importKey(recoveryBytes), raw, aad(vaultId, 'recovery')) };
    const recovery = Array.from(recoveryBytes, b => b.toString(16).padStart(2, '0')).join('').match(/.{8}/g)!.join('-');
    return { vault: { key: await importKey(raw), vaultId }, envelope, recovery };
  } finally { raw.fill(0); recoveryBytes.fill(0); wrapping?.fill(0); }
}
export async function unlockVault(input: unknown, passphrase: string, derive: Derive = deriveInWorker): Promise<VaultKey> {
  const envelope = envelopeSchema.parse(input);
  const wrapping = await derive(passphrase, fromBase64(envelope.kdf.salt));
  let raw: Uint8Array | undefined;
  try {
    raw = await open(await importKey(wrapping), envelope.passphrase, aad(envelope.vaultId, 'passphrase'));
    return { key: await importKey(raw), vaultId: envelope.vaultId };
  } catch { throw new Error('The passphrase is incorrect, or the vault key is damaged.'); }
  finally { wrapping.fill(0); raw?.fill(0); }
}
export async function recoverVault(input: unknown, recovery: string, newPassphrase: string, derive: Derive = deriveInWorker) {
  checkPassphrase(newPassphrase);
  const envelope = envelopeSchema.parse(input);
  const hex = recovery.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Enter the complete recovery secret.');
  const secret = Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16));
  let raw: Uint8Array | undefined, wrapping: Uint8Array | undefined;
  try {
    raw = await open(await importKey(secret), envelope.recovery, aad(envelope.vaultId, 'recovery'));
    const salt = random(16);
    wrapping = await derive(newPassphrase, salt);
    const updated = { ...envelope, kdf: { ...envelope.kdf, salt: toBase64(salt) }, passphrase: await seal(await importKey(wrapping), raw, aad(envelope.vaultId, 'passphrase')) };
    return { envelope: updated, vault: { key: await importKey(raw), vaultId: envelope.vaultId } };
  } catch { throw new Error('Recovery failed. Check the recovery secret and try again.'); }
  finally { secret.fill(0); raw?.fill(0); wrapping?.fill(0); }
}
export async function encryptObject(vault: VaultKey, purpose: ObjectRef['purpose'], bytes: Uint8Array) {
  const id = crypto.randomUUID(), raw = random(32), iv = random(12);
  const context = `${purpose}:${id}`;
  try {
    const key = await seal(vault.key, raw, aad(vault.vaultId, `key:${context}`));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(vault.vaultId, `data:${context}`), tagLength: 128 }, await importKey(raw), new Uint8Array(bytes));
    return { ref: { id, vaultId: vault.vaultId, purpose, iv: toBase64(iv), key } satisfies ObjectRef, data: new Uint8Array(data) };
  } finally { raw.fill(0); }
}
export async function decryptObject(vault: VaultKey, input: ObjectRef, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const ref = refSchema.parse(input);
  if (ref.vaultId !== vault.vaultId) throw new Error('This image belongs to a different vault.');
  const context = `${ref.purpose}:${ref.id}`;
  const raw = await open(vault.key, ref.key, aad(vault.vaultId, `key:${context}`));
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ref.iv), additionalData: aad(vault.vaultId, `data:${context}`), tagLength: 128 }, await importKey(raw), new Uint8Array(data))); }
  finally { raw.fill(0); }
}
const imageSchema = z.object({
  id: z.string().uuid(), name: z.string().max(512), category: z.string().max(80), added: z.string().datetime(),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), width: z.number().int().positive().max(40_000_000),
  height: z.number().int().positive().max(40_000_000), bytes: z.number().int().positive().max(25 * 1024 * 1024),
  original: refSchema, thumbnail: refSchema, preview: refSchema,
}).strict();
const catalogSchema = z.object({ v: z.literal(1), categories: z.array(z.string().min(1).max(80)).max(1000), images: z.array(imageSchema).max(10_000) }).strict();
export async function encryptCatalog(vault: VaultKey, catalog: Catalog): Promise<Packet> {
  const bytes = encoder.encode(JSON.stringify(catalogSchema.parse(catalog)));
  if (bytes.length > 1_400_000) throw new Error('The catalog reached this version’s size limit.');
  const encrypted = await encryptObject(vault, 'catalog', bytes);
  return { v: 1, ref: encrypted.ref, data: toBase64(encrypted.data) };
}
export async function decryptCatalog(vault: VaultKey, input: unknown): Promise<Catalog> {
  const packet = packetSchema.parse(input);
  if (packet.ref.purpose !== 'catalog') throw new Error('Invalid catalog type.');
  const decrypted = await decryptObject(vault, packet.ref, fromBase64(packet.data));
  try {
    const catalog = catalogSchema.parse(JSON.parse(decoder.decode(decrypted)));
    for (const image of catalog.images) {
      for (const purpose of ['original', 'thumbnail', 'preview'] as const) {
        if (image[purpose].purpose !== purpose || image[purpose].vaultId !== vault.vaultId) throw new Error('Invalid image reference.');
      }
    }
    return catalog;
  } finally { decrypted.fill(0); }
}
