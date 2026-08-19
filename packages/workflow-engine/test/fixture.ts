import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadChangeContract, type ExecutionTask } from '../src/contracts.ts';
import { createEvidenceNode } from '../src/evidence-node.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  createInvestigationApplicability,
  INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
} from '../src/modules/investigation/domain/investigation-applicability.ts';
import { OPENSPEC_REPOSITORY_REVIEWED_SOURCES } from '../src/openspec-planning-asset-contract.ts';
import { generateOpenSpecPlanningAssets } from '../src/openspec-planning-assets.ts';
import { INVESTIGATION_PLANNING_ACTIVATION_MARKER } from '../src/openspec-schema-contract.ts';
import {
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import {
  deriveInvestigationFirstPlanningSubject,
  validateInvestigationFirstPlanningReadiness,
} from '../src/modules/assurance/planning-assurance-validator.ts';
import { admitRoleResult } from '../src/modules/provider-orchestration/role-scheduler.ts';

export const sourceRepositoryRoot = path.resolve(
  import.meta.dirname,
  '../../..',
);

let openSpecAssetTemplateRoot: string | undefined;

export function createFixtureRepository(
  options: { objectFormat?: 'sha1' | 'sha256' } = {},
): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-session-repo-'),
  );
  git(repository, [
    'init',
    '-b',
    'main',
    `--object-format=${options.objectFormat ?? 'sha1'}`,
  ]);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);

  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName: 'fixture',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
    taskAuthorization: {
      pathRoleRegistry: 'workflow/path-roles.json',
      mandateRequiredRoles: ['control-plane'],
    },
  });
  writeJson(path.join(repository, 'workflow/path-roles.json'), {
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles: {
      ordinary: [
        'additional/**',
        'alias/**',
        'apps/**',
        'broken/**',
        'docs/**',
        'escape/**',
        'feature/**',
        'openspec/**',
        'outside.txt',
        'package.json',
        'packages/**',
        'sample/**',
        'scripts/**',
        'src/**',
        'test/**',
        'workflow/**',
      ],
    },
  });
  writeJson(path.join(repository, 'package.json'), {
    name: 'workflow-fixture',
    private: true,
    devDependencies: {
      'fixture-tool': '1.0.0',
    },
  });
  fs.writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\n');
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks: {
      fixture: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: false,
      },
    },
  });
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/ai-adapter-policy.json'),
    path.join(repository, 'workflow/ai-adapter-policy.json'),
  );
  writeJson(path.join(repository, 'workflow/document-policy.json'), {
    schemaVersion: 1,
    enforcementMode: 'enforced',
    documents: {
      'docs/architecture/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
      'docs/features/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
    },
  });
  fs.mkdirSync(path.join(repository, 'workflow/schemas'), {
    recursive: true,
  });
  for (const schemaName of [
    'guard.schema.json',
    'execution-artifact.schema.json',
    'investigation-artifact.schema.json',
    'plan-review-artifact.schema.json',
  ]) {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/schemas', schemaName),
      path.join(repository, 'workflow/schemas', schemaName),
    );
  }

  const changeDirectory = path.join(repository, 'openspec/changes/demo-change');
  fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  addFixtureScripts(repository);
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    'schema: expense-app\ncreated: 2026-07-15\n',
  );
  fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(changeDirectory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(changeDirectory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Demo task\n',
  );
  fs.writeFileSync(
    path.join(changeDirectory, 'specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Demo behavior',
      '',
      'The system SHALL provide the demo behavior.',
      '',
      '#### Scenario: Demo succeeds',
      '',
      '- **WHEN** the demo is exercised',
      '- **THEN** the behavior succeeds',
      '',
    ].join('\n'),
  );
  writeJson(path.join(changeDirectory, 'guard.json'), {
    schemaVersion: 1,
    changeId: 'demo-change',
    tasks: {
      '1.1': {
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
      },
    },
  });
  fs.writeFileSync(path.join(repository, 'src/.gitkeep'), '');
  installFakeOpenSpec(repository);
  installOpenSpecAssetFixture(repository);

  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create fixture']);
  syncOriginMain(repository);
  return repository;
}

