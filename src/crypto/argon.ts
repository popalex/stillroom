import sodium from 'libsodium-wrappers-sumo';

export async function deriveArgon(passphrase: string, salt: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  await sodium.ready;
  if (salt.length !== 16) throw new Error('Invalid vault salt.');
  const password = sodium.from_string(passphrase);
  try { return new Uint8Array(sodium.crypto_pwhash(32, password, salt, 3, 67108864, sodium.crypto_pwhash_ALG_ARGON2ID13)); }
  finally { sodium.memzero(password); }
}
