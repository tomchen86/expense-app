import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  readContentRecord,
  writeContentRecord,
  type ContentRecord,
} from './content-record-store.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError, type ExitCodeValue } from './errors.ts';
import { discoverRepository } from './git.ts';
import { markdownHeadings } from './markdown-sections.ts';
import { normalizeChangedPath } from './paths.ts';
import { runtimePaths } from './session-store.ts';

type ProposalRecord = ContentRecord & {
  kind: 'document-refresh-proposal';
  target: string;
  section: string;
  sourceDigest: string;
  resultDigest: string;
  policyDigest: string;
  replacement: string;
};

type ReviewRecord = ContentRecord & {
  kind: 'document-refresh-review';
  proposalId: string;
  decision: 'approve' | 'reject';
  reviewer: string;
};

export function proposeDocumentRefresh(
  cwd: string,
  requestedTarget: string,
  section: string,
  replacement: string,
): { proposalId: string; target: string; resultDigest: string } {
  const context = refreshContext(cwd);
  const target = assertCuratedTarget(context.repositoryRoot, requestedTarget);
  const policyDigest = assertReviewedRefreshPolicy(
    context.repositoryRoot,
    target,
  );
  const current = fs.readFileSync(
    path.join(context.repositoryRoot, target),
    'utf8',
  );
  const result = replaceSection(current, section, replacement);
  const record: ProposalRecord = {
    schemaVersion: 1,
    kind: 'document-refresh-proposal',
    createdAt: new Date().toISOString(),
    target,
    section,
    sourceDigest: digest(current),
    resultDigest: digest(result),
    policyDigest,
    replacement,
  };
  const proposalId = writeContentRecord(context.proposals, record);
  return { proposalId, target, resultDigest: record.resultDigest };
}

export function reviewDocumentRefresh(
  cwd: string,
  proposalId: string,
  decision: 'approve' | 'reject',
  reviewer: string,
): { reviewId: string; decision: 'approve' | 'reject' } {
  if (!['approve', 'reject'].includes(decision) || !isSafeText(reviewer)) {
    throw refreshError(
      'DOCUMENT_REVIEW_INVALID',
      'Review requires an explicit decision and reviewer.',
      ExitCode.usage,
    );
  }
  const context = refreshContext(cwd);
  readProposal(context.proposals, proposalId);
  const record: ReviewRecord = {
    schemaVersion: 1,
    kind: 'document-refresh-review',
    createdAt: new Date().toISOString(),
    proposalId,
    decision,
    reviewer,
  };
  return {
    reviewId: writeContentRecord(context.reviews, record),
    decision,
  };
}

export function inspectDocumentRefreshProposal(
  cwd: string,
  proposalId: string,
): Omit<ProposalRecord, 'schemaVersion' | 'kind'> & { proposalId: string } {
  const context = refreshContext(cwd);
  const proposal = readProposal(context.proposals, proposalId);
  return {
    proposalId,
    createdAt: proposal.createdAt,
    target: proposal.target,
    section: proposal.section,
    sourceDigest: proposal.sourceDigest,
    resultDigest: proposal.resultDigest,
    policyDigest: proposal.policyDigest,
    replacement: proposal.replacement,
  };
}

export function applyDocumentRefresh(
  cwd: string,
  proposalId: string,
  reviewId: string,
): { target: string; resultDigest: string } {
  const context = refreshContext(cwd);
  const proposal = readProposal(context.proposals, proposalId);
  const review = readReview(context.reviews, reviewId);
  if (review.proposalId !== proposalId) {
    throw refreshError(
      'DOCUMENT_REVIEW_MISMATCH',
      'Review is bound to a different proposal.',
    );
  }
  if (review.decision !== 'approve') {
    throw refreshError(
      'DOCUMENT_REVIEW_REJECTED',
      'Document refresh was not approved.',
    );
  }
  const target = assertCuratedTarget(context.repositoryRoot, proposal.target);
  return withTargetLock(context.locks, target, () => {
    if (
      assertReviewedRefreshPolicy(context.repositoryRoot, target) !==
      proposal.policyDigest
    ) {
      throw refreshError(
        'DOCUMENT_REFRESH_POLICY_CHANGED',
        'Document refresh policy changed after the proposal was created.',
        ExitCode.guard,
      );
    }
    const targetPath = path.join(context.repositoryRoot, target);
    const current = fs.readFileSync(targetPath, 'utf8');
    if (digest(current) !== proposal.sourceDigest) {
      throw refreshError(
        'DOCUMENT_TARGET_STALE',
        'Target changed after the refresh proposal was created.',
      );
    }
    const result = replaceSection(
      current,
      proposal.section,
      proposal.replacement,
    );
    if (digest(result) !== proposal.resultDigest) {
      throw refreshError(
        'DOCUMENT_PROPOSAL_INVALID',
        'Proposal result digest does not match its scoped replacement.',
      );
    }
    writeTextAtomic(targetPath, result);
    return { target, resultDigest: proposal.resultDigest };
  });
}