/**
 * Reproduce the immutable legacy history a pre-activation change actually has:
 * a governing `Transition: plan` generation with every task unchecked, then a
 * task commit that checks exactly one box. The legacy-migration transition must
 * preserve that projection instead of re-authoring it.
 */
export function writeLegacyGoverningPlan(
  repository: string,
  changeId: string,
): { created: string; governingCommit: string; taskContent: string } {
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  git(repository, [
    'mv',
    'openspec/changes/demo-change',
    `openspec/changes/${changeId}`,
  ]);
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  const guardPath = path.join(changeDirectory, 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
    tasks: Record<string, unknown>;
  };
  guard.changeId = changeId;
  guard.tasks['1.2'] = {
    allowedPaths: ['src/**'],
    requiredChecks: ['fixture'],
  };
  writeJson(guardPath, guard);
  fs.writeFileSync(
    path.join(changeDirectory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Demo task\n- [ ] 1.2 Follow-up task\n',
  );
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    `Plan ${changeId}\n\nChange: ${changeId}\nTransition: plan`,
  ]);
  const governingCommit = git(repository, ['rev-parse', 'HEAD']).trim();

  const taskContent =
    '# Tasks\n\n- [x] 1.1 Demo task\n- [ ] 1.2 Follow-up task\n';
  fs.writeFileSync(path.join(changeDirectory, 'tasks.md'), taskContent);
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    `Complete the demo task\n\nChange: ${changeId}\nTask: 1.1`,
  ]);
  return { created: '2026-07-15', governingCommit, taskContent };
}

