import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { resolveActorIdentity } from '../src/actor-identity.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import {
  createProviderInvocationRequest,
  evaluateProviderProcess,
  MAX_PROVIDER_LIMITS,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/provider-contracts.ts';
import {
  listBuiltInProviders,
  requireProviderCapability,
} from '../src/provider-registry.ts';
import {
  admitRoleResult,
  assessRoleIndependence,
  scheduleOrdinaryRole,
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RoleAssignment,
  type RoleParticipant,
} from '../src/role-scheduler.ts';
import { WorkflowError } from '../src/errors.ts';

const DIGESTS = {
  authorization: '1'.repeat(64),
  baseTree: '2'.repeat(40),
  target: '3'.repeat(64),
  manifest: '4'.repeat(64),
  outputSchema: '5'.repeat(64),
  policy: '6'.repeat(64),
} as const;

test('built-in provider registry is exact, immutable, and capability-scoped', () => {
  const providers = listBuiltInProviders();

  assert.deepEqual(providers, [
    {
      id: 'codex',
      capabilities: [
        {
          purpose: 'survey',
          profile: 'repository-read-only',
        },
        {
          purpose: 'plan-review',
          profile: 'repository-read-only',
        },
      ],
    },
    {
      id: 'claude',
      capabilities: [
        {
          purpose: 'survey',
          profile: 'repository-read-only',
        },
        {
          purpose: 'plan-review',
          profile: 'repository-read-only',
        },
      ],
    },
  ]);
  assert.equal(Object.isFrozen(providers), true);
  assert.equal(Object.isFrozen(providers[0]), true);
  assert.equal(Object.isFrozen(providers[0]?.capabilities), true);
  assert.equal(Object.isFrozen(providers[0]?.capabilities[0]), true);
  assert.strictEqual(listBuiltInProviders(), providers);

  assert.equal(
    requireProviderCapability('claude', 'plan-review', 'repository-read-only')
      .id,
    'claude',
  );
  assert.throws(
    () =>
      requireProviderCapability(
        'unknown' as 'codex',
        'survey',
        'repository-read-only',
      ),
    (error) => isWorkflowError(error, 'PROVIDER_UNKNOWN'),
  );
  assert.throws(
    () =>
      requireProviderCapability(
        'codex',
        'implementation' as 'survey',
        'repository-read-only',
      ),
    (error) => isWorkflowError(error, 'PROVIDER_CAPABILITY_UNSUPPORTED'),
  );
});

