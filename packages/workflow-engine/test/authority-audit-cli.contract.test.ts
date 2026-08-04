import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dispatchAuthorityAuditCommand } from '../src/authority-audit-cli.ts';
import { recordAuthorityAuditEvent } from '../src/authority-audit-service.ts';
import { git, isWorkflowError, sourceRepositoryRoot } from './fixture.ts';

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'authority-audit-cli-')),
  );
  fs.chmodSync(root, 0o700);
  const repository = path.join(root, 'repository');
  const auditRoot = path.join(root, 'audit');
  fs.mkdirSync(repository, { mode: 0o700 });
  fs.mkdirSync(auditRoot, { mode: 0o700 });
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  fs.mkdirSync(path.join(repository, 'workflow'));
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow', 'maintainer-policy.json'),
    path.join(repository, 'workflow', 'maintainer-policy.json'),
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install audit trust base']);
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow', 'maintainer-policy.json'),
      'utf8',
    ),
  ) as { repository: { id: string } };
  const resolved = dispatchAuthorityAuditCommand;
  return {
    root,
    repository,
    auditRoot,
    repositoryIdentity: policy.repository.id,
    resolved,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

test('audit show and verify expose task-correlated external events', () => {
  const value = fixture();
  try {
    const empty = dispatchAuthorityAuditCommand(
      ['verify', value.repositoryIdentity, '--audit-root', value.auditRoot],
      value.repository,
    );
    const scope = empty.result.repositoryId;
    assert.equal(empty.verified, true);
    assert.equal(empty.result.recordCount, 0);
    const resolvedScope = {
      repositoryRoot: value.repository,
      externalAuditRoot: value.auditRoot,
      repositoryId: scope,
    };
    recordAuthorityAuditEvent(resolvedScope, {
      eventType: 'task-mandate',
      occurredAt: '2026-08-03T12:00:00.000Z',
      idempotencyKey: digest('1'),
      actor: { kind: 'human', identity: 'fixture-maintainer' },
      taskId: 'unified-plan',
      changeId: 'engine-v2',
      workflowId: null,
      grantDigest: digest('2'),
      candidateBundleDigest: null,
      prestateDigest: null,
      poststateDigest: digest('3'),
      command: null,
      providerInvocation: null,
      externalEffect: null,
      result: 'succeeded',
      outcomeDigest: digest('4'),
      errorCode: null,
    });

    const shown = dispatchAuthorityAuditCommand(
      ['show', 'unified-plan', '--audit-root', value.auditRoot],
      value.repository,
    );
    assert.equal(shown.verified, true);
    assert.equal(shown.result.events.length, 1);
    assert.equal(shown.result.events[0]!.event.eventType, 'task-mandate');
    const verified = dispatchAuthorityAuditCommand(
      ['verify', value.repositoryIdentity, '--audit-root', value.auditRoot],
      value.repository,
    );
    assert.equal(verified.verified, true);
    assert.equal(verified.result.projectedEventCount, 1);
  } finally {
    value.cleanup();
  }
});

test('audit CLI rejects implicit roots, repository mismatch, and unsafe arguments', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          ['verify', value.repositoryIdentity],
          value.repository,
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_USAGE'),
    );
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          [
            'verify',
            'github:wrong/repository',
            '--audit-root',
            value.auditRoot,
          ],
          value.repository,
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_REPOSITORY_MISMATCH'),
    );
    assert.throws(
      () =>
        dispatchAuthorityAuditCommand(
          ['show', 'unified-plan', '--audit-root', 'relative-audit'],
          value.repository,
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_USAGE'),
    );
  } finally {
    value.cleanup();
  }
});
