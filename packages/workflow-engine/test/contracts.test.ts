import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from '../src/database-policy.ts';
import {
  loadChangeContract,
  parseExecutionArtifact,
  parseInvestigationArtifact,
  parsePlanReviewArtifact,
  parseTasks,
} from '../src/contracts.ts';
import {
  createConvergenceRecord,
  createDescendantReuseProof,
} from '../src/evidence-convergence.ts';
import {
  currentParentEvidenceRef,
  descendantReuseProofEvidenceRef,
} from '../src/evidence-reuse-path.ts';
import { createEvidenceNode } from '../src/evidence-node.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  assertPolicyPathInsideRepository,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizePolicyPath,
} from '../src/paths.ts';
import { workflowContractArtifactPaths } from '../src/contract-artifacts.ts';
import './archive-diagnostic-preservation.contract.test.ts';
import './archive-applicability-provenance.contract.test.ts';
import './assurance-assessment-chain.contract.test.ts';
import './declared-path-symbols.contract.test.ts';
import './class-disposition.contract.test.ts';
import './review-enforcement.contract.test.ts';
import './semantic-reuse.integration.test.ts';
import './semantic-ledger.contract.test.ts';
import './semantic-manifest-reuse.integration.test.ts';
import './scan-saturation-exit.integration.test.ts';
import './propose-scan-saturation-acceptance.integration.test.ts';
import './semantic-reconciliation.contract.test.ts';
import './evidence-reuse-path.contract.test.ts';
import './evidence-reuse-production.integration.test.ts';
import './implementation-reconciliation-finalization.integration.test.ts';
import './single-pass-finalize-command.integration.test.ts';
import './finalize-recovery-command.integration.test.ts';
import './task-diff-review.contract.test.ts';
import './task-diff-review-artifact.contract.test.ts';
import './task-diff-review-inspection.integration.test.ts';
import './task-diff-review-provider-output.contract.test.ts';
import './task-diff-review-provider-role.contract.test.ts';
import './task-diff-review-provider-worker.integration.test.ts';
import './task-strategy-provider-contract.test.ts';
import './floor-overflow-pruning.contract.test.ts';
import './class-sample-audit.contract.test.ts';
import './hit-predicate.contract.test.ts';
import './predicate-discrimination.contract.test.ts';
import './scan-hit-context-window.contract.test.ts';
import './assurance-inspection.integration.test.ts';
import './change-class-floors.contract.test.ts';
import './path-role-registry.contract.test.ts';
import './spec-delta-applicability.contract.test.ts';
import './spec-scenario-preservation.contract.test.ts';
import './git-security.test.ts';
import './openspec-adapter.integration.test.ts';
import './openspec-doctor.integration.test.ts';
import './openspec-schema-contract.integration.test.ts';
import './planning-transition.contract.test.ts';
import './openspec-planning-assets.integration.test.ts';
import './authority-attestation.contract.test.ts';
import './authority-relay-command.contract.test.ts';
import './authority-audit-cli.contract.test.ts';
import './authority-audit-ledger.contract.test.ts';
import './authority-audit-profile.contract.test.ts';
import './authority-audit-service.contract.test.ts';
import './authority-refusal-audit.contract.test.ts';
import './boundary-hardening.contract.test.ts';
import './maintainer-attestation.integration.test.ts';
import './ci-attestation.integration.test.ts';
import './evidence-node.contract.test.ts';
import './evidence-currentness.contract.test.ts';
import './execution-core.contract.test.ts';
import './execution-core-terminal-failures.contract.test.ts';
import './engine-projection-authority.integration.test.ts';
import './engine-metrics.contract.test.ts';
import './execution-governance.contract.test.ts';
import './execution-grant-cli.contract.test.ts';
import './execution-grant-mandate-audit.contract.test.ts';
import './execution-replacement.integration.test.ts';
import './execution-store.contract.test.ts';
import './external-effect-cli.contract.test.ts';
import './external-effect-grant.contract.test.ts';
import './external-effect-optional-ttl.contract.test.ts';
import './external-effect-reconciliation.contract.test.ts';
import './external-effect-refusal-audit.contract.test.ts';
import './human-resolution-supersede.contract.test.ts';
import './investigation-groups.contract.test.ts';
import './intervention-control-bootstrap.contract.test.ts';
import './intervention-control-cli.contract.test.ts';
import './intervention-control-persistence.contract.test.ts';
import './intervention-control.contract.test.ts';
import './intervention-adoption-grant-renewal.integration.test.ts';
import './maintainer-candidate-artifacts.contract.test.ts';
import './maintainer-candidate.contract.test.ts';
import './maintainer-grant-v2.contract.test.ts';
import './maintainer-post-approval-budget.integration.test.ts';
import './maintainer-grant-v2-reissue-cli.integration.test.ts';
import './maintainer-manifest.contract.test.ts';
import './plan-review.contract.test.ts';
import './provider-orchestration.contract.test.ts';
import './provider-invocation-supersession.contract.test.ts';
import './provider-retry-accounting.contract.test.ts';
import './protected-capabilities.contract.test.ts';
import './protected-capability-path-roles.contract.test.ts';
import './amend-plan-reopen.contract.test.ts';
import './amend-plan-trailers.contract.test.ts';
import './class-disposition-mounting.integration.test.ts';
import './class-sample-gating.integration.test.ts';
import './declared-path-symbol-floor.integration.test.ts';
import './execution-replacement-crash-window.integration.test.ts';
import './investigation-branch-rename.integration.test.ts';
import './floor-trimming.integration.test.ts';
import './legacy-provider-attempt-numbering.integration.test.ts';
import './legacy-provider-policy-lineage-gap.integration.test.ts';
import './legacy-provider-invocation-projection.integration.test.ts';
import './legacy-provider-output-schema-projection.integration.test.ts';
import './legacy-provider-residuals-projection.integration.test.ts';
import './plan-amendment-contribution.integration.test.ts';
import './planning-execution-epoch-recovery.integration.test.ts';
import './planning-workspace.integration.test.ts';
import './propose-planning-workspace.integration.test.ts';
import './open-task-atomic-ingress.integration.test.ts';
import './provider-retention-human-pin.contract.test.ts';
import './task-mandate-grant-budget.integration.test.ts';
import './provider-retention.contract.test.ts';
import './provider-retention-closure.integration.test.ts';
import './provider-runtime-registration.integration.test.ts';
import './retention-control.contract.test.ts';
import './semantic-reuse-reporting.integration.test.ts';
import './task-mandate.contract.test.ts';
import './unified-cli-routing.contract.test.ts';
import './adaptive-class-sample-gate.integration.test.ts';
import './amend-plan-change-option.integration.test.ts';
import './amend-plan-state-gate.integration.test.ts';
import './archive-applicability-current-tree.integration.test.ts';
import './archive-applicability-public-projection.integration.test.ts';
import './archive-diagnostic-budget.integration.test.ts';
import './archive-utc-midnight-rollover.integration.test.ts';
import './assurance-floor-propose.integration.test.ts';
import './class-sample-audit-duplicate.integration.test.ts';
import './control-plane-initial-supervisor-bootstrap.integration.test.ts';
import './control-plane-promotion-material-binding.integration.test.ts';
import './control-plane-promotion-producer.integration.test.ts';
import './control-plane-recovery-grant.integration.test.ts';
import './control-plane-refusal-audit.integration.test.ts';
import './control-plane-successive-promotion-lineage.integration.test.ts';
import './control-plane-successive-promotion-production.integration.test.ts';
import './control-plane-supervisor-history-crash.integration.test.ts';
import './control-plane-v2-sidecar-pin.integration.test.ts';
import './epoch-carry-forward-manifest.integration.test.ts';
import './epoch-transition-retention-maintenance.integration.test.ts';
import './execution-workflow-blocker-projection.integration.test.ts';
import './floor-overflow-production-closure.integration.test.ts';
import './intervention-parent-pause-fence.integration.test.ts';
import './intervention-sidecar-public-replay.integration.test.ts';
import './intervention-sidecar-session.integration.test.ts';
import './intervention-sidecar-workflow-binding.integration.test.ts';
import './maintainer-evidence-waiver-security.integration.test.ts';
import './maintainer-evidence-waiver.integration.test.ts';
import './planning-r6-review-coverage.integration.test.ts';
import './planning-shadow-metrics.integration.test.ts';
import './provider-lease-expiry-retry.integration.test.ts';
import './provider-semantic-contract-rollover.integration.test.ts';
import './provider-strategy-change.integration.test.ts';
import './recovery-authority-cli.integration.test.ts';
import './recovery-authority-descriptor.integration.test.ts';
import './recovery-quarantine.integration.test.ts';
import './recovery-trust-root-restore.integration.test.ts';
import './recovery-trust-root-restore-cli.integration.test.ts';
import './semantic-ledger-propose.integration.test.ts';
import './spec-delta-shared-applicability.integration.test.ts';
import './spec-delta-transition-enforcement.integration.test.ts';
import './unified-plan-capability-path-roles.contract.test.ts';
import { createFixtureRepository, writeV2ChangeArtifacts } from './fixture.ts';

