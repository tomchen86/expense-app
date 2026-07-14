import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { dispatchDocumentRefreshCommand } from '../src/document-refresh-cli.ts';
import {
  applyDocumentRefresh,
  proposeDocumentRefresh,
  reviewDocumentRefresh,
} from '../src/document-refresh.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

test('approved refresh replaces exactly one reviewed document section', () => {
  const repository = createFixtureRepository();
  try {
    const target = 'docs/architecture/ARCHITECTURE.md';
    fs.mkdirSync(path.join(repository, 'docs/architecture'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, target),
      '# Architecture\n\n## Scope\n\nOld text.\n\n```md\n## Example\n```\n\n## Stable\n\nKeep me.\n',
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add architecture fixture']);

    const proposal = proposeDocumentRefresh(
      repository,
      target,
      '## Scope',
      '## Scope\n\nNew reviewed text.\n\n```md\n## Example\n```\n',
    );
    const review = reviewDocumentRefresh(
      repository,
      proposal.proposalId,
      'approve',
      'maintainer@example.test',
    );
    applyDocumentRefresh(repository, proposal.proposalId, review.reviewId);

    assert.equal(
      fs.readFileSync(path.join(repository, target), 'utf8'),
      '# Architecture\n\n## Scope\n\nNew reviewed text.\n\n```md\n## Example\n```\n\n## Stable\n\nKeep me.\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('refresh rejects target drift and a review bound to another proposal', () => {
  const repository = createFixtureRepository();
  try {
    const target = 'docs/features/demo.md';
    fs.mkdirSync(path.join(repository, 'docs/features'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, target),
      '# Demo\n\n## Scope\n\nOld.\n',
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add feature fixture']);
    const first = proposeDocumentRefresh(
      repository,
      target,
      '## Scope',
      '## Scope\n\nFirst.\n',
    );
    const second = proposeDocumentRefresh(
      repository,
      target,
      '## Scope',
      '## Scope\n\nSecond.\n',
    );
    const review = reviewDocumentRefresh(
      repository,
      first.proposalId,
      'approve',
      'maintainer@example.test',
    );
    assert.throws(
      () =>
        applyDocumentRefresh(repository, second.proposalId, review.reviewId),
      (error) => isWorkflowError(error, 'DOCUMENT_REVIEW_MISMATCH'),
    );

    fs.appendFileSync(path.join(repository, target), '\nDrift.\n');
    assert.throws(
      () => applyDocumentRefresh(repository, first.proposalId, review.reviewId),
      (error) => isWorkflowError(error, 'DOCUMENT_TARGET_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('refresh rejects targets outside curated architecture and feature roots', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () =>
        proposeDocumentRefresh(
          repository,
          'docs/ISSUE_LOG.md',
          '## Purpose',
          '## Purpose\n\nReplacement.\n',
        ),
      (error) => isWorkflowError(error, 'DOCUMENT_TARGET_NOT_CURATED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('refresh rejects unapproved changes and replacements that escape section scope', () => {
  const repository = createFixtureRepository();
  try {
    const target = 'docs/features/demo.md';
    fs.mkdirSync(path.join(repository, 'docs/features'), { recursive: true });
    fs.writeFileSync(path.join(repository, target), '# Demo\n\n## Scope');

    assert.throws(
      () =>
        proposeDocumentRefresh(
          repository,
          target,
          '## Scope',
          '## Scope\n\n### Allowed\n\n## Escaped\n',
        ),
      (error) => isWorkflowError(error, 'DOCUMENT_REPLACEMENT_ESCAPES_SECTION'),
    );

    const proposal = proposeDocumentRefresh(
      repository,
      target,
      '## Scope',
      '## Scope\n\nReviewed.\n',
    );
    const review = reviewDocumentRefresh(
      repository,
      proposal.proposalId,
      'reject',
      'maintainer@example.test',
    );
    assert.throws(
      () =>
        applyDocumentRefresh(repository, proposal.proposalId, review.reviewId),
      (error) => isWorkflowError(error, 'DOCUMENT_REVIEW_REJECTED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('document refresh CLI rejects missing and unexpected named options', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () =>
        dispatchDocumentRefreshCommand(
          [
            'propose',
            '--target',
            'docs/features/demo.md',
            '--section',
            '## Scope',
            '--replacement',
            '## Scope\n',
            '--unexpected',
            'value',
          ],
          repository,
        ),
      (error) => isWorkflowError(error, 'INVALID_DOCUMENT_REFRESH_USAGE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('refresh rejects symlink traversal and policy drift after proposal', () => {
  const repository = createFixtureRepository();
  try {
    fs.mkdirSync(path.join(repository, 'docs/architecture'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, 'src/outside.md'),
      '## Scope\n\nOld.\n',
    );
    fs.symlinkSync(
      '../../src',
      path.join(repository, 'docs/architecture/link'),
    );
    assert.throws(
      () =>
        proposeDocumentRefresh(
          repository,
          'docs/architecture/link/outside.md',
          '## Scope',
          '## Scope\n\nNew.\n',
        ),
      (error) => isWorkflowError(error, 'DOCUMENT_TARGET_UNSAFE'),
    );

    const target = 'docs/architecture/safe.md';
    fs.writeFileSync(path.join(repository, target), '## Scope\n\nOld.\n');
    const proposal = proposeDocumentRefresh(
      repository,
      target,
      '## Scope',
      '## Scope\n\nNew.\n',
    );
    const review = reviewDocumentRefresh(
      repository,
      proposal.proposalId,
      'approve',
      'maintainer@example.test',
    );
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    policy.documents['docs/research/**'] = { mode: 'reference' };
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    assert.throws(
      () =>
        applyDocumentRefresh(repository, proposal.proposalId, review.reviewId),
      (error) => isWorkflowError(error, 'DOCUMENT_REFRESH_POLICY_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reviewers can inspect proposals and an active target lock blocks apply', () => {
  const repository = createFixtureRepository();
  try {
    const target = 'docs/features/demo.md';
    fs.mkdirSync(path.join(repository, 'docs/features'), { recursive: true });
    fs.writeFileSync(path.join(repository, target), '## Scope\n\nOld.\n');
    const proposal = proposeDocumentRefresh(
      repository,
      target,
      '## Scope',
      '## Scope\n\nNew.\n',
    );
    const shown = dispatchDocumentRefreshCommand(
      ['show', '--proposal', proposal.proposalId],
      repository,
    );
    assert.equal(
      (shown.proposal as { replacement: string }).replacement,
      '## Scope\n\nNew.\n',
    );
    const review = reviewDocumentRefresh(
      repository,
      proposal.proposalId,
      'approve',
      'maintainer@example.test',
    );
    const locks = path.join(
      repository,
      '.git/workflow-engine/document-refresh-locks',
    );
    fs.mkdirSync(locks, { recursive: true });
    const lockName = crypto.createHash('sha256').update(target).digest('hex');
    fs.writeFileSync(path.join(locks, `${lockName}.lock`), 'other\n');
    assert.throws(
      () =>
        applyDocumentRefresh(repository, proposal.proposalId, review.reviewId),
      (error) => isWorkflowError(error, 'DOCUMENT_REFRESH_CONFLICT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