export function writeV2ChangeArtifacts(
  repository: string,
  changeId = 'demo-change',
) {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    'schema: expense-app-v2\ncreated: 2026-07-15\n',
  );
  const investigationNode = createEvidenceNode({
    type: 'fixture-investigation',
    nodeSchema: 'fixture.investigation.v1',
    evaluator: 'fixture.investigation.v1',
    policyDigest: '1'.repeat(64),
    exactInputDigests: { intent: '2'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.investigation-output.v1',
    output: { sealed: true },
    runtimeMetadata: {},
  });
  const reviewNode = createEvidenceNode({
    type: 'fixture-plan-review',
    nodeSchema: 'fixture.plan-review.v1',
    evaluator: 'fixture.plan-review.v1',
    policyDigest: '3'.repeat(64),
    exactInputDigests: { target: '4'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.plan-review-output.v1',
    output: { verdict: 'advisory-approve' },
    runtimeMetadata: {},
  });
  const investigation = {
    schemaVersion: 1 as const,
    kind: 'investigation-artifact' as const,
    changeId,
    legacyMigration: false,
    nodes: [investigationNode],
    currentRefs: { sealedInvestigation: investigationNode.nodeId },
  };
  const execution = {
    schemaVersion: 1 as const,
    kind: 'execution-artifact' as const,
    changeId,
    tasks: {
      '1.1': {
        strategy: 'direct-reviewed' as const,
        enforcement: 'available' as const,
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
        diffReview: 'policy-required' as const,
        exemptionKind: 'documentation-only' as const,
        exemptionReason: 'documentation-only',
        legacyBootstrap: null,
      },
    },
  };
  const planReview = {
    schemaVersion: 1 as const,
    kind: 'plan-review-artifact' as const,
    changeId,
    nodes: [reviewNode],
    currentRefs: { planReview: reviewNode.nodeId },
  };
  for (const [name, artifact] of Object.entries({
    'investigation.json': investigation,
    'execution.json': execution,
    'plan-review.json': planReview,
  })) {
    fs.writeFileSync(
      path.join(changeDirectory, name),
      `${canonicalJson(artifact)}\n`,
    );
  }
  for (const schemaName of [
    'investigation-artifact.schema.json',
    'execution-artifact.schema.json',
    'plan-review-artifact.schema.json',
  ]) {
    const target = path.join(repository, 'workflow/schemas', schemaName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/schemas', schemaName),
      target,
    );
  }
  return { investigation, execution, planReview };
}

export function writeReadyV2ExemptChange(
  repository: string,
  changeId = 'demo-change',
  options: {
    diffReview?: 'required' | 'policy-required';
    executionTask?: (input: {
      taskId: string;
      policy: { allowedPaths: string[]; requiredChecks: string[] };
    }) => ExecutionTask;
  } = {},
) {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  const baseline = {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    'schema: expense-app-v2\ncreated: 2026-07-15\n',
  );
  const applicability = createInvestigationApplicability({
    kind: 'investigation-exemption',
    category: 'documentation-only',
    baseline,
    intentDigest: '2'.repeat(64),
    declaredPaths: ['src/documentation.md'],
    declaredChangeClasses: ['documentation-only'],
    rationale: 'The fixture change is documentation-only.',
    semanticAuthor: { id: 'codex', provenance: 'fixture-main-agent' },
    nonTrivialBehaviorReliance: 'none-declared',
    researchBudgetMinutes: null,
  });
  const applicabilityNode = createEvidenceNode({
    type: 'investigation-applicability',
    nodeSchema: 'investigation.applicability.v1',
    evaluator: 'investigation-applicability.v1',
    policyDigest: INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
    exactInputDigests: {
      applicability: applicability.applicabilityDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.applicability-output.v1',
    output: applicability,
    runtimeMetadata: {},
  });
  const investigation = {
    schemaVersion: 1 as const,
    kind: 'investigation-artifact' as const,
    changeId,
    legacyMigration: false,
    nodes: [applicabilityNode],
    currentRefs: { investigationApplicability: applicabilityNode.nodeId },
    applicability,
  };
  const guard = JSON.parse(
    fs.readFileSync(path.join(changeDirectory, 'guard.json'), 'utf8'),
  ) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  const execution = {
    schemaVersion: 1 as const,
    kind: 'execution-artifact' as const,
    changeId,
    tasks: Object.fromEntries(
      Object.entries(guard.tasks).map(([taskId, policy]) => [
        taskId,
        options.executionTask?.({ taskId, policy }) ?? {
          strategy: 'direct-reviewed' as const,
          enforcement: 'available' as const,
          allowedPaths: policy.allowedPaths,
          requiredChecks: policy.requiredChecks,
          diffReview: options.diffReview ?? ('policy-required' as const),
          exemptionKind: 'documentation-only' as const,
          exemptionReason: 'Fixture documentation-only task.',
          legacyBootstrap: null,
        },
      ]),
    ),
  };
  const placeholder = createEvidenceNode({
    type: 'pending-plan-review',
    nodeSchema: 'fixture.pending-plan-review.v1',
    evaluator: 'fixture.pending-plan-review.v1',
    policyDigest: '3'.repeat(64),
    exactInputDigests: { applicability: applicability.applicabilityDigest },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.pending-plan-review-output.v1',
    output: { pending: true },
    runtimeMetadata: {},
  });
  writeCanonicalJson(
    path.join(changeDirectory, 'investigation.json'),
    investigation,
  );
  writeCanonicalJson(path.join(changeDirectory, 'execution.json'), execution);
  writeCanonicalJson(path.join(changeDirectory, 'plan-review.json'), {
    schemaVersion: 1,
    kind: 'plan-review-artifact',
    changeId,
    nodes: [placeholder],
    currentRefs: { planReview: placeholder.nodeId },
  });

  const subjectContext = deriveInvestigationFirstPlanningSubject(
    repository,
    loadChangeContract(repository, changeId),
  );
  const assignment = {
    role: 'plan-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: 'fixture-plan-review-session',
    targetDigest: subjectContext.subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const snapshotRelativePaths = [
    '.openspec.yaml',
    'design.md',
    'execution.json',
    'guard.json',
    'investigation.json',
    'proposal.md',
    'specs/demo/spec.md',
    'tasks.md',
  ];
  const snapshotContents = new Map(
    snapshotRelativePaths.map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(changeDirectory, relativePath)),
    ]),
  );
  const materializationNode = createEvidenceNode({
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'fixture.propose-exemption-planning-materialization.v1',
    evaluator: 'fixture.propose-exemption-planning-materialization.v1',
    policyDigest: subjectContext.policies.reviewPolicyDigest,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema:
      'fixture.propose-exemption-planning-materialization-output.v1',
    output: {
      artifacts: Object.fromEntries(
        [...snapshotContents].map(([relativePath, content]) => [
          relativePath,
          crypto.createHash('sha256').update(content).digest('hex'),
        ]),
      ),
    },
    runtimeMetadata: {},
  });
  const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
    changeId,
    changePrefix: `openspec/changes/${changeId}`,
    subject: subjectContext.subject,
    materializationNode,
    artifacts: snapshotContents,
    legacyMigration: null,
  });
  const submission = {
    schemaVersion: 2 as const,
    verdict: 'advisory-approve' as const,
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge' as const,
      evidence: [
        {
          kind: 'investigation-node' as const,
          nodeId: applicabilityNode.nodeId,
          resultDigest: applicabilityNode.resultDigest,
        },
      ],
    },
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk:
      'The structured exemption does not prove semantic completeness.',
    uncertainty: 'The fixture relies only on the declared low-risk exemption.',
  };
  const providerResultNode = createPlanReviewProviderResultNode({
    subject: subjectContext.subject,
    assignment,
    submission,
    providerPolicyDigest: subjectContext.policies.reviewPolicyDigest,
    targetSnapshotNode,
  });
  const reviewNode = createPlanReviewNode({
    subject: subjectContext.subject,
    assignment,
    providerResultNode,
    submission,
  });
  const roleResult = admitRoleResult({
    assignment,
    author: {
      providerId: 'codex',
      sessionId: 'fixture-plan-author-session',
      principalId: undefined,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    participant: {
      providerId: 'claude',
      sessionId: assignment.sessionId,
      principalId: undefined,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    },
    content: {
      kind: 'plan-review',
      nodeId: reviewNode.nodeId,
      resultDigest: reviewNode.resultDigest,
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluator: reviewNode.evaluator,
      policyDigest: reviewNode.policyDigest,
      contentDigest: reviewNode.resultDigest,
      current: true,
    },
    providerInvocation: {
      invocationId: 'fixture-plan-review-invocation',
      requestDigest: '4'.repeat(64),
      outputDigest: '5'.repeat(64),
      providerId: assignment.providerId,
      sessionId: assignment.sessionId,
      targetDigest: assignment.targetDigest,
      engineSpawned: true,
    },
    grantUse: null,
    grantValidation: null,
  });
  writeCanonicalJson(path.join(changeDirectory, 'plan-review.json'), {
    schemaVersion: 1,
    kind: 'plan-review-artifact',
    changeId,
    nodes: [targetSnapshotNode, providerResultNode, reviewNode].sort(
      (left, right) => left.nodeId.localeCompare(right.nodeId),
    ),
    currentRefs: { planReview: reviewNode.nodeId },
    roleResults: [roleResult],
  });

  const planningAssurance = validateInvestigationFirstPlanningReadiness(
    repository,
    loadChangeContract(repository, changeId),
  ).summary;
  return { applicability, applicabilityNode, planningAssurance };
}

