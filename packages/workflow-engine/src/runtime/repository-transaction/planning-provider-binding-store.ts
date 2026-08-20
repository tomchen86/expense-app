import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import {
  parsePlanningProviderBinding,
  type PlanningProviderBindingReaderPort,
  type PlanningProviderBindingV1,
} from '../../modules/planning-provider/planning-provider-binding.ts';
import { planningProviderBindingPath } from '../../modules/source/planning-paths.ts';
import { runGitBuffer } from './git.ts';

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TREE_ENTRY = /^(100644) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u;
const MAX_BINDING_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export { planningProviderBindingPath };

export function readCurrentPlanningProviderBinding(
  repositoryRoot: string,
  changeId: string,
): PlanningProviderBindingV1 | null {
  const root = fs.realpathSync(repositoryRoot);
  const relativePath = planningProviderBindingPath(changeId);
  const absolutePath = path.join(root, relativePath);
  const parent = path.dirname(absolutePath);
  const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (parentStats === undefined) return null;
  if (
    !parentStats.isDirectory() ||
    parentStats.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent
  ) {
    throw bindingStoreInvalid(
      'Planning-provider binding directory is not a canonical plain directory.',
    );
  }
  const before = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (before === undefined) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o111) !== 0 ||
    before.size > MAX_BINDING_BYTES
  ) {
    throw bindingStoreInvalid(
      'Planning-provider binding must be one bounded non-executable regular file.',
    );
  }

  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1 ||
      (opened.mode & 0o111) !== 0
    ) {
      throw bindingStoreInvalid(
        'Planning-provider binding identity changed while it was opened.',
      );
    }
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== opened.size || bytes.length > MAX_BINDING_BYTES) {
      throw bindingStoreInvalid(
        'Planning-provider binding bytes changed while they were read.',
      );
    }
    return parsePlanningProviderBinding(decodeBinding(bytes), changeId);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPinnedPlanningProviderBinding(
  repositoryRoot: string,
  commit: string,
  changeId: string,
): PlanningProviderBindingV1 | null {
  const bytes = readPinnedPlanningProviderEvidenceFile(
    repositoryRoot,
    commit,
    planningProviderBindingPath(changeId),
  );
  return bytes === null
    ? null
    : parsePlanningProviderBinding(decodeBinding(bytes), changeId);
}

export function readPinnedPlanningProviderEvidenceFile(
  repositoryRoot: string,
  commit: string,
  requestedPath: string,
): Buffer | null {
  if (!FULL_OBJECT_ID.test(commit)) {
    throw bindingStoreInvalid(
      'Pinned planning-provider evidence requires one full commit object ID.',
    );
  }
  let repositoryPath: string;
  try {
    repositoryPath = normalizeExactRepositoryPath(requestedPath);
  } catch {
    throw bindingStoreInvalid(
      'Pinned planning-provider evidence path is not a safe exact path.',
    );
  }
  const entrySource = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-z',
    '--full-tree',
    commit,
    '--',
    `:(literal)${repositoryPath}`,
  ]);
  if (entrySource.length === 0) return null;

  let entry: RegExpExecArray | null;
  try {
    entry = TREE_ENTRY.exec(UTF8.decode(entrySource));
  } catch {
    entry = null;
  }
  if (entry === null || entry[3] !== repositoryPath) {
    throw bindingStoreInvalid(
      'Pinned planning-provider evidence must be one exact non-executable regular blob.',
    );
  }
  const bytes = runGitBuffer(repositoryRoot, ['cat-file', 'blob', entry[2]!]);
  if (bytes.length > MAX_BINDING_BYTES) {
    throw bindingStoreInvalid(
      'Pinned planning-provider evidence exceeds the bounded file size.',
    );
  }
  return bytes;
}

export function pinnedHistoryContainsPlanningProviderPath(
  repositoryRoot: string,
  commit: string,
  requestedPath: string,
): boolean {
  if (!FULL_OBJECT_ID.test(commit)) {
    throw bindingStoreInvalid(
      'Pinned planning-provider history requires one full commit object ID.',
    );
  }
  let repositoryPath: string;
  try {
    repositoryPath = normalizeExactRepositoryPath(requestedPath);
  } catch {
    throw bindingStoreInvalid(
      'Pinned planning-provider history path is not a safe exact path.',
    );
  }
  const source = runGitBuffer(repositoryRoot, [
    'rev-list',
    '--full-history',
    '--topo-order',
    '--reverse',
    commit,
    '--',
    `:(literal)${repositoryPath}`,
  ]).toString('ascii');
  const revisions = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (revisions.some((revision) => !FULL_OBJECT_ID.test(revision))) {
    throw bindingStoreInvalid(
      'Pinned planning-provider history returned an invalid commit identity.',
    );
  }
  return revisions.length > 0;
}

export const planningProviderBindingReader: PlanningProviderBindingReaderPort =
  Object.freeze({
    readCurrent: readCurrentPlanningProviderBinding,
    readPinnedBinding: readPinnedPlanningProviderBinding,
    readPinnedEvidenceFile: readPinnedPlanningProviderEvidenceFile,
    pinnedHistoryContainsPath: pinnedHistoryContainsPlanningProviderPath,
  });

function decodeBinding(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw bindingStoreInvalid(
      'Planning-provider binding must be canonical UTF-8 JSON.',
    );
  }
}

function bindingStoreInvalid(
  message: string,
): ReturnType<typeof workflowError> {
  return workflowError(
    'PROVIDER_BINDING_INVALID',
    message,
    ExitCode.verification,
  );
}