test('maintainer policy is a pinned workflow contract artifact', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const artifacts = workflowContractArtifactPaths(repositoryRoot).map(
    (artifact) => path.relative(repositoryRoot, artifact),
  );

  assert.ok(artifacts.includes('workflow/maintainer-policy.json'));
  assert.ok(
    artifacts.includes('workflow/schemas/maintainer-policy.schema.json'),
  );
  assert.ok(
    artifacts.includes('workflow/schemas/maintainer-grant.schema.json'),
  );
  assert.ok(
    artifacts.includes('workflow/schemas/authority-attestation.schema.json'),
  );
});

test('runner security suite is portable to the package working directory', () => {
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--test',
      'test/runner-package-security.integration.test.ts',
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== 'NODE_TEST_CONTEXT',
        ),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
});

test('workflow assurance checks out an ordinary apps/web directory without gitlink compatibility', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const webEntries = execFileSync(
    'git',
    ['ls-files', '--stage', '--', 'apps/web'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean);

  for (const entry of webEntries) {
    assert.doesNotMatch(
      entry,
      /^160000\s/,
      `apps/web must not contain a gitlink: ${entry}`,
    );
  }
  assert.ok(
    fs.existsSync(path.join(repositoryRoot, 'apps/web/README.md')),
    'apps/web must contain its ordinary-directory placeholder',
  );

  const workflow = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../../.github/workflows/workflow-assurance.yml',
    ),
    'utf8',
  );

  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  );
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /retained gitlink/i);
  assert.doesNotMatch(workflow, /transient gitlink/i);
  assert.doesNotMatch(workflow, /\.gitmodules/);
  assert.doesNotMatch(workflow, /clean: false/);

  const checkout = workflow.indexOf('- name: Checkout exact PR head');
  const verify = workflow.indexOf('- name: Recompute workflow assurance');
  assert.ok(checkout >= 0);
  assert.ok(checkout < verify);
});

test('format verification delegates to the registered canonical authority', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    manifest.scripts['format:check'],
    'pnpm workflow run-check workflow-format --json',
  );

  const formatWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/format.yml'),
    'utf8',
  );
  assert.match(formatWorkflow, /run: pnpm run format:check/);
  assert.doesNotMatch(formatWorkflow, /prettier\s+--check/);

  const checks = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'workflow/checks.json'), 'utf8'),
  );
  const registeredFormat = checks.checks['workflow-format'];
  const assetSeparatedFormatCommand = [
    'node-package-bin',
    '.',
    'prettier',
    'prettier',
    '--check',
    'packages/workflow-engine',
    'workflow/ai-adapter-policy.json',
    'workflow/checks.json',
    'workflow/ci-policy.json',
    'workflow/config.json',
    'workflow/document-policy.json',
    'workflow/maintainer-policy.json',
    'workflow/schemas',
    'apps/api/src/__tests__/setup/datasource.factory.ts',
    'apps/api/src/__tests__/setup/database-target-policy.ts',
    'apps/api/src/__tests__/isolated/database-target-policy.isolated.spec.ts',
    'package.json',
    'pnpm-workspace.yaml',
    'docs/README.md',
    'docs/ROADMAP.md',
    'docs/CURRENT_AND_NEXT_STEPS.md',
    'docs/DOCUMENT_STRUCTURE_GUIDE.md',
    'docs/WORKFLOW.md',
    'AGENTS.md',
  ];
  assert.equal(registeredFormat?.destructiveDatabase, false);
  assert.deepEqual(registeredFormat?.command, assetSeparatedFormatCommand);
});

