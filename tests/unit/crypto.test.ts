import { describe, expect, it } from 'vitest';
import {
  createVault,
  decryptCatalog,
  decryptObject,
  encryptCatalog,
  encryptObject,
  fromBase64,
  recoverVault,
  unlockVault,
} from '../../src/crypto/vault';
import { deriveArgon } from '../../src/crypto/argon';

const passphrase = 'copper orchard sailboat winter river';
describe('encrypted vault format', () => {
  it('unlocks on a second client and rejects incorrect passwords', async () => {
    const { vault, envelope } = await createVault(passphrase, deriveArgon);
    const input = new TextEncoder().encode('private photograph bytes');
    const encrypted = await encryptObject(vault, 'original', input);
    const second = await unlockVault(JSON.parse(JSON.stringify(envelope)), passphrase, deriveArgon);
    expect(await decryptObject(second, encrypted.ref, encrypted.data)).toEqual(input);
    expect(JSON.stringify(envelope)).not.toContain(passphrase);
    expect(Buffer.from(encrypted.data).includes(Buffer.from(input))).toBe(false);
    await expect(unlockVault(envelope, 'incorrect passphrase', deriveArgon)).rejects.toThrow(
      'incorrect',
    );
  });
  it('authenticates ciphertext, object identity, purpose, and wrapped keys', async () => {
    const { vault } = await createVault(passphrase, deriveArgon);
    const object = await encryptObject(vault, 'thumbnail', new Uint8Array([1, 2, 3]));
    const changed = new Uint8Array(object.data);
    changed[0] ^= 1;
    await expect(decryptObject(vault, object.ref, changed)).rejects.toThrow();
    await expect(
      decryptObject(vault, { ...object.ref, id: crypto.randomUUID() }, object.data),
    ).rejects.toThrow();
    await expect(
      decryptObject(vault, { ...object.ref, purpose: 'original' }, object.data),
    ).rejects.toThrow();
    await expect(
      decryptObject(vault, { ...object.ref, vaultId: crypto.randomUUID() }, object.data),
    ).rejects.toThrow();
    await expect(
      decryptObject(
        vault,
        { ...object.ref, key: { ...object.ref.key, iv: 'A'.repeat(16) } },
        object.data,
      ),
    ).rejects.toThrow();
    expect(object.data.length).toBe(19);
    expect(fromBase64(object.ref.key.data)).toHaveLength(48);
  });
  it('recovers the same vault with a new passphrase', async () => {
    const original = await createVault(passphrase, deriveArgon);
    const object = await encryptObject(original.vault, 'original', new Uint8Array([4, 5]));
    const recovered = await recoverVault(
      original.envelope,
      original.recovery,
      'another random phrase with enough words',
      deriveArgon,
    );
    expect(await decryptObject(recovered.vault, object.ref, object.data)).toEqual(
      new Uint8Array([4, 5]),
    );
    const unlocked = await unlockVault(
      recovered.envelope,
      'another random phrase with enough words',
      deriveArgon,
    );
    expect(unlocked.vaultId).toBe(original.vault.vaultId);
    await expect(unlockVault(recovered.envelope, passphrase, deriveArgon)).rejects.toThrow();
    await expect(
      recoverVault(original.envelope, '00'.repeat(32), passphrase, deriveArgon),
    ).rejects.toThrow();
  });
  it('encrypts category names and rejects forged catalog types', async () => {
    const { vault } = await createVault(passphrase, deriveArgon);
    const catalog = { v: 1 as const, categories: ['secret category'], images: [] };
    const packet = await encryptCatalog(vault, catalog);
    expect(JSON.stringify(packet)).not.toContain('secret category');
    expect(await decryptCatalog(vault, packet)).toEqual(catalog);
    await expect(
      decryptCatalog(vault, { ...packet, ref: { ...packet.ref, purpose: 'preview' } }),
    ).rejects.toThrow();
  });
  it('rejects unbounded KDF parameters before deriving a key', async () => {
    const { envelope } = await createVault(passphrase, deriveArgon);
    let called = false;
    await expect(
      unlockVault(
        { ...envelope, kdf: { ...envelope.kdf, memory: 2 ** 40 } },
        passphrase,
        async () => {
          called = true;
          return new Uint8Array(32);
        },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
