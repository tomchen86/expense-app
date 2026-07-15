import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

export function ensurePlainDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!existing) {
    const parent = path.dirname(absolute);
    if (parent === absolute) {
      throw unsafeDirectory(absolute);
    }
    ensurePlainDirectory(parent);
    try {
      fs.mkdirSync(absolute, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  assertPlainDirectory(absolute);
}

export function assertPlainDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw unsafeDirectory(absolute);
  }
}

function unsafeDirectory(directory: string) {
  return workflowError(
    'RUNTIME_DIRECTORY_UNSAFE',
    'Workflow runtime directory is not a canonical plain directory.',
    ExitCode.staleState,
    { details: { directory } },
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