/**
 * Mirror the local protected branch tip into its remote-tracking ref, which is
 * the base archive eligibility resolves. Fixtures call this whenever `main`
 * advances to a new intended integration base, reproducing the ref a real
 * clone would track.
 */
export function syncOriginMain(repository: string): void {
  const tip = git(repository, ['rev-parse', 'main']).trim();
  git(repository, ['update-ref', 'refs/remotes/origin/main', tip]);
}

/**
 * Introduce the reviewed investigation-planning activation marker exactly as
 * the cutover commit does. The returned commit is the activation anchor for
 * every lineage that reaches it; fixtures that omit this call reproduce a
 * pre-activation repository, where legacy selection is still eligible.
 */
export function activateInvestigationPlanning(repository: string): string {
  const target = path.join(
    repository,
    INVESTIGATION_PLANNING_ACTIVATION_MARKER,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, INVESTIGATION_PLANNING_ACTIVATION_MARKER),
    target,
  );
  git(repository, ['add', '--', INVESTIGATION_PLANNING_ACTIVATION_MARKER]);
  git(repository, ['commit', '-m', 'Activate investigation-first planning']);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

export function addFixtureScripts(repository: string): void {
  const scriptsDirectory = path.join(repository, 'scripts');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDirectory, 'capture-args.mjs'),
    [
      "import fs from 'node:fs';",
      'const [outputPath, ...arguments_] = process.argv.slice(2);',
      'fs.writeFileSync(',
      '  outputPath,',
      '  JSON.stringify({ cwd: process.cwd(), arguments: arguments_ }),',
      ');',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'write-file.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.argv[2], 'ran');",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'pass.mjs'),
    'process.exit(0);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'fail.mjs'),
    'process.exit(7);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'remove-file.mjs'),
    ["import fs from 'node:fs';", 'fs.rmSync(process.argv[2]);', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'mutate-self.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(import.meta.filename, "\\n");',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'overflow.mjs'),
    "process.stdout.write('x'.repeat(11 * 1024 * 1024));\n",
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.writeFileSync(process.argv[2], process.argv[3]);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'chmod-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.chmodSync(process.argv[2], 0o755);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-preserve-times.mjs'),
    [
      "import fs from 'node:fs';",
      'const targetPath = process.argv[2];',
      'const before = fs.statSync(targetPath);',
      'fs.writeFileSync(targetPath, process.argv[3]);',
      'fs.utimesSync(targetPath, before.atime, before.mtime);',
      '',
    ].join('\n'),
  );
}

