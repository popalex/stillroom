import Database from 'better-sqlite3';
import { mkdir, copyFile, writeFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withMaintenanceLock } from './maintenance.js';

export async function createBackup(dataDir: string, destination: string) {
  return withMaintenanceLock(dataDir, () => copyBackup(dataDir, destination));
}

async function copyBackup(dataDir: string, destination: string) {
  const source = await realpath(dataDir);
  const target = resolve(destination);
  const inside = relative(source, target);
  if (!inside || (!inside.startsWith('..') && !inside.startsWith('/')))
    throw new Error('Choose a backup destination outside the data directory.');
  await mkdir(target, { mode: 0o700 });
  await mkdir(join(target, 'objects'), { mode: 0o700 });
  const live = new Database(join(source, 'vault.sqlite'), { readonly: true, fileMustExist: true });
  try {
    await live.backup(join(target, 'vault.sqlite'));
  } finally {
    live.close();
  }
  const snapshot = new Database(join(target, 'vault.sqlite'));
  let objects: { id: string; bytes: number }[];
  try {
    if (!snapshot.prepare('SELECT 1 FROM vault').get())
      throw new Error('Create a vault before backing it up.');
    objects = snapshot
      .prepare(
        'SELECT o.id,o.bytes FROM objects o JOIN current_objects c ON c.id=o.id ORDER BY o.id',
      )
      .all() as { id: string; bytes: number }[];
    snapshot.exec(
      'DELETE FROM sessions; DELETE FROM challenges; DELETE FROM invitations; DELETE FROM objects WHERE id NOT IN (SELECT id FROM current_objects);',
    );
    if (snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name='pending_deletions'").get())
      snapshot.exec('DELETE FROM pending_deletions');
    snapshot.pragma('journal_mode = DELETE');
    snapshot.exec('VACUUM');
  } finally {
    snapshot.close();
  }
  const manifest: { version: number; created: string; files: { path: string; sha256: string }[] } =
    { version: 1, created: new Date().toISOString(), files: [] };
  for (const object of objects)
    await copyFile(join(source, 'objects', object.id), join(target, 'objects', object.id));
  for (const name of ['vault.sqlite', ...objects.map((o) => `objects/${o.id}`)]) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(target, name))) hash.update(chunk);
    manifest.files.push({ path: name, sha256: hash.digest('hex') });
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  });
  return objects.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const destination = process.argv[2];
  if (!destination)
    throw new Error('Usage: pnpm backup /path/on/encrypted-storage/new-backup-directory');
  const count = await createBackup(resolve(process.env.DATA_DIR || 'data'), destination);
  console.log(
    `Saved a consistent snapshot with ${count} encrypted objects. Keep this directory on encrypted storage; device metadata is not application-encrypted.`,
  );
}