test('repository exposes only reviewed OpenSpec planning skills', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agentSkillsRoot = path.join(repositoryRoot, '.agents/skills');
  const skillNames = fs
    .readdirSync(agentSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, ['openspec-explore', 'openspec-propose']);
  for (const skillName of skillNames) {
    const agentSkill = fs.readFileSync(
      path.join(agentSkillsRoot, skillName, 'SKILL.md'),
      'utf8',
    );
    const canonicalSkill = fs.readFileSync(
      path.join(repositoryRoot, '.codex/skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assert.equal(agentSkill, canonicalSkill, `${skillName} mirror drifted`);
  }

  const nestedSpectraMetadata = fs
    .readdirSync(path.join(repositoryRoot, 'openspec'), { recursive: true })
    .filter((entry) => path.basename(entry.toString()) === '.spectra.yaml');
  assert.deepEqual(nestedSpectraMetadata, []);

  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const maintenance = fs.readFileSync(
    path.join(repositoryRoot, '.agents/README.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );
  assert.doesNotMatch(agents, /spectra/i);
  assert.match(agents, /`openspec-explore`/);
  assert.match(agents, /`openspec-propose`/);
  assert.match(maintenance, /^# OpenSpec skill mirror maintenance/m);
  assert.doesNotMatch(maintenance, /spectra update/i);
  assert.match(roadmap, /retained root Spectra configuration historical-only/);
  assert.doesNotMatch(roadmap, /Keep Spectra installed/);
});

test('agent guide documents the complete public workflow surface and source-size rule', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const commands = [
    'pnpm workflow doctor',
    'pnpm workflow validate-change',
    'pnpm workflow plan-commit',
    'pnpm workflow run-check',
    'pnpm workflow archive',
    'pnpm workflow openspec-assets generate',
    'pnpm workflow openspec-assets check',
    'pnpm workflow openspec-assets install-prompts',
    'pnpm workflow start',
    'pnpm workflow status',
    'pnpm workflow check',
    'pnpm workflow ci',
    'pnpm workflow adapter evaluate',
    'pnpm workflow issue add',
    'pnpm workflow issue update',
    'pnpm workflow issue close',
    'pnpm workflow issue render',
    'pnpm workflow issue validate',
    'pnpm workflow maintainer grant',
    'pnpm workflow maintainer inspect',
    'pnpm workflow maintainer revoke',
    'pnpm workflow authority-start',
    'pnpm workflow authority-check',
    'pnpm workflow authority-commit',
    'pnpm workflow authority-recover',
    'pnpm workflow authority-abort',
    'pnpm workflow documents validate',
    'pnpm workflow document-refresh propose',
    'pnpm workflow document-refresh show',
    'pnpm workflow document-refresh review',
    'pnpm workflow document-refresh apply',
    'pnpm workflow handoff validate',
    'pnpm workflow hook pre-commit',
    'pnpm workflow hook commit-msg',
    'pnpm workflow hook pre-push',
    'pnpm workflow hook post-merge',
    'pnpm workflow complete-task',
    'pnpm workflow finish',
    'pnpm workflow rollback-completion',
    'pnpm workflow commit',
    'pnpm workflow abort',
  ];

  for (const command of commands) {
    assert.match(agents, new RegExp(command.replaceAll(' ', '\\s+')));
  }
  assert.doesNotMatch(agents, /pnpm workflow handoff render/);
  assert.match(
    agents,
    /Do not change, split, or refactor source\s+solely because it exceeds 500 lines\./,
  );
  assert.doesNotMatch(agents, /keep files under 500 LOC/i);
});

test('public guidance exposes the investigation-first and projected single-pass boundaries', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );

  for (const surface of [agents, workflow]) {
    assert.match(surface, /pnpm workflow propose/);
    assert.match(surface, /pnpm workflow finalize-task/);
  }
  assert.match(workflow, /implementation \+ checkbox \+ handoff/i);
  assert.match(
    workflow,
    /(?:checked\s+tree[\s\S]{0,160}staged\s+tree|stages only[\s\S]{0,160}checked\s+tree)/i,
  );
  assert.match(workflow, /caught ordinary failure/i);
  assert.match(
    workflow,
    /legacy[\s\S]{0,240}check[\s\S]{0,120}complete-task[\s\S]{0,120}finish/i,
  );
  assert.match(workflow, /commit[\s\S]{0,120}separate/i);
  assert.match(workflow, /must not rerun required checks/i);
  assert.match(roadmap, /T2\.3[\s\S]{0,160}exact-diff AI review/i);
  assert.match(roadmap, /T2\.3[\s\S]{0,240}crash-safe[\s\S]{0,80}finalize/i);
  assert.match(roadmap, /T2\.3[\s\S]{0,240}commit transaction/i);
  assert.match(roadmap, /T2\.4[\s\S]{0,120}exact-byte[\s\S]{0,80}closure/i);
});

test('public guidance preserves the assurance registry and keeps exemptions distinct', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  const expectedClaims = [
    [
      '`C-TERM-SCAN`',
      'Every currently effective sealed term was scanned under the governed scan policy',
      'Hard',
      'T1.5 sealed-investigation branch',
    ],
    [
      '`C-TERM-SUPERSESSION`',
      'Engine-floor terms cannot be removed; an agent term leaves the effective set only by reviewed, reasoned, audit-visible supersession',
      'Hard engine floor; audit-monotone but correctable agent contribution',
      'T1.5',
    ],
    [
      '`C-TERM-COMPLETENESS`',
      'The effective term set is semantically complete',
      'Soft and not provable',
      'Residual, never delivered as hard',
    ],
    [
      '`C-REVIEW-CURRENT`',
      'A review artifact exists, is immutable, and is current for its exact target',
      'Hard',
      'T1.5',
    ],
    [
      '`C-REVIEW-JUDGMENT`',
      'The reviewer judgment is correct',
      'Soft',
      'Human/agent judgment',
    ],
    [
      '`C-WHY-BINDING`',
      'Every required WHY field exists and is bound to exact source blobs',
      'Hard structure',
      'T1.5 sealed-investigation branch',
    ],
    [
      '`C-WHY-TRUTH`',
      'The WHY explanation is true or proves understanding',
      'Soft',
      'Human/agent judgment',
    ],
    [
      '`C-ARTIFACT-ORDER`',
      'Authoritative design materialization follows sealed investigation inputs',
      'Hard artifact order; cognition order is not proved',
      'T1.5 when investigation applies; exemption is separately labeled',
    ],
    [
      '`C-SEMANTIC-INJECTION`',
      '`proposedTerms` is the only review-to-lifecycle semantic cost injection path and stays within aggregate budgets',
      'Hard structural choke point and budgets; semantic usefulness is soft',
      'T1.5',
    ],
    [
      '`C-EXACT-CLOSURE`',
      'Exact declared bytes are absent from the governed live closure scope',
      'Hard',
      'Future T2.4 mechanical closure; not delivered by T1.5',
    ],
    [
      '`C-GRAPH-COMPLETENESS`',
      'All semantic consumers and dependency edges have been found',
      'Soft and not proved by grep or declared DAG structure',
      'Residual, never delivered as hard',
    ],
    [
      '`C-CANONICALIZATION`',
      'Canonical subjects preserve every assurance-relevant distinction',
      'Tested and fail-closed; residual implementation risk remains',
      'T1.5 for planning subjects; later owners extend their subjects',
    ],
    [
      '`C-COVERAGE-COMPOSITION`',
      'Composed review manifests cover exactly the claimed subject',
      'Hard algorithm over declared facts; semantic adequacy is soft',
      'Future T2.3; not delivered by T1.5',
    ],
    [
      '`C-CONVERGENCE`',
      'A reused descendant has a complete valid proof path to the current generation',
      'Hard validator over declared graph; proof/canonicalizer defects remain residual',
      'T1.5',
    ],
    [
      '`C-PROVIDER-IDENTITY`',
      'Local provider identity from runtime hints or adapter assignment',
      'Soft',
      'T1.5 records assurance only',
    ],
    [
      '`C-CONTAINMENT`',
      'A local provider is confined against the same OS user',
      'Soft without stronger isolation',
      'Not delivered as hard',
    ],
    [
      '`C-DEGRADED-INDEPENDENCE`',
      'A collaboration grant recreates missing provider independence',
      'False; grant authorizes only visible degradation',
      'T1.5',
    ],
    [
      '`C-AVAILABILITY`',
      'The ordinary two-provider path meets wait, grant, latency, and cost budgets',
      'Empirical pilot claim',
      'T1.5 pilot, never structural proof',
    ],
  ];

  const registry = workflow.match(
    /### Stable assurance claim registry\n([\s\S]*?)\n## Managed Task Lifecycle/,
  );
  assert.notEqual(registry, null);
  const actualClaims = registry![1]!
    .split('\n')
    .filter((line) => /^\|\s*`C-[A-Z-]+`\s*\|/.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  assert.deepEqual(actualClaims, expectedClaims);
  assert.match(agents, /stable\s+claim-ID\/hardness registry/i);
  assert.match(agents, /do not invent a stronger synonym/i);
  assert.match(workflow, /investigation exemption/i);
  assert.match(workflow, /task-execution exemption/i);
  assert.match(
    workflow,
    /C-TERM-SCAN[\s\S]{0,120}C-WHY-BINDING[\s\S]{0,120}inapplicable/i,
  );
  assert.match(
    workflow,
    /task-execution exemption[\s\S]{0,160}does not[\s\S]{0,120}investigation exemption/i,
  );
  assert.match(
    workflow,
    /investigation exemption[\s\S]{0,180}PlanReview[\s\S]{0,120}checks[\s\S]{0,120}Git/i,
  );
  for (const boundary of [
    /semantic completeness[\s\S]{0,120}(?:soft|not proved)/i,
    /WHY truth[\s\S]{0,120}(?:soft|not proved)/i,
    /provider identity[\s\S]{0,120}(?:soft|not cryptographic)/i,
    /same-user containment[\s\S]{0,120}(?:soft|not proved)/i,
    /reviewer judgment[\s\S]{0,120}(?:soft|not proved)/i,
    /semantic closure[\s\S]{0,120}(?:not delivered|T2\.4)/i,
    /degraded[\s\S]{0,160}does not recreate[\s\S]{0,80}independence/i,
    /availability[\s\S]{0,160}empirical[\s\S]{0,120}not structural/i,
    /projected single-pass[\s\S]{0,500}(?:not crash-safe|not fully atomic)/i,
  ]) {
    assert.match(workflow, boundary);
  }
});

test('the public asset CLI exposes only the tool-plural command', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const cliPath = path.join(
    repositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, ...args, '--json'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

  const current = run(['openspec-assets', 'check']);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).command, 'openspec-assets');

  const legacy = run(['codex-assets', 'check']);
  assert.equal(legacy.status, 2);
  assert.equal(JSON.parse(legacy.stderr).error.code, 'INVALID_USAGE');

  const help = run(['help']);
  assert.equal(help.status, 0, help.stderr);
  const usage = JSON.parse(help.stdout).usage as string;
  assert.match(usage, /pnpm workflow openspec-assets/);
  assert.doesNotMatch(usage, /pnpm workflow codex-assets/);
});

