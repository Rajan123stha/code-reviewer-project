import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RENAME_ATTEMPTS = 5;

/**
 * Write a file so that readers only ever see the old contents or the complete new ones.
 *
 * The data goes to a uniquely named temporary file, which is then renamed into place. The
 * unique name matters: cache entries are content-addressed, so two writers (in one process
 * or several) can produce the same path at the same moment, and a shared temp name would
 * make one rename fail. On Windows a rename can also fail briefly while another process
 * has the target open, so it is retried.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!retryable || attempt >= RENAME_ATTEMPTS) {
        await rm(tmp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}
