import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export class MaintenanceBusyError extends Error {
  statusCode = 409;
  constructor() {
    super('A backup or deletion is running. Try again shortly.');
  }
}

export async function withMaintenanceLock<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const path = join(dataDir, 'maintenance.lock');
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MaintenanceBusyError();
    throw error;
  }
  try {
    return await work();
  } finally {
    await rmdir(path);
  }
}