test('the retired Codex-only asset implementation and home are absent', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  for (const retiredPath of [
    'packages/workflow-engine/src/codex-planning-asset-contract.ts',
    'packages/workflow-engine/src/codex-planning-assets.ts',
    'packages/workflow-engine/test/codex-planning-assets.integration.test.ts',
    'workflow/codex-assets',
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, retiredPath)),
      false,
      `${retiredPath} must not remain as a compatibility surface`,
    );
  }
});

test('break-glass maintainer operator contract is complete and bootstrap-only', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );

  for (const command of [
    'pnpm workflow maintainer grant',
    'pnpm workflow maintainer attest',
    'pnpm workflow maintainer attestation-relay',
    'pnpm workflow maintainer inspect',
    'pnpm workflow maintainer revoke',
    'pnpm workflow authority-start',
    'pnpm workflow authority-check',
    'pnpm workflow authority-commit',
    'pnpm workflow authority-recover',
    'pnpm workflow authority-abort',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(' ', '\\s+')));
  }

  assert.match(workflow, /controlling interactive terminal/i);
  assert.match(workflow, /git config --local gpg\.format ssh/);
  assert.match(workflow, /git config --local user\.signingkey/);
  assert.match(workflow, /workflow-grant\/\*\*/);
  assert.match(workflow, /workflow-attestation\/\*\*/);
  assert.match(workflow, /migration gate/i);
  assert.match(workflow, /protected environment/i);
  assert.match(workflow, /one-way/i);
  assert.match(workflow, /repository-admin, out-of-band/i);
  assert.match(roadmap, /bootstrap-only/i);
  assert.match(roadmap, /workflow-grant\/\*\*/);
  assert.match(roadmap, /workflow-attestation\/\*\*/);
  assert.match(roadmap, /protected environment/i);
});

