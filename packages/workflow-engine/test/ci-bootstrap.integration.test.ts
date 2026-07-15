import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertExactPlanningBootstrap } from '../src/ci-bootstrap.ts';
import { loadPlanningBootstrapPolicy } from '../src/ci-policy.ts';
import { verifyPullRequest } from '../src/ci.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const INTEGRATION_BOOTSTRAP = '648ae2405567ea0db830e7fb4b49dbebeecf56bb';

test('exact integration planning bootstrap is accepted only at range position zero', () => {
  const [policy] = loadPlanningBootstrapPolicy(sourceRepositoryRoot);
  assert.equal(policy.changeId, 'integrate-openspec-with-workflow');
  assert.doesNotThrow(() =>
    assertExactPlanningBootstrap(
      sourceRepositoryRoot,
      INTEGRATION_BOOTSTRAP,
      policy,
      0,
    ),
  );
  assert.throws(
    () =>
      assertExactPlanningBootstrap(
        sourceRepositoryRoot,
        INTEGRATION_BOOTSTRAP,
        policy,
        1,
      ),
    (error) => isWorkflowError(error, 'CI_PLANNING_BOOTSTRAP_POSITION_INVALID'),
  );
});

test('exact integration planning bootstrap rejects parent and content policy drift', () => {
  const [policy] = loadPlanningBootstrapPolicy(sourceRepositoryRoot);
  assert.throws(
    () =>
      assertExactPlanningBootstrap(
        sourceRepositoryRoot,
        INTEGRATION_BOOTSTRAP,
        { ...policy, expectedParent: INTEGRATION_BOOTSTRAP },
        0,
      ),
    (error) => isWorkflowError(error, 'CI_PLANNING_BOOTSTRAP_MISMATCH'),
  );
  assert.throws(
    () =>
      assertExactPlanningBootstrap(
        sourceRepositoryRoot,
        INTEGRATION_BOOTSTRAP,
        {
          ...policy,
          fileDigests: {
            ...policy.fileDigests,
            'package.json': '0'.repeat(64),
          },
        },
        0,
      ),
    (error) => isWorkflowError(error, 'CI_PLANNING_BOOTSTRAP_MISMATCH'),
  );
});

test('pinned bootstrap rejects checked tasks even when HEAD policy digests match', () => {
  const fixture = createBootstrapVariant((repository) => {
    const tasksPath = path.join(
      repository,
      'openspec/changes/integrate-openspec-with-workflow/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
  });
  try {
    assert.throws(
      () =>
        assertExactPlanningBootstrap(
          fixture.repository,
          fixture.commit,
          fixture.policy,
          0,
        ),
      (error) => isWorkflowError(error, 'CI_PLANNING_BOOTSTRAP_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pinned bootstrap rejects dependency drift even when HEAD policy digests match', () => {
  const cases = [
    {
      name: 'manifest version',
      mutate(repository: string) {
        const manifestPath = path.join(repository, 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.devDependencies['@fission-ai/openspec'] = '1.6.1';
        fs.writeFileSync(
          manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
      },
    },
    {
      name: 'lock integrity',
      mutate(repository: string) {
        const lockPath = path.join(repository, 'pnpm-lock.yaml');
        fs.writeFileSync(
          lockPath,
          fs
            .readFileSync(lockPath, 'utf8')
            .replace(
              'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==',
              'sha512-tampered',
            ),
        );
      },
    },
    {
      name: 'allowed build script',
      mutate(repository: string) {
        const workspacePath = path.join(repository, 'pnpm-workspace.yaml');
        fs.writeFileSync(
          workspacePath,
          fs
            .readFileSync(workspacePath, 'utf8')
            .replace(
              "'@fission-ai/openspec': false",
              "'@fission-ai/openspec': true",
            ),
        );
      },
    },
  ];
  for (const testCase of cases) {
    const fixture = createBootstrapVariant(testCase.mutate);
    try {
      assert.throws(
        () =>
          assertExactPlanningBootstrap(
            fixture.repository,
            fixture.commit,
            fixture.policy,
            0,
          ),
        (error) => isWorkflowError(error, 'CI_PLANNING_BOOTSTRAP_MISMATCH'),
        testCase.name,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('bootstrap compatibility commits match one exact semantic sequence', () => {
  const repository = createFixtureRepository();
  try {
    const sourceCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '--orphan', 'ci-base']);
    fs.rmSync(path.join(repository, 'openspec/changes/demo-change'), {
      recursive: true,
      force: true,
    });
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Create CI base without change']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/bootstrap-compatibility']);

    fs.writeFileSync(
      path.join(repository, 'workflow/ci-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          bootstrapExceptions: [
            {
              changeId: 'demo-change',
              taskIds: ['1.1'],
              compatibilityCommits: [
                {
                  taskId: '1.1',
                  subject: 'Record compatibility evidence',
                  changedPaths: ['src/compatibility.ts'],
                },
              ],
              introductionPaths: [
                'openspec/changes/demo-change/proposal.md',
                'openspec/changes/demo-change/design.md',
                'openspec/changes/demo-change/tasks.md',
                'openspec/changes/demo-change/guard.json',
                'openspec/changes/demo-change/specs/demo/spec.md',
              ],
              allowedPaths: [
                'openspec/changes/demo-change/**',
                'src/**',
                'workflow/ci-policy.json',
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    git(repository, [
      'checkout',
      sourceCommit,
      '--',
      'openspec/changes/demo-change',
    ]);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Bootstrap demo change']);

    fs.writeFileSync(
      path.join(repository, 'src/compatibility.ts'),
      'export {};\n',
    );
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Record compatibility evidence',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const compatibleHead = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.doesNotThrow(() =>
      verifyPullRequest(repository, base, compatibleHead),
    );

    fs.writeFileSync(path.join(repository, 'src/replay.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Replay compatibility evidence',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const replayHead = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, replayHead),
      (error) => isWorkflowError(error, 'CI_TASK_TRANSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createBootstrapVariant(mutate: (repository: string) => void): {
  root: string;
  repository: string;
  commit: string;
  policy: ReturnType<typeof loadPlanningBootstrapPolicy>[number];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-bootstrap-'));
  const repository = path.join(root, 'repository');
  execFileSync(
    '/usr/bin/git',
    ['clone', '--quiet', '--no-local', sourceRepositoryRoot, repository],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  const [sourcePolicy] = loadPlanningBootstrapPolicy(sourceRepositoryRoot);
  git(repository, ['checkout', '--detach', sourcePolicy.expectedParent]);
  git(repository, [
    'checkout',
    INTEGRATION_BOOTSTRAP,
    '--',
    ...sourcePolicy.changedPaths,
  ]);
  mutate(repository);
  git(repository, ['add', '-A', '--', ...sourcePolicy.changedPaths]);
  git(repository, [
    'commit',
    '-m',
    sourcePolicy.subject,
    '-m',
    `Change: ${sourcePolicy.changeId}\nTransition: plan`,
  ]);
  const commit = git(repository, ['rev-parse', 'HEAD']).trim();
  const fileDigests = Object.fromEntries(
    sourcePolicy.changedPaths.map((filePath) => [
      filePath,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(repository, filePath)))
        .digest('hex'),
    ]),
  );
  return {
    root,
    repository,
    commit,
    policy: { ...sourcePolicy, fileDigests },
  };
}
