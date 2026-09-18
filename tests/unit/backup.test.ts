import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openStore } from '../../server/store';
import { createBackup } from '../../server/backup';
import {
  createVault,
  encryptCatalog,
  encryptObject,
  decryptCatalog,
  decryptObject,
  unlockVault,
} from '../../src/crypto/vault';
import { deriveArgon } from '../../src/crypto/argon';

it('restores a consistent snapshot without active sessions or unreferenced objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stillroom-backup-'));
  const source = join(root, 'source'),
    target = join(root, 'snapshot'),
    restored = join(root, 'restored');
  const db = openStore(source);
  try {
    const passphrase = 'a sufficiently long random vault passphrase';
    const created = await createVault(passphrase, deriveArgon);
    const catalog = { v: 1 as const, categories: ['private category'], images: [] };
    const packet = await encryptCatalog(created.vault, catalog);
    db.prepare('INSERT INTO vault VALUES (1,?,?,1)').run(
      JSON.stringify(created.envelope),
      JSON.stringify(packet),
    );
    const image = await encryptObject(
      created.vault,
      'original',
      new TextEncoder().encode('private original bytes'),
    );
    await writeFile(join(source, 'objects', image.ref.id), image.data);
    db.prepare('INSERT INTO objects VALUES (?,?,?)').run(
      image.ref.id,
      image.data.length,
      Date.now(),
    );
    db.prepare('INSERT INTO current_objects VALUES (?)').run(image.ref.id);
    const orphan = crypto.randomUUID();
    db.prepare('INSERT INTO objects VALUES (?,16,0)').run(orphan);
    await writeFile(join(source, 'objects', orphan), new Uint8Array(16));
    db.prepare('INSERT INTO credentials VALUES (?, ?, 0, ?, ?, ?, ?, ?, 0)').run(
      'admin',
      Buffer.from([1]),
      '[]',
      'Upload PC',
      'admin',
      '100.80.0.1',
      Date.now(),
    );
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(
      'session-hash',
      'admin',
      Date.now(),
      Date.now(),
      '100.80.0.1',
    );
    expect(await createBackup(source, target)).toBe(1);
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
    for (const file of manifest.files)
      expect(
        createHash('sha256')
          .update(await readFile(join(target, file.path)))
          .digest('hex'),
      ).toBe(file.sha256);
    await cp(target, restored, { recursive: true });
    const restoreDB = openStore(restored);
    try {
      expect(restoreDB.prepare('SELECT * FROM sessions').all()).toHaveLength(0);
      expect(restoreDB.prepare('SELECT * FROM objects').all()).toHaveLength(1);
      const row = restoreDB.prepare('SELECT * FROM vault').get() as {
        envelope: string;
        catalog: string;
      };
      const key = await unlockVault(JSON.parse(row.envelope), passphrase, deriveArgon);
      expect(await decryptCatalog(key, JSON.parse(row.catalog))).toEqual(catalog);
      expect(
        new TextDecoder().decode(
          await decryptObject(
            key,
            image.ref,
            await readFile(join(restored, 'objects', image.ref.id)),
          ),
        ),
      ).toBe('private original bytes');
    } finally {
      restoreDB.close();
    }
    await expect(createBackup(source, join(source, 'nested'))).rejects.toThrow('outside');
    await expect(createBackup(source, target)).rejects.toThrow();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