test('documentation entry point is a project overview and archive policy remains immutable', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const readme = fs.readFileSync(
    path.join(repositoryRoot, 'docs/README.md'),
    'utf8',
  );
  const gitignore = fs.readFileSync(
    path.join(repositoryRoot, '.gitignore'),
    'utf8',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'workflow/document-policy.json'),
      'utf8',
    ),
  ) as { documents: Record<string, unknown> };

  assert.match(readme, /^# Expense App$/m);
  assert.match(readme, /React Native/);
  assert.match(readme, /NestJS/);
  assert.match(readme, /apps\/web/);
  assert.match(readme, /DOCUMENT_STRUCTURE_GUIDE\.md/);
  assert.doesNotMatch(readme, /^# Documentation Entry Point$/m);
  assert.doesNotMatch(readme, /^## Target Structure$/m);
  assert.match(gitignore, /^\/memo\/$/m);

  assert.deepEqual(documentPolicy.documents['docs/archive/**'], {
    mode: 'immutable',
    enforcement: 'planned',
  });
  assert.ok(documentPolicy.documents['docs/ROADMAP.md']);
  assert.ok(documentPolicy.documents['openspec/specs/**']);
  assert.ok(documentPolicy.documents['openspec/changes/**']);
});

test('legacy documents exist only under the immutable archive boundary', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const gitignore = fs.readFileSync(
    path.join(repositoryRoot, '.gitignore'),
    'utf8',
  );
  const legacyPaths = [
    'DEVELOPER_NOTE.md',
    'GUIDE-JAVASCRIPT_WEB_DEVELOPMENT_BASICS.md',
    'GUIDE-LOG_TRACKING.md',
    'PROJECT_EVALUATION_REPORT.md',
    'REQUIREMENT_LOG.md',
    'UPDATE_CHECKLIST.md',
    'logs/COMMIT_LOG.md',
    'logs/LOG-PHASE3_TESTING_REPORT.md',
    'logs/LOG-SESSION_2025_09_19.md',
    'logs/LOG-SESSION_2025_09_19_DOCUMENTATION_OPTIMIZATION.md',
    'logs/LOG-SESSION_2025_09_19_TESTING.md',
    'logs/LOG-SESSION_2025_09_19_TESTING_FIXES.md',
    'logs/LOG-SESSION_2025_09_21.md',
    'logs/LOG-SESSION_2025_09_23_IDENTITY_PHASE.md',
    'logs/LOG-SESSION_2025_09_25.md',
    'logs/LOG-SESSION_2025_09_26.md',
    'planning/PLAN-DOCUMENTATION_STRUCTURE_V2.md',
    'planning/PLAN-EXECUTABLE_AI_WORKFLOW_ENGINE.md',
    'planning/PLAN-MOBILE_E2E_TEST_MIGRATION.md',
    'planning/PLAN-PHASE_2_API_DEVELOPMENT.md',
    'planning/PLAN-TASK_2.2_API_ENDPOINTS.md',
    'planning/PLAN-TASK_2.2_IMPLEMENTATION.md',
    'planning/PLAN-TASK_2.3_AUTH_INTEGRATION.md',
    'planning/PLAN-TDD_API_IMPLEMENTATION.md',
    'planning/PLAN-TDD_DATABASE_DESIGN.md',
    'planning/ROADMAP.md',
    'planning/mobile-app-analysis.md',
    'planning/✅ NEXT_STEPS_STRATEGIC_PLAN.md',
    'status/STATUS-CURRENT_AND_NEXT_STEPS.md',
    'status/STATUS-E2E_IMPLEMENTATION.md',
    'status/STATUS-RESUME_AUDIT_2026_03_03.md',
    'template/ARCHITECTURE_DECISION_RECORDS.md',
    'template/PERFORMANCE_METRICS.md',
    'template/RISK_ASSESSMENT.md',
    'template/TOOL_INTEGRATION_GUIDE.md',
  ];

  assert.match(gitignore, /^\/legacy\/$/m);
  assert.doesNotMatch(gitignore, /^legacy\/$/m);
  for (const legacyPath of legacyPaths) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, 'docs', legacyPath)),
      false,
      `legacy source still exists: docs/${legacyPath}`,
    );
    assert.equal(
      fs.existsSync(
        path.join(repositoryRoot, 'docs/archive/legacy', legacyPath),
      ),
      true,
      `archived copy is missing: docs/archive/legacy/${legacyPath}`,
    );
  }
});

test('parseTasks reads ordered checkbox tasks', () => {
  const tasks = parseTasks(`
# Tasks

- [ ] 1.1 Add failing test
- [x] 1.2 Implement behavior
`);

  assert.deepEqual(tasks, [
    { id: '1.1', completed: false, title: 'Add failing test' },
    { id: '1.2', completed: true, title: 'Implement behavior' },
  ]);
});