function replaceSection(
  current: string,
  section: string,
  replacement: string,
): string {
  const heading = /^(#{2,6}) [^\n]+$/.exec(section);
  const replacementHeadings = markdownHeadings(replacement);
  if (
    !heading ||
    replacement.split('\n')[0] !== section ||
    replacementHeadings[0]?.start !== 0 ||
    replacementHeadings[0]?.canonical !== section
  ) {
    throw refreshError(
      'DOCUMENT_SECTION_INVALID',
      'Replacement must begin with the exact scoped heading.',
      ExitCode.usage,
    );
  }
  const headings = markdownHeadings(current);
  const matches = headings.filter((item) => item.canonical === section);
  if (matches.length !== 1) {
    throw refreshError(
      'DOCUMENT_SECTION_NOT_UNIQUE',
      'Target must contain exactly one scoped heading.',
    );
  }
  const start = matches[0].start;
  const headingEnd = current.indexOf('\n', start);
  const afterHeading = headingEnd === -1 ? current.length : headingEnd + 1;
  const nextHeading = headings.find(
    (item) => item.start >= afterHeading && item.level <= heading[1].length,
  );
  const end = nextHeading?.start ?? current.length;
  const nested = replacementHeadings
    .slice(1)
    .some((item) => item.level <= heading[1].length);
  if (nested) {
    throw refreshError(
      'DOCUMENT_REPLACEMENT_ESCAPES_SECTION',
      'Replacement contains a heading outside the proposed section scope.',
      ExitCode.usage,
    );
  }
  const normalized = replacement.trimEnd();
  return nextHeading !== undefined
    ? `${current.slice(0, start)}${normalized}\n\n${current.slice(end)}`
    : `${current.slice(0, start)}${normalized}\n`;
}

function assertCuratedTarget(repositoryRoot: string, value: string): string {
  const target = normalizeChangedPath(value);
  if (
    !target.endsWith('.md') ||
    (!target.startsWith('docs/architecture/') &&
      !target.startsWith('docs/features/'))
  ) {
    throw refreshError(
      'DOCUMENT_TARGET_NOT_CURATED',
      'Refresh target must be a Markdown file under architecture or features.',
      ExitCode.guard,
    );
  }
  const targetPath = path.join(repositoryRoot, target);
  assertNoSymlinkSegments(repositoryRoot, target);
  const stats = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw refreshError(
      'DOCUMENT_TARGET_UNSAFE',
      'Refresh target is missing or is not a plain file.',
      ExitCode.guard,
    );
  }
  const relative = path.relative(repositoryRoot, fs.realpathSync(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw refreshError(
      'DOCUMENT_TARGET_UNSAFE',
      'Refresh target escapes the repository.',
      ExitCode.guard,
    );
  }
  return target;
}

function assertNoSymlinkSegments(repositoryRoot: string, target: string): void {
  let candidate = repositoryRoot;
  for (const segment of target.split('/')) {
    candidate = path.join(candidate, segment);
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw refreshError(
        'DOCUMENT_TARGET_UNSAFE',
        'Refresh target may not traverse symbolic links.',
        ExitCode.guard,
      );
    }
  }
}

