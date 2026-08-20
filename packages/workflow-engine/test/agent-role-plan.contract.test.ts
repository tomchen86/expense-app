import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadValidatedChangeContract } from '../src/adapters/planning/openspec/documents/managed-change-contract.ts';
import { planningProviderBindingReader } from '../src/runtime/repository-transaction/planning-provider-binding-store.ts';
import {
  agentRolePlanDigest,
  parseAgentRolePlan,
  renderAgentRolePlan,
  type AgentRolePlanBodyV1,
  type AgentRolePlanV1,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import { assertPlanningPaths } from '../src/modules/source/planning-paths.ts';
import {
  readCurrentAgentRolePlan,
  readPinnedAgentRolePlan,
} from '../src/runtime/repository-transaction/agent-role-plan-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'demo-change';
const PLANNING_GENERATION = 'a'.repeat(64);

function planBody(
  overrides: Partial<AgentRolePlanBodyV1> = {},
): AgentRolePlanBodyV1 {
  return {
    schemaVersion: 1,
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    roleLanes: [
      {
        role: 'author',
        scopeRule: 'planning-generation',
        allowedProviderFamilies: ['anthropic', 'openai'],
        preferredLogicalProviderIds: ['claude', 'codex'],
      },
      {
        role: 'builder',
        scopeRule: 'task',
        allowedProviderFamilies: ['openai'],
        preferredLogicalProviderIds: ['codex'],
      },
      {
        role: 'reviewer',
        scopeRule: 'candidate',
        allowedProviderFamilies: ['anthropic'],
        preferredLogicalProviderIds: ['claude'],
      },
    ],
    pairwiseRequirements: [
      { pair: 'author-builder', required: 'session-independent' },
      { pair: 'author-reviewer', required: 'provider-independent' },
      { pair: 'builder-reviewer', required: 'provider-independent' },
    ],
    customWrapperPolicy: 'allowed-non-protected',
    grantReferences: ['12345678-1234-4123-8123-123456789abc'],
    ...overrides,
  };
}

function plan(overrides: Partial<AgentRolePlanBodyV1> = {}): AgentRolePlanV1 {
  const body = planBody(overrides);
  return { ...body, planDigest: agentRolePlanDigest(body) };
}

function parseObject(value: unknown): AgentRolePlanV1 {
  return parseAgentRolePlan(
    `${JSON.stringify(value, null, 2)}\n`,
    CHANGE_ID,
    PLANNING_GENERATION,
  );
}

function temporaryRepository(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-role-plan-'));
}

function planPath(repository: string): string {
  return path.join(repository, 'workflow', 'agent-plans', `${CHANGE_ID}.json`);
}

function writePlan(repository: string, value = plan()): string {
  const destination = planPath(repository);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, renderAgentRolePlan(value));
  return destination;
}

test('agent-role plan v1 is canonical, self-digested, and deeply frozen', () => {
  const value = plan();
  const document = renderAgentRolePlan(value);
  const parsed = parseAgentRolePlan(document, CHANGE_ID, PLANNING_GENERATION);

  assert.deepEqual(parsed, value);
  assert.equal(renderAgentRolePlan(parsed), document);
  assert.equal(parsed.planDigest, agentRolePlanDigest(planBody()));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.roleLanes), true);
  assert.equal(Object.isFrozen(parsed.roleLanes[0]), true);
  assert.equal(
    Object.isFrozen(parsed.roleLanes[0]?.allowedProviderFamilies),
    true,
  );
  assert.equal(Object.isFrozen(parsed.pairwiseRequirements), true);
  assert.equal(Object.isFrozen(parsed.pairwiseRequirements[0]), true);
  assert.equal(Object.isFrozen(parsed.grantReferences), true);

  assert.throws(
    () =>
      parseAgentRolePlan(
        `${document.trimEnd()} \n`,
        CHANGE_ID,
        PLANNING_GENERATION,
      ),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
});