test('change contracts preserve legacy loading and strictly load v2 engine artifacts', () => {
  const repository = createFixtureRepository();
  try {
    const legacy = loadChangeContract(repository, 'demo-change');
    assert.equal(
      loadChangeContract(
        path.relative(process.cwd(), repository),
        'demo-change',
      ).schemaName,
      'expense-app',
    );
    assert.equal(legacy.schemaName, 'expense-app');
    assert.equal(legacy.investigation, undefined);
    assert.equal(legacy.execution, undefined);
    assert.equal(legacy.planReview, undefined);

    const metadataPath = path.join(
      repository,
      'openspec/changes/demo-change/.openspec.yaml',
    );
    fs.writeFileSync(metadataPath, 'schema: spec-driven\n');
    assert.equal(
      loadChangeContract(repository, 'demo-change').schemaName,
      'spec-driven',
    );
    fs.writeFileSync(
      metadataPath,
      'schema: spec-driven\ncreated: 2026-07-15\n',
    );
    assert.equal(
      loadChangeContract(repository, 'demo-change').schemaName,
      'spec-driven',
    );
    fs.writeFileSync(
      metadataPath,
      'schema: expense-app\ncreated: 2026-07-15\n',
    );

    const artifacts = writeV2ChangeArtifacts(repository);
    const v2 = loadChangeContract(repository, 'demo-change');
    assert.equal(v2.schemaName, 'expense-app-v2');
    assert.deepEqual(v2.investigation, artifacts.investigation);
    assert.deepEqual(v2.execution, artifacts.execution);
    assert.deepEqual(v2.planReview, artifacts.planReview);
    for (const artifact of [
      'investigation.json',
      'execution.json',
      'plan-review.json',
    ]) {
      assert.ok(
        v2.artifactPaths.includes(
          path.join(repository, 'openspec/changes/demo-change', artifact),
        ),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('raw change loading rejects final and ancestor metadata symlink escapes', () => {
  for (const escape of ['metadata', 'change-directory'] as const) {
    const repository = createFixtureRepository();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-metadata-outside-'),
    );
    try {
      const changeDirectory = path.join(
        repository,
        'openspec/changes/demo-change',
      );
      if (escape === 'metadata') {
        const metadataPath = path.join(changeDirectory, '.openspec.yaml');
        const outsideMetadata = path.join(outside, '.openspec.yaml');
        fs.writeFileSync(
          outsideMetadata,
          'schema: expense-app\ncreated: 2026-07-15\n',
        );
        fs.rmSync(metadataPath);
        fs.symlinkSync(outsideMetadata, metadataPath);
      } else {
        const outsideChange = path.join(outside, 'demo-change');
        fs.renameSync(changeDirectory, outsideChange);
        fs.symlinkSync(outsideChange, changeDirectory, 'dir');
      }
      assert.throws(
        () => loadChangeContract(repository, 'demo-change'),
        (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_TREE_UNSAFE'),
        escape,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('raw change loading rejects the reserved archive container', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => loadChangeContract(repository, 'archive'),
      (error) => isWorkflowError(error, 'PLANNING_CHANGE_ID_RESERVED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('engine artifact validators reject noncanonical, forged, over-keyed, and scope-expanding inputs', () => {
  const repository = createFixtureRepository();
  try {
    const { investigation, execution, planReview } =
      writeV2ChangeArtifacts(repository);
    assert.deepEqual(
      parseInvestigationArtifact(investigation, 'demo-change'),
      investigation,
    );
    assert.deepEqual(
      parseExecutionArtifact(
        execution,
        'demo-change',
        loadChangeContract(repository, 'demo-change').tasks,
        loadChangeContract(repository, 'demo-change').guard,
        loadChangeContract(repository, 'demo-change').checks,
        loadChangeContract(repository, 'demo-change').behaviorContracts,
      ),
      execution,
    );
    assert.deepEqual(
      parsePlanReviewArtifact(planReview, 'demo-change'),
      planReview,
    );

    const forgedInvestigation = structuredClone(investigation);
    forgedInvestigation.nodes[0]!.resultDigest = 'f'.repeat(64);
    assert.throws(
      () => parseInvestigationArtifact(forgedInvestigation, 'demo-change'),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    assert.throws(
      () =>
        parseInvestigationArtifact(
          { ...investigation, unexpected: true },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    assert.throws(
      () =>
        parsePlanReviewArtifact(
          { ...planReview, changeId: 'another-change' },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
    );
    assert.throws(
      () =>
        parseInvestigationArtifact(
          {
            ...investigation,
            nodes: [investigation.nodes[0], investigation.nodes[0]],
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    assert.throws(
      () =>
        parsePlanReviewArtifact(
          {
            ...planReview,
            currentRefs: { planReview: '9'.repeat(64) },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
    );
    assert.throws(
      () =>
        parseInvestigationArtifact(
          { ...investigation, legacyMigration: true },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const namedMigration = {
      ...investigation,
      changeId: 'establish-investigation-first-planning',
      legacyMigration: true,
    };
    assert.deepEqual(
      parseInvestigationArtifact(
        namedMigration,
        'establish-investigation-first-planning',
      ),
      namedMigration,
    );
    const orphan = createEvidenceNode({
      type: 'fixture-orphan',
      nodeSchema: 'fixture.orphan.v1',
      evaluator: 'fixture.orphan.v1',
      policyDigest: '6'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { parent: '7'.repeat(64) },
      provenanceParentNodeIds: { parent: '8'.repeat(64) },
      outputSchema: 'fixture.orphan-output.v1',
      output: { valid: false },
      runtimeMetadata: {},
    });
    assert.throws(
      () =>
        parseInvestigationArtifact(
          {
            ...investigation,
            nodes: [orphan],
            currentRefs: { sealedInvestigation: orphan.nodeId },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const parent = investigation.nodes[0]!;
    const mismatchedRoles = createEvidenceNode({
      type: 'fixture-child',
      nodeSchema: 'fixture.child.v1',
      evaluator: 'fixture.child.v1',
      policyDigest: '6'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { semantic: parent.resultDigest },
      provenanceParentNodeIds: { provenance: parent.nodeId },
      outputSchema: 'fixture.child-output.v1',
      output: { valid: false },
      runtimeMetadata: {},
    });
    assert.throws(
      () =>
        parseInvestigationArtifact(
          {
            ...investigation,
            nodes: [parent, mismatchedRoles].sort((left, right) =>
              left.nodeId.localeCompare(right.nodeId),
            ),
            currentRefs: { sealedInvestigation: mismatchedRoles.nodeId },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const forgedParentResult = createEvidenceNode({
      type: 'fixture-child',
      nodeSchema: 'fixture.child.v1',
      evaluator: 'fixture.child.v1',
      policyDigest: '6'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { parent: '7'.repeat(64) },
      provenanceParentNodeIds: { parent: parent.nodeId },
      outputSchema: 'fixture.child-output.v1',
      output: { valid: false },
      runtimeMetadata: {},
    });
    assert.throws(
      () =>
        parseInvestigationArtifact(
          {
            ...investigation,
            nodes: [parent, forgedParentResult].sort((left, right) =>
              left.nodeId.localeCompare(right.nodeId),
            ),
            currentRefs: { sealedInvestigation: forgedParentResult.nodeId },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const oldParent = createEvidenceNode({
      type: 'fixture-parent',
      nodeSchema: 'fixture.parent.v1',
      evaluator: 'fixture.parent.v1',
      policyDigest: 'a'.repeat(64),
      exactInputDigests: { source: 'b'.repeat(64) },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'fixture.parent-output.v1',
      output: { equivalent: true },
      runtimeMetadata: {},
    });
    const newParent = createEvidenceNode({
      type: 'fixture-parent',
      nodeSchema: 'fixture.parent.v1',
      evaluator: 'fixture.parent.v1',
      policyDigest: 'a'.repeat(64),
      exactInputDigests: { source: 'c'.repeat(64) },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'fixture.parent-output.v1',
      output: { equivalent: true },
      runtimeMetadata: {},
    });
    const descendant = createEvidenceNode({
      type: 'fixture-descendant',
      nodeSchema: 'fixture.descendant.v1',
      evaluator: 'fixture.descendant.v1',
      policyDigest: 'd'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { source: oldParent.resultDigest },
      provenanceParentNodeIds: { source: oldParent.nodeId },
      outputSchema: 'fixture.descendant-output.v1',
      output: { valid: true },
      runtimeMetadata: {},
    });
    const convergence = createConvergenceRecord({
      oldParent,
      newParent,
      validatorVersion: 'evidence-currentness.v1',
      runtimeMetadata: {},
    });
    const reuseProof = createDescendantReuseProof({
      descendant,
      parentRole: 'source',
      oldParent,
      newParent,
      convergenceRecord: convergence,
      validatorVersion: 'evidence-currentness.v1',
      runtimeMetadata: {},
    });
    const artifactWithReuse = {
      ...investigation,
      nodes: [oldParent, newParent, descendant, convergence, reuseProof].sort(
        (left, right) => left.nodeId.localeCompare(right.nodeId),
      ),
      currentRefs: {
        sealedInvestigation: descendant.nodeId,
        [currentParentEvidenceRef(descendant.nodeId, 'source')]:
          newParent.nodeId,
        [descendantReuseProofEvidenceRef(descendant.nodeId, 'source')]:
          reuseProof.nodeId,
      },
    };
    assert.deepEqual(
      parseInvestigationArtifact(artifactWithReuse, 'demo-change'),
      artifactWithReuse,
    );

    const expandedExecution = structuredClone(execution);
    expandedExecution.tasks['1.1']!.allowedPaths = ['outside/**'];
    const contract = loadChangeContract(repository, 'demo-change');
    assert.throws(
      () =>
        parseExecutionArtifact(
          expandedExecution,
          'demo-change',
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const investigationPath = path.join(
      repository,
      'openspec/changes/demo-change/investigation.json',
    );
    fs.writeFileSync(
      investigationPath,
      `${JSON.stringify(investigation, null, 2)}\n`,
    );
    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('execution artifacts use one exact strategy variant per task without claiming execution', () => {
  const repository = createFixtureRepository();
  try {
    writeV2ChangeArtifacts(repository);
    const contract = loadChangeContract(repository, 'demo-change');
    const common = {
      enforcement: 'planned' as const,
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
      diffReview: 'required' as const,
    };
    const transformationContract = {
      rule: 'Rename the reviewed symbol exactly.',
      examples: [{ before: 'OLD_NAME', after: 'NEW_NAME' }],
      fileScopes: ['src/features/**'],
      oldTerms: [{ kind: 'symbol' as const, value: 'OLD_NAME' }],
      replacementTerms: [{ kind: 'symbol' as const, value: 'NEW_NAME' }],
      redInapplicableReason:
        'Exact-byte closure and registered checks specify this codemod.',
    };
    const variants = [
      {
        ...common,
        strategy: 'cross-agent-tdd' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: null,
          },
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['src/__tests__/**'],
        fixturePathScopes: ['src/__tests__/fixtures/**'],
        implementationPathScopes: ['src/features/**'],
        redCheck: 'fixture',
        greenChecks: ['fixture'],
        requiredImplementerIndependence: 'provider-independent' as const,
      },
      {
        ...common,
        strategy: 'mechanical-transform' as const,
        transformationContract,
      },
      {
        ...common,
        strategy: 'direct-reviewed' as const,
        exemptionKind: 'documentation-only' as const,
        exemptionReason: 'Only authored documentation changes.',
        legacyBootstrap: null,
      },
      {
        ...common,
        strategy: 'tdd-single-agent' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['src/__tests__/**'],
        fixturePathScopes: ['src/__tests__/fixtures/**'],
        implementationPathScopes: ['src/features/**'],
        redCheck: 'fixture',
        greenChecks: ['fixture'],
        requiredImplementerIndependence: 'none' as const,
      },
    ];

    for (const task of variants) {
      const artifact = {
        schemaVersion: 1 as const,
        kind: 'execution-artifact' as const,
        changeId: 'demo-change',
        tasks: { '1.1': task },
      };
      assert.deepEqual(
        parseExecutionArtifact(
          artifact,
          'demo-change',
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
        artifact,
      );
    }

    const invalid = [
      {
        ...variants[0],
        strategy: 'unknown-strategy',
      },
      {
        ...variants[1],
        exemptionReason: 'mixed union branch',
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          examples: [],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          fileScopes: ['outside/**'],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          replacementTerms: [{ kind: 'symbol' as const, value: 'OLD_NAME' }],
        },
      },
      {
        ...variants[2],
        requiredChecks: ['unregistered'],
      },
      {
        ...variants[2],
        allowedPaths: [],
      },
      {
        ...variants[2],
        exemptionKind: 'legacy-bootstrap',
        legacyBootstrap: 'establish-investigation-first-planning',
      },
      {
        ...variants[0],
        enforcement: 'available',
      },
      {
        ...variants[1],
        enforcement: 'available',
      },
      {
        ...variants[0],
        behaviorContractRefs: ['specs/demo/spec.md#demo'],
      },
      {
        ...variants[0],
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Missing behavior',
            scenario: null,
          },
        ],
      },
      {
        ...variants[0],
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Missing scenario',
          },
        ],
      },
      {
        ...variants[0],
        implementationPathScopes: ['src/__tests__/fixtures/**'],
      },
      {
        ...variants[0],
        testPathScopes: ['outside/**'],
      },
      {
        ...variants[0],
        requiredImplementerIndependence: 'none',
      },
      {
        ...variants[3],
        requiredImplementerIndependence: 'provider-independent',
      },
    ];
    for (const task of invalid) {
      assert.throws(
        () =>
          parseExecutionArtifact(
            {
              schemaVersion: 1,
              kind: 'execution-artifact',
              changeId: 'demo-change',
              tasks: { '1.1': task },
            },
            'demo-change',
            contract.tasks,
            contract.guard,
            contract.checks,
            contract.behaviorContracts,
          ),
        (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
      );
    }
    assert.throws(
      () =>
        parseExecutionArtifact(
          {
            schemaVersion: 1,
            kind: 'execution-artifact',
            changeId: 'demo-change',
            tasks: {},
          },
          'demo-change',
          [],
          { schemaVersion: 1, changeId: 'demo-change', tasks: {} },
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const overbroadBootstrap = {
      schemaVersion: 1 as const,
      kind: 'execution-artifact' as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '1.1': {
          ...variants[2],
          exemptionKind: 'legacy-bootstrap' as const,
          legacyBootstrap: 'establish-investigation-first-planning' as const,
        },
      },
    };
    assert.throws(
      () =>
        parseExecutionArtifact(
          overbroadBootstrap,
          overbroadBootstrap.changeId,
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const bootstrapTasks = [
      { id: '6.8', completed: true, title: 'Activate the schema.' },
      { id: '7.1', completed: false, title: 'Adopt the schema.' },
    ];
    const bootstrapGuard = {
      schemaVersion: 1 as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '6.8': {
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
        },
        '7.1': {
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
        },
      },
    };
    const bootstrapExecution = {
      schemaVersion: 1 as const,
      kind: 'execution-artifact' as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '6.8': variants[2],
        '7.1': {
          ...variants[2],
          exemptionKind: 'legacy-bootstrap' as const,
          exemptionReason:
            'Adopt the named pre-T2 plan under its reviewed bootstrap.',
          legacyBootstrap: 'establish-investigation-first-planning' as const,
        },
      },
    };
    assert.deepEqual(
      parseExecutionArtifact(
        bootstrapExecution,
        bootstrapExecution.changeId,
        bootstrapTasks,
        bootstrapGuard,
        contract.checks,
        contract.behaviorContracts,
      ),
      bootstrapExecution,
    );
    assert.deepEqual(
      parseExecutionArtifact(
        bootstrapExecution,
        bootstrapExecution.changeId,
        bootstrapTasks.map((task) => ({ ...task, completed: true })),
        bootstrapGuard,
        contract.checks,
        contract.behaviorContracts,
      ),
      bootstrapExecution,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('parseTasks rejects duplicate task IDs', () => {
  assert.throws(
    () =>
      parseTasks(`
- [ ] 1.1 First
- [ ] 1.1 Duplicate
`),
    (error) => isWorkflowError(error, 'DUPLICATE_TASK_ID'),
  );
});

test('parseTasks preserves wrapped task titles', () => {
  assert.deepEqual(
    parseTasks(`
- [ ] 3.2 Generate the six-field semantic handoff
      from controlled change state without hashes.
`),
    [
      {
        id: '3.2',
        completed: false,
        title:
          'Generate the six-field semantic handoff from controlled change state without hashes.',
      },
    ],
  );
});

test('policy paths accept exact paths and segment-aware directory prefixes', () => {
  assert.equal(
    normalizePolicyPath('apps/api/src/file.ts'),
    'apps/api/src/file.ts',
  );
  assert.equal(normalizePolicyPath('apps/api/**'), 'apps/api/**');
  assert.equal(matchesAllowedPath('apps/api/src/file.ts', 'apps/api/**'), true);
  assert.equal(matchesAllowedPath('apps/api', 'apps/api/**'), true);
  assert.equal(
    matchesAllowedPath('apps/api-copy/file.ts', 'apps/api/**'),
    false,
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/file.ts', 'apps/api/src/file.ts'),
    true,
  );
  assert.equal(
    normalizeChangedPath('apps/api/src/[slug]/file?.ts'),
    'apps/api/src/[slug]/file?.ts',
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/[slug]/file?.ts', 'apps/api/**'),
    true,
  );
});

test('generic changed paths reject Git directory markers', () => {
  assert.throws(
    () => normalizeChangedPath('memo/'),
    (error) => isWorkflowError(error, 'INVALID_REPOSITORY_PATH'),
  );
});

test('policy paths reject traversal, absolute paths, and unsupported globs', () => {
  for (const invalidPath of [
    '../secret',
    '/tmp/secret',
    'C:\\secret',
    './apps/api',
    'apps/*/src',
    'apps/api/',
  ]) {
    assert.throws(
      () => normalizePolicyPath(invalidPath),
      (error) => isWorkflowError(error, 'INVALID_POLICY_PATH'),
      invalidPath,
    );
  }
});

test('policy validation rejects an existing symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-path-root-'));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-path-outside-'),
  );
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.throws(
      () => assertPolicyPathInsideRepository(root, 'escape/**'),
      (error) => isWorkflowError(error, 'PATH_ESCAPES_REPOSITORY'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('disposable database policy accepts only explicit isolated test identities', () => {
  const evidence = assertDisposableDatabase({
    WORKFLOW_DISPOSABLE_DATABASE: '1',
    TEST_DATABASE_URL:
      'postgres://runner:super-secret@127.0.0.1:5433/expense_ci?sslmode=disable',
    DATABASE_URL: 'postgres://app:secret@127.0.0.1:5433/expense_dev',
  });

  assert.deepEqual(evidence, {
    identity: 'postgresql://127.0.0.1:5433/expense_ci',
  });
  assert.equal(JSON.stringify(evidence).includes('super-secret'), false);
  assert.equal(JSON.stringify(evidence).includes('sslmode'), false);
});

test('check environment exposes only deterministic runtime and validated database values', () => {
  const callerEnvironment = {
    ...process.env,
    PATH: '/tmp/fake-bin',
    NODE_OPTIONS: '--require=/tmp/inject.cjs',
    NODE_PATH: '/tmp/modules',
    LD_PRELOAD: '/tmp/inject.so',
    DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    GIT_DIR: '/tmp/decoy.git',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    PRIVATE_TOKEN: 'marker-secret',
    DATABASE_URL: 'postgres://app:secret@localhost/expense_dev',
    COMPOSE_TEST_DATABASE_URL:
      'postgres://compose:secret@localhost/expense_test',
  };

  const nonDestructive = createCheckEnvironment(callerEnvironment, false);

  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'GIT_DIR',
    'SSH_AUTH_SOCK',
    'PRIVATE_TOKEN',
    'DATABASE_URL',
    'COMPOSE_TEST_DATABASE_URL',
    'TEST_DATABASE_URL',
  ]) {
    assert.equal(Object.hasOwn(nonDestructive, key), false, key);
  }
  assert.equal(nonDestructive.PATH?.includes('/tmp/fake-bin'), false);
  assert.equal(nonDestructive.CI, '1');
  assert.equal(nonDestructive.WORKFLOW_CHECK_EXECUTION, '1');

  const destructive = createCheckEnvironment(
    {
      ...callerEnvironment,
      WORKFLOW_DISPOSABLE_DATABASE: '1',
      TEST_DATABASE_URL:
        'postgres://runner:marker-secret@localhost/expense_test',
    },
    true,
  );
  assert.equal(
    destructive.TEST_DATABASE_URL,
    'postgres://runner:marker-secret@localhost/expense_test',
  );
  assert.equal(destructive.WORKFLOW_DISPOSABLE_DATABASE, '1');
  assert.equal(JSON.stringify(nonDestructive).includes('marker-secret'), false);
});

test(
  'check environment ignores a caller-controlled temporary directory',
  { skip: process.platform === 'win32' },
  () => {
    const attackerDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-tmp-'),
    );
    const originalTemporaryDirectory = process.env.TMPDIR;
    try {
      process.env.TMPDIR = attackerDirectory;

      const environment = createCheckEnvironment({}, false);

      assert.equal(environment.TMPDIR, fs.realpathSync('/tmp'));
      assert.notEqual(environment.TMPDIR, fs.realpathSync(attackerDirectory));
    } finally {
      if (originalTemporaryDirectory === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTemporaryDirectory;
      }
      fs.rmSync(attackerDirectory, { recursive: true, force: true });
    }
  },
);

test('disposable database policy fails closed without leaking connection secrets', () => {
  const cases: Array<{
    name: string;
    environment: NodeJS.ProcessEnv;
    code: string;
  }> = [
    {
      name: 'confirmation missing',
      environment: {
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test',
      },
      code: 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED',
    },
    {
      name: 'test URL missing',
      environment: { WORKFLOW_DISPOSABLE_DATABASE: '1' },
      code: 'TEST_DATABASE_URL_REQUIRED',
    },
    {
      name: 'unsupported protocol',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'mysql://runner:marker-secret@localhost/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'no disposable name token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_sandbox',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'forbidden production token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_prod_test',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'same identity as development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@db.example.test:5432/expense_test?ssl=true',
        DATABASE_URL:
          'postgresql://app:other-secret@db.example.test/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'different DNS aliases cannot prove database isolation',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@ci-db.internal:6543/expense_test',
        DATABASE_URL:
          'postgres://app:other-secret@primary-db.internal:5432/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'trailing-dot hostname aliases development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@localhost./expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4 and localhost loopback aliases match',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@127.0.0.1/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4-mapped IPv6 loopback aliases localhost',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@[::ffff:127.0.0.1]/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'query overrides the PostgreSQL target',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@safe.example.test:6543/expense_test?host=prod.example.test&port=5432',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'percent-encoded hostname is ambiguous',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@%70rod.example.test/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'control character in URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test\0',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'driver-equivalent encoded database identity',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@db.example.test/expense_%74est%23x',
        DATABASE_URL:
          'postgres://app:other-secret@db.example.test/expense_test%2523x',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => assertDisposableDatabase(fixture.environment),
      (error) => {
        assert.equal(isWorkflowError(error, fixture.code), true, fixture.name);
        const rendered = JSON.stringify({
          error,
          message: error instanceof Error ? error.message : String(error),
        });
        assert.equal(rendered.includes('marker-secret'), false, fixture.name);
        assert.equal(rendered.includes('other-secret'), false, fixture.name);
        return true;
      },
    );
  }
});

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