test('actor resolution preserves all agreeing soft signals and their grade', () => {
  const result = resolveActorIdentity({
    explicitActor: 'claude',
    environment: {
      AGENT: 'claude',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PATH: '/tmp/fake-provider-bin',
    },
  });

  assert.deepEqual(result, {
    outcome: 'resolved',
    actor: {
      providerId: 'claude',
      assurance: 'runtime-hint',
    },
    signals: [
      {
        source: 'explicit',
        name: '--actor',
        providerId: 'claude',
        assurance: 'self-declared',
      },
      {
        source: 'runtime-hint',
        name: 'AGENT',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDE_CODE_ENTRYPOINT',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal(
    JSON.stringify(result).includes('/tmp/fake-provider-bin'),
    false,
  );
});

test('actor resolution distinguishes explicit-only, missing, and conflicts', () => {
  assert.deepEqual(
    resolveActorIdentity({
      explicitActor: 'codex',
      environment: {},
    }),
    {
      outcome: 'resolved',
      actor: {
        providerId: 'codex',
        assurance: 'self-declared',
      },
      signals: [
        {
          source: 'explicit',
          name: '--actor',
          providerId: 'codex',
          assurance: 'self-declared',
        },
      ],
    },
  );
  assert.deepEqual(
    resolveActorIdentity({
      environment: {
        AGENT: 'unknown-agent',
        CLAUDECODE: '0',
        CLAUDE_CODE_ENTRYPOINT: '',
        CODEX_SANDBOX: '',
      },
    }),
    {
      outcome: 'actor-resolution-required',
      code: 'ACTOR_IDENTITY_REQUIRED',
      signals: [],
    },
  );

  const conflict = resolveActorIdentity({
    explicitActor: 'codex',
    environment: {
      CLAUDECODE: '1',
      CODEX_SANDBOX: 'seatbelt',
    },
  });
  assert.deepEqual(conflict, {
    outcome: 'actor-resolution-required',
    code: 'ACTOR_IDENTITY_CONFLICT',
    signals: [
      {
        source: 'explicit',
        name: '--actor',
        providerId: 'codex',
        assurance: 'self-declared',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CODEX_SANDBOX',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal('actor' in conflict, false);

  const runtimeConflict = resolveActorIdentity({
    environment: {
      AGENT: 'codex',
      CLAUDECODE: '1',
    },
  });
  assert.deepEqual(runtimeConflict, {
    outcome: 'actor-resolution-required',
    code: 'ACTOR_IDENTITY_CONFLICT',
    signals: [
      {
        source: 'runtime-hint',
        name: 'AGENT',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal('actor' in runtimeConflict, false);

  assert.throws(
    () =>
      resolveActorIdentity({
        explicitActor: 'unregistered',
        environment: {},
      }),
    (error) => isWorkflowError(error, 'ACTOR_PROVIDER_UNKNOWN'),
  );
});

test('role independence keeps provider, session, and principal dimensions separate', () => {
  const author = participant({
    providerId: 'codex',
    sessionId: 'author-session',
    principalId: 'principal-a',
  });

  assert.deepEqual(
    assessRoleIndependence(
      author,
      participant({
        providerId: 'codex',
        sessionId: 'fresh-session',
        principalId: 'principal-b',
      }),
    ),
    {
      principalIndependent: true,
      providerIndependent: false,
      sessionIndependent: true,
      achievedIndependence: 'principal-independent',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(
      author,
      participant({
        providerId: 'claude',
        sessionId: 'author-session',
        principalId: 'principal-a',
      }),
    ),
    {
      principalIndependent: false,
      providerIndependent: true,
      sessionIndependent: false,
      achievedIndependence: 'provider-independent',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(author, {
      providerId: undefined,
      sessionId: undefined,
      principalId: undefined,
      identityAssurance: 'self-declared',
      engineSpawned: false,
    }),
    {
      principalIndependent: null,
      providerIndependent: false,
      sessionIndependent: false,
      achievedIndependence: 'none',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(
      {
        providerId: undefined,
        sessionId: undefined,
        principalId: undefined,
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      participant({
        providerId: 'claude',
        sessionId: 'adapter-session',
        identityAssurance: 'adapter-assigned',
      }),
    ),
    {
      principalIndependent: null,
      providerIndependent: false,
      sessionIndependent: false,
      achievedIndependence: 'none',
    },
  );
});

test('ordinary role scheduling selects an alternate or requires a grant', () => {
  const author = participant({
    providerId: 'codex',
    sessionId: 'author-session',
  });
  const scheduled = scheduleOrdinaryRole({
    role: 'blind-surveyor',
    author,
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'codex-survey',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'claude-survey',
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') {
    assert.fail('expected an assigned alternate provider');
  }
  assert.equal(scheduled.assignment.providerId, 'claude');
  assert.equal(
    scheduled.assignment.requiredIndependence,
    'provider-independent',
  );
  assert.equal(
    scheduled.assignment.achievedIndependence,
    'provider-independent',
  );

  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'plan-reviewer',
      author,
      targetDigest: DIGESTS.target,
      candidates: [
        {
          providerId: 'codex',
          sessionId: 'fresh-codex-review',
          enabled: true,
          available: true,
        },
        {
          providerId: 'claude',
          sessionId: 'claude-review',
          enabled: false,
          available: true,
        },
      ],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'plan-reviewer',
      requiredIndependence: 'provider-independent',
      reason: 'NO_PROVIDER_INDEPENDENT_CANDIDATE',
    },
  );
  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'blind-surveyor',
      author,
      targetDigest: DIGESTS.target,
      candidates: [
        {
          providerId: 'claude',
          sessionId: 'unavailable-claude-survey',
          enabled: true,
          available: false,
        },
      ],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'blind-surveyor',
      requiredIndependence: 'provider-independent',
      reason: 'NO_PROVIDER_INDEPENDENT_CANDIDATE',
    },
  );
  assert.throws(
    () =>
      scheduleOrdinaryRole({
        role: 'blind-surveyor',
        author,
        targetDigest: DIGESTS.target,
        candidates: [
          {
            providerId: 'unregistered' as 'claude',
            sessionId: 'unknown-provider-session',
            enabled: true,
            available: true,
          },
        ],
      }),
    (error) => isWorkflowError(error, 'PROVIDER_UNKNOWN'),
  );
  assert.throws(
    () =>
      scheduleOrdinaryRole({
        role: 'blind-surveyor',
        author,
        targetDigest: DIGESTS.target,
        requestedIndependence: 'session-independent',
        candidates: [],
      }),
    (error) => isWorkflowError(error, 'ROLE_INDEPENDENCE_DOWNGRADE'),
  );
});

test('typed provider request is immutable, bounded, and assignment-bound', () => {
  assert.equal(MAX_PROVIDER_LIMITS.timeoutMs, 600_000);
  const assignment = surveyAssignment();
  const source = requestInput(assignment);
  const request = createProviderInvocationRequest(source);

  source.targetDigest = 'f'.repeat(64);
  source.limits.timeoutMs = 1;
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.targetDigest, DIGESTS.target);
  assert.equal(request.limits.timeoutMs, 600_000);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.roleAssignment), true);
  assert.equal(Object.isFrozen(request.limits), true);
  assert.equal(Object.isFrozen(request.outputSchema), true);
  assert.equal(Object.isFrozen(request.writeAllowedPaths), true);
  assert.equal(request.providerId, request.roleAssignment.providerId);
  assert.deepEqual(request.writeAllowedPaths, []);
  assert.match(request.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    createProviderInvocationRequest(requestInput(surveyAssignment()))
      .requestDigest,
    request.requestDigest,
  );
  assert.notEqual(
    createProviderInvocationRequest({
      ...requestInput(surveyAssignment()),
      repositoryId: 'expense-app@other-canonical-origin',
    }).requestDigest,
    request.requestDigest,
  );

  for (const limits of [
    { timeoutMs: 0, aggregateOutputBytes: 1024 },
    { timeoutMs: 1.5, aggregateOutputBytes: 1024 },
    {
      timeoutMs: MAX_PROVIDER_LIMITS.timeoutMs + 1,
      aggregateOutputBytes: 1024,
    },
    { timeoutMs: 1000, aggregateOutputBytes: 0 },
    {
      timeoutMs: 1000,
      aggregateOutputBytes: MAX_PROVIDER_LIMITS.aggregateOutputBytes + 1,
    },
  ]) {
    assert.throws(
      () =>
        createProviderInvocationRequest({
          ...requestInput(surveyAssignment()),
          limits,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
    );
  }

  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput(surveyAssignment()),
        providerId: 'codex',
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput({
          ...surveyAssignment(),
          requiredIndependence: 'none',
          achievedIndependence: 'none',
        }),
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput(surveyAssignment()),
        writeAllowedPaths: ['openspec/changes/example/design.md'],
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput({
          ...surveyAssignment(),
          targetDigest: 'f'.repeat(64),
        }),
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput(surveyAssignment()),
        unexpected: true,
      } as ReturnType<typeof requestInput>),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
});

test('provider requests admit only ordinary or granted same-provider assignments', () => {
  const ordinary = surveyAssignment();
  const admitted = admitRoleResult({
    assignment: ordinary,
    author: participant({
      providerId: 'codex',
      sessionId: 'author-session',
      engineSpawned: false,
    }),
    participant: participant({
      providerId: ordinary.providerId,
      sessionId: ordinary.sessionId,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    }),
    content: roleContent(),
    providerInvocation: {
      invocationId: 'invocation-1',
      requestDigest: '7'.repeat(64),
      outputDigest: '8'.repeat(64),
      providerId: ordinary.providerId,
      sessionId: ordinary.sessionId,
      targetDigest: ordinary.targetDigest,
      engineSpawned: true,
    },
    grantUse: null,
    grantValidation: null,
  });
  assert.equal(admitted.form, 'ordinary-provider');
  assert.equal(admitted.orchestration, 'engine-spawned-provider');

  const granted = grantedSameProviderAssignment();
  const request = createProviderInvocationRequest(requestInput(granted));
  assert.equal(
    request.roleAssignment.achievedIndependence,
    'session-independent',
  );
  assert.equal(request.providerId, 'codex');

  assert.throws(
    () =>
      createProviderInvocationRequest(
        requestInput({
          ...granted,
          orchestration: 'caller-supplied',
          engineSpawned: false,
        } as unknown as ProviderRoleAssignment),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
});

test('tracked planning schemas expose every admitted role-result form', () => {
  for (const relativePath of [
    '../../../workflow/schemas/investigation-artifact.schema.json',
    '../../../workflow/schemas/plan-review-artifact.schema.json',
  ]) {
    const schema = JSON.parse(
      fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
    ) as {
      $defs: {
        admittedRoleResult: {
          properties: { form: { enum: string[] } };
          allOf: unknown[];
        };
      };
    };
    assert.deepEqual(schema.$defs.admittedRoleResult.properties.form.enum, [
      'ordinary-provider',
      'granted-same-provider',
      'granted-caller-supplied',
      'direct-human-attestation',
    ]);
    assert.equal(schema.$defs.admittedRoleResult.allOf.length, 4);
  }
});

test('deterministic fake process accepts only a fully bound structured result', () => {
  const request = createProviderInvocationRequest(
    requestInput(surveyAssignment()),
  );
  const accepted = evaluateProviderProcess(
    request,
    processOutcome(providerResult(request, { terms: ['protectedBranches'] })),
    {
      id: request.outputSchema.id,
      version: request.outputSchema.version,
      digest: request.outputSchema.digest,
      validate(value) {
        assert.equal(Object.isFrozen(value), true);
        assert.equal(
          Object.isFrozen((value as { terms: unknown[] }).terms),
          true,
        );
        return (
          typeof value === 'object' &&
          value !== null &&
          Array.isArray((value as { terms?: unknown }).terms)
        );
      },
    },
  );

  assert.deepEqual(accepted.output, { terms: ['protectedBranches'] });
  assert.match(accepted.outputDigest, /^[0-9a-f]{64}$/);
  assert.equal(accepted.requestDigest, request.requestDigest);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.output), true);
  assert.equal(
    Object.isFrozen((accepted.output as { terms: unknown[] }).terms),
    true,
  );
});

test('provider results reject every mismatched request binding', () => {
  const request = createProviderInvocationRequest(
    requestInput(surveyAssignment()),
  );
  const base = providerResult(request, { terms: [] });
  const mismatches: Array<[string, unknown]> = [
    ['requestDigest', 'f'.repeat(64)],
    ['invocationId', 'different-invocation'],
    ['nonce', 'different-nonce'],
    ['purpose', 'plan-review'],
    ['providerId', 'codex'],
    ['roleAssignmentDigest', 'f'.repeat(64)],
    ['capabilityProfile', 'different-profile'],
    ['repositoryId', 'different-repository'],
    ['baseCommit', 'f'.repeat(40)],
    ['baseTree', 'f'.repeat(40)],
    ['targetDigest', 'f'.repeat(64)],
    ['inputManifestDigest', 'f'.repeat(64)],
    ['authorizationNodeId', 'f'.repeat(64)],
    ['outputSchema', { ...request.outputSchema, id: 'other-output' }],
    ['evaluatorVersion', 'other-evaluator.v1'],
    ['policyDigest', 'f'.repeat(64)],
    ['limits', { timeoutMs: 1, aggregateOutputBytes: 1024 }],
  ];

  for (const [field, value] of mismatches) {
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome({ ...base, [field]: value }),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_UNBOUND'),
      field,
    );
  }
  assert.throws(
    () =>
      evaluateProviderProcess(
        request,
        processOutcome({ ...base, unexpected: true }),
        outputValidator(request),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
  );
  for (const invalid of [
    { ...base, schemaVersion: 2 },
    { ...base, observedTouchedPaths: '' },
    { ...base, observedTouchedPaths: [1] },
    {
      ...base,
      outputSchema: { ...base.outputSchema, unexpected: true },
    },
    {
      ...base,
      limits: { ...base.limits, unexpected: true },
    },
    {
      ...base,
      limits: { ...base.limits, timeoutMs: 1.5 },
    },
    {
      ...base,
      outputSchema: { ...base.outputSchema, digest: 'not-a-digest' },
    },
  ]) {
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome(invalid),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
    );
  }
  for (const field of Object.keys(base)) {
    const missing = { ...base } as Record<string, unknown>;
    delete missing[field];
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome(missing),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
      `missing ${field}`,
    );
  }
});

test('provider process and output failures never become successful results', () => {
  const request = createProviderInvocationRequest({
    ...requestInput(surveyAssignment()),
    limits: {
      timeoutMs: 100,
      aggregateOutputBytes: 4096,
    },
  });
  const result = providerResult(request, { terms: [] });
  const failures: Array<[Partial<ProviderProcessOutcome>, string]> = [
    [{ timedOut: true }, 'PROVIDER_PROCESS_FAILED'],
    [{ elapsedMs: 101 }, 'PROVIDER_PROCESS_FAILED'],
    [{ signal: 'SIGTERM' }, 'PROVIDER_PROCESS_FAILED'],
    [{ spawnErrorCode: 'ENOENT' }, 'PROVIDER_PROCESS_FAILED'],
    [{ exitCode: 1 }, 'PROVIDER_PROCESS_FAILED'],
    [{ stdout: '{not-json' }, 'PROVIDER_RESULT_INVALID'],
    [
      { stdout: `${JSON.stringify(result)}\n${JSON.stringify(result)}` },
      'PROVIDER_RESULT_INVALID',
    ],
    [{ stderr: '界'.repeat(1400) }, 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'],
  ];

  for (const [override, code] of failures) {
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome(result, override),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, code),
      code,
    );
  }
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        validate: () => false,
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        digest: 'f'.repeat(64),
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        validate() {
          throw new Error('validator failure');
        },
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        validate: () => 1 as unknown as boolean,
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
});

test('aggregate provider output includes the normalized semantic output', () => {
  const request = createProviderInvocationRequest({
    ...requestInput(surveyAssignment()),
    limits: {
      timeoutMs: 100,
      aggregateOutputBytes: 4096,
    },
  });
  const output = { terms: ['x'.repeat(1500)] };
  const result = providerResult(request, output);
  const stdout = JSON.stringify(result);
  const rawBytes = Buffer.byteLength(stdout, 'utf8');
  const normalizedBytes = Buffer.byteLength(canonicalJson(output), 'utf8');
  assert.ok(rawBytes < request.limits.aggregateOutputBytes);
  assert.ok(rawBytes + normalizedBytes > request.limits.aggregateOutputBytes);

  assert.throws(
    () =>
      evaluateProviderProcess(
        request,
        processOutcome(result),
        outputValidator(request),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'),
  );
});

test('read-only provider result rejects any observed repository mutation', () => {
  const request = createProviderInvocationRequest(
    requestInput(surveyAssignment()),
  );
  const result = providerResult(request, { terms: [] });

  assert.throws(
    () =>
      evaluateProviderProcess(
        request,
        processOutcome({
          ...result,
          observedTouchedPaths: ['openspec/changes/example/design.md'],
        }),
        outputValidator(request),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_READ_ONLY_DRIFT'),
  );
});

function participant(override: Partial<RoleParticipant> = {}): RoleParticipant {
  return {
    providerId: 'codex',
    sessionId: 'session-a',
    principalId: undefined,
    identityAssurance: 'runtime-hint',
    engineSpawned: true,
    ...override,
  };
}

function surveyAssignment(): RoleAssignment {
  const scheduled = scheduleOrdinaryRole({
    role: 'blind-surveyor',
    author: participant({
      providerId: 'codex',
      sessionId: 'author-session',
    }),
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'claude',
        sessionId: 'survey-session',
        enabled: true,
        available: true,
      },
    ],
  });
  if (scheduled.outcome !== 'assigned') {
    throw new Error('fixture role assignment was not scheduled');
  }
  return scheduled.assignment;
}

function requestInput(assignment: ProviderRoleAssignment) {
  return {
    invocationId: 'invocation-1',
    nonce: 'nonce-with-at-least-16-bytes',
    purpose: 'survey' as const,
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: 'expense-app@canonical-origin',
    baseCommit: 'a'.repeat(40),
    baseTree: DIGESTS.baseTree,
    targetDigest: DIGESTS.target,
    inputManifestDigest: DIGESTS.manifest,
    authorizationNodeId: DIGESTS.authorization,
    writeAllowedPaths: [] as string[],
    outputSchema: {
      id: 'expense-app.workflow.survey-output',
      version: 1,
      digest: DIGESTS.outputSchema,
    },
    evaluatorVersion: 'survey-evaluator.v1',
    policyDigest: DIGESTS.policy,
    limits: {
      timeoutMs: 600_000,
      aggregateOutputBytes: 1_048_576,
    },
  };
}

function grantedSameProviderAssignment(): GrantedSameProviderRoleAssignment {
  return {
    role: 'blind-surveyor',
    providerId: 'codex',
    sessionId: 'fresh-session',
    targetDigest: DIGESTS.target,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'session-independent',
    providerIndependent: false,
    sessionIndependent: true,
    engineSpawned: true,
    orchestration: 'engine-spawned-provider',
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    degradedForm: 'same-provider-fresh-session',
    authorizedEffect: 'role-independence-degradation-only',
    author: {
      providerId: 'codex',
      sessionId: 'author-session',
      principalId: null,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    participant: {
      providerId: 'codex',
      sessionId: 'fresh-session',
      principalId: null,
      identityAssurance: 'runtime-hint',
      engineSpawned: true,
    },
    callableProviderIds: ['codex'],
    directHumanReviewAttestationDigest: null,
  };
}

function roleContent() {
  return {
    kind: 'blind-survey' as const,
    nodeId: '9'.repeat(64),
    resultDigest: 'a'.repeat(64),
    outputSchema: {
      id: 'blind-survey-output.v1',
      version: 1,
      digest: DIGESTS.outputSchema,
    },
    evaluator: 'blind-survey-evaluator.v1',
    policyDigest: DIGESTS.policy,
    contentDigest: 'a'.repeat(64),
    current: true as const,
  };
}

function providerResult(request: ProviderInvocationRequest, output: unknown) {
  return {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
}

function processOutcome(
  result: unknown,
  override: Partial<ProviderProcessOutcome> = {},
): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify(result),
    stderr: '',
    ...override,
  };
}

function outputValidator(request: ProviderInvocationRequest) {
  return {
    id: request.outputSchema.id,
    version: request.outputSchema.version,
    digest: request.outputSchema.digest,
    validate: () => true,
  };
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