function assertReviewedRefreshPolicy(
  repositoryRoot: string,
  target: string,
): string {
  const policyPath = path.join(repositoryRoot, 'workflow/document-policy.json');
  let content: string;
  let value: unknown;
  try {
    content = fs.readFileSync(policyPath, 'utf8');
    value = JSON.parse(content);
  } catch {
    throw refreshError(
      'DOCUMENT_REFRESH_POLICY_INVALID',
      'Document refresh policy is missing or invalid.',
      ExitCode.guard,
    );
  }
  const policyKey = target.startsWith('docs/architecture/')
    ? 'docs/architecture/**'
    : 'docs/features/**';
  const policy =
    isRecord(value) && isRecord(value.documents)
      ? value.documents[policyKey]
      : undefined;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.enforcementMode !== 'enforced' ||
    !isRecord(policy) ||
    policy.mode !== 'curated' ||
    policy.refresh !== 'reviewed-section'
  ) {
    throw refreshError(
      'DOCUMENT_REFRESH_NOT_AUTHORIZED',
      'Document policy does not authorize reviewed section refreshes.',
      ExitCode.guard,
    );
  }
  return digest(content);
}

function refreshContext(cwd: string) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  assertSafeRuntimeRoot(git.gitCommonDirectory, runtime.root);
  return {
    repositoryRoot: git.repositoryRoot,
    proposals: path.join(runtime.root, 'document-proposals'),
    reviews: path.join(runtime.root, 'document-reviews'),
    locks: path.join(runtime.root, 'document-refresh-locks'),
  };
}

function readProposal(directory: string, id: string): ProposalRecord {
  const value = readContentRecord(directory, id);
  if (
    value.kind !== 'document-refresh-proposal' ||
    typeof value.target !== 'string' ||
    typeof value.section !== 'string' ||
    typeof value.replacement !== 'string' ||
    !isDigest(value.sourceDigest) ||
    !isDigest(value.resultDigest) ||
    !isDigest(value.policyDigest)
  ) {
    throw refreshError('DOCUMENT_PROPOSAL_INVALID', 'Proposal is invalid.');
  }
  return value as ProposalRecord;
}

function readReview(directory: string, id: string): ReviewRecord {
  const value = readContentRecord(directory, id);
  if (
    value.kind !== 'document-refresh-review' ||
    !isDigest(value.proposalId) ||
    !['approve', 'reject'].includes(String(value.decision)) ||
    !isSafeText(value.reviewer)
  ) {
    throw refreshError('DOCUMENT_REVIEW_INVALID', 'Review is invalid.');
  }
  return value as ReviewRecord;
}

function writeTextAtomic(filePath: string, content: string): void {
  const stats = fs.lstatSync(filePath);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', stats.mode & 0o777);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function assertSafeRuntimeRoot(
  gitCommonDirectory: string,
  runtimeRoot: string,
): void {
  const relative = path.relative(gitCommonDirectory, runtimeRoot);
  let candidate = gitCommonDirectory;
  for (const segment of relative.split(path.sep)) {
    candidate = path.join(candidate, segment);
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw refreshError(
        'DOCUMENT_RUNTIME_UNSAFE',
        'Document refresh runtime may not traverse symbolic links.',
        ExitCode.unsafeEnvironment,
      );
    }
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const resolved = path.relative(
    fs.realpathSync(gitCommonDirectory),
    fs.realpathSync(runtimeRoot),
  );
  if (resolved.startsWith('..') || path.isAbsolute(resolved)) {
    throw refreshError(
      'DOCUMENT_RUNTIME_UNSAFE',
      'Document refresh runtime escapes the Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function withTargetLock<T>(
  locksDirectory: string,
  target: string,
  operation: () => T,
): T {
  fs.mkdirSync(locksDirectory, { recursive: true });
  const stats = fs.lstatSync(locksDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw refreshError(
      'DOCUMENT_RUNTIME_UNSAFE',
      'Document refresh lock directory is unsafe.',
      ExitCode.unsafeEnvironment,
    );
  }
  const lockPath = path.join(locksDirectory, `${digest(target)}.lock`);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw refreshError(
        'DOCUMENT_REFRESH_CONFLICT',
        'Another refresh is already applying to this document.',
        ExitCode.conflict,
      );
    }
    if (created) {
      fs.rmSync(lockPath, { force: true });
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isSafeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    !value.includes('\n')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refreshError(
  code: string,
  message: string,
  exitCode: ExitCodeValue = ExitCode.staleState,
) {
  return workflowError(code, message, exitCode);
}
