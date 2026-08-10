import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import {
  authorizeTaskMandate,
  inspectActiveTaskMandateBinding,
} from '../src/task-mandate.ts';
import { git, sourceRepositoryRoot } from './fixture.ts';

export function prepareExecutionMandate(repository: string, changeId: string) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'execution-mandate-fixture-')),
  );
  const keyPath = path.join(root, 'maintainer-key');
  const externalAuditRoot = path.join(root, 'authority-audit');
  fs.mkdirSync(externalAuditRoot, { mode: 0o700 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const publicKey = fs
    .readFileSync(`${keyPath}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprint = execFileSync(
    'ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`],
    { encoding: 'utf8' },
  ).match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
  if (!fingerprint) throw new Error('Fixture SSH fingerprint is missing.');
  const identity = 'execution-fixture-maintainer';
  const origin = `https://github.com/example/${changeId}.git`;
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as Record<string, unknown> & {
    repository: { id: string; origin: string };
    trustedSigners: Array<Record<string, string>>;
  };
  policy.repository = {
    id: `github:R_${changeId.replaceAll('-', '_')}`,
    origin,
  };
  policy.trustedSigners = [{ identity, publicKey, fingerprint }];
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  if (git(repository, ['remote']).split(/\r?\n/).includes('origin')) {
    git(repository, ['remote', 'set-url', 'origin', origin]);
  } else {
    git(repository, ['remote', 'add', 'origin', origin]);
  }
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Install execution mandate trust base']);

  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity: () => identity,
    sign(payload, namespace) {
      const payloadPath = path.join(root, 'payload');
      fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
      execFileSync('ssh-keygen', [
        '-Y',
        'sign',
        '-f',
        keyPath,
        '-n',
        namespace ?? 'fixture',
        payloadPath,
      ]);
      const signature = fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      fs.rmSync(payloadPath, { force: true });
      fs.rmSync(`${payloadPath}.sig`, { force: true });
      return signature;
    },
    verify() {},
  };
  const taskId = `${changeId}-task`;
  const issuedAt = new Date();
  authorizeTaskMandate(
    repository,
    {
      changeId,
      taskId,
      intent: `Prepare and retry the exact ${changeId} execution Job.`,
      providerCalls: {
        codex: {
          maxInvocations: 16,
          maxBudget: null,
          dataTypes: [
            'diff',
            'repository-metadata',
            'source-code',
            'task-intent',
            'test-output',
          ],
          sourceCode: true,
          secrets: false,
          retryOnFailure: true,
          retryRequiresHuman: false,
        },
        claude: {
          maxInvocations: 16,
          maxBudget: null,
          dataTypes: [
            'diff',
            'repository-metadata',
            'source-code',
            'task-intent',
            'test-output',
          ],
          sourceCode: true,
          secrets: false,
          retryOnFailure: true,
          retryRequiresHuman: false,
        },
      },
    },
    {
      externalAuditRoot,
      now: issuedAt,
      signer,
    },
  );
  const binding = inspectActiveTaskMandateBinding(repository, taskId, {
    now: issuedAt,
    signer,
  });
  return {
    taskId,
    binding,
    signer,
    repositoryIdentity: policy.repository.id,
    externalAuditRoot,
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
