import { deriveArgon } from './argon';

self.onmessage = async (event: MessageEvent<{ passphrase: string; salt: Uint8Array }>) => {
  try {
    const result = await deriveArgon(event.data.passphrase, event.data.salt);
    self.postMessage({ result }, { transfer: [result.buffer] });
  } catch { self.postMessage({ error: 'Could not unlock the vault on this device.' }); }
};
