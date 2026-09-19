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

// Files that were uploaded but never committed to a catalog: a batch interrupted
// before its commit, or a failed upload. Nothing references them, so nothing
// would ever remove them. The grace period keeps an upload still in flight safe,
// since its files exist before the commit that adopts them.
export async function sweepOrphans(db: Database.Database, dataDir: string, grace = 3_600_000) {
  const orphans = db
    .prepare(
      `SELECT id FROM objects
       WHERE created < ?
         AND id NOT IN (SELECT id FROM current_objects)
         AND id NOT IN (SELECT id FROM pending_deletions)`,
    )
    .all(Date.now() - grace) as { id: string }[];
  let removed = 0;
  for (const { id } of orphans) {
    try {
      await unlink(join(dataDir, 'objects', id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    db.prepare('DELETE FROM objects WHERE id=?').run(id);
    removed++;
  }
  return removed;
}
