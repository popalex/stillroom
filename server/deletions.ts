import type Database from 'better-sqlite3';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

// The caller holds the maintenance lock until all file deletions finish.
export async function drainDeletions(db: Database.Database, dataDir: string) {
  const pending = db.prepare('SELECT id FROM pending_deletions').all() as { id: string }[];
  for (const { id } of pending) {
    try {
      await unlink(join(dataDir, 'objects', id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    db.transaction(() => {
      db.prepare('DELETE FROM objects WHERE id=?').run(id);
      db.prepare('DELETE FROM pending_deletions WHERE id=?').run(id);
    })();
  }
  return (db.prepare('SELECT count(*) AS count FROM pending_deletions').get() as { count: number })
    .count;
}
