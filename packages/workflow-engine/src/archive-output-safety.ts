import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

export function assertPlainArchiveOutputFile(
  repository: string,
  relativePath: string,
): void {
  const absolutePath = path.join(repository, relativePath);
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(absolutePath) !== absolutePath ||
    (stats.mode & 0o111) !== 0
  ) {
    throw unsafeOutput(
      'Archive produced an unsafe base-spec target.',
      relativePath,
    );
  }
}

export function listPlainArchiveFiles(
  repository: string,
  relativeRoot: string,
): string[] {
  const files: string[] = [];
  walk(path.join(repository, relativeRoot));
  return files.sort();

  function walk(directory: string): void {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw unsafeOutput('Archive output contains an unsafe directory.');
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(entryPath);
        continue;
      }
      const entryStats = fs.lstatSync(entryPath);
      if (
        !entryStats.isFile() ||
        entryStats.isSymbolicLink() ||
        (entryStats.mode & 0o111) !== 0
      ) {
        throw unsafeOutput('Archive output contains an unsafe file.');
      }
      files.push(
        path.relative(repository, entryPath).split(path.sep).join('/'),
      );
    }
  }
}

function unsafeOutput(message: string, relativePath?: string) {
  return workflowError(
    'ARCHIVE_TRANSFORMATION_TREE_INVALID',
    message,
    ExitCode.verification,
    { details: relativePath ? { path: relativePath } : {} },
  );
}
