import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  parseInvestigationArtifact,
  type InvestigationArtifact,
} from '../src/contracts.ts';
import {
  canonicalEvidenceNodeEnvelope,
  createEvidenceNode,
} from '../src/evidence-node.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveInvestigationGroupFacts,
  deriveInvestigationGroups,
  readInvestigationGroupNode,
} from '../src/modules/investigation/domain/investigation-groups.ts';
import { projectInvestigationArtifactForTracking } from '../src/investigation-artifact-projection.ts';
import {
  deriveEngineFloor,
  derivePinnedDiffPathFacts,
  validateEngineFloor,
  type EngineFloorFacts,
} from '../src/modules/investigation/domain/investigation-floor.ts';
import {
  adaptInvestigationScanFactsResult,
  scanInvestigationTreeFacts,
  scanInvestigationTree,
  type InvestigationScanResult,
  type ScanSkippedObject,
} from '../src/modules/investigation/domain/investigation-scanner.ts';
import {
  INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
  createInvestigationApplicability,
} from '../src/modules/investigation/domain/investigation-applicability.ts';
import {
  INVESTIGATION_LIMITS,
  normalizeInvestigationTerm,
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/modules/investigation/domain/investigation-terms.ts';
import { runGitBuffer } from '../src/git.ts';
import {
  readPinnedTrackedTree,
  TRACKED_TREE_LIMITS,
} from '../src/tracked-tree-reader.ts';
import { createMutationClassPolicy } from '../src/modules/source/mutation-class-policy.ts';
import { git, isWorkflowError } from './fixture.ts';

test('typed terms preserve exact bytes, deduplicate semantics, and retain every provenance', () => {
  assert.equal(
    fs
      .readFileSync(
        new URL(
          '../src/modules/investigation/domain/investigation-terms.ts',
          import.meta.url,
        ),
      )
      .includes(0),
    false,
  );
  const first = normalizeInvestigationTerm({
    kind: 'literal-content',
    value: 'a.*b',
  });
  const same = normalizeInvestigationTerm({
    kind: 'literal-content',
    value: 'a.*b',
  });
  const differentKind = normalizeInvestigationTerm({
    kind: 'symbol',
    value: 'a.*b',
  });

  assert.equal(first.termId, same.termId);
  assert.notEqual(first.termId, differentKind.termId);
  assert.deepEqual(first, {
    termId: first.termId,
    kind: 'literal-content',
    value: 'a.*b',
    matching: 'case-sensitive-literal-v1',
  });
  assert.match(first.termId, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    normalizeInvestigationTerm({
      kind: 'literal-content',
      value: '  exact spaces  ',
    }).value,
    '  exact spaces  ',
  );
  assert.equal(
    Buffer.byteLength(
      normalizeInvestigationTerm({
        kind: 'symbol',
        value: 'é'.repeat(128),
      }).value,
      'utf8',
    ),
    256,
  );

  for (const input of [
    { kind: 'regex', value: 'a.*b' },
    { kind: 'symbol', value: '' },
    { kind: 'symbol', value: 'x'.repeat(257) },
    { kind: 'symbol', value: 'é'.repeat(129) },
    { kind: 'symbol', value: '\u0000' },
    { kind: 'symbol', value: 'line\nbreak' },
    { kind: 'symbol', value: 'tab\tvalue' },
    { kind: 'symbol', value: '\u007f' },
    { kind: 'symbol', value: '\u0085' },
    { kind: 'symbol', value: '\ud800' },
  ]) {
    assert.throws(
      () => normalizeInvestigationTerm(input as never),
      (error) => isWorkflowError(error, 'INVESTIGATION_TERM_INVALID'),
    );
  }

  const contributions: InvestigationTermContribution[] = [
    contribution('main', 'main-1', [
      { kind: 'literal-content', value: 'shared-token' },
      { kind: 'symbol', value: 'MainOnly' },
    ]),
    contribution('survey', 'survey-1', [
      { kind: 'literal-content', value: 'shared-token' },
    ]),
    contribution('reviewer', 'review-1', [
      { kind: 'config-key', value: 'protectedBranches' },
    ]),
  ];
  const preview = previewInvestigationTermUnion(contributions);
  assert.equal(preview.outcome, 'ready');
  assert.deepEqual(preview.rawCounts, {
    engine: 0,
    main: 2,
    survey: 1,
    reviewer: 1,
  });
  assert.equal(preview.terms.length, 3);
  const shared = preview.terms.find((term) => term.value === 'shared-token');
  assert.deepEqual(shared?.provenance, [
    {
      source: 'main',
      reference: 'main-1',
      rationale: 'Main investigation expects literal-content shared-token.',
      expectedRelationship:
        'The term may identify an existing consumer or invariant.',
    },
    {
      source: 'survey',
      reference: 'survey-1',
      rationale: null,
      expectedRelationship: null,
    },
  ]);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.terms), true);
  assert.equal(Object.isFrozen(shared?.provenance), true);

  contributions[0]!.terms[0]!.value = 'mutated-after-preview';
  assert.equal(shared?.value, 'shared-token');

  const reordered = previewInvestigationTermUnion([
    contribution('reviewer', 'review-1', [
      { kind: 'config-key', value: 'protectedBranches' },
    ]),
    contribution('survey', 'survey-1', [
      { kind: 'literal-content', value: 'shared-token' },
    ]),
    contribution('main', 'main-1', [
      { kind: 'symbol', value: 'MainOnly' },
      { kind: 'literal-content', value: 'shared-token' },
    ]),
  ]);
  assert.deepEqual(reordered, preview);
});

test('main terms require bounded rationale and expected relationship without changing term identity', () => {
  assert.throws(
    () =>
      previewInvestigationTermUnion([
        {
          source: 'main',
          reference: 'main:missing-metadata',
          terms: [{ kind: 'symbol', value: 'SharedContract' }],
        } as never,
      ]),
    (error) => isWorkflowError(error, 'INVESTIGATION_TERM_INVALID'),
  );

  const main = {
    source: 'main' as const,
    reference: 'main:contract',
    terms: [
      {
        kind: 'symbol' as const,
        value: 'SharedContract',
        rationale: 'The change modifies the shared contract surface.',
        expectedRelationship: 'Existing consumers import this symbol.',
      },
    ],
  };
  const preview = previewInvestigationTermUnion([
    main,
    contribution('survey', 'survey:contract', [
      { kind: 'symbol', value: 'SharedContract' },
    ]),
  ]);
  assert.equal(preview.outcome, 'ready');
  assert.equal(preview.terms.length, 1);
  assert.deepEqual(preview.terms[0]?.provenance, [
    {
      source: 'main',
      reference: 'main:contract',
      rationale: 'The change modifies the shared contract surface.',
      expectedRelationship: 'Existing consumers import this symbol.',
    },
    {
      source: 'survey',
      reference: 'survey:contract',
      rationale: null,
      expectedRelationship: null,
    },
  ]);
  assert.equal(
    preview.terms[0]?.termId,
    normalizeInvestigationTerm({
      kind: 'symbol',
      value: 'SharedContract',
    }).termId,
  );

  const changedMetadata = previewInvestigationTermUnion([
    {
      ...main,
      terms: [
        {
          ...main.terms[0]!,
          rationale: 'A different rationale must change contribution meaning.',
        },
      ],
    },
  ]);
  assert.equal(changedMetadata.terms[0]?.termId, preview.terms[0]?.termId);
  assert.notDeepEqual(changedMetadata, preview);
});

