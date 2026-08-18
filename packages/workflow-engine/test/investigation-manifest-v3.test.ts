import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { deriveInvestigationGroupFacts } from '../src/investigation-groups.ts';
import {
  buildInvestigationManifestDraft,
  inspectHistorical,
  sealInvestigationManifestDraft,
  validateDraftForSeal,
  validateForAuthority,
  type InvestigationAuthoringState,
  type OrdinaryInvestigationAuthoringState,
} from '../src/investigation-manifest.ts';
import { materializeInvestigationEvidenceView } from '../src/investigation-materializer.ts';
import { runGitBuffer } from '../src/git.ts';
import { scanInvestigationTreeFacts } from '../src/investigation-scanner.ts';
import {
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/investigation-terms.ts';
import { createMutationClassPolicy } from '../src/mutation-class-policy.ts';
import { git } from './fixture.ts';

test('ordinary v3 is built directly, sealed separately, and replayed from pinned Git', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
    assert.equal(built.outcome, 'built');
    const draft = built.draft;
    assert.equal(draft.schemaVersion, 3);
    assert.equal(draft.kind, 'manifest-first-investigation');
    assert.equal(draft.applicability.kind, 'ordinary');
    assert.equal(draft.investigationApproval, null);
    assert.equal(draft.manifestDigest, null);
    const serialized = canonicalJson(draft);
    for (const forbidden of [
      'nodes',
      'currentRefs',
      'legacyMigration',
      'nodeSchema',
      'outputSchema',
      'provenanceParentNodeIds',
      'semanticParentResultDigests',
    ]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }

    const draftValidation = validateDraftForSeal({
      repositoryRoot: repository,
      draft,
    });
    if (draftValidation.outcome !== 'verified') {
      assert.fail(canonicalJson(draftValidation.blocker));
    }
    assert.equal(draftValidation.outcome, 'verified');
    const sealed = sealInvestigationManifestDraft({
      draft,
      approval: {
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:investigation-approval',
        },
        approvalProvenanceDigest: digest('approval-provenance'),
      },
    });
    if (sealed.outcome !== 'sealed') {
      assert.fail(sealed.blocker.failureCode);
    }
    assert.equal(sealed.outcome, 'sealed');
    assert.match(
      sealed.manifest.investigationApproval.sealDigest,
      /^[0-9a-f]{64}$/,
    );
    assert.match(sealed.manifest.manifestDigest, /^[0-9a-f]{64}$/);

    fs.writeFileSync(
      path.join(repository, 'src/domain.ts'),
      'dirty worktree content must not affect pinned replay\n',
    );
    const authority = validateForAuthority({
      repositoryRoot: repository,
      manifest: sealed.manifest,
      expected: {
        repositoryId: 'expense-app-test',
        changeId: 'manifest-first-v3',
        investigationId: 'investigation-v3-test',
        sessionRevision: 7,
        sessionSnapshotDigest: digest('session-snapshot'),
      },
    });
    if (authority.outcome !== 'verified') {
      assert.fail(authority.blocker.failureCode);
    }
    assert.equal(authority.outcome, 'verified');
    assert.equal(authority.manifestDigest, sealed.manifest.manifestDigest);

    const historical = inspectHistorical({
      repositoryRoot: repository,
      manifest: sealed.manifest,
    });
    assert.equal(historical.outcome, 'inspected');
    if (historical.outcome === 'inspected') {
      assert.equal(historical.authorityEligible, false);
    }

    const overKeyed = structuredClone(sealed.manifest) as unknown as Record<
      string,
      unknown
    >;
    overKeyed.unexpected = true;
    const rejected = validateForAuthority({
      repositoryRoot: repository,
      manifest: overKeyed,
      expected: authorityExpected(),
    });
    assert.equal(rejected.outcome, 'blocked');
    if (rejected.outcome === 'blocked') {
      assert.equal(rejected.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }

    const staleGroupRef = structuredClone(sealed.manifest);
    assert.equal(staleGroupRef.applicability.kind, 'ordinary');
    if (staleGroupRef.applicability.kind !== 'ordinary') {
      assert.fail('ordinary applicability expected');
    }
    staleGroupRef.applicability.semanticDelta.dispositions[0]!.groupRef.index = 999;
    const staleGroupRefResult = validateForAuthority({
      repositoryRoot: repository,
      manifest: staleGroupRef,
      expected: authorityExpected(),
    });
    assert.equal(staleGroupRefResult.outcome, 'blocked');
    if (staleGroupRefResult.outcome === 'blocked') {
      assert.equal(
        staleGroupRefResult.blocker.failureCode,
        'RECONSTRUCTION_MISMATCH',
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v3 exemption is a strict separate branch with no synthetic proof collections', () => {
  const repository = createRepository();
  try {
    const baseline = baselineOf(repository);
    const state: InvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: 'expense-app-test',
      changeId: 'manifest-first-v3-exemption',
      investigationId: 'investigation-v3-exemption',
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Refresh explanatory documentation only.',
        explicitPaths: ['docs/example.md'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: {
        sessionRevision: 0,
        sessionSnapshotDigest: digest('exemption-snapshot'),
      },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: ['docs/example.md'],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'Only prose changes; no behavior is relied upon.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:exemption',
        },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    };
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
    assert.equal(built.outcome, 'built');
    assert.equal(built.draft.applicability.kind, 'exemption');
    const serialized = canonicalJson(built.draft.applicability);
    for (const absent of [
      'replayContract',
      'semanticDelta',
      'derivedCommitments',
      'canonicalTerms',
      'dispositions',
      'whyOverlays',
    ]) {
      assert.equal(serialized.includes(`"${absent}"`), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v3 validation rejects schema v1 through a structured non-grant blocker', () => {
  const repository = createRepository();
  try {
    const result = validateForAuthority({
      repositoryRoot: repository,
      manifest: {
        schemaVersion: 1,
        kind: 'investigation-artifact',
      },
      expected: authorityExpected(),
    });
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked') {
      assert.equal(result.blocker.failureCode, 'SCHEMA_V1_FORBIDDEN');
      assert.equal('grantId' in result.blocker, false);
      assert.equal(
        canonicalJson(result.blocker).toLowerCase().includes('grant'),
        false,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('MaterializedEvidenceView is process-local and the direct writer has no projection dependency', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    assert.equal(state.applicabilityKind, 'ordinary');
    if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: state.ordinary,
    });
    assert.throws(
      () => JSON.stringify(view),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'PROJECTION_PIPELINE_FORBIDDEN',
    );
    assert.deepEqual(
      Object.keys(view),
      [],
      'the process-local view must not expose serializable own state',
    );
    assert.deepEqual(
      structuredClone(view),
      {},
      'structured cloning the view must not copy evidence into a durable shape',
    );
    assert.deepEqual(view.canonicalTerms, state.ordinary.canonicalTerms);
    for (const moduleName of [
      'investigation-manifest.ts',
      'investigation-materializer.ts',
    ]) {
      const source = fs.readFileSync(
        new URL(`../src/${moduleName}`, import.meta.url),
        'utf8',
      );
      assert.equal(source.includes('investigation-artifact-projection'), false);
      assert.equal(source.includes('createEvidenceNode'), false);
      assert.equal(source.includes("from './evidence-node.ts'"), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('every load-bearing path/blob has exactly one complete WHY overlay or fresh knowledge reuse', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    assert.equal(state.applicabilityKind, 'ordinary');
    if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    state.ordinary.dispositionDecisions =
      state.ordinary.dispositionDecisions.map((decision) => ({
        ...decision,
        classification: 'load-bearing',
      }));
    const missing = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    assert.equal(missing.outcome, 'blocked');
    if (missing.outcome === 'blocked') {
      assert.equal(
        missing.blocker.failureCode,
        'SEMANTIC_COMPLETENESS_FAILURE',
      );
    }

    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: state.ordinary,
    });
    const firstHit = view.grouping.hits[0]!;
    state.ordinary.whyOverlays = [
      {
        overlayId: 'why:domain-source',
        pathIdentity: firstHit.path,
        blobOid: firstHit.sourceObject.objectId,
        contentSha256: firstHit.sourceObject.contentSha256!,
        groupRefs: view.dispositions.map(({ groupRef }) => groupRef),
        anchors: view.grouping.hits.map((hit) => ({
          pathIdentity: hit.path,
          blobOid: hit.sourceObject.objectId,
          byteRange: {
            start: hit.byteOffset,
            end: hit.byteOffset + hit.byteLength,
          },
          termId: hit.termId,
        })),
        why: 'This source defines both Manifest-first fixture identities.',
        protectedInvariant: 'Both exact symbols remain bound to pinned bytes.',
        reviewerQuestion: 'Does the change preserve both source identities?',
        answer: 'Yes; both anchors are explicitly reconciled.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:why',
        },
        readComplete: true,
        semanticAssurance: 'actor-attested-not-engine-verified',
      },
    ];
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') {
      assert.fail(canonicalJson(built.blocker));
    }
    assert.equal(built.draft.applicability.kind, 'ordinary');

    const stale = structuredClone(state);
    assert.equal(stale.applicabilityKind, 'ordinary');
    if (stale.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    stale.ordinary.whyOverlays[0]!.anchors[0]!.byteRange.end += 1;
    const rejected = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: stale,
    });
    assert.equal(rejected.outcome, 'blocked');
    if (rejected.outcome === 'blocked') {
      assert.equal(rejected.blocker.failureCode, 'SOURCE_ANCHOR_UNRESOLVED');
    }

    const reused = structuredClone(state);
    assert.equal(reused.applicabilityKind, 'ordinary');
    if (reused.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    reused.ordinary.whyOverlays = [];
    reused.ordinary.knowledgeReuseDecisions = [
      {
        decisionId: 'reuse:domain-source',
        pathIdentity: firstHit.path,
        blobOid: firstHit.sourceObject.objectId,
        knowledgeRef: {
          subjectId: 'knowledge:manifest-first-domain',
          versionDigest: digest('knowledge-version'),
        },
        freshness: {
          decision: 'fresh',
          rationale: 'The immutable knowledge version names these exact bytes.',
          semanticAuthor: {
            id: 'owner',
            provenance: 'checkpoint:knowledge-reuse',
          },
          provenanceDigest: digest('knowledge-freshness'),
        },
      },
    ];
    const reusedBuilt = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: reused,
    });
    if (reusedBuilt.outcome !== 'built') {
      assert.fail(canonicalJson(reusedBuilt.blocker));
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('raw-byte anchors replay identically for a non-UTF-8 Git path in another clone', () => {
  const repository = createRepository();
  const clone = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-manifest-v3-clone-'),
  );
  try {
    const rawPath = Buffer.concat([
      Buffer.from(`src/`, 'utf8'),
      Buffer.from('raw-', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('-anchor.ts', 'utf8'),
    ]);
    const rawBlob = runGitBuffer(repository, ['hash-object', '-w', '--stdin'], {
      input: Buffer.from('export const rawAnchor = true;\n', 'utf8'),
    })
      .toString('ascii')
      .trim();
    runGitBuffer(repository, ['update-index', '-z', '--index-info'], {
      input: Buffer.concat([
        Buffer.from(`100644 blob ${rawBlob}\t`, 'ascii'),
        rawPath,
        Buffer.from([0]),
      ]),
    });
    git(repository, ['commit', '-m', 'Add non UTF-8 investigation path']);
    const contribution: InvestigationTermContribution<'main'> = {
      source: 'main',
      reference: 'main:raw-path-anchor',
      terms: [
        {
          kind: 'literal-path',
          value: 'anchor.ts',
          rationale: 'Locate the raw-byte path suffix.',
          expectedRelationship: 'The invalid UTF-8 path is load-bearing.',
        },
      ],
    };
    const preview = previewInvestigationTermUnion([contribution]);
    assert.equal(preview.outcome, 'ready');
    if (preview.outcome !== 'ready') assert.fail('expected raw path term');
    const baseline = baselineOf(repository);
    const mutationPolicy = createMutationClassPolicy({ rules: [] });
    const scan = scanInvestigationTreeFacts({
      repositoryRoot: repository,
      treeOid: baseline.treeOid,
      terms: preview.terms,
    });
    assert.equal(scan.outcome, 'ready');
    if (scan.outcome !== 'ready') assert.fail('expected raw path scan');
    const grouping = deriveInvestigationGroupFacts({
      scanFacts: scan.facts,
      mutationPolicy,
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
    });
    assert.equal(grouping.hits.length, 1);
    assert.equal(grouping.hits[0]!.path.utf8, null);
    const ordinary: OrdinaryInvestigationAuthoringState['ordinary'] = {
      baseline,
      termContributions: [contribution],
      canonicalTerms: preview.terms,
      scanner: {
        allowSaturatedTerms: false,
        saturationDecision: null,
      },
      grouping: {
        mutationPolicy,
        declaredRoots: [{ rootId: 'repository', path: '' }],
        reviewedRelationships: [],
      },
      semanticGroupDecisions: [],
      dispositionDecisions: grouping.groups.map((group) => ({
        groupKey: group.key,
        classification: 'load-bearing',
        rationale: 'The raw-byte path is part of the planned behavior.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:raw-path-disposition',
        },
      })),
      whyOverlays: [],
      knowledgeReuseDecisions: [],
      investigationRoleResults: [
        {
          role: 'blind-surveyor' as const,
          targetDigest: digest('raw-role-target'),
          providerId: 'codex',
          sessionId: 'raw-path-session',
          principalId: null,
          requiredIndependence: 'provider-independent',
          achievedIndependence: 'provider-independent',
          requestDigest: digest('raw-role-request'),
          outputDigest: digest('raw-role-output'),
          contentDigest: digest('raw-role-content'),
          policyDigest: digest('raw-role-policy'),
          provenanceDigest: digest('raw-role-provenance'),
        },
      ],
      floorOverflowDecision: null,
      exceptions: [],
      investigationRequirements: [],
      assuranceFacts: {
        assessmentDigest: digest('raw-assessment'),
        coverageTier: 'standard' as const,
        escalated: false,
        reasons: [],
        provenanceDigest: digest('raw-assessment-provenance'),
      },
    };
    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: ordinary,
    });
    const hit = view.grouping.hits[0]!;
    ordinary.whyOverlays = [
      {
        overlayId: 'why:raw-path',
        pathIdentity: hit.path,
        blobOid: hit.sourceObject.objectId,
        contentSha256: hit.sourceObject.contentSha256!,
        groupRefs: view.dispositions.map(({ groupRef }) => groupRef),
        anchors: [
          {
            pathIdentity: hit.path,
            blobOid: hit.sourceObject.objectId,
            byteRange: {
              start: hit.byteOffset,
              end: hit.byteOffset + hit.byteLength,
            },
            termId: hit.termId,
          },
        ],
        why: 'The exact raw path identifies the load-bearing source.',
        protectedInvariant:
          'Invalid UTF-8 bytes are never replaced by display text.',
        reviewerQuestion: 'Does replay bind the same raw Git path bytes?',
        answer: 'Yes; rawBase64 and the half-open byte range are exact.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:raw-path-why',
        },
        readComplete: true as const,
        semanticAssurance: 'actor-attested-not-engine-verified' as const,
      },
    ];
    const state: InvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'ordinary',
      repositoryId: 'expense-app-raw-path-test',
      changeId: 'manifest-first-v3-raw-path',
      investigationId: 'investigation-v3-raw-path',
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Bind a non UTF-8 Git path without lossy display conversion.',
        explicitPaths: [],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: {
        sessionRevision: 1,
        sessionSnapshotDigest: digest('raw-path-snapshot'),
      },
      ordinary,
    };
    const original = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (original.outcome !== 'built') assert.fail(original.blocker.failureCode);

    fs.rmSync(clone, { recursive: true, force: true });
    git(repository, [
      'clone',
      '--no-hardlinks',
      '--no-checkout',
      repository,
      clone,
    ]);
    fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(clone, 'src/domain.ts'),
      'dirty clone bytes must not affect pinned raw-path replay\n',
    );
    const cloned = buildInvestigationManifestDraft({
      repositoryRoot: clone,
      state,
    });
    if (cloned.outcome !== 'built') assert.fail(cloned.blocker.failureCode);
    assert.equal(canonicalJson(cloned.draft), canonicalJson(original.draft));
    assert.equal(
      cloned.draft.applicability.kind === 'ordinary'
        ? cloned.draft.applicability.semanticDelta.whyOverlays[0]!.pathIdentity
            .utf8
        : 'wrong-branch',
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

function ordinaryAuthoringState(
  repository: string,
): InvestigationAuthoringState {
  const normalizedIntent = {
    schemaVersion: 1 as const,
    summary: 'Introduce a ManifestFirst implementation.',
    explicitPaths: [],
    explicitSymbols: ['ManifestFirst'],
    explicitConfigKeys: [],
    renamePairs: [],
  };
  const contributions: InvestigationTermContribution[] = [
    {
      source: 'engine',
      reference: 'engine-floor:manifest-first-v3',
      terms: [{ kind: 'symbol', value: 'ManifestFirst' }],
    },
    {
      source: 'main',
      reference: 'main:manifest-first-v3',
      terms: [
        {
          kind: 'literal-content',
          value: 'manifest-first',
          rationale: 'Locate the intended direct-writer fixture.',
          expectedRelationship: 'It is the behavior under investigation.',
        },
      ],
    },
  ];
  const preview = previewInvestigationTermUnion(contributions);
  assert.equal(preview.outcome, 'ready');
  if (preview.outcome !== 'ready') assert.fail('expected term union');
  const baseline = baselineOf(repository);
  const mutationPolicy = createMutationClassPolicy({ rules: [] });
  const scan = scanInvestigationTreeFacts({
    repositoryRoot: repository,
    treeOid: baseline.treeOid,
    terms: preview.terms,
  });
  assert.equal(scan.outcome, 'ready');
  if (scan.outcome !== 'ready') assert.fail('expected scan facts');
  const grouping = deriveInvestigationGroupFacts({
    scanFacts: scan.facts,
    mutationPolicy,
    declaredRoots: [{ rootId: 'repository', path: '' }],
    reviewedRelationships: [],
  });
  return {
    schemaVersion: 1,
    applicabilityKind: 'ordinary',
    repositoryId: 'expense-app-test',
    changeId: 'manifest-first-v3',
    investigationId: 'investigation-v3-test',
    normalizedIntent,
    authoring: {
      sessionRevision: 7,
      sessionSnapshotDigest: digest('session-snapshot'),
    },
    ordinary: {
      baseline,
      termContributions: contributions,
      canonicalTerms: preview.terms,
      scanner: {
        allowSaturatedTerms: false,
        saturationDecision: null,
      },
      grouping: {
        mutationPolicy,
        declaredRoots: [{ rootId: 'repository', path: '' }],
        reviewedRelationships: [],
      },
      semanticGroupDecisions: [],
      dispositionDecisions: grouping.groups.map((group) => ({
        groupKey: group.key,
        classification: 'irrelevant',
        rationale: 'The fixture proves replay but is not load-bearing.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:dispositions',
        },
      })),
      whyOverlays: [],
      knowledgeReuseDecisions: [],
      investigationRoleResults: [
        {
          role: 'blind-surveyor',
          targetDigest: digest('survey-target'),
          providerId: 'codex',
          sessionId: 'survey-session',
          principalId: null,
          requiredIndependence: 'provider-independent',
          achievedIndependence: 'provider-independent',
          requestDigest: digest('survey-request'),
          outputDigest: digest('survey-output'),
          contentDigest: digest('survey-content'),
          policyDigest: digest('survey-policy'),
          provenanceDigest: digest('survey-provenance'),
        },
      ],
      floorOverflowDecision: null,
      exceptions: [],
      investigationRequirements: [],
      assuranceFacts: {
        assessmentDigest: digest('assurance-assessment'),
        coverageTier: 'standard',
        escalated: false,
        reasons: [],
        provenanceDigest: digest('assurance-provenance'),
      },
    },
  };
}

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-manifest-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'manifest-v3@example.test']);
  git(repository, ['config', 'user.name', 'Manifest V3 Test']);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'src/domain.ts'),
    'export const ManifestFirst = "manifest-first";\n',
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create manifest v3 fixture']);
  return repository;
}

function baselineOf(repository: string) {
  return {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
}

function authorityExpected() {
  return {
    repositoryId: 'expense-app-test',
    changeId: 'manifest-first-v3',
    investigationId: 'investigation-v3-test',
    sessionRevision: 7,
    sessionSnapshotDigest: digest('session-snapshot'),
  };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