export function addFixturePackage(
  repository: string,
  source = 'process.exit(0);\n',
): void {
  const packageDirectory = path.join(repository, 'node_modules/fixture-tool');
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: 'fixture-tool',
    version: '1.0.0',
    exports: { '.': './index.mjs' },
    bin: './bin/run.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'bin/run.mjs'), source);
}

export function configureChecks(
  repository: string,
  checks: Record<
    string,
    {
      command: string[];
      destructiveDatabase: boolean;
      liveStderr?: boolean;
    }
  >,
  requiredChecks: string[],
): void {
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks,
  });
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
  guard.tasks['1.1'].requiredChecks = requiredChecks;
  writeJson(guardPath, guard);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure fixture checks']);
}

export function installFakeOpenSpec(repository: string): void {
  fs.mkdirSync(path.join(repository, 'openspec'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'openspec/config.yaml'),
    path.join(repository, 'openspec/config.yaml'),
  );
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/expense-app'),
    path.join(repository, 'openspec/schemas/expense-app'),
    { recursive: true },
  );
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/expense-app-v2'),
    path.join(repository, 'openspec/schemas/expense-app-v2'),
    { recursive: true },
  );

  const manifestPath = path.join(repository, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.devDependencies['@fission-ai/openspec'] = '1.6.0';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(repository, 'pnpm-workspace.yaml'),
    [
      'packages:',
      "  - 'packages/*'",
      '',
      'allowBuilds:',
      "  '@fission-ai/openspec': false",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    devDependencies:',
      "      '@fission-ai/openspec':",
      '        specifier: 1.6.0',
      '        version: 1.6.0',
      '',
      'packages:',
      '',
      "  '@fission-ai/openspec@1.6.0':",
      '    resolution: {integrity: sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==}',
      '    hasBin: true',
      '',
      'snapshots:',
      '',
      "  '@fission-ai/openspec@1.6.0': {}",
      '',
    ].join('\n'),
  );

  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.cpSync(
    path.join(
      sourceRepositoryRoot,
      'node_modules/@fission-ai/openspec/schemas/spec-driven',
    ),
    path.join(packageDirectory, 'schemas/spec-driven'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: '@fission-ai/openspec',
        version: '1.6.0',
        type: 'module',
        bin: { openspec: './bin/openspec.js' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/openspec.js'),
    `import './runtime-helper.js';
import { applyFixtureArchiveSpecs } from './archive-helper.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[2] === 'init') {
  await import('./openspec-asset-init.mjs');
  process.exit(0);
}
if (process.argv[2] === '--version') {
  process.stdout.write('1.6.0\\n');
  process.exit(0);
}
if (process.argv[2] === 'schema') {
  const operation = process.argv[3];
  const schemaName = process.argv[4];
  const root = process.cwd();
  const packageRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const schemaPath = schemaName === 'spec-driven'
    ? path.join(packageRoot, 'schemas/spec-driven')
    : path.join(root, 'openspec/schemas', schemaName);
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify(operation === 'which'
    ? {
        name: schemaName,
        source: schemaName === 'spec-driven' ? 'package' : 'project',
        path: schemaPath,
        shadows: []
      }
    : { name: schemaName, path: schemaPath, valid: true, issues: [] }
  ));
  process.exit(0);
}
if (process.argv[2] === 'instructions') {
  const artifactId = process.argv[3];
  const changeId = process.argv[5];
  const schemaName = process.argv[7];
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const graph = [
    ['investigation', 'investigation.json', []],
    ['proposal', 'proposal.md', ['investigation']],
    ['specs', 'specs/**/*.md', ['proposal']],
    ['design', 'design.md', ['proposal']],
    ['tasks', 'tasks.md', ['specs', 'design']],
    ['guard', 'guard.json', ['tasks']],
    ['execution', 'execution.json', ['tasks']],
    ['plan-review', 'plan-review.json', ['guard', 'execution']]
  ];
  const artifact = graph.find(([id]) => id === artifactId);
  if (schemaName !== 'expense-app-v2' || !artifact) {
    process.stderr.write('unsupported fixture instructions');
    process.exit(2);
  }
  const exists = (id) => {
    const candidate = graph.find(([entryId]) => entryId === id);
    if (!candidate) return false;
    if (candidate[1] === 'specs/**/*.md') {
      return fs.existsSync(path.join(changeRoot, 'specs/demo/spec.md'));
    }
    return fs.existsSync(path.join(changeRoot, candidate[1]));
  };
  const outputPath = artifact[1];
  const resolvedOutputPath = path.join(changeRoot, outputPath);
  const existingOutputPaths = exists(artifactId)
    ? [outputPath === 'specs/**/*.md'
        ? path.join(changeRoot, 'specs/demo/spec.md')
        : resolvedOutputPath]
    : [];
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    artifactId,
    schemaName,
    changeDir: changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'spec-driven'
    },
    outputPath,
    resolvedOutputPath,
    existingOutputPaths,
    dependencies: artifact[2].map((id) => {
      const dependency = graph.find(([entryId]) => entryId === id);
      return {
        id,
        path: dependency[1],
        description: id + ' dependency',
        done: exists(id)
      };
    }),
    unlocks: graph
      .filter(([, , dependencies]) => dependencies.includes(artifactId))
      .map(([id]) => id)
      .sort(),
    instruction: 'Author the reviewed ' + artifactId + ' artifact.',
    template: artifactId === 'proposal' ? '# Proposal\\n' : '',
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'status') {
  const changeId = process.argv[4];
  const schemaName = process.argv[6];
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const gitDirectory = path.join(root, '.git');
  const lifecycleMutation = path.join(gitDirectory, 'mutate-on-lifecycle-start');
  const operationLock = path.join(
    gitDirectory,
    'workflow-engine/operations/repository-lifecycle.lock'
  );
  const checkMutation = path.join(gitDirectory, 'mutate-on-next-status');
  const statusCountdown = path.join(gitDirectory, 'mutate-status-countdown');
  const allowedStatusCountdown = path.join(
    gitDirectory,
    'mutate-allowed-status-countdown'
  );
  if (fs.existsSync(lifecycleMutation) && fs.existsSync(operationLock)) {
    fs.rmSync(lifecycleMutation);
    fs.writeFileSync(path.join(root, 'src/injected.ts'), 'export const injected = true;\\n');
  } else if (fs.existsSync(checkMutation)) {
    fs.rmSync(checkMutation);
    fs.writeFileSync(path.join(root, 'src/feature.ts'), 'export const injected = true;\\n');
  } else if (fs.existsSync(allowedStatusCountdown)) {
    const remaining = Number(fs.readFileSync(allowedStatusCountdown, 'utf8'));
    if (remaining <= 1) {
      fs.rmSync(allowedStatusCountdown);
      fs.appendFileSync(
        path.join(root, 'src/feature.ts'),
        'export const postCheckDrift = true;\\n'
      );
    } else {
      fs.writeFileSync(allowedStatusCountdown, String(remaining - 1));
    }
  } else if (fs.existsSync(statusCountdown)) {
    const remaining = Number(fs.readFileSync(statusCountdown, 'utf8'));
    if (remaining <= 1) {
      fs.rmSync(statusCountdown);
      fs.appendFileSync(path.join(changeRoot, 'proposal.md'), '\\nPost-stage mutation.\\n');
    } else {
      fs.writeFileSync(statusCountdown, String(remaining - 1));
    }
  }
  const legacyArtifacts = [
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')]],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')]],
    ['specs', 'specs/**/*.md', [path.join(changeRoot, 'specs/demo/spec.md')]],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')]],
    ['guard', 'guard.json', [path.join(changeRoot, 'guard.json')]]
  ];
  const v2Artifacts = [
    ['investigation', 'investigation.json', [path.join(changeRoot, 'investigation.json')]],
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')]],
    ['specs', 'specs/**/*.md', [path.join(changeRoot, 'specs/demo/spec.md')]],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')]],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')]],
    ['guard', 'guard.json', [path.join(changeRoot, 'guard.json')]],
    ['execution', 'execution.json', [path.join(changeRoot, 'execution.json')]],
    ['plan-review', 'plan-review.json', [path.join(changeRoot, 'plan-review.json')]]
  ];
  const artifacts = schemaName === 'expense-app-v2'
    ? v2Artifacts
    : legacyArtifacts;
  const dependencies = schemaName === 'expense-app-v2'
    ? {
        investigation: [],
        proposal: ['investigation'],
        specs: ['proposal'],
        design: ['proposal'],
        tasks: ['specs', 'design'],
        guard: ['tasks'],
        execution: ['tasks'],
        'plan-review': ['guard', 'execution']
      }
    : {
        proposal: [],
        design: [],
        specs: [],
        tasks: [],
        guard: []
      };
  const done = Object.fromEntries(artifacts.map(([id, , existingOutputPaths]) => [
    id,
    existingOutputPaths.some((candidate) => fs.existsSync(candidate))
  ]));
  const statuses = artifacts.map(([id, outputPath]) => {
    const missingDeps = dependencies[id].filter((dependency) => !done[dependency]);
    return {
      id,
      outputPath,
      status: done[id] ? 'done' : missingDeps.length === 0 ? 'ready' : 'blocked',
      ...(missingDeps.length === 0 ? {} : { missingDeps })
    };
  });
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    schemaName,
    changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'spec-driven'
    },
    artifactPaths: Object.fromEntries(artifacts.map(([id, outputPath, existingOutputPaths]) => [
      id,
      {
        outputPath,
        resolvedOutputPath: path.join(changeRoot, outputPath),
        existingOutputPaths: existingOutputPaths.filter((candidate) =>
          fs.existsSync(candidate)
        )
      }
    ])),
    artifacts: statuses,
    applyRequires: schemaName === 'expense-app-v2'
      ? ['investigation', 'tasks', 'guard', 'execution', 'plan-review']
      : ['tasks', 'guard'],
    isComplete: statuses.every(({ status }) => status === 'done'),
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'archive') {
  const changeId = process.argv[3];
  const expected = ['archive', changeId, '--yes', '--json'];
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
    process.stderr.write('unexpected archive argv');
    process.exit(2);
  }
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const deltaRoot = path.join(changeRoot, 'specs');
  const marker = fs.readFileSync(
    path.join(deltaRoot, 'demo/spec.md'),
    'utf8'
  );
  if (marker.includes('PARTIAL_FAILURE')) {
    process.stdout.write(JSON.stringify({
      archive: null,
      root: { path: root, source: 'nearest' },
      status: [{ code: 'archive_spec_update_failed' }]
    }));
    process.exit(1);
  }
  const applied = applyFixtureArchiveSpecs(root, changeId);
  const archiveName = new Date().toISOString().slice(0, 10) + '-' + changeId;
  const archivePath = path.join(root, 'openspec/changes/archive', archiveName);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.renameSync(changeRoot, archivePath);
  if (marker.includes('ARCHIVE_UNEXPECTED')) {
    fs.writeFileSync(path.join(root, 'unexpected.txt'), 'unexpected\\n');
  }
  process.stdout.write(JSON.stringify({
    archive: {
      change: changeId,
      archivedAs: archiveName,
      path: marker.includes('ARCHIVE_ESCAPE')
        ? path.join(root, '..', 'escape')
        : archivePath,
      specsUpdated: true,
      totals: applied.totals
    },
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'validate' && process.argv.includes('--specs')) {
  process.stdout.write(JSON.stringify({
    items: [{ id: 'demo', type: 'spec', valid: true, issues: [], durationMs: 1 }],
    summary: {
      totals: { items: 1, passed: 1, failed: 0 },
      byType: { spec: { items: 1, passed: 1, failed: 0 } }
    },
    version: '1.0',
    root: { path: process.cwd(), source: 'nearest' }
  }));
  process.exit(0);
}
const changeId = process.argv[3];
const changeRoot = path.join(process.cwd(), 'openspec/changes', changeId);
const invalid = fs.readFileSync(path.join(changeRoot, 'proposal.md'), 'utf8')
  .includes('INVALID');
const passed = invalid ? 0 : 1;
const failed = invalid ? 1 : 0;
process.stdout.write(JSON.stringify({
  items: [{
    id: changeId,
    type: 'change',
    valid: !invalid,
    issues: invalid
      ? [{ level: 'ERROR', path: 'proposal.md', message: 'invalid fixture' }]
      : [],
    durationMs: 1
  }],
  summary: {
    totals: { items: 1, passed, failed },
    byType: { change: { items: 1, passed, failed } }
  },
  version: '1.0',
  root: { path: process.cwd(), source: 'nearest' }
}));
process.exitCode = invalid ? 1 : 0;
`,
  );
  fs.copyFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/test/fixtures/openspec-assets/fake-openspec.mjs',
    ),
    path.join(packageDirectory, 'bin/openspec-asset-init.mjs'),
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/runtime-helper.js'),
    'export const fixtureRuntime = true;\n',
  );
  fs.copyFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/test/fixtures/fake-openspec-archive.mjs',
    ),
    path.join(packageDirectory, 'bin/archive-helper.js'),
  );
}

