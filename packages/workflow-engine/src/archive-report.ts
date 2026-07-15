import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  readContentRecord,
  writeContentRecord,
  type ContentRecord,
} from './content-record-store.ts';
import { ExitCode, workflowError } from './errors.ts';

export type ArchiveTransitionReport = ContentRecord & {
  kind: 'archive-transition';
  changeId: string;
  archivePath: string;
  parent: string;
  tree: string;
  commitHash: string;
  patch: string;
  patchDigest: string;
  changedPaths: string[];
  logicalIdentity: string;
  contractDigest: string;
  promotedSpecDigests: Record<string, string>;
  archivedArtifactDigests: Record<string, string>;
};

export function writeArchiveReport(
  directory: string,
  report: ArchiveTransitionReport,
): string {
  return writeContentRecord(directory, report);
}

export function readArchiveReport(
  directory: string,
  reportId: string,
): ArchiveTransitionReport {
  const value = readContentRecord(directory, reportId);
  if (!isArchiveReport(value) || digest(value.patch) !== value.patchDigest) {
    throw invalidReport();
  }
  return value;
}

export function listArchiveReports(
  directory: string,
  changeId: string,
): Array<{ reportId: string; report: ArchiveTransitionReport }> {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalidReport();
  return fs
    .readdirSync(directory)
    .filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))
    .map((entry) => {
      const reportId = entry.slice(0, -5);
      return { reportId, report: readArchiveReport(directory, reportId) };
    })
    .filter(({ report }) => report.changeId === changeId);
}

function isArchiveReport(
  value: ContentRecord,
): value is ArchiveTransitionReport {
  return (
    value.kind === 'archive-transition' &&
    typeof value.changeId === 'string' &&
    typeof value.archivePath === 'string' &&
    typeof value.parent === 'string' &&
    typeof value.tree === 'string' &&
    typeof value.commitHash === 'string' &&
    typeof value.patch === 'string' &&
    typeof value.patchDigest === 'string' &&
    Array.isArray(value.changedPaths) &&
    value.changedPaths.every((entry) => typeof entry === 'string') &&
    typeof value.logicalIdentity === 'string' &&
    typeof value.contractDigest === 'string' &&
    isStringRecord(value.promotedSpecDigests) &&
    isStringRecord(value.archivedArtifactDigests)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function invalidReport() {
  return workflowError(
    'ARCHIVE_REPORT_INVALID',
    'Archive transition evidence is missing, unsafe, or stale.',
    ExitCode.staleState,
  );
}