test('investigation applicability admits only exact reviewed low-risk exemptions', () => {
  const eligible = createInvestigationApplicability({
    kind: 'investigation-exemption',
    category: 'documentation-only',
    baseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
    intentDigest: 'c'.repeat(64),
    declaredPaths: ['docs/WORKFLOW.md'],
    declaredChangeClasses: ['documentation-only'],
    rationale: 'This revision changes explanatory prose only.',
    semanticAuthor: {
      id: 'codex',
      provenance: 'typed-caller-contribution',
    },
    nonTrivialBehaviorReliance: 'none-declared',
    researchBudgetMinutes: null,
  });
  assert.equal(eligible.kind, 'investigation-exemption');
  assert.equal(
    eligible.policyDigest,
    INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
  );
  assert.match(eligible.applicabilityDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(eligible), true);

  assert.throws(
    () =>
      createInvestigationApplicability({
        kind: 'investigation-exemption',
        category: eligible.category,
        baseline: eligible.baseline,
        intentDigest: eligible.intentDigest,
        declaredPaths: [...eligible.declaredPaths],
        declaredChangeClasses: ['documentation-only', 'behavioral'],
        rationale: eligible.rationale,
        semanticAuthor: eligible.semanticAuthor,
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_EXEMPTION_INELIGIBLE'),
  );
  assert.throws(
    () =>
      createInvestigationApplicability({
        kind: 'investigation-exemption',
        category: 'time-boxed-research',
        baseline: eligible.baseline,
        intentDigest: eligible.intentDigest,
        declaredPaths: [...eligible.declaredPaths],
        declaredChangeClasses: ['time-boxed-research'],
        rationale: eligible.rationale,
        semanticAuthor: eligible.semanticAuthor,
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_EXEMPTION_INVALID'),
  );

  const sealed = createInvestigationApplicability({
    kind: 'sealed-investigation',
    baseline: eligible.baseline,
    intentDigest: eligible.intentDigest,
    sealNodeId: 'd'.repeat(64),
    sealResultDigest: 'e'.repeat(64),
  });
  assert.equal(sealed.kind, 'sealed-investigation');
  assert.notEqual(sealed.applicabilityDigest, eligible.applicabilityDigest);

  const trackedSchema = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../../workflow/schemas/investigation-artifact.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    $defs: { investigationApplicability: { oneOf: unknown[] } };
  };
  assert.equal(trackedSchema.$defs.investigationApplicability.oneOf.length, 2);
});

test('term preview reports source and effective overage without dropping proposals', () => {
  const mainTerms = Array.from({ length: 3 }, (_, index) => ({
    kind: 'symbol' as const,
    value: `MainSymbol${index}`,
  }));
  const preview = previewInvestigationTermUnion(
    [contribution('main', 'main-overage', mainTerms)],
    {
      ...INVESTIGATION_LIMITS,
      maxMainTerms: 2,
      maxEffectiveTerms: 2,
    },
  );

  assert.equal(preview.outcome, 'requires-narrowing');
  assert.equal(preview.terms.length, 3);
  assert.deepEqual(
    preview.violations.map((violation) => violation.code).sort(),
    ['EFFECTIVE_TERM_LIMIT_EXCEEDED', 'MAIN_TERM_LIMIT_EXCEEDED'],
  );
  assert.throws(
    () =>
      previewInvestigationTermUnion([], {
        ...INVESTIGATION_LIMITS,
        maxMainTerms: INVESTIGATION_LIMITS.maxMainTerms + 1,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_LIMITS_INVALID'),
  );

  const providerOverage = previewInvestigationTermUnion(
    [
      contribution('survey', 'survey-overage', [
        { kind: 'symbol', value: 'SurveyOne' },
        { kind: 'symbol', value: 'SurveyTwo' },
      ]),
      contribution('reviewer', 'reviewer-overage', [
        { kind: 'symbol', value: 'ReviewerOne' },
        { kind: 'symbol', value: 'ReviewerTwo' },
      ]),
    ],
    {
      ...INVESTIGATION_LIMITS,
      maxSurveyTerms: 1,
      maxReviewerTerms: 1,
    },
  );
  assert.equal(providerOverage.outcome, 'requires-narrowing');
  if (providerOverage.outcome !== 'requires-narrowing') {
    assert.fail('expected provider term-limit narrowing');
  }
  assert.deepEqual(providerOverage.violations.map(({ code }) => code).sort(), [
    'REVIEWER_TERM_LIMIT_EXCEEDED',
    'SURVEY_TERM_LIMIT_EXCEEDED',
  ]);
});

test('engine floor is complete, provenance-preserving, and validates by recomputation', () => {
  const facts = completeFloorFacts();
  const floor = deriveEngineFloor(facts);
  assert.equal(floor.outcome, 'derived');
  if (floor.outcome !== 'derived') {
    assert.fail('expected a derived engine floor');
  }
  assert.equal(floor.breadthContribution, true);
  assert.deepEqual(
    new Set(floor.terms.map(({ value }) => value)),
    new Set([
      'src/old-service.ts',
      'OldService',
      'protectedBranches',
      'ARCHIVE_BASE',
      'ARCHIVE_TARGET',
      'removed-config.json',
      'removed-config',
      'legacy-name.ts',
      'legacy-name',
      'new-name.ts',
      'new-name',
      '.codex/skills/openspec-propose/SKILL.md',
      '.agents/skills/openspec-propose/SKILL.md',
    ]),
  );
  const oldService = floor.terms.find(
    (term) => term.value === 'src/old-service.ts',
  );
  assert.equal(oldService?.kind, 'literal-path');
  assert.deepEqual(
    oldService?.provenance.map(({ source }) => source),
    ['engine-floor'],
  );
  assert.ok(
    floor.derivations.some(
      (item) =>
        item.termId === oldService?.termId && item.rule === 'explicit-path',
    ),
  );
  assert.ok(
    floor.derivations.some(
      (item) =>
        item.value === 'ARCHIVE_BASE' &&
        item.rule === 'transformation-before' &&
        item.sourceReference === 'intent:rename-archive-symbol',
    ),
  );
  assert.ok(
    floor.derivations.some(
      (item) =>
        item.value === '.agents/skills/openspec-propose/SKILL.md' &&
        item.rule === 'reviewed-counterpart' &&
        item.subject === '.codex/skills/openspec-propose/SKILL.md' &&
        item.sourceReference === 'reviewed-mirror:openspec-propose',
    ),
  );
  assert.deepEqual(validateEngineFloor(facts, floor), floor);

  const missing = structuredClone(floor);
  missing.terms = missing.terms.slice(1);
  assert.throws(
    () => validateEngineFloor(facts, missing),
    (error) => isWorkflowError(error, 'INVESTIGATION_FLOOR_INVALID'),
  );

  const empty = deriveEngineFloor({
    explicitPaths: [],
    symbols: [],
    configKeys: [],
    transformations: [],
    changedPaths: [],
    reviewedCounterparts: [],
  });
  assert.deepEqual(empty, {
    outcome: 'no-derivable-floor-facts',
    breadthContribution: false,
    checkedCategories: [
      'changedPaths',
      'configKeys',
      'explicitPaths',
      'reviewedCounterparts',
      'symbols',
      'transformations',
    ],
  });
  assert.deepEqual(
    validateEngineFloor(
      {
        explicitPaths: [],
        symbols: [],
        configKeys: [],
        transformations: [],
        changedPaths: [],
        reviewedCounterparts: [],
      },
      empty,
    ),
    empty,
  );
  assert.throws(
    () =>
      deriveEngineFloor({
        explicitPaths: [],
        symbols: [],
        configKeys: [],
        transformations: [],
        changedPaths: [],
        reviewedCounterparts: [
          {
            kind: 'literal-path',
            value: '.agents/skills/orphan/SKILL.md',
            subject: '.codex/skills/orphan/SKILL.md',
            reference: 'reviewed-mirror:orphan',
          },
        ],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_FLOOR_INVALID'),
  );

  const sharedCounterpartFacts: EngineFloorFacts = {
    explicitPaths: ['src/subject-a.ts', 'src/subject-b.ts'],
    symbols: [],
    configKeys: [],
    transformations: [],
    changedPaths: [],
    reviewedCounterparts: [
      {
        kind: 'literal-path',
        value: '.agents/shared/SKILL.md',
        subject: 'src/subject-a.ts',
        reference: 'reviewed-mirror:shared',
      },
      {
        kind: 'literal-path',
        value: '.agents/shared/SKILL.md',
        subject: 'src/subject-b.ts',
        reference: 'reviewed-mirror:shared',
      },
    ],
  };
  assert.deepEqual(
    deriveEngineFloor(sharedCounterpartFacts),
    deriveEngineFloor({
      ...sharedCounterpartFacts,
      explicitPaths: [...sharedCounterpartFacts.explicitPaths].reverse(),
      reviewedCounterparts: [
        ...sharedCounterpartFacts.reviewedCounterparts,
      ].reverse(),
    }),
  );
});

test('engine floor path facts come from an exact pinned diff, not the worktree', () => {
  const repository = createScannerRepository();
  try {
    fs.mkdirSync(path.join(repository, 'config'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src/legacy-name.ts'), 'legacy\n');
    fs.writeFileSync(
      path.join(repository, 'config/removed-config.json'),
      '{}\n',
    );
    commitAll(repository, 'Add old paths');
    const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();

    git(repository, ['mv', 'src/legacy-name.ts', 'src/new-name.ts']);
    git(repository, ['rm', 'config/removed-config.json']);
    commitAll(repository, 'Rename and remove paths');
    const targetCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repository, 'later-head-only.ts'), 'later\n');
    commitAll(repository, 'Advance HEAD beyond target commit');
    fs.writeFileSync(path.join(repository, 'worktree-only.ts'), 'ignored\n');

    const changedPaths = derivePinnedDiffPathFacts({
      repositoryRoot: repository,
      baseCommit,
      targetCommit,
    });
    assert.deepEqual(changedPaths, [
      {
        change: 'removed',
        before: 'config/removed-config.json',
        reference: `${baseCommit}..${targetCommit}:D:config/removed-config.json`,
      },
      {
        change: 'renamed',
        before: 'src/legacy-name.ts',
        after: 'src/new-name.ts',
        reference: `${baseCommit}..${targetCommit}:R:src/legacy-name.ts:src/new-name.ts`,
      },
    ]);
    git(repository, ['config', 'diff.renames', 'false']);
    git(repository, ['config', 'diff.renameLimit', '1']);
    git(repository, ['config', 'diff.algorithm', 'histogram']);
    assert.deepEqual(
      derivePinnedDiffPathFacts({
        repositoryRoot: repository,
        baseCommit,
        targetCommit,
      }),
      changedPaths,
    );
    assert.equal(
      JSON.stringify(changedPaths).includes('later-head-only'),
      false,
    );
    assert.equal(JSON.stringify(changedPaths).includes('worktree-only'), false);
    assert.throws(
      () =>
        derivePinnedDiffPathFacts({
          repositoryRoot: repository,
          baseCommit: 'HEAD',
          targetCommit,
        }),
      (error) => isWorkflowError(error, 'PINNED_DIFF_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('pinned scan ignores index, worktree, untracked, ignored, caller PATH, and allowedPaths', () => {
  const repository = createScannerRepository();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-fake-bin-'));
  const marker = path.join(fakeBin, 'executed');
  const previous = {
    PATH: process.env.PATH,
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  try {
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/outside.md'),
      'committed-needle\n',
    );
    fs.writeFileSync(
      path.join(repository, 'guard.json'),
      '{"allowedPaths":["src/**"]}\n',
    );
    commitAll(repository, 'Add pinned breadth fixture');
    const pinnedTree = treeOid(repository);

    fs.writeFileSync(
      path.join(repository, 'docs/outside.md'),
      'later-head-only\n',
    );
    fs.writeFileSync(
      path.join(repository, 'docs/later-head.md'),
      'committed-needle later-head\n',
    );
    commitAll(repository, 'Advance HEAD beyond pinned tree');
    fs.writeFileSync(
      path.join(repository, 'docs/outside.md'),
      'worktree-only\n',
    );
    fs.writeFileSync(
      path.join(repository, 'untracked.txt'),
      'committed-needle untracked-only\n',
    );
    fs.writeFileSync(
      path.join(repository, 'index-only.txt'),
      'committed-needle index-only\n',
    );
    git(repository, ['add', 'docs/outside.md', 'index-only.txt']);
    fs.mkdirSync(path.join(repository, 'ignored'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'ignored/secret.txt'),
      'committed-needle ignored-only\n',
    );
    for (const executable of ['git', 'grep', 'rg']) {
      const fake = path.join(fakeBin, executable);
      fs.writeFileSync(
        fake,
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`,
      );
      fs.chmodSync(fake, 0o755);
    }
    process.env.PATH = fakeBin;
    process.env.GIT_DIR = path.join(fakeBin, 'wrong-git-dir');
    process.env.GIT_WORK_TREE = path.join(fakeBin, 'wrong-worktree');

    const term = normalizeInvestigationTerm({
      kind: 'literal-content',
      value: 'committed-needle',
    });
    const result = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: pinnedTree,
      terms: [{ ...term, provenance: [] }],
    });
    assert.equal(result.outcome, 'ready');
    if (result.outcome !== 'ready') {
      assert.fail('expected a ready pinned scan');
    }
    assert.equal(result.nodes.length, 1);
    const output = scanOutput(result, term.termId);
    assert.deepEqual(
      output.hits.map((hit) => hit.path.utf8),
      ['docs/outside.md'],
    );
    assert.equal(output.hits[0]?.surface, 'content');
    assert.equal(fs.existsSync(marker), false);
    const serialized = JSON.stringify(result.nodes);
    assert.equal(serialized.includes('worktree-only'), false);
    assert.equal(serialized.includes('index-only'), false);
    assert.equal(serialized.includes('untracked-only'), false);
    assert.equal(serialized.includes('ignored-only'), false);
  } finally {
    restoreEnvironment('PATH', previous.PATH);
    restoreEnvironment('GIT_DIR', previous.GIT_DIR);
    restoreEnvironment('GIT_WORK_TREE', previous.GIT_WORK_TREE);
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'tree reader preserves raw paths and records every unsupported object',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createScannerRepository();
    try {
      fs.mkdirSync(path.join(repository, 'odd'), { recursive: true });
      fs.writeFileSync(path.join(repository, 'odd/tab\tnewline\n.txt'), 'ok');
      fs.writeFileSync(
        path.join(repository, 'odd/binary.bin'),
        Buffer.from([0x61, 0x00, 0x62]),
      );
      fs.writeFileSync(
        path.join(repository, 'odd/invalid-blob.txt'),
        Buffer.from([0x61, 0xff, 0x62]),
      );
      fs.writeFileSync(
        path.join(repository, 'odd/oversize.txt'),
        'x'.repeat(33),
      );
      fs.writeFileSync(path.join(repository, 'odd/duplicate-a.txt'), 'dupe');
      fs.writeFileSync(path.join(repository, 'odd/duplicate-b.txt'), 'dupe');
      const credentialSentinel = 'CREDENTIAL_SENTINEL\n';
      fs.writeFileSync(path.join(repository, '.env'), credentialSentinel);
      fs.writeFileSync(path.join(repository, '.npmrc'), credentialSentinel);
      fs.writeFileSync(
        path.join(repository, 'credentials.json'),
        credentialSentinel,
      );
      fs.writeFileSync(
        path.join(repository, 'odd/id_ed25519'),
        credentialSentinel,
      );
      fs.writeFileSync(
        path.join(repository, 'odd/client.pem'),
        credentialSentinel,
      );
      fs.writeFileSync(
        path.join(repository, 'odd/duplicate-secret.txt'),
        credentialSentinel,
      );
      fs.symlinkSync(
        '/repository-external-target',
        path.join(repository, 'odd/link'),
      );
      const invalidPath = Buffer.concat([
        Buffer.from(`${repository}/odd/invalid-path-`),
        Buffer.from([0xff]),
        Buffer.from('.txt'),
      ]);
      let hasInvalidUtf8Path = false;
      try {
        fs.writeFileSync(invalidPath, 'path-is-raw');
        hasInvalidUtf8Path = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== 'darwin' ||
          (code !== 'EILSEQ' && code !== 'EPERM')
        ) {
          throw error;
        }
      }
      git(repository, ['add', '-A']);
      const rawCredentialSentinel = Buffer.from(
        'RAW_CREDENTIAL_SENTINEL\n',
        'utf8',
      );
      const rawCredentialObjectId = runGitBuffer(
        repository,
        ['hash-object', '-w', '--stdin'],
        { input: rawCredentialSentinel },
      )
        .toString('ascii')
        .trim();
      const rawSensitivePaths = [
        Buffer.concat([
          Buffer.from('bad-'),
          Buffer.from([0xff]),
          Buffer.from('/.env'),
        ]),
        Buffer.concat([
          Buffer.from('bad-'),
          Buffer.from([0xfe]),
          Buffer.from('/.ssh/id_rsa'),
        ]),
      ];
      runGitBuffer(repository, ['update-index', '-z', '--index-info'], {
        input: Buffer.concat(
          rawSensitivePaths.flatMap((rawPath) => [
            Buffer.from(`100644 blob ${rawCredentialObjectId}\t`, 'ascii'),
            rawPath,
            Buffer.from([0]),
          ]),
        ),
      });
      git(repository, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${git(repository, ['rev-parse', 'HEAD']).trim()},vendor/submodule`,
      ]);
      git(repository, ['commit', '-m', 'Add binary tree cases']);

      const snapshot = readPinnedTrackedTree({
        repositoryRoot: repository,
        treeOid: treeOid(repository),
        limits: {
          ...TRACKED_TREE_LIMITS,
          maxBlobBytes: 32,
        },
      });
      assert.throws(
        () =>
          readPinnedTrackedTree({
            repositoryRoot: repository,
            treeOid: 'HEAD',
          }),
        (error) => isWorkflowError(error, 'PINNED_TREE_INVALID'),
      );
      const byDisplay = new Map(
        snapshot.entries.map((entry) => [entry.path.utf8, entry]),
      );
      assert.equal(
        byDisplay.get('odd/tab\tnewline\n.txt')?.content?.toString('utf8'),
        'ok',
      );
      assert.equal(byDisplay.get('odd/tab\tnewline\n.txt')?.objectType, 'blob');
      assert.equal(byDisplay.get('odd/tab\tnewline\n.txt')?.byteSize, 2);
      assert.equal(byDisplay.get('.env')?.skipReason, 'sensitive-path');
      assert.equal(byDisplay.get('.npmrc')?.skipReason, 'sensitive-path');
      assert.equal(
        byDisplay.get('credentials.json')?.skipReason,
        'sensitive-path',
      );
      assert.equal(
        byDisplay.get('odd/id_ed25519')?.skipReason,
        'sensitive-path',
      );
      assert.equal(
        byDisplay.get('odd/client.pem')?.skipReason,
        'sensitive-path',
      );
      assert.equal(
        byDisplay.get('odd/duplicate-secret.txt')?.skipReason,
        'sensitive-suppressed',
      );
      assert.equal(byDisplay.get('odd/binary.bin')?.skipReason, 'binary');
      assert.equal(
        byDisplay.get('odd/invalid-blob.txt')?.skipReason,
        'invalid-utf8',
      );
      assert.equal(byDisplay.get('odd/oversize.txt')?.skipReason, 'oversize');
      assert.equal(byDisplay.get('odd/link')?.skipReason, 'symlink');
      assert.equal(byDisplay.get('vendor/submodule')?.skipReason, 'submodule');
      assert.equal(byDisplay.get('vendor/submodule')?.objectType, 'commit');
      assert.equal(byDisplay.get('vendor/submodule')?.byteSize, null);
      const rawPath = snapshot.entries.find(
        (entry) => entry.path.utf8 === null,
      );
      if (hasInvalidUtf8Path) {
        assert.ok(rawPath);
        assert.equal(rawPath.content?.toString('utf8'), 'path-is-raw');
        assert.match(rawPath.path.rawBase64, /^[A-Za-z0-9+/]+=*$/);
      }
      for (const rawSensitivePath of rawSensitivePaths) {
        const rawSensitiveEntry = snapshot.entries.find(
          (entry) =>
            entry.path.rawBase64 === rawSensitivePath.toString('base64'),
        );
        assert.ok(rawSensitiveEntry);
        assert.equal(rawSensitiveEntry.path.utf8, null);
        assert.equal(rawSensitiveEntry.skipReason, 'sensitive-path');
        assert.equal(rawSensitiveEntry.content, undefined);
      }
      assert.deepEqual(
        snapshot.entries.map((entry) => entry.path.rawBase64),
        [...snapshot.entries]
          .sort((left, right) =>
            Buffer.compare(
              Buffer.from(left.path.rawBase64, 'base64'),
              Buffer.from(right.path.rawBase64, 'base64'),
            ),
          )
          .map((entry) => entry.path.rawBase64),
      );
      const uniqueScanned = new Map(
        snapshot.entries
          .filter((entry) => entry.content !== undefined)
          .map((entry) => [entry.objectId, entry.content!.byteLength]),
      );
      assert.equal(
        snapshot.totalScannedBlobBytes,
        [...uniqueScanned.values()].reduce((sum, size) => sum + size, 0),
      );

      const secretTerm = termWithProvenance(
        'literal-content',
        'CREDENTIAL_SENTINEL',
      );
      const rawSecretTerm = termWithProvenance(
        'literal-content',
        'RAW_CREDENTIAL_SENTINEL',
      );
      const sensitivePathTerm = termWithProvenance('literal-path', '.env');
      const scan = scanInvestigationTree({
        repositoryRoot: repository,
        treeOid: treeOid(repository),
        terms: [secretTerm, rawSecretTerm, sensitivePathTerm],
        limits: {
          ...INVESTIGATION_LIMITS,
          maxBlobBytes: 32,
        },
      });
      assert.equal(scan.outcome, 'ready');
      if (scan.outcome !== 'ready') {
        assert.fail('expected ready scan with auditable skips');
      }
      assert.deepEqual(scanOutput(scan, secretTerm.termId).hits, []);
      assert.deepEqual(scanOutput(scan, rawSecretTerm.termId).hits, []);
      const sensitivePathHits = scanOutput(scan, sensitivePathTerm.termId).hits;
      assert.equal(sensitivePathHits.length, 2);
      assert.equal(
        sensitivePathHits.some(({ path: hitPath }) => hitPath.utf8 === '.env'),
        true,
      );
      for (const hit of sensitivePathHits) {
        assert.equal(hit.surface, 'path');
        assert.equal(hit.sourceObject.skipReason, 'sensitive-path');
        assert.equal(hit.sourceObject.contentSha256, null);
      }
      for (const [skippedPath, reason] of [
        ['.env', 'sensitive-path'],
        ['.npmrc', 'sensitive-path'],
        ['credentials.json', 'sensitive-path'],
        ['odd/id_ed25519', 'sensitive-path'],
        ['odd/client.pem', 'sensitive-path'],
        ['odd/duplicate-secret.txt', 'sensitive-suppressed'],
        ['odd/binary.bin', 'binary'],
        ['odd/invalid-blob.txt', 'invalid-utf8'],
        ['odd/oversize.txt', 'oversize'],
        ['odd/link', 'symlink'],
        ['vendor/submodule', 'submodule'],
      ] as const) {
        let skipRecord: ScanSkippedObject | undefined;
        for (const entry of scan.inventory.skippedObjects) {
          if (entry.path.utf8 === skippedPath) {
            skipRecord = entry;
            break;
          }
        }
        assert.equal(skipRecord?.reason, reason);
        assert.match(skipRecord?.objectId ?? '', /^[0-9a-f]{40,64}$/);
        assert.match(skipRecord?.mode ?? '', /^[0-7]{6}$/);
      }
      assert.equal(
        scan.nodes[0]?.exactInputDigests.tree,
        scan.inventory.treeDigest,
      );
      assert.equal(
        scan.inventory.evidenceNode.type,
        'investigation-tree-inventory',
      );
      assert.equal(
        scan.inventory.evidenceNode.exactInputDigests.tree,
        scan.inventory.treeDigest,
      );
      assert.deepEqual(
        (
          scan.inventory.evidenceNode.output as {
            skippedObjects: ScanSkippedObject[];
          }
        ).skippedObjects,
        scan.inventory.skippedObjects,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test('literal scans are deterministic, per-term independent, and include zero-hit nodes', () => {
  const repository = createScannerRepository();
  try {
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/example.ts'),
      'const exact = "🙂a.*b";\nconst other = "aXXb";\n',
    );
    fs.writeFileSync(
      path.join(repository, 'src/path-consumer.ts'),
      'export const referenced = "docs/a.*b.md";\n',
    );
    fs.writeFileSync(path.join(repository, 'src/overlap.txt'), 'ZXZXZ\n');
    fs.writeFileSync(path.join(repository, 'docs/a.*b.md'), 'path fixture\n');
    commitAll(repository, 'Add literal scan fixtures');
    const pinnedTree = treeOid(repository);
    const content = termWithProvenance('literal-content', 'a.*b');
    const pathTerm = termWithProvenance('literal-path', 'docs/a.*b.md');
    const zero = termWithProvenance('symbol', 'DefinitelyMissingSymbol');

    const onlyContent = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: pinnedTree,
      terms: [content],
    });
    const all = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: pinnedTree,
      terms: [zero, pathTerm, content],
    });
    const reordered = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: pinnedTree,
      terms: [content, pathTerm, zero],
    });
    const reprovenanced = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: pinnedTree,
      terms: [
        {
          ...content,
          provenance: [
            ...content.provenance,
            {
              source: 'survey',
              reference: 'survey:shared-term',
              rationale: null,
              expectedRelationship: null,
            },
          ],
        },
      ],
    });
    assert.equal(onlyContent.outcome, 'ready');
    assert.equal(all.outcome, 'ready');
    assert.equal(reordered.outcome, 'ready');
    assert.equal(reprovenanced.outcome, 'ready');
    if (
      onlyContent.outcome !== 'ready' ||
      all.outcome !== 'ready' ||
      reordered.outcome !== 'ready' ||
      reprovenanced.outcome !== 'ready'
    ) {
      assert.fail('expected ready literal scans');
    }
    assert.equal(all.nodes.length, 3);
    assert.equal(
      canonicalEvidenceNodeEnvelope(
        onlyContent.nodes.find(
          (node) =>
            (node.output as { termId: string }).termId === content.termId,
        )!,
      ),
      canonicalEvidenceNodeEnvelope(
        all.nodes.find(
          (node) =>
            (node.output as { termId: string }).termId === content.termId,
        )!,
      ),
    );
    assert.equal(
      canonicalEvidenceNodeEnvelope(onlyContent.nodes[0]!),
      canonicalEvidenceNodeEnvelope(reprovenanced.nodes[0]!),
    );
    assert.deepEqual(
      all.nodes.map(canonicalEvidenceNodeEnvelope),
      reordered.nodes.map(canonicalEvidenceNodeEnvelope),
    );
    assert.deepEqual(
      all.nodes.map((node) => (node.output as { termId: string }).termId),
      [...all.nodes]
        .map((node) => (node.output as { termId: string }).termId)
        .sort(),
    );

    const contentOutput = scanOutput(all, content.termId);
    assert.deepEqual(
      contentOutput.hits.map(({ path: hitPath, surface, byteOffset }) => ({
        path: hitPath.utf8,
        surface,
        byteOffset,
      })),
      [
        {
          path: 'src/example.ts',
          surface: 'content',
          byteOffset: 19,
        },
        {
          path: 'src/path-consumer.ts',
          surface: 'content',
          byteOffset: 32,
        },
      ],
    );
    assert.equal(
      contentOutput.hits.some((hit) => hit.path.utf8 === 'src/example.ts'),
      true,
    );
    for (const hit of contentOutput.hits) {
      assert.match(hit.sourceObject.objectId, /^[0-9a-f]{40,64}$/);
      assert.equal(hit.sourceObject.objectType, 'blob');
      assert.equal(hit.sourceObject.mode, '100644');
      assert.ok((hit.sourceObject.byteSize ?? 0) > 0);
      assert.match(hit.sourceObject.contentSha256 ?? '', /^[0-9a-f]{64}$/);
      assert.equal(hit.sourceObject.skipReason, null);
      assert.equal(hit.byteLength, Buffer.byteLength(content.value, 'utf8'));
    }
    const pathOutput = scanOutput(all, pathTerm.termId);
    assert.equal(
      pathOutput.hits.some(
        (hit) => hit.surface === 'path' && hit.path.utf8 === 'docs/a.*b.md',
      ),
      true,
    );
    assert.equal(
      pathOutput.hits.some(
        (hit) =>
          hit.surface === 'content' && hit.path.utf8 === 'src/path-consumer.ts',
      ),
      true,
    );
    assert.deepEqual(scanOutput(all, zero.termId).hits, []);

    const overlap = termWithProvenance('literal-content', 'ZXZ');
    const overlapResult = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: pinnedTree,
      terms: [overlap],
    });
    assert.equal(overlapResult.outcome, 'ready');
    if (overlapResult.outcome !== 'ready') {
      assert.fail('expected ready overlap scan');
    }
    assert.deepEqual(
      scanOutput(overlapResult, overlap.termId).hits.map(
        ({ path: hitPath, byteOffset }) => ({
          path: hitPath.utf8,
          byteOffset,
        }),
      ),
      [
        { path: 'src/overlap.txt', byteOffset: 0 },
        { path: 'src/overlap.txt', byteOffset: 2 },
      ],
    );

    for (const node of all.nodes) {
      assert.deepEqual(node.semanticParentResultDigests, {});
      assert.deepEqual(node.provenanceParentNodeIds, {});
      assert.deepEqual(Object.keys(node.exactInputDigests).sort(), [
        'term',
        'tree',
      ]);
      assert.match(node.exactInputDigests.tree!, /^[0-9a-f]{64}$/);
      assert.notEqual(node.exactInputDigests.tree, pinnedTree);
      assert.deepEqual(node.runtimeMetadata, {});
    }

    const loweredPolicy = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: pinnedTree,
      terms: [content],
      limits: {
        ...INVESTIGATION_LIMITS,
        maxHitsPerTerm: INVESTIGATION_LIMITS.maxHitsPerTerm - 1,
      },
    });
    assert.equal(loweredPolicy.outcome, 'ready');
    if (loweredPolicy.outcome !== 'ready') {
      assert.fail('expected ready lower-policy scan');
    }
    assert.equal(
      loweredPolicy.nodes[0]!.resultDigest,
      onlyContent.nodes[0]!.resultDigest,
    );
    assert.notEqual(
      loweredPolicy.nodes[0]!.policyDigest,
      onlyContent.nodes[0]!.policyDigest,
    );
    assert.notEqual(
      loweredPolicy.nodes[0]!.nodeId,
      onlyContent.nodes[0]!.nodeId,
    );
    assert.equal(
      loweredPolicy.inventory.evidenceNode.resultDigest,
      onlyContent.inventory.evidenceNode.resultDigest,
    );
    assert.notEqual(
      loweredPolicy.inventory.evidenceNode.nodeId,
      onlyContent.inventory.evidenceNode.nodeId,
    );

    fs.writeFileSync(
      path.join(repository, 'src/new-binary.bin'),
      Buffer.from([0x00, 0x01]),
    );
    commitAll(repository, 'Add skipped object without a term hit');
    const changedInventory = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: [zero],
    });
    assert.equal(changedInventory.outcome, 'ready');
    if (changedInventory.outcome !== 'ready') {
      assert.fail('expected ready scan after inventory-only change');
    }
    const oldZeroNode = all.nodes.find(
      (node) => (node.output as { termId: string }).termId === zero.termId,
    )!;
    assert.equal(
      changedInventory.nodes[0]!.resultDigest,
      oldZeroNode.resultDigest,
    );
    assert.notEqual(changedInventory.nodes[0]!.nodeId, oldZeroNode.nodeId);
    assert.notEqual(
      changedInventory.inventory.evidenceNode.resultDigest,
      all.inventory.evidenceNode.resultDigest,
    );

    assert.throws(
      () =>
        scanInvestigationTree({
          repositoryRoot: repository,
          treeOid: pinnedTree,
          terms: [content, content],
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_SCAN_INVALID'),
    );
    assert.throws(
      () =>
        scanInvestigationTree({
          repositoryRoot: repository,
          treeOid: pinnedTree,
          terms: [{ ...content, termId: '0'.repeat(64) }],
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_SCAN_INVALID'),
    );
    assert.throws(
      () =>
        scanInvestigationTree({
          repositoryRoot: repository,
          treeOid: pinnedTree,
          terms: [content, pathTerm],
          limits: {
            ...INVESTIGATION_LIMITS,
            maxEffectiveTerms: 1,
          },
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_SCAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('scan preview fails boundedly without emitting partial evidence', () => {
  const repository = createScannerRepository();
  try {
    fs.writeFileSync(
      path.join(repository, 'src/many.txt'),
      'needle needle needle\n',
    );
    fs.writeFileSync(
      path.join(repository, 'src/cpu-budget.txt'),
      'x'.repeat(1024 * 1024),
    );
    commitAll(repository, 'Add bounded scan fixture');
    const term = termWithProvenance('literal-content', 'needle');
    const hitLimited = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: [term],
      limits: {
        ...INVESTIGATION_LIMITS,
        maxHitsPerTerm: 2,
      },
    });
    assert.deepEqual(hitLimited.outcome, 'requires-narrowing');
    if (hitLimited.outcome !== 'requires-narrowing') {
      assert.fail('expected hit-limit narrowing');
    }
    assert.deepEqual(hitLimited.nodes, []);
    assert.deepEqual(
      hitLimited.violations.map(({ code }) => code),
      ['TERM_HIT_LIMIT_EXCEEDED'],
    );
    assert.deepEqual(hitLimited.terms, [term]);

    const aggregateLimited = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: [term],
      limits: {
        ...INVESTIGATION_LIMITS,
        maxTotalHits: 2,
        maxHitDispositionWorkItems: 2,
      },
    });
    assert.equal(aggregateLimited.outcome, 'requires-narrowing');
    if (aggregateLimited.outcome !== 'requires-narrowing') {
      assert.fail('expected aggregate-hit narrowing');
    }
    assert.deepEqual(aggregateLimited.nodes, []);
    assert.deepEqual(
      aggregateLimited.violations.map(({ code }) => code).sort(),
      ['HIT_DISPOSITION_WORK_LIMIT_EXCEEDED', 'TOTAL_HIT_LIMIT_EXCEEDED'],
    );

    const byteLimited = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: [term],
      limits: {
        ...INVESTIGATION_LIMITS,
        maxTotalScannedBlobBytes: 1,
      },
    });
    assert.equal(byteLimited.outcome, 'requires-narrowing');
    if (byteLimited.outcome !== 'requires-narrowing') {
      assert.fail('expected byte-limit narrowing');
    }
    assert.deepEqual(byteLimited.nodes, []);
    assert.equal(
      byteLimited.violations.some(
        ({ code }) => code === 'SCANNED_BYTE_LIMIT_EXCEEDED',
      ),
      true,
    );
    assert.equal(
      byteLimited.inventory.skippedObjects.some(
        ({ reason }) => reason === 'total-budget',
      ),
      true,
    );

    const workLimited = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: Array.from({ length: 64 }, (_, index) =>
        termWithProvenance('literal-content', `work-miss-${index}`),
      ),
      limits: {
        ...INVESTIGATION_LIMITS,
        maxScanWorkBytes: 512 * 1024,
      },
    });
    assert.equal(workLimited.outcome, 'requires-narrowing');
    if (workLimited.outcome !== 'requires-narrowing') {
      assert.fail('expected deterministic work-limit narrowing');
    }
    assert.deepEqual(workLimited.nodes, []);
    assert.equal(
      workLimited.violations.some(
        ({ code }) => code === 'SCAN_WORK_LIMIT_EXCEEDED',
      ),
      true,
    );

    const denseHitLimited = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: [termWithProvenance('literal-content', 'x')],
      limits: {
        ...INVESTIGATION_LIMITS,
        maxHitsPerTerm: 2,
      },
    });
    assert.equal(denseHitLimited.outcome, 'requires-narrowing');
    if (denseHitLimited.outcome !== 'requires-narrowing') {
      assert.fail('expected dense hit-limit narrowing');
    }
    assert.deepEqual(
      denseHitLimited.violations.map(({ code }) => code),
      ['TERM_HIT_LIMIT_EXCEEDED'],
    );
    assert.throws(
      () =>
        scanInvestigationTree({
          repositoryRoot: repository,
          treeOid: treeOid(repository),
          terms: [term],
          limits: {
            ...INVESTIGATION_LIMITS,
            maxHitsPerTerm: INVESTIGATION_LIMITS.maxHitsPerTerm + 1,
          },
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_LIMITS_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('operational CPU timeout aborts without returning semantic evidence', (t) => {
  const repository = createScannerRepository();
  try {
    const originalCpuUsage = process.cpuUsage;
    t.mock.method(process, 'cpuUsage', ((start?: NodeJS.CpuUsage) =>
      start === undefined
        ? { user: 0, system: 0 }
        : {
            user: INVESTIGATION_LIMITS.maxScanCpuMillis * 1000,
            system: 0,
          }) as typeof originalCpuUsage);
    assert.throws(
      () =>
        scanInvestigationTree({
          repositoryRoot: repository,
          treeOid: treeOid(repository),
          terms: [termWithProvenance('literal-content', 'base')],
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_SCAN_TIMEOUT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('domain scanner facts contain no generic evidence envelopes and preserve legacy scan semantics', () => {
  const repository = createScannerRepository();
  try {
    fs.writeFileSync(
      path.join(repository, 'src/base.txt'),
      'base domain-fact marker\n',
    );
    commitAll(repository, 'Add domain scanner fixture');
    const request = {
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: [termWithProvenance('literal-content', 'domain-fact')],
    };

    const domain = scanInvestigationTreeFacts(request);
    assert.equal(domain.outcome, 'ready');
    if (domain.outcome !== 'ready') {
      assert.fail('expected domain scan facts');
    }
    assert.equal(domain.facts.terms.length, 1);
    assert.equal(domain.facts.terms[0]?.hits.length, 1);
    assert.equal(domain.facts.inventory.skippedObjects.length, 0);
    const serializedFacts = canonicalJson(domain.facts);
    for (const forbidden of [
      'nodeId',
      'nodeSchema',
      'evaluator',
      'outputSchema',
      'provenanceParentNodeIds',
      'semanticParentResultDigests',
    ]) {
      assert.equal(serializedFacts.includes(`"${forbidden}"`), false);
    }

    const legacy = adaptInvestigationScanFactsResult(domain);
    assert.equal(legacy.outcome, 'ready');
    if (legacy.outcome !== 'ready') {
      assert.fail('expected legacy scan adapter');
    }
    assert.equal(
      legacy.inventory.treeDigest,
      domain.facts.inventory.treeDigest,
    );
    assert.deepEqual(
      legacy.inventory.skippedObjects,
      domain.facts.inventory.skippedObjects,
    );
    assert.deepEqual(
      legacy.nodes.map((node) => ({
        termId: (node.output as { termId: string }).termId,
        hits: (node.output as { hits: unknown[] }).hits,
      })),
      domain.facts.terms.map(({ term, hits }) => ({
        termId: term.termId,
        hits,
      })),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('domain grouping facts consume scanner facts without constructing evidence envelopes', () => {
  const repository = createScannerRepository();
  try {
    fs.writeFileSync(
      path.join(repository, 'src/base.txt'),
      'group-domain marker\ngroup-domain marker\n',
    );
    fs.writeFileSync(
      path.join(repository, 'src/secondary.ts'),
      'export const value = "group-domain";\n',
    );
    commitAll(repository, 'Add domain grouping fixture');
    const request = {
      repositoryRoot: repository,
      treeOid: treeOid(repository),
      terms: [termWithProvenance('literal-content', 'group-domain')],
    };
    const mutationPolicy = createMutationClassPolicy({ rules: [] });
    const declaredRoots = [{ rootId: 'repository', path: '' }];

    const scanFacts = scanInvestigationTreeFacts(request);
    assert.equal(scanFacts.outcome, 'ready');
    if (scanFacts.outcome !== 'ready') {
      assert.fail('expected domain scan facts');
    }
    const domain = deriveInvestigationGroupFacts({
      scanFacts: scanFacts.facts,
      mutationPolicy,
      declaredRoots,
      reviewedRelationships: [],
    });
    const serializedFacts = canonicalJson(domain);
    for (const forbidden of [
      'nodeId',
      'nodeSchema',
      'evaluator',
      'outputSchema',
      'provenanceParentNodeIds',
      'semanticParentResultDigests',
    ]) {
      assert.equal(serializedFacts.includes(`"${forbidden}"`), false);
    }

    const legacyScan = scanInvestigationTree(request);
    assert.equal(legacyScan.outcome, 'ready');
    if (legacyScan.outcome !== 'ready') {
      assert.fail('expected legacy scan adapter');
    }
    const legacyGroups = deriveInvestigationGroups({
      scanNodes: legacyScan.nodes,
      mutationPolicy,
      declaredRoots,
      reviewedRelationships: [],
      exceptions: [],
    }).groupNodes.map(readInvestigationGroupNode);

    const normalizeDomainGroups = domain.groups
      .map((group) => ({
        selector: group.selector,
        hits: group.hits
          .map(({ hitKey: _hitKey, ...hit }) => hit)
          .sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          ),
        sourceObjects: group.sourceObjects,
      }))
      .sort((left, right) =>
        canonicalJson(left.selector).localeCompare(
          canonicalJson(right.selector),
        ),
      );
    const normalizeLegacyGroups = legacyGroups
      .map((group) => ({
        selector: {
          termId: group.selector.termId,
          rootId: group.selector.rootId,
          extension: group.selector.extension,
          mutationClass: group.selector.mutationClass,
          relationshipId: group.selector.relationshipId,
          splitId: group.selector.splitId,
        },
        hits: group.hits
          .map(({ hitId: _hitId, ...hit }) => hit)
          .sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          ),
        sourceObjects: group.sourceObjects,
      }))
      .sort((left, right) =>
        canonicalJson(left.selector).localeCompare(
          canonicalJson(right.selector),
        ),
      );
    assert.deepEqual(normalizeDomainGroups, normalizeLegacyGroups);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Git-backed tracked projection replays deterministic evidence from the pinned tree', () => {
  const repository = createScannerRepository();
  try {
    fs.writeFileSync(
      path.join(repository, 'src/base.txt'),
      `${'needle\n'.repeat(100)}tail\n`,
    );
    commitAll(repository, 'Add repeated investigation evidence');
    const baseline = {
      head: git(repository, ['rev-parse', 'HEAD']).trim(),
      tree: treeOid(repository),
    };
    const term = termWithProvenance('literal-content', 'needle');
    const scan = scanInvestigationTree({
      repositoryRoot: repository,
      treeOid: baseline.tree,
      terms: [term],
    });
    assert.equal(scan.outcome, 'ready');
    if (scan.outcome !== 'ready') {
      assert.fail('expected a replayable scan');
    }
    const grouped = deriveInvestigationGroups({
      scanNodes: scan.nodes,
      mutationPolicy: createMutationClassPolicy({ rules: [] }),
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
      exceptions: [],
    });
    const dispositions = createInvestigationDispositionNodes({
      groupNodes: grouped.groupNodes,
      dispositions: grouped.groupNodes.map((node) => ({
        groupId: (node.output as { groupId: string }).groupId,
        classification: 'load-bearing',
        rationale: 'The repeated fixture is deliberately load-bearing.',
        author: 'projection-test',
      })),
    });
    const coverage = createInvestigationCoverageNode({
      effectiveTermIds: [term.termId],
      scanNodes: scan.nodes,
      inventoryNode: scan.inventory.evidenceNode,
      hitNodes: grouped.hitNodes,
      groupNodes: grouped.groupNodes,
      dispositionNodes: dispositions,
    });
    const termUnion = createEvidenceNode({
      type: 'investigation-term-union',
      nodeSchema: 'investigation.term-union.test.v1',
      evaluator: 'investigation-projection-test.v1',
      policyDigest: '1'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'investigation.term-union-output.test.v1',
      output: {
        rawCounts: { engine: 0, main: 1, reviewer: 0, survey: 0 },
        terms: [term],
      },
      runtimeMetadata: {},
    });
    const applicability = createInvestigationApplicability({
      kind: 'sealed-investigation',
      baseline,
      intentDigest: '2'.repeat(64),
      sealNodeId: coverage.nodeId,
      sealResultDigest: coverage.resultDigest,
    });
    const full = parseInvestigationArtifact(
      {
        schemaVersion: 1,
        kind: 'investigation-artifact',
        changeId: 'compact-investigation',
        legacyMigration: false,
        nodes: [
          termUnion,
          ...scan.nodes,
          scan.inventory.evidenceNode,
          ...grouped.hitNodes,
          ...grouped.groupNodes,
          ...dispositions,
          coverage,
        ].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        currentRefs: { coverage: coverage.nodeId },
        applicability,
      },
      'compact-investigation',
    );

    const projected = projectInvestigationArtifactForTracking(repository, full);
    assert.equal(projected.schemaVersion, 2);
    assert.equal(projected.nodes.length, 1);
    assert.ok(
      Buffer.byteLength(canonicalJson(projected)) <
        Buffer.byteLength(canonicalJson(full)) / 2,
    );

    const historicalTermUnion = createEvidenceNode({
      type: 'investigation-term-union',
      nodeSchema: 'investigation.term-union.test.v1',
      evaluator: 'investigation-projection-test.v1',
      policyDigest: '3'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'investigation.term-union-output.test.v1',
      output: termUnion.output,
      runtimeMetadata: {},
    });
    const multiEpoch = parseInvestigationArtifact(
      {
        ...full,
        nodes: [...full.nodes, historicalTermUnion].sort((left, right) =>
          left.nodeId.localeCompare(right.nodeId),
        ),
      },
      'compact-investigation',
    );
    assert.strictEqual(
      projectInvestigationArtifactForTracking(repository, multiEpoch),
      multiEpoch,
    );

    fs.writeFileSync(
      path.join(repository, 'src/base.txt'),
      'uncommitted worktree bytes must never satisfy replay\n',
    );
    const replayed = parseInvestigationArtifact(
      projected,
      'compact-investigation',
      { repositoryRoot: repository },
    );
    assert.equal(canonicalJson(replayed), canonicalJson(full));
    assert.throws(
      () => parseInvestigationArtifact(projected, 'compact-investigation'),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );

    const changedDisposition = {
      ...projected,
      replay: {
        ...projected.replay,
        dispositions: projected.replay.dispositions.map((disposition, index) =>
          index === 0
            ? {
                ...disposition,
                rationale:
                  'A different semantic decision cannot reuse the recorded node identity.',
              }
            : disposition,
        ),
      },
    };
    assert.throws(
      () =>
        parseInvestigationArtifact(
          changedDisposition,
          'compact-investigation',
          { repositoryRoot: repository },
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );

    const missingTree = {
      ...projected,
      applicability: {
        ...projected.applicability,
        baseline: {
          ...projected.applicability.baseline,
          tree: 'f'.repeat(40),
        },
      },
      replay: {
        ...projected.replay,
        baseline: { ...projected.replay.baseline, tree: 'f'.repeat(40) },
      },
    };
    assert.throws(
      () =>
        parseInvestigationArtifact(missingTree, 'compact-investigation', {
          repositoryRoot: repository,
        }),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );

    const treeObjectBaseline = {
      head: projected.applicability.baseline.tree,
      tree: projected.applicability.baseline.tree,
    };
    const treeObjectApplicability = createInvestigationApplicability({
      kind: 'sealed-investigation',
      baseline: treeObjectBaseline,
      intentDigest: projected.applicability.intentDigest,
      sealNodeId: projected.applicability.sealNodeId,
      sealResultDigest: projected.applicability.sealResultDigest,
    });
    const treeAsHead = {
      ...projected,
      applicability: treeObjectApplicability,
      replay: {
        ...projected.replay,
        baseline: treeObjectBaseline,
      },
    };
    assert.throws(
      () =>
        parseInvestigationArtifact(treeAsHead, 'compact-investigation', {
          repositoryRoot: repository,
        }),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createScannerRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-scanner-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'scanner@example.test']);
  git(repository, ['config', 'user.name', 'Scanner Test']);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'src/base.txt'), 'base\n');
  fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored/\n');
  commitAll(repository, 'Create scanner fixture');
  return repository;
}

function commitAll(repository: string, message: string): void {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', message]);
}

function treeOid(repository: string): string {
  return git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
}

function contribution(
  source: InvestigationTermContribution['source'],
  reference: string,
  terms: Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>,
): InvestigationTermContribution {
  if (source === 'main') {
    return {
      source,
      reference,
      terms: terms.map((term) => ({
        ...term,
        rationale: `Main investigation expects ${term.kind} ${term.value}.`,
        expectedRelationship:
          'The term may identify an existing consumer or invariant.',
      })),
    };
  }
  return { source, reference, terms };
}

function termWithProvenance(
  kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key',
  value: string,
) {
  return {
    ...normalizeInvestigationTerm({ kind, value }),
    provenance: [
      {
        source: 'main' as const,
        reference: `main:${value}`,
        rationale: `Main investigation expects ${kind} ${value}.`,
        expectedRelationship:
          'The term may identify an existing consumer or invariant.',
      },
    ],
  };
}

function completeFloorFacts(): EngineFloorFacts {
  return {
    explicitPaths: [
      'src/old-service.ts',
      '.codex/skills/openspec-propose/SKILL.md',
    ],
    symbols: ['OldService'],
    configKeys: ['protectedBranches'],
    transformations: [
      {
        kind: 'symbol',
        before: 'ARCHIVE_BASE',
        after: 'ARCHIVE_TARGET',
        reference: 'intent:rename-archive-symbol',
      },
    ],
    changedPaths: [
      {
        change: 'removed',
        before: 'config/removed-config.json',
        reference: 'diff:removed-config',
      },
      {
        change: 'renamed',
        before: 'src/legacy-name.ts',
        after: 'src/new-name.ts',
        reference: 'diff:rename-service',
      },
    ],
    reviewedCounterparts: [
      {
        kind: 'literal-path',
        value: '.agents/skills/openspec-propose/SKILL.md',
        subject: '.codex/skills/openspec-propose/SKILL.md',
        reference: 'reviewed-mirror:openspec-propose',
      },
    ],
  };
}

type ScanOutput = {
  termId: string;
  hits: Array<{
    path: { rawBase64: string; utf8: string | null };
    sourceObject: {
      objectId: string;
      objectType: string;
      mode: string;
      byteSize: number | null;
      contentSha256: string | null;
      skipReason: string | null;
    };
    surface: 'path' | 'content';
    byteOffset: number;
    byteLength: number;
  }>;
};

function scanOutput(
  result: Extract<InvestigationScanResult, { outcome: 'ready' }>,
  termId: string,
): ScanOutput {
  const node = result.nodes.find(
    (candidate) => (candidate.output as { termId: string }).termId === termId,
  );
  assert.ok(node, `missing scan node for ${termId}`);
  return node.output as ScanOutput;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