function installOpenSpecAssetFixture(repository: string): void {
  const templateRoot = openSpecAssetTemplate();
  for (const relativePath of [
    '.codex/skills',
    '.claude/skills',
    '.agents/skills',
    'workflow/openspec-assets',
  ]) {
    const destination = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(templateRoot, relativePath), destination, {
      recursive: true,
    });
  }
}

function openSpecAssetTemplate(): string {
  if (openSpecAssetTemplateRoot) return openSpecAssetTemplateRoot;

  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-openspec-asset-fixture-template-'),
  );
  try {
    writeJson(path.join(repository, 'package.json'), {
      name: 'workflow-openspec-asset-fixture-template',
      private: true,
      devDependencies: {},
    });
    for (const sourcePath of OPENSPEC_REPOSITORY_REVIEWED_SOURCES) {
      const destination = path.join(repository, sourcePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceRepositoryRoot, sourcePath), destination);
    }
    installFakeOpenSpec(repository);
    generateOpenSpecPlanningAssets(repository, {
      installationRepositoryRoot: repository,
      formatterRepositoryRoot: sourceRepositoryRoot,
    });
    openSpecAssetTemplateRoot = repository;
    process.once('exit', () => {
      fs.rmSync(repository, { recursive: true, force: true });
    });
    return repository;
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

export function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runtimeRoot(repository: string): string {
  return path.join(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
  );
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCanonicalJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`);
}