test('agent-role plan rejects unknown versions, stale identity, and malformed requirements', () => {
  const value = plan();
  assert.throws(
    () => parseObject({ ...value, schemaVersion: 2 }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_VERSION_UNSUPPORTED'),
  );
  assert.throws(
    () =>
      parseAgentRolePlan(
        renderAgentRolePlan(value),
        'other-change',
        PLANNING_GENERATION,
      ),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  assert.throws(
    () =>
      parseAgentRolePlan(renderAgentRolePlan(value), CHANGE_ID, 'b'.repeat(64)),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  assert.throws(
    () => parseObject({ ...value, planDigest: 'b'.repeat(64) }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  assert.throws(
    () =>
      parseObject({
        ...value,
        roleLanes: [value.roleLanes[0], value.roleLanes[0]],
      }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  assert.throws(
    () =>
      parseObject({
        ...value,
        pairwiseRequirements: [
          value.pairwiseRequirements[0],
          value.pairwiseRequirements[0],
        ],
      }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  assert.throws(
    () =>
      parseObject({
        ...value,
        pairwiseRequirements: [
          { pair: 'author-author', required: 'principal-independent' },
        ],
      }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
});

test('agent-role plan cannot carry execution or credential authority', () => {
  const value = plan();
  for (const [field, injected] of [
    ['executable', '/usr/local/bin/claude'],
    ['argv', ['--dangerously-skip-permissions']],
    ['shell', 'rm -rf workspace'],
    ['credentials', { path: '/tmp/provider-token' }],
  ] as const) {
    assert.throws(
      () => parseObject({ ...value, [field]: injected }),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      field,
    );
    assert.throws(
      () =>
        parseObject({
          ...value,
          roleLanes: [
            { ...value.roleLanes[0], [field]: injected },
            ...value.roleLanes.slice(1),
          ],
        }),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      `nested ${field}`,
    );
  }

  for (const roleLane of [
    {
      ...value.roleLanes[0],
      allowedProviderFamilies: ['../anthropic'],
    },
    {
      ...value.roleLanes[0],
      preferredLogicalProviderIds: ['codex;launch'],
    },
  ]) {
    assert.throws(
      () =>
        parseObject({
          ...value,
          roleLanes: [roleLane, ...value.roleLanes.slice(1)],
        }),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  }
  assert.throws(
    () => parseObject({ ...value, grantReferences: ['secret/provider-token'] }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
});

test('current agent-role plan reader returns null for absence and rejects unsafe or stale files', () => {
  const repository = temporaryRepository();
  try {
    assert.equal(
      readCurrentAgentRolePlan(repository, CHANGE_ID, PLANNING_GENERATION),
      null,
    );
    fs.mkdirSync(path.dirname(planPath(repository)), { recursive: true });
    assert.equal(
      readCurrentAgentRolePlan(repository, CHANGE_ID, PLANNING_GENERATION),
      null,
    );
    writePlan(repository);
    assert.deepEqual(
      readCurrentAgentRolePlan(repository, CHANGE_ID, PLANNING_GENERATION),
      plan(),
    );
    assert.throws(
      () => readCurrentAgentRolePlan(repository, CHANGE_ID, 'b'.repeat(64)),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }

  for (const mutate of [
    (repository: string, destination: string) =>
      fs.chmodSync(destination, 0o755),
    (repository: string, destination: string) => {
      const target = path.join(repository, 'agent-plan-target.json');
      fs.renameSync(destination, target);
      fs.symlinkSync(target, destination);
    },
    (repository: string, destination: string) =>
      fs.linkSync(destination, path.join(repository, 'agent-plan-alias.json')),
    (repository: string, destination: string) =>
      fs.writeFileSync(destination, Buffer.from([0xff])),
    (repository: string, destination: string) =>
      fs.writeFileSync(destination, Buffer.alloc(64 * 1024 + 1, 0x61)),
  ]) {
    const unsafeRepository = temporaryRepository();
    try {
      const destination = writePlan(unsafeRepository);
      mutate(unsafeRepository, destination);
      assert.throws(
        () =>
          readCurrentAgentRolePlan(
            unsafeRepository,
            CHANGE_ID,
            PLANNING_GENERATION,
          ),
        (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      );
    } finally {
      fs.rmSync(unsafeRepository, { recursive: true, force: true });
    }
  }
});

test('pinned agent-role plan reader accepts only an exact bounded 100644 blob', () => {
  const repository = temporaryRepository();
  try {
    git(repository, ['init', '-q']);
    git(repository, ['config', 'user.email', 'agent-plan@example.test']);
    git(repository, ['config', 'user.name', 'Agent Plan Test']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-q', '-m', 'Create fixture']);
    const absentCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      readPinnedAgentRolePlan(
        repository,
        absentCommit,
        CHANGE_ID,
        PLANNING_GENERATION,
      ),
      null,
    );

    writePlan(repository);
    git(repository, ['add', `workflow/agent-plans/${CHANGE_ID}.json`]);
    git(repository, ['commit', '-q', '-m', 'Add optional agent plan']);
    const validCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.deepEqual(
      readPinnedAgentRolePlan(
        repository,
        validCommit,
        CHANGE_ID,
        PLANNING_GENERATION,
      ),
      plan(),
    );
    assert.throws(
      () =>
        readPinnedAgentRolePlan(
          repository,
          'HEAD',
          CHANGE_ID,
          PLANNING_GENERATION,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    git(repository, [
      'update-index',
      '--chmod=+x',
      `workflow/agent-plans/${CHANGE_ID}.json`,
    ]);
    git(repository, ['commit', '-q', '-m', 'Make plan executable']);
    const executableCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlan(
          repository,
          executableCommit,
          CHANGE_ID,
          PLANNING_GENERATION,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    fs.rmSync(planPath(repository));
    fs.symlinkSync('../../README.md', planPath(repository));
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-q', '-m', 'Make plan a symlink']);
    const symlinkCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlan(
          repository,
          symlinkCommit,
          CHANGE_ID,
          PLANNING_GENERATION,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    fs.rmSync(planPath(repository));
    fs.writeFileSync(planPath(repository), Buffer.from([0xff]));
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-q', '-m', 'Write invalid UTF-8 plan']);
    const invalidUtf8Commit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlan(
          repository,
          invalidUtf8Commit,
          CHANGE_ID,
          PLANNING_GENERATION,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    fs.writeFileSync(planPath(repository), Buffer.alloc(64 * 1024 + 1, 0x61));
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-q', '-m', 'Write oversized agent plan']);
    const oversizedCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlan(
          repository,
          oversizedCommit,
          CHANGE_ID,
          PLANNING_GENERATION,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('agent-role plan remains outside planning paths and managed planning digest', () => {
  assert.throws(
    () =>
      assertPlanningPaths('openspec/changes', CHANGE_ID, [
        `workflow/agent-plans/${CHANGE_ID}.json`,
      ]),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );

  const repository = createFixtureRepository();
  try {
    const before = loadValidatedChangeContract(
      repository,
      CHANGE_ID,
      planningProviderBindingReader,
    );
    writePlan(repository);
    const after = loadValidatedChangeContract(
      repository,
      CHANGE_ID,
      planningProviderBindingReader,
    );
    assert.equal(after.contractDigest, before.contractDigest);
    assert.deepEqual(after.artifactPaths, before.artifactPaths);
    assert.equal(
      after.artifactPaths.some((artifactPath) =>
        artifactPath.includes('/workflow/agent-plans/'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
