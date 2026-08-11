import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { isRecord } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  canonicalPatchManifest,
  parsePatchManifest,
  type CheckDependency,
  type PatchManifest,
} from './maintainer-manifest.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';
import type { TaskMandateBinding } from './task-mandate.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INVOCATION_ID = /^invocation-[A-Za-z0-9-]+$/;
const INVESTIGATION_ID = /^investigation-[A-Za-z0-9-]+$/;

export type CheckReuseClass =
  'content-pure' | 'toolchain-dependent' | 'external-state';

export type { CheckDependency } from './maintainer-manifest.ts';

export type CandidateCheckAttestation = {
  checkId: string;
  definitionDigest: string;
  commandDigest: string;
  runnerDigest: string;
  environmentDigest: string;
  resultDigest: string;
  outcome: 'passed';
  startedAt: string;
  completedAt: string;
  reuseClass: CheckReuseClass;
  maxAgeMs: number | null;
  externalSnapshotDigest: string | null;
  dependsOn: CheckDependency[];
};

export type CandidateChecksAttestation = {
  schemaVersion: 2;
  candidateTree: string;
  patchDigest: string;
  trustBaseCommit: string;
  checks: CandidateCheckAttestation[];
};

export type CandidateDependencySnapshot = {
  schemaVersion: 1;
  sourceTree: string;
  baseCommit: string;
  harnessEngineDigest: string;
  policyDigest: string;
  runnerDigests: Record<string, string>;
  externalStateDigests: Record<string, string | null>;
};

export type CandidateChecksAttestationV3 = {
  schemaVersion: 3;
  candidateTree: string;
  patchDigest: string;
  trustBaseCommit: string;
  dependencySnapshot: CandidateDependencySnapshot;
  checks: CandidateCheckAttestation[];
};

export type CandidateClassification =
  'ordinary' | 'root-one-shot' | 'control-plane';

type ImmutableCandidateBundleCommon = {
  mandateBinding: TaskMandateBinding;
  repositoryId: string;
  targetRef: string;
  expectedOldCommit: string;
  expectedRefGeneration: number;
  candidateCommit: string;
  resultTree: string;
  commitMessage: string;
  manifest: PatchManifest;
  manifestDigest: string;
  checksAttestationDigest: string;
  effectsManifestDigest: string;
  providerInvocationsDigest: string;
  classification: CandidateClassification;
  recoveryPlanDigest: string;
  createdAt: string;
  candidateBundleDigest: string;
};

export type ImmutableCandidateBundle = ImmutableCandidateBundleCommon & {
  schemaVersion: 1;
  checksAttestation: CandidateChecksAttestation;
};

export type ImmutableCandidateBundleV2 = ImmutableCandidateBundleCommon & {
  schemaVersion: 2;
  checksAttestation: CandidateChecksAttestationV3;
  humanReadableSummaryDigest: string;
};

export type AnyImmutableCandidateBundle =
  ImmutableCandidateBundle | ImmutableCandidateBundleV2;

export type ImmutableCandidateBundleInput = Omit<
  ImmutableCandidateBundle,
  | 'schemaVersion'
  | 'manifestDigest'
  | 'checksAttestationDigest'
  | 'candidateBundleDigest'
> & {
  candidateBundleDigest?: string;
};

export type ImmutableCandidateBundleV2Input = Omit<
  ImmutableCandidateBundleV2,
  | 'schemaVersion'
  | 'manifestDigest'
  | 'checksAttestationDigest'
  | 'humanReadableSummaryDigest'
  | 'candidateBundleDigest'
> & {
  candidateBundleDigest?: string;
};

export type CandidateExternalEffect = {
  effectType: string;
  targetDigest: string;
  authorizationDigest: string | null;
  resultDigest: string | null;
};

export type CandidateExternalEffectsManifest = {
  schemaVersion: 1;
  kind: 'candidate-external-effects.v1';
  changeId: string;
  mandateBinding: TaskMandateBinding;
  effects: CandidateExternalEffect[];
};

export type CandidateProviderInvocation = {
  invocationId: string;
  investigationId: string;
  purpose: 'survey' | 'plan-review' | 'task-diff-review';
  attempt: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  requestDigest: string;
  manifestDigest: string;
  outputDigest: string | null;
  failureDigest: string | null;
};

export type CandidateProviderInvocationsManifest = {
  schemaVersion: 1;
  kind: 'candidate-provider-invocations.v1';
  changeId: string;
  mandateBinding: TaskMandateBinding;
  invocations: CandidateProviderInvocation[];
};

export type CandidateRecoveryPlan = {
  schemaVersion: 1;
  kind: 'candidate-recovery-plan.v1';
  changeId: string;
  mandateBinding: TaskMandateBinding;
  targetRef: string;
  expectedOldCommit: string;
  expectedRefGeneration: number;
  candidateCommit: string;
  rollbackTarget: string;
};

export type CandidateSupportingArtifact =
  | CandidateExternalEffectsManifest
  | CandidateProviderInvocationsManifest
  | CandidateRecoveryPlan;

export type CandidateSupportingArtifactSet = {
  effectsManifest: CandidateExternalEffectsManifest;
  providerInvocations: CandidateProviderInvocationsManifest;
  recoveryPlan: CandidateRecoveryPlan;
};

/**
 * Freeze the caller's explicit external-effect declaration before any human
 * candidate signing. An explicit empty array is meaningful; omission is not.
 * Non-empty declarations remain fail-closed until Apply can verify the exact
 * separately issued External Effect Grant and production executor receipt.
 */
export function buildCandidateExternalEffectsManifest(input: {
  changeId: string;
  mandateBinding: TaskMandateBinding;
  externalEffects: unknown;
}): CandidateExternalEffectsManifest {
  if (!Array.isArray(input.externalEffects)) {
    throw candidateError(
      'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED',
      'Approve-and-apply requires an explicit canonical external effects declaration; use an empty array only when no effects are declared.',
    );
  }
  const artifact = assertCandidateSupportingArtifact({
    schemaVersion: 1,
    kind: 'candidate-external-effects.v1',
    changeId: input.changeId,
    mandateBinding: input.mandateBinding,
    effects: input.externalEffects,
  });
  if (artifact.kind !== 'candidate-external-effects.v1') {
    throw candidateArtifactInvalid();
  }
  if (artifact.effects.length > 0) {
    throw candidateError(
      'APPLY_CANDIDATE_EXTERNAL_EFFECT_UNSUPPORTED',
      'Apply does not execute external effects, and this candidate declaration cannot yet be verified against a separate production External Effect Grant receipt.',
    );
  }
  return artifact;
}

export type StoredCandidateSupportingArtifacts = {
  effectsManifestDigest: string;
  providerInvocationsDigest: string;
  recoveryPlanDigest: string;
  paths: string[];
};

export function buildImmutableCandidateBundle(
  input: ImmutableCandidateBundleInput,
): ImmutableCandidateBundle {
  const mandateBinding = assertCandidateMandateBinding(input.mandateBinding);
  const manifest = parsePatchManifest(canonicalPatchManifest(input.manifest));
  const checksAttestation = assertCandidateChecksAttestation(
    input.checksAttestation,
  );
  const createdAt = exactTimestamp(input.createdAt, 'candidate creation time');
  if (
    !/^github:[A-Za-z0-9_.:-]+$/.test(input.repositoryId) ||
    !validRef(input.targetRef) ||
    !OBJECT_ID.test(input.expectedOldCommit) ||
    !Number.isSafeInteger(input.expectedRefGeneration) ||
    input.expectedRefGeneration < 0 ||
    !OBJECT_ID.test(input.candidateCommit) ||
    input.candidateCommit === input.expectedOldCommit ||
    !OBJECT_ID.test(input.resultTree) ||
    !validCommitMessage(input.commitMessage) ||
    !DIGEST.test(input.effectsManifestDigest) ||
    !DIGEST.test(input.providerInvocationsDigest) ||
    !['ordinary', 'root-one-shot', 'control-plane'].includes(
      input.classification,
    ) ||
    !DIGEST.test(input.recoveryPlanDigest) ||
    checksAttestation.candidateTree !== input.resultTree ||
    checksAttestation.patchDigest !== manifest.patchDigest ||
    checksAttestation.trustBaseCommit !== manifest.trustBaseCommit
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_INVALID',
      'Immutable candidate bundle bindings are malformed or inconsistent.',
    );
  }
  const bundleBody = {
    schemaVersion: 1 as const,
    mandateBinding,
    repositoryId: input.repositoryId,
    targetRef: input.targetRef,
    expectedOldCommit: input.expectedOldCommit,
    expectedRefGeneration: input.expectedRefGeneration,
    candidateCommit: input.candidateCommit,
    resultTree: input.resultTree,
    commitMessage: input.commitMessage,
    manifest,
    manifestDigest: digest(canonicalPatchManifest(manifest)),
    checksAttestation,
    checksAttestationDigest: digest(canonicalJson(checksAttestation)),
    effectsManifestDigest: input.effectsManifestDigest,
    providerInvocationsDigest: input.providerInvocationsDigest,
    classification: input.classification,
    recoveryPlanDigest: input.recoveryPlanDigest,
    createdAt,
  };
  const candidateBundleDigest = digest(canonicalJson(bundleBody));
  if (
    input.candidateBundleDigest !== undefined &&
    input.candidateBundleDigest !== candidateBundleDigest
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_DIGEST_MISMATCH',
      'Candidate bundle digest differs from its canonical content.',
    );
  }
  return { ...bundleBody, candidateBundleDigest };
}

export function buildImmutableCandidateBundleV2(
  input: ImmutableCandidateBundleV2Input,
): {
  bundle: ImmutableCandidateBundleV2;
  humanReadableSummary: string;
} {
  const mandateBinding = assertCandidateMandateBinding(input.mandateBinding);
  const manifest = parsePatchManifest(canonicalPatchManifest(input.manifest));
  const checksAttestation = assertCandidateChecksAttestationV3(
    input.checksAttestation,
  );
  const createdAt = exactTimestamp(input.createdAt, 'candidate creation time');
  if (
    !/^github:[A-Za-z0-9_.:-]+$/.test(input.repositoryId) ||
    !validRef(input.targetRef) ||
    !OBJECT_ID.test(input.expectedOldCommit) ||
    !Number.isSafeInteger(input.expectedRefGeneration) ||
    input.expectedRefGeneration < 0 ||
    !OBJECT_ID.test(input.candidateCommit) ||
    input.candidateCommit === input.expectedOldCommit ||
    !OBJECT_ID.test(input.resultTree) ||
    !validCommitMessage(input.commitMessage) ||
    !DIGEST.test(input.effectsManifestDigest) ||
    !DIGEST.test(input.providerInvocationsDigest) ||
    !['ordinary', 'root-one-shot', 'control-plane'].includes(
      input.classification,
    ) ||
    !DIGEST.test(input.recoveryPlanDigest) ||
    checksAttestation.candidateTree !== input.resultTree ||
    checksAttestation.patchDigest !== manifest.patchDigest ||
    checksAttestation.trustBaseCommit !== manifest.trustBaseCommit ||
    checksAttestation.dependencySnapshot.sourceTree !== input.resultTree ||
    checksAttestation.dependencySnapshot.baseCommit !==
      input.expectedOldCommit ||
    checksAttestation.dependencySnapshot.policyDigest !== manifest.policyDigest
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_INVALID',
      'Immutable candidate v2 bindings are malformed or inconsistent.',
    );
  }
  const summaryMaterial = {
    schemaVersion: 2 as const,
    mandateBinding,
    repositoryId: input.repositoryId,
    targetRef: input.targetRef,
    expectedOldCommit: input.expectedOldCommit,
    expectedRefGeneration: input.expectedRefGeneration,
    candidateCommit: input.candidateCommit,
    resultTree: input.resultTree,
    commitMessage: input.commitMessage,
    manifest,
    manifestDigest: digest(canonicalPatchManifest(manifest)),
    checksAttestation,
    checksAttestationDigest: digest(canonicalJson(checksAttestation)),
    effectsManifestDigest: input.effectsManifestDigest,
    providerInvocationsDigest: input.providerInvocationsDigest,
    classification: input.classification,
    recoveryPlanDigest: input.recoveryPlanDigest,
    createdAt,
  };
  const humanReadableSummary = candidateHumanReadableSummary(summaryMaterial);
  const humanReadableSummaryDigest = digest(humanReadableSummary);
  const bundleBody = { ...summaryMaterial, humanReadableSummaryDigest };
  const candidateBundleDigest = digest(canonicalJson(bundleBody));
  if (
    input.candidateBundleDigest !== undefined &&
    input.candidateBundleDigest !== candidateBundleDigest
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_DIGEST_MISMATCH',
      'Candidate v2 bundle digest differs from its canonical content.',
    );
  }
  return {
    bundle: { ...bundleBody, candidateBundleDigest },
    humanReadableSummary,
  };
}

export function canonicalCandidateHumanReadableSummary(
  candidate: ImmutableCandidateBundleV2,
): string {
  return candidateHumanReadableSummary(candidate);
}

function candidateHumanReadableSummary(
  candidate: Omit<
    ImmutableCandidateBundleV2,
    'humanReadableSummaryDigest' | 'candidateBundleDigest'
  >,
): string {
  const checks = candidate.checksAttestation.checks;
  const requiredChecks = checks.map(({ checkId }) => checkId);
  const changedPaths = candidate.manifest.files.map(
    (entry) =>
      `- ${JSON.stringify(entry.path)} — ${entry.operation}; ${entry.role}`,
  );
  const checkLines = checks.map(
    (check) =>
      `- ${JSON.stringify(check.checkId)} — completed ${check.completedAt}; depends on ${check.dependsOn.join(', ')}`,
  );
  return [
    '# Immutable Candidate Summary',
    '',
    `Change: \`${candidate.mandateBinding.changeId}\``,
    `Task: \`${candidate.mandateBinding.mandateTaskId}\``,
    `Repository: \`${candidate.repositoryId}\``,
    `Profile: \`${candidate.manifest.profile}@${candidate.manifest.profileVersion}\``,
    `Classification: \`${candidate.classification}\``,
    `Target ref: \`${candidate.targetRef}\``,
    `Expected old commit: \`${candidate.expectedOldCommit}\``,
    `Expected ref generation: \`${candidate.expectedRefGeneration}\``,
    `Candidate commit: \`${candidate.candidateCommit}\``,
    `Result tree: \`${candidate.resultTree}\``,
    `Patch digest: \`${candidate.manifest.patchDigest}\``,
    `Required checks: ${requiredChecks.map((value) => `\`${value}\``).join(', ')}`,
    `Changed paths: \`${candidate.manifest.files.length}\``,
    `Created at: \`${candidate.createdAt}\``,
    '',
    '## Changed paths',
    '',
    ...changedPaths,
    '',
    '## Checks',
    '',
    ...checkLines,
    '',
    '## Supporting artifacts',
    '',
    `- External effects: \`${candidate.effectsManifestDigest}\``,
    `- Provider invocations: \`${candidate.providerInvocationsDigest}\``,
    `- Recovery plan: \`${candidate.recoveryPlanDigest}\``,
    '',
  ].join('\n');
}

const CANDIDATE_V1_KEYS = [
  'schemaVersion',
  'mandateBinding',
  'repositoryId',
  'targetRef',
  'expectedOldCommit',
  'expectedRefGeneration',
  'candidateCommit',
  'resultTree',
  'commitMessage',
  'manifest',
  'manifestDigest',
  'checksAttestation',
  'checksAttestationDigest',
  'effectsManifestDigest',
  'providerInvocationsDigest',
  'classification',
  'recoveryPlanDigest',
  'createdAt',
  'candidateBundleDigest',
];

const CANDIDATE_V2_KEYS = [...CANDIDATE_V1_KEYS, 'humanReadableSummaryDigest'];

export function canonicalImmutableCandidateBundle(
  bundle: AnyImmutableCandidateBundle,
): string {
  return `${canonicalJson(bundle)}\n`;
}

export function parseImmutableCandidateBundle(
  raw: string,
): AnyImmutableCandidateBundle {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length < 3 ||
      raw.length > 4_194_304 ||
      !raw.endsWith('\n')
    ) {
      throw new Error('invalid candidate bytes');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      !hasExactKeys(
        value,
        value.schemaVersion === 1 ? CANDIDATE_V1_KEYS : CANDIDATE_V2_KEYS,
      ) ||
      !isRecord(value.mandateBinding) ||
      typeof value.repositoryId !== 'string' ||
      typeof value.targetRef !== 'string' ||
      typeof value.expectedOldCommit !== 'string' ||
      typeof value.expectedRefGeneration !== 'number' ||
      typeof value.candidateCommit !== 'string' ||
      typeof value.resultTree !== 'string' ||
      typeof value.commitMessage !== 'string' ||
      !isRecord(value.manifest) ||
      typeof value.manifestDigest !== 'string' ||
      !isRecord(value.checksAttestation) ||
      typeof value.checksAttestationDigest !== 'string' ||
      typeof value.effectsManifestDigest !== 'string' ||
      typeof value.providerInvocationsDigest !== 'string' ||
      (value.classification !== 'ordinary' &&
        value.classification !== 'root-one-shot' &&
        value.classification !== 'control-plane') ||
      typeof value.recoveryPlanDigest !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.candidateBundleDigest !== 'string' ||
      (value.schemaVersion === 2 &&
        typeof value.humanReadableSummaryDigest !== 'string')
    ) {
      throw new Error('invalid candidate shape');
    }
    const manifest = parsePatchManifest(value.manifest);
    const common = {
      mandateBinding: value.mandateBinding as TaskMandateBinding,
      repositoryId: value.repositoryId,
      targetRef: value.targetRef,
      expectedOldCommit: value.expectedOldCommit,
      expectedRefGeneration: value.expectedRefGeneration as number,
      candidateCommit: value.candidateCommit,
      resultTree: value.resultTree,
      commitMessage: value.commitMessage,
      manifest,
      effectsManifestDigest: value.effectsManifestDigest,
      providerInvocationsDigest: value.providerInvocationsDigest,
      classification: value.classification as CandidateClassification,
      recoveryPlanDigest: value.recoveryPlanDigest,
      createdAt: value.createdAt,
      candidateBundleDigest: value.candidateBundleDigest,
    };
    const bundle =
      value.schemaVersion === 1
        ? buildImmutableCandidateBundle({
            ...common,
            checksAttestation:
              value.checksAttestation as CandidateChecksAttestation,
          })
        : buildImmutableCandidateBundleV2({
            ...common,
            checksAttestation:
              value.checksAttestation as CandidateChecksAttestationV3,
          }).bundle;
    if (
      value.manifestDigest !== bundle.manifestDigest ||
      value.checksAttestationDigest !== bundle.checksAttestationDigest ||
      (bundle.schemaVersion === 2 &&
        value.humanReadableSummaryDigest !==
          bundle.humanReadableSummaryDigest) ||
      canonicalImmutableCandidateBundle(bundle) !== raw
    ) {
      throw new Error('candidate digest or canonical bytes differ');
    }
    return bundle;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('APPLY_CANDIDATE_')
    ) {
      throw error;
    }
    throw candidateError(
      'APPLY_CANDIDATE_INVALID',
      'Immutable candidate bundle is malformed or noncanonical.',
    );
  }
}

export function canonicalCandidateSupportingArtifact(
  artifact: CandidateSupportingArtifact,
): string {
  return `${canonicalJson(assertCandidateSupportingArtifact(artifact))}\n`;
}

export function parseCandidateSupportingArtifact(
  raw: string,
): CandidateSupportingArtifact {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length < 3 ||
      raw.length > 4_194_304 ||
      !raw.endsWith('\n')
    ) {
      throw new Error('invalid supporting artifact bytes');
    }
    const artifact = assertCandidateSupportingArtifact(JSON.parse(raw));
    if (canonicalCandidateSupportingArtifact(artifact) !== raw) {
      throw new Error('noncanonical supporting artifact');
    }
    return artifact;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'APPLY_CANDIDATE_ARTIFACT_INVALID'
    ) {
      throw error;
    }
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifact is malformed or noncanonical.',
    );
  }
}

/**
 * Publish all candidate-supporting objects before the candidate bundle. An
 * interrupted publication can leave only unreachable content-addressed
 * objects; it can never expose a bundle whose claimed objects were skipped by
 * this transaction.
 */
export function storeCandidateSupportingArtifacts(
  gitCommonDirectory: string,
  input: CandidateSupportingArtifactSet,
): StoredCandidateSupportingArtifacts {
  const artifacts = [
    assertCandidateSupportingArtifact(input.effectsManifest),
    assertCandidateSupportingArtifact(input.providerInvocations),
    assertCandidateSupportingArtifact(input.recoveryPlan),
  ];
  const changeIds = new Set(artifacts.map(({ changeId }) => changeId));
  const mandateBindings = new Set(
    artifacts.map(({ mandateBinding }) => canonicalJson(mandateBinding)),
  );
  if (changeIds.size !== 1 || mandateBindings.size !== 1) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifacts belong to different changes or task mandates.',
    );
  }
  const runtime = candidateRuntime(gitCommonDirectory);
  return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
    assertOwned();
    const directory = ensureCandidateArtifactStoreDirectory(runtime.root);
    const stored = artifacts.map((artifact) => {
      const canonical = canonicalCandidateSupportingArtifact(artifact);
      const artifactDigest = digest(canonicalJson(artifact));
      const target = path.join(directory, `${artifactDigest}.json`);
      publishCandidateContentAddressedFile(
        directory,
        target,
        canonical,
        assertOwned,
      );
      const observed = readStoredCandidateSupportingArtifact(
        gitCommonDirectory,
        artifactDigest,
      );
      if (canonicalCandidateSupportingArtifact(observed) !== canonical) {
        throw candidateStoreError(
          'Stored candidate supporting artifact differs from its canonical bytes.',
        );
      }
      return { artifact, artifactDigest, target };
    });
    const byKind = new Map(
      stored.map((entry) => [entry.artifact.kind, entry] as const),
    );
    return {
      effectsManifestDigest: byKind.get('candidate-external-effects.v1')!
        .artifactDigest,
      providerInvocationsDigest: byKind.get(
        'candidate-provider-invocations.v1',
      )!.artifactDigest,
      recoveryPlanDigest: byKind.get('candidate-recovery-plan.v1')!
        .artifactDigest,
      paths: stored.map(({ target }) => target).sort(),
    };
  });
}

export function readStoredCandidateSupportingArtifact(
  gitCommonDirectory: string,
  requestedDigest: string,
): CandidateSupportingArtifact {
  const digestValue = assertCandidateArtifactDigest(requestedDigest);
  const runtime = candidateRuntime(gitCommonDirectory);
  const directory = path.join(runtime.root, 'candidate-artifacts');
  assertCandidateArtifactStoreDirectory(directory);
  const target = path.join(directory, `${digestValue}.json`);
  try {
    const raw = readPrivateCandidateArtifactFile(target);
    const artifact = parseCandidateSupportingArtifact(raw);
    if (digest(canonicalJson(artifact)) !== digestValue) {
      throw new Error('supporting artifact identity mismatch');
    }
    return artifact;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'APPLY_CANDIDATE_STORE_INVALID'
    ) {
      throw error;
    }
    throw candidateStoreError(
      'Stored candidate supporting artifact is malformed or has different content.',
    );
  }
}

export function storeCandidateHumanReadableSummary(
  gitCommonDirectory: string,
  summary: string,
): { humanReadableSummaryDigest: string; path: string } {
  assertCandidateHumanReadableSummary(summary);
  const humanReadableSummaryDigest = digest(summary);
  const runtime = candidateRuntime(gitCommonDirectory);
  return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
    assertOwned();
    const directory = ensureCandidateArtifactStoreDirectory(runtime.root);
    const target = path.join(directory, `${humanReadableSummaryDigest}.md`);
    publishCandidateContentAddressedFile(
      directory,
      target,
      summary,
      assertOwned,
    );
    if (
      readStoredCandidateHumanReadableSummary(
        gitCommonDirectory,
        humanReadableSummaryDigest,
      ) !== summary
    ) {
      throw candidateStoreError(
        'Stored candidate summary differs from its canonical bytes.',
      );
    }
    return { humanReadableSummaryDigest, path: target };
  });
}

export function readStoredCandidateHumanReadableSummary(
  gitCommonDirectory: string,
  requestedDigest: string,
): string {
  const digestValue = assertCandidateArtifactDigest(requestedDigest);
  const runtime = candidateRuntime(gitCommonDirectory);
  const directory = path.join(runtime.root, 'candidate-artifacts');
  assertCandidateArtifactStoreDirectory(directory);
  const target = path.join(directory, `${digestValue}.md`);
  const summary = readPrivateCandidateArtifactFile(target);
  assertCandidateHumanReadableSummary(summary);
  if (digest(summary) !== digestValue) {
    throw candidateStoreError(
      'Stored candidate summary has different content from its identity.',
    );
  }
  return summary;
}

export function assertStoredCandidateSupportingArtifacts(
  gitCommonDirectory: string,
  changeId: string,
  candidate: AnyImmutableCandidateBundle,
): CandidateSupportingArtifactSet {
  if (!CHANGE_ID.test(changeId)) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifact change binding is invalid.',
    );
  }
  const effectsManifest = readStoredCandidateSupportingArtifact(
    gitCommonDirectory,
    candidate.effectsManifestDigest,
  );
  const providerInvocations = readStoredCandidateSupportingArtifact(
    gitCommonDirectory,
    candidate.providerInvocationsDigest,
  );
  const recoveryPlan = readStoredCandidateSupportingArtifact(
    gitCommonDirectory,
    candidate.recoveryPlanDigest,
  );
  if (
    effectsManifest.kind !== 'candidate-external-effects.v1' ||
    providerInvocations.kind !== 'candidate-provider-invocations.v1' ||
    recoveryPlan.kind !== 'candidate-recovery-plan.v1' ||
    effectsManifest.changeId !== changeId ||
    providerInvocations.changeId !== changeId ||
    recoveryPlan.changeId !== changeId ||
    canonicalJson(effectsManifest.mandateBinding) !==
      canonicalJson(candidate.mandateBinding) ||
    canonicalJson(providerInvocations.mandateBinding) !==
      canonicalJson(candidate.mandateBinding) ||
    canonicalJson(recoveryPlan.mandateBinding) !==
      canonicalJson(candidate.mandateBinding) ||
    candidate.mandateBinding.changeId !== changeId ||
    recoveryPlan.targetRef !== candidate.targetRef ||
    recoveryPlan.expectedOldCommit !== candidate.expectedOldCommit ||
    recoveryPlan.expectedRefGeneration !== candidate.expectedRefGeneration ||
    recoveryPlan.candidateCommit !== candidate.candidateCommit ||
    recoveryPlan.rollbackTarget !== candidate.expectedOldCommit
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_BINDING_INVALID',
      'Stored candidate supporting artifacts do not bind the immutable candidate.',
    );
  }
  if (candidate.schemaVersion === 2) {
    const summary = readStoredCandidateHumanReadableSummary(
      gitCommonDirectory,
      candidate.humanReadableSummaryDigest,
    );
    if (summary !== canonicalCandidateHumanReadableSummary(candidate)) {
      throw candidateError(
        'APPLY_CANDIDATE_ARTIFACT_BINDING_INVALID',
        'Stored candidate summary does not describe the immutable candidate.',
      );
    }
  }
  return { effectsManifest, providerInvocations, recoveryPlan };
}

export function storeImmutableCandidateBundle(
  gitCommonDirectory: string,
  candidate: AnyImmutableCandidateBundle,
): string {
  const bundle = parseImmutableCandidateBundle(
    canonicalImmutableCandidateBundle(candidate),
  );
  const runtime = candidateRuntime(gitCommonDirectory);
  return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
    assertOwned();
    const directory = ensureCandidateStoreDirectory(runtime.root);
    const target = path.join(directory, `${bundle.candidateBundleDigest}.json`);
    const canonical = canonicalImmutableCandidateBundle(bundle);
    if (fs.existsSync(target)) {
      const existing = readStoredImmutableCandidateBundle(
        gitCommonDirectory,
        bundle.candidateBundleDigest,
      );
      if (canonicalImmutableCandidateBundle(existing) !== canonical) {
        throw candidateStoreError(
          'Candidate digest already exists with different canonical bytes.',
        );
      }
      return target;
    }

    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, canonical, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertOwned();
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
      fsyncCandidateDirectory(directory);
      assertOwned();
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = readStoredImmutableCandidateBundle(
          gitCommonDirectory,
          bundle.candidateBundleDigest,
        );
        if (canonicalImmutableCandidateBundle(existing) === canonical) {
          return target;
        }
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  });
}

export function readStoredImmutableCandidateBundle(
  gitCommonDirectory: string,
  requestedCandidateBundleDigest: string,
): AnyImmutableCandidateBundle {
  const digestValue = assertCandidateBundleDigest(
    requestedCandidateBundleDigest,
  );
  const runtime = candidateRuntime(gitCommonDirectory);
  const directory = path.join(runtime.root, 'candidates');
  assertCandidateStoreDirectory(directory);
  const target = path.join(directory, `${digestValue}.json`);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw candidateStoreError(
      'Stored immutable candidate is missing or has unsafe permissions.',
    );
  }
  try {
    const bundle = parseImmutableCandidateBundle(
      fs.readFileSync(target, 'utf8'),
    );
    if (bundle.candidateBundleDigest !== digestValue) {
      throw new Error('candidate identity mismatch');
    }
    return bundle;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'APPLY_CANDIDATE_STORE_INVALID'
    ) {
      throw error;
    }
    throw candidateStoreError(
      'Stored immutable candidate is malformed or has different content.',
    );
  }
}

function candidateRuntime(gitCommonDirectory: string) {
  if (!path.isAbsolute(gitCommonDirectory)) {
    throw candidateStoreError(
      'Immutable candidate storage requires an absolute Git common directory.',
    );
  }
  return runtimePaths(gitCommonDirectory, 'workflow-engine');
}

function assertCandidateSupportingArtifact(
  value: unknown,
): CandidateSupportingArtifact {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.kind !== 'string' ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    !isRecord(value.mandateBinding)
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifact has an invalid identity.',
    );
  }
  const mandateBinding = assertCandidateMandateBinding(value.mandateBinding);
  if (mandateBinding.changeId !== value.changeId) {
    throw candidateArtifactInvalid();
  }
  if (value.kind === 'candidate-external-effects.v1') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'mandateBinding',
        'effects',
      ]) ||
      !Array.isArray(value.effects)
    ) {
      throw candidateArtifactInvalid();
    }
    const effects = value.effects.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          'effectType',
          'targetDigest',
          'authorizationDigest',
          'resultDigest',
        ]) ||
        !validArtifactLabel(entry.effectType) ||
        typeof entry.targetDigest !== 'string' ||
        !DIGEST.test(entry.targetDigest) ||
        (entry.authorizationDigest !== null &&
          (typeof entry.authorizationDigest !== 'string' ||
            !DIGEST.test(entry.authorizationDigest))) ||
        (entry.resultDigest !== null &&
          (typeof entry.resultDigest !== 'string' ||
            !DIGEST.test(entry.resultDigest)))
      ) {
        throw candidateArtifactInvalid();
      }
      return {
        effectType: entry.effectType,
        targetDigest: entry.targetDigest,
        authorizationDigest: entry.authorizationDigest,
        resultDigest: entry.resultDigest,
      } as CandidateExternalEffect;
    });
    assertCanonicalArtifactEntries(effects);
    return {
      schemaVersion: 1,
      kind: value.kind,
      changeId: value.changeId,
      mandateBinding,
      effects,
    };
  }
  if (value.kind === 'candidate-provider-invocations.v1') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'mandateBinding',
        'invocations',
      ]) ||
      !Array.isArray(value.invocations)
    ) {
      throw candidateArtifactInvalid();
    }
    const invocations = value.invocations.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          'invocationId',
          'investigationId',
          'purpose',
          'attempt',
          'state',
          'requestDigest',
          'manifestDigest',
          'outputDigest',
          'failureDigest',
        ]) ||
        typeof entry.invocationId !== 'string' ||
        !INVOCATION_ID.test(entry.invocationId) ||
        typeof entry.investigationId !== 'string' ||
        !INVESTIGATION_ID.test(entry.investigationId) ||
        (entry.purpose !== 'survey' &&
          entry.purpose !== 'plan-review' &&
          entry.purpose !== 'task-diff-review') ||
        !Number.isSafeInteger(entry.attempt) ||
        (entry.attempt as number) < 1 ||
        !['prepared', 'leased', 'succeeded', 'failed'].includes(
          String(entry.state),
        ) ||
        typeof entry.requestDigest !== 'string' ||
        !DIGEST.test(entry.requestDigest) ||
        typeof entry.manifestDigest !== 'string' ||
        !DIGEST.test(entry.manifestDigest) ||
        (entry.outputDigest !== null &&
          (typeof entry.outputDigest !== 'string' ||
            !DIGEST.test(entry.outputDigest))) ||
        (entry.failureDigest !== null &&
          (typeof entry.failureDigest !== 'string' ||
            !DIGEST.test(entry.failureDigest))) ||
        (entry.state === 'succeeded') !== (entry.outputDigest !== null) ||
        (entry.state === 'failed') !== (entry.failureDigest !== null)
      ) {
        throw candidateArtifactInvalid();
      }
      return {
        invocationId: entry.invocationId,
        investigationId: entry.investigationId,
        purpose: entry.purpose,
        attempt: entry.attempt,
        state: entry.state,
        requestDigest: entry.requestDigest,
        manifestDigest: entry.manifestDigest,
        outputDigest: entry.outputDigest,
        failureDigest: entry.failureDigest,
      } as CandidateProviderInvocation;
    });
    assertCanonicalArtifactEntries(invocations);
    const invocationIds = new Set(
      invocations.map(({ invocationId }) => invocationId),
    );
    if (invocationIds.size !== invocations.length) {
      throw candidateArtifactInvalid();
    }
    return {
      schemaVersion: 1,
      kind: value.kind,
      changeId: value.changeId,
      mandateBinding,
      invocations,
    };
  }
  if (value.kind === 'candidate-recovery-plan.v1') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'mandateBinding',
        'targetRef',
        'expectedOldCommit',
        'expectedRefGeneration',
        'candidateCommit',
        'rollbackTarget',
      ]) ||
      typeof value.targetRef !== 'string' ||
      !validRef(value.targetRef) ||
      typeof value.expectedOldCommit !== 'string' ||
      !OBJECT_ID.test(value.expectedOldCommit) ||
      !Number.isSafeInteger(value.expectedRefGeneration) ||
      (value.expectedRefGeneration as number) < 0 ||
      typeof value.candidateCommit !== 'string' ||
      !OBJECT_ID.test(value.candidateCommit) ||
      value.candidateCommit === value.expectedOldCommit ||
      typeof value.rollbackTarget !== 'string' ||
      value.rollbackTarget !== value.expectedOldCommit
    ) {
      throw candidateArtifactInvalid();
    }
    return {
      schemaVersion: 1,
      kind: value.kind,
      changeId: value.changeId,
      mandateBinding,
      targetRef: value.targetRef,
      expectedOldCommit: value.expectedOldCommit,
      expectedRefGeneration: value.expectedRefGeneration as number,
      candidateCommit: value.candidateCommit,
      rollbackTarget: value.rollbackTarget,
    };
  }
  throw candidateArtifactInvalid();
}

function assertCanonicalArtifactEntries(values: unknown[]): void {
  const serialized = values.map((value) => canonicalJson(value));
  const sorted = [...serialized].sort();
  if (
    serialized.some((value, index) => value !== sorted[index]) ||
    new Set(serialized).size !== serialized.length
  ) {
    throw candidateArtifactInvalid();
  }
}

function assertCandidateMandateBinding(value: unknown): TaskMandateBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
    value.mandateTaskId.length > 128 ||
    typeof value.mandateId !== 'string' ||
    !GRANT_ID.test(value.mandateId) ||
    typeof value.mandateDigest !== 'string' ||
    !DIGEST.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_MANDATE_BINDING_INVALID',
      'Candidate task mandate binding is malformed or incomplete.',
    );
  }
  return {
    schemaVersion: 1,
    mandateTaskId: value.mandateTaskId,
    mandateId: value.mandateId,
    mandateDigest: value.mandateDigest,
    changeId: value.changeId,
    externalAuditRoot: value.externalAuditRoot,
  };
}

function validArtifactLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z][a-z0-9.-]{0,127}$/.test(value) &&
    Buffer.byteLength(value, 'utf8') <= 128
  );
}

function assertCandidateHumanReadableSummary(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith('# Immutable Candidate Summary\n') ||
    !value.endsWith('\n') ||
    value.includes('\0') ||
    value.includes('\r') ||
    Buffer.byteLength(value, 'utf8') > 1_048_576
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate human-readable summary is malformed or noncanonical.',
    );
  }
}

function candidateArtifactInvalid() {
  return candidateError(
    'APPLY_CANDIDATE_ARTIFACT_INVALID',
    'Candidate supporting artifact has an invalid canonical shape.',
  );
}

function ensureCandidateStoreDirectory(runtimeRoot: string): string {
  const directory = path.join(runtimeRoot, 'candidates');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertCandidateStoreDirectory(directory);
  fs.chmodSync(directory, 0o700);
  return directory;
}

function ensureCandidateArtifactStoreDirectory(runtimeRoot: string): string {
  const directory = path.join(runtimeRoot, 'candidate-artifacts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertCandidateArtifactStoreDirectory(directory);
  fs.chmodSync(directory, 0o700);
  return directory;
}

function assertCandidateStoreDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw candidateStoreError(
      'Immutable candidate store is missing or has unsafe permissions.',
    );
  }
}

function assertCandidateArtifactStoreDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw candidateStoreError(
      'Candidate supporting artifact store is missing or has unsafe permissions.',
    );
  }
}

function publishCandidateContentAddressedFile(
  directory: string,
  target: string,
  canonical: string,
  assertOwned: () => void,
): void {
  if (fs.existsSync(target)) {
    if (readPrivateCandidateArtifactFile(target) !== canonical) {
      throw candidateStoreError(
        'Candidate artifact digest already exists with different bytes.',
      );
    }
    return;
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, canonical, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertOwned();
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    fsyncCandidateDirectory(directory);
    assertOwned();
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EEXIST' &&
      readPrivateCandidateArtifactFile(target) === canonical
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function readPrivateCandidateArtifactFile(filePath: string): string {
  const flags =
    fs.constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch {
    throw candidateStoreError(
      'Stored candidate supporting artifact is missing or unsafe.',
    );
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 4_194_304
    ) {
      throw candidateStoreError(
        'Stored candidate supporting artifact has unsafe permissions or size.',
      );
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertCandidateBundleDigest(value: string): string {
  if (!DIGEST.test(value)) {
    throw candidateStoreError('Immutable candidate digest is invalid.');
  }
  return value;
}

function assertCandidateArtifactDigest(value: string): string {
  if (!DIGEST.test(value)) {
    throw candidateStoreError(
      'Candidate supporting artifact digest is invalid.',
    );
  }
  return value;
}

function fsyncCandidateDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function candidateStoreError(message: string) {
  return workflowError(
    'APPLY_CANDIDATE_STORE_INVALID',
    message,
    ExitCode.guard,
  );
}

export type CandidateCheckFreshnessOptions = {
  now: Date;
  candidateTree: string;
  patchDigest: string;
  trustBaseCommit: string;
  requiredChecks: string[];
  waivedFreshnessCheckIds?: string[];
  environmentDigest: string;
  changedDependencies: CheckDependency[];
};

export function assertCandidateChecksFresh(
  raw: CandidateChecksAttestation,
  options: CandidateCheckFreshnessOptions,
): CandidateChecksAttestation {
  const attestation = assertCandidateChecksAttestation(raw);
  const now = exactDate(options.now, 'attestation evaluation time').getTime();
  const requiredChecks = assertSortedUnique(
    options.requiredChecks,
    CHECK_ID,
    'required check IDs',
  );
  const waivedFreshnessCheckIds = assertSortedUnique(
    options.waivedFreshnessCheckIds ?? [],
    CHECK_ID,
    'waived freshness check IDs',
  );
  if (
    waivedFreshnessCheckIds.some((checkId) => !requiredChecks.includes(checkId))
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Named freshness waivers must reference exact required check IDs.',
    );
  }
  const waivedFreshness = new Set(waivedFreshnessCheckIds);
  const changedDependencies = assertSortedUnique(
    options.changedDependencies,
    /^(?:source-tree|base-commit|harness-engine|policy|runner|external-state)$/,
    'changed dependencies',
  ) as CheckDependency[];
  if (
    attestation.candidateTree !== options.candidateTree ||
    attestation.patchDigest !== options.patchDigest ||
    attestation.trustBaseCommit !== options.trustBaseCommit ||
    !DIGEST.test(options.environmentDigest) ||
    !sameStrings(
      attestation.checks.map(({ checkId }) => checkId),
      requiredChecks,
    )
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Checks attestation does not bind the exact candidate and trust base.',
    );
  }
  for (const check of attestation.checks) {
    if (
      check.dependsOn.some((dependency) =>
        changedDependencies.includes(dependency),
      )
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALIDATED',
        `Check ${check.checkId} depends on state that changed.`,
      );
    }
    if (
      check.reuseClass === 'toolchain-dependent' &&
      check.environmentDigest !== options.environmentDigest
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_ENVIRONMENT_MISMATCH',
        `Check ${check.checkId} was produced in another toolchain environment.`,
      );
    }
    const completedAt = Date.parse(check.completedAt);
    if (
      check.maxAgeMs !== null &&
      now - completedAt > check.maxAgeMs &&
      !waivedFreshness.has(check.checkId)
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_STALE',
        `Check ${check.checkId} exceeded its original evidence validity window.`,
      );
    }
  }
  return attestation;
}

export type CandidateV2CheckFreshnessOptions = Omit<
  CandidateCheckFreshnessOptions,
  'changedDependencies'
> & {
  currentDependencySnapshot: CandidateDependencySnapshot;
};

export function assertCandidateV2ChecksFresh(
  raw: CandidateChecksAttestationV3,
  options: CandidateV2CheckFreshnessOptions,
): CandidateChecksAttestationV3 {
  const attestation = assertCandidateChecksAttestationV3(raw);
  const current = assertCandidateDependencySnapshot(
    options.currentDependencySnapshot,
    attestation.checks,
    false,
  );
  assertCandidateChecksFresh(
    {
      schemaVersion: 2,
      candidateTree: attestation.candidateTree,
      patchDigest: attestation.patchDigest,
      trustBaseCommit: attestation.trustBaseCommit,
      checks: attestation.checks,
    },
    { ...options, changedDependencies: [] },
  );
  const sealed = attestation.dependencySnapshot;
  for (const check of attestation.checks) {
    const invalidated = check.dependsOn.some((dependency) => {
      switch (dependency) {
        case 'source-tree':
          return sealed.sourceTree !== current.sourceTree;
        case 'base-commit':
          return sealed.baseCommit !== current.baseCommit;
        case 'harness-engine':
          return sealed.harnessEngineDigest !== current.harnessEngineDigest;
        case 'policy':
          return sealed.policyDigest !== current.policyDigest;
        case 'runner':
          return (
            sealed.runnerDigests[check.checkId] !==
            current.runnerDigests[check.checkId]
          );
        case 'external-state':
          return (
            sealed.externalStateDigests[check.checkId] !==
            current.externalStateDigests[check.checkId]
          );
      }
    });
    if (invalidated) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALIDATED',
        `Check ${check.checkId} depends on state that changed.`,
      );
    }
  }
  return attestation;
}

function assertCandidateChecksAttestation(
  value: CandidateChecksAttestation,
): CandidateChecksAttestation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'candidateTree',
      'patchDigest',
      'trustBaseCommit',
      'checks',
    ]) ||
    value.schemaVersion !== 2 ||
    !OBJECT_ID.test(value.candidateTree) ||
    !DIGEST.test(value.patchDigest) ||
    !OBJECT_ID.test(value.trustBaseCommit) ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate checks attestation is malformed.',
    );
  }
  const checks = value.checks.map((check) => {
    if (
      !isRecord(check) ||
      !hasExactKeys(check, [
        'checkId',
        'definitionDigest',
        'commandDigest',
        'runnerDigest',
        'environmentDigest',
        'resultDigest',
        'outcome',
        'startedAt',
        'completedAt',
        'reuseClass',
        'maxAgeMs',
        'externalSnapshotDigest',
        'dependsOn',
      ])
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALID',
        'Candidate check attestation contains unknown or missing fields.',
      );
    }
    const startedAt = exactTimestamp(check.startedAt, 'check start time');
    const completedAt = exactTimestamp(
      check.completedAt,
      'check completion time',
    );
    const dependsOn = assertSortedUnique(
      check.dependsOn,
      /^(?:source-tree|base-commit|harness-engine|policy|runner|external-state)$/,
      'check dependencies',
    ) as CheckDependency[];
    if (
      !CHECK_ID.test(check.checkId) ||
      !DIGEST.test(check.definitionDigest) ||
      !DIGEST.test(check.commandDigest) ||
      !DIGEST.test(check.runnerDigest) ||
      !DIGEST.test(check.environmentDigest) ||
      !DIGEST.test(check.resultDigest) ||
      check.outcome !== 'passed' ||
      Date.parse(startedAt) > Date.parse(completedAt) ||
      !['content-pure', 'toolchain-dependent', 'external-state'].includes(
        check.reuseClass,
      ) ||
      (check.maxAgeMs !== null &&
        (!Number.isSafeInteger(check.maxAgeMs) || check.maxAgeMs < 1)) ||
      (check.reuseClass !== 'content-pure' && check.maxAgeMs === null) ||
      (check.externalSnapshotDigest !== null &&
        !DIGEST.test(check.externalSnapshotDigest)) ||
      (check.reuseClass === 'external-state' &&
        check.externalSnapshotDigest === null)
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALID',
        `Candidate check ${check.checkId || '<unknown>'} is malformed.`,
      );
    }
    return { ...check, startedAt, completedAt, dependsOn };
  });
  const ids = checks.map(({ checkId }) => checkId);
  if (!sameStrings(ids, [...new Set(ids)].sort())) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate checks must be sorted and unique.',
    );
  }
  return {
    schemaVersion: 2,
    candidateTree: value.candidateTree,
    patchDigest: value.patchDigest,
    trustBaseCommit: value.trustBaseCommit,
    checks,
  };
}

function assertCandidateChecksAttestationV3(
  value: CandidateChecksAttestationV3,
): CandidateChecksAttestationV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'candidateTree',
      'patchDigest',
      'trustBaseCommit',
      'dependencySnapshot',
      'checks',
    ]) ||
    value.schemaVersion !== 3 ||
    !isRecord(value.dependencySnapshot)
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate v2 checks attestation is malformed.',
    );
  }
  const legacyShape = assertCandidateChecksAttestation({
    schemaVersion: 2,
    candidateTree: value.candidateTree,
    patchDigest: value.patchDigest,
    trustBaseCommit: value.trustBaseCommit,
    checks: value.checks,
  });
  const dependencySnapshot = assertCandidateDependencySnapshot(
    value.dependencySnapshot,
    legacyShape.checks,
  );
  if (
    dependencySnapshot.sourceTree !== legacyShape.candidateTree ||
    dependencySnapshot.baseCommit !== legacyShape.trustBaseCommit
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Candidate dependency snapshot differs from its candidate tree or trust base.',
    );
  }
  return {
    schemaVersion: 3,
    candidateTree: legacyShape.candidateTree,
    patchDigest: legacyShape.patchDigest,
    trustBaseCommit: legacyShape.trustBaseCommit,
    dependencySnapshot,
    checks: legacyShape.checks,
  };
}

function assertCandidateDependencySnapshot(
  value: Record<string, unknown> | CandidateDependencySnapshot,
  checks: CandidateCheckAttestation[],
  bindToAttestation = true,
): CandidateDependencySnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'sourceTree',
      'baseCommit',
      'harnessEngineDigest',
      'policyDigest',
      'runnerDigests',
      'externalStateDigests',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.sourceTree !== 'string' ||
    !OBJECT_ID.test(value.sourceTree) ||
    typeof value.baseCommit !== 'string' ||
    !OBJECT_ID.test(value.baseCommit) ||
    typeof value.harnessEngineDigest !== 'string' ||
    !DIGEST.test(value.harnessEngineDigest) ||
    typeof value.policyDigest !== 'string' ||
    !DIGEST.test(value.policyDigest) ||
    !isRecord(value.runnerDigests) ||
    !isRecord(value.externalStateDigests)
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate dependency snapshot is malformed.',
    );
  }
  const checkIds = checks.map(({ checkId }) => checkId);
  if (
    !sameStrings(Object.keys(value.runnerDigests).sort(), checkIds) ||
    !sameStrings(Object.keys(value.externalStateDigests).sort(), checkIds)
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate dependency snapshot must exactly cover every required check.',
    );
  }
  const runnerDigests: Record<string, string> = {};
  const externalStateDigests: Record<string, string | null> = {};
  for (const check of checks) {
    const runnerDigest = value.runnerDigests[check.checkId];
    const externalStateDigest = value.externalStateDigests[check.checkId];
    if (
      typeof runnerDigest !== 'string' ||
      !DIGEST.test(runnerDigest) ||
      (bindToAttestation && runnerDigest !== check.runnerDigest) ||
      (externalStateDigest !== null &&
        (typeof externalStateDigest !== 'string' ||
          !DIGEST.test(externalStateDigest))) ||
      (check.dependsOn.includes('external-state') &&
        (externalStateDigest === null ||
          (bindToAttestation &&
            externalStateDigest !== check.externalSnapshotDigest))) ||
      (!check.dependsOn.includes('external-state') &&
        externalStateDigest !== null)
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALID',
        `Candidate dependency snapshot for ${check.checkId} is malformed.`,
      );
    }
    runnerDigests[check.checkId] = runnerDigest;
    externalStateDigests[check.checkId] = externalStateDigest;
  }
  return {
    schemaVersion: 1,
    sourceTree: value.sourceTree,
    baseCommit: value.baseCommit,
    harnessEngineDigest: value.harnessEngineDigest,
    policyDigest: value.policyDigest,
    runnerDigests,
    externalStateDigests,
  };
}

export type RefGenerationTransition = {
  fromOid: string;
  toOid: string;
  fromGeneration: number;
  toGeneration: number;
  reason:
    'apply' | 'rollback' | 'external-sync' | 'promotion' | 'uncertain-cas';
  at: string;
};

export type RefGenerationLedger = {
  schemaVersion: 1;
  ref: string;
  currentOid: string;
  generation: number;
  transitions: RefGenerationTransition[];
};

export function createRefGenerationLedger(
  ref: string,
  currentOid: string,
): RefGenerationLedger {
  if (!validRef(ref) || !OBJECT_ID.test(currentOid)) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'Ref generation ledger identity is invalid.',
    );
  }
  return {
    schemaVersion: 1,
    ref,
    currentOid,
    generation: 0,
    transitions: [],
  };
}

export function acceptApplyPrestate(
  ledger: RefGenerationLedger,
  expectedOid: string,
  expectedGeneration: number,
): void {
  assertRefLedger(ledger);
  if (ledger.generation !== expectedGeneration) {
    throw candidateError(
      'APPLY_REF_GENERATION_MISMATCH',
      'The managed ref moved since approval, including an ABA transition.',
    );
  }
  if (ledger.currentOid !== expectedOid) {
    throw candidateError(
      'APPLY_REF_OID_MISMATCH',
      'The managed ref object ID differs from the approved prestate.',
    );
  }
}

export function recordRefGenerationTransition(
  ledger: RefGenerationLedger,
  input: {
    expectedOid: string;
    expectedGeneration: number;
    nextOid: string;
    reason: RefGenerationTransition['reason'];
    at: string;
  },
): RefGenerationLedger {
  assertRefLedger(ledger);
  acceptApplyPrestate(ledger, input.expectedOid, input.expectedGeneration);
  const at = exactTimestamp(input.at, 'ref transition time');
  if (
    !OBJECT_ID.test(input.nextOid) ||
    (input.nextOid === ledger.currentOid && input.reason !== 'uncertain-cas') ||
    ![
      'apply',
      'rollback',
      'external-sync',
      'promotion',
      'uncertain-cas',
    ].includes(input.reason)
  ) {
    throw candidateError(
      'APPLY_REF_TRANSITION_INVALID',
      'Ref generation transition is malformed or a no-op.',
    );
  }
  const transition: RefGenerationTransition = {
    fromOid: ledger.currentOid,
    toOid: input.nextOid,
    fromGeneration: ledger.generation,
    toGeneration: ledger.generation + 1,
    reason: input.reason,
    at,
  };
  return {
    ...ledger,
    currentOid: input.nextOid,
    generation: ledger.generation + 1,
    transitions: [...ledger.transitions, transition],
  };
}

export function ensureDurableRefGenerationLedger(
  gitCommonDirectory: string,
  ref: string,
  currentOid: string,
): RefGenerationLedger {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
    assertOwned();
    const existing = readDurableRefGenerationLedger(
      gitCommonDirectory,
      ref,
      false,
    );
    if (existing) {
      if (existing.currentOid !== currentOid) {
        throw candidateError(
          'APPLY_REF_LEDGER_DIVERGED',
          'The protected ref ledger differs from the observed ref.',
        );
      }
      return existing;
    }
    const created = createRefGenerationLedger(ref, currentOid);
    writeDurableRefGenerationLedger(gitCommonDirectory, created, true);
    return created;
  });
}

export function readDurableRefGenerationLedger(
  gitCommonDirectory: string,
  ref: string,
  required: true,
): RefGenerationLedger;
export function readDurableRefGenerationLedger(
  gitCommonDirectory: string,
  ref: string,
  required?: false,
): RefGenerationLedger | null;
export function readDurableRefGenerationLedger(
  gitCommonDirectory: string,
  ref: string,
  required = true,
): RefGenerationLedger | null {
  if (!path.isAbsolute(gitCommonDirectory) || !validRef(ref)) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'Durable ref ledger location or ref is invalid.',
    );
  }
  const target = durableRefLedgerPath(gitCommonDirectory, ref);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stats) {
    if (!required) return null;
    throw candidateError(
      'APPLY_REF_LEDGER_MISSING',
      'The protected ref generation ledger is missing.',
    );
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'The protected ref generation ledger file is unsafe.',
    );
  }
  try {
    const raw = fs.readFileSync(target, 'utf8');
    const value = JSON.parse(raw) as RefGenerationLedger;
    if (
      raw !== `${canonicalJson(value)}\n` ||
      value.ref !== ref ||
      value.transitions.some(
        (transition, index) =>
          transition.fromGeneration !== index ||
          transition.toGeneration !== index + 1 ||
          (index === 0
            ? transition.fromOid !== value.transitions[0]!.fromOid
            : transition.fromOid !== value.transitions[index - 1]!.toOid) ||
          transition.at !==
            exactTimestamp(transition.at, 'ref transition time'),
      ) ||
      (value.transitions.length > 0 &&
        value.transitions.at(-1)!.toOid !== value.currentOid)
    ) {
      throw new Error('invalid ref ledger');
    }
    assertRefLedger(value);
    return value;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'APPLY_REF_LEDGER_INVALID'
    ) {
      throw error;
    }
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'The protected ref generation ledger is malformed.',
    );
  }
}

export function recordDurableRefGenerationTransitionUnderLifecycleLock(
  gitCommonDirectory: string,
  input: {
    ref: string;
    expectedOid: string;
    expectedGeneration: number;
    nextOid: string;
    reason: RefGenerationTransition['reason'];
    at: string;
  },
  assertOwned: () => void,
): RefGenerationLedger {
  assertOwned();
  const current = readDurableRefGenerationLedger(
    gitCommonDirectory,
    input.ref,
    true,
  );
  const next = recordRefGenerationTransition(current, input);
  assertOwned();
  writeDurableRefGenerationLedger(gitCommonDirectory, next, false);
  assertOwned();
  return next;
}

function durableRefLedgerPath(gitCommonDirectory: string, ref: string): string {
  return path.join(
    runtimePaths(gitCommonDirectory, 'workflow-engine').root,
    'ref-generation-ledger',
    `${digest(ref)}.json`,
  );
}

function writeDurableRefGenerationLedger(
  gitCommonDirectory: string,
  ledger: RefGenerationLedger,
  create: boolean,
): void {
  assertRefLedger(ledger);
  const target = durableRefLedgerPath(gitCommonDirectory, ledger.ref);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const directoryStats = fs.lstatSync(directory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory)
  ) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'The protected ref generation ledger directory is unsafe.',
    );
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${canonicalJson(ledger)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (create) {
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(directoryDescriptor);
    fs.closeSync(directoryDescriptor);
  } catch (error) {
    if (create && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw candidateError(
        'APPLY_REF_LEDGER_EXISTS',
        'The protected ref generation ledger was initialized concurrently.',
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function assertRefLedger(ledger: RefGenerationLedger): void {
  if (
    ledger.schemaVersion !== 1 ||
    !validRef(ledger.ref) ||
    !OBJECT_ID.test(ledger.currentOid) ||
    !Number.isSafeInteger(ledger.generation) ||
    ledger.generation < 0 ||
    !Array.isArray(ledger.transitions) ||
    ledger.transitions.length !== ledger.generation
  ) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'Ref generation ledger is malformed.',
    );
  }
  for (let index = 0; index < ledger.transitions.length; index += 1) {
    const transition = ledger.transitions[index]!;
    const previous = index === 0 ? undefined : ledger.transitions[index - 1];
    if (
      !OBJECT_ID.test(transition.fromOid) ||
      !OBJECT_ID.test(transition.toOid) ||
      transition.fromGeneration !== index ||
      transition.toGeneration !== index + 1 ||
      (previous !== undefined && previous.toOid !== transition.fromOid) ||
      ![
        'apply',
        'rollback',
        'external-sync',
        'promotion',
        'uncertain-cas',
      ].includes(transition.reason) ||
      (transition.fromOid === transition.toOid &&
        transition.reason !== 'uncertain-cas') ||
      exactTimestamp(transition.at, 'ref transition time') !== transition.at
    ) {
      throw candidateError(
        'APPLY_REF_LEDGER_INVALID',
        'Ref generation ledger transition history is malformed.',
      );
    }
  }
  if (
    ledger.transitions.length > 0 &&
    ledger.transitions.at(-1)!.toOid !== ledger.currentOid
  ) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'Ref generation ledger head differs from its transition history.',
    );
  }
}

// The apply crash journal for production commits is AuthorityCommitJournal in
// maintainer-recovery.ts — the normative implementation of the plan's apply
// write-ahead model. A second journal lived here with tests and no callers;
// a normative table proven only on an unused module proves nothing about the
// recovery path that runs, so the copy is gone rather than kept aligned.

function assertSortedUnique(
  values: readonly string[],
  pattern: RegExp,
  label: string,
): string[] {
  if (!Array.isArray(values)) {
    throw candidateError(
      'APPLY_CONTRACT_INVALID',
      `${label} must be an array.`,
    );
  }
  const result = [...values];
  const sorted = [...new Set(result)].sort();
  if (
    !sameStrings(result, sorted) ||
    result.some((value) => typeof value !== 'string' || !pattern.test(value))
  ) {
    throw candidateError(
      'APPLY_CONTRACT_INVALID',
      `${label} must be valid, sorted, and unique.`,
    );
  }
  return result;
}

function validRef(value: string): boolean {
  return (
    typeof value === 'string' &&
    TARGET_REF.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('.') &&
    !value.endsWith('/')
  );
}

function validCommitMessage(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 2 &&
    value.length <= 16_384 &&
    value.endsWith('\n') &&
    !value.endsWith('\n\n') &&
    !value.includes('\r') &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0 || (codePoint < 32 && character !== '\n');
    })
  );
}

function exactTimestamp(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw candidateError('APPLY_TIME_INVALID', `${label} is invalid.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw candidateError('APPLY_TIME_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exactDate(value: Date, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw candidateError('APPLY_TIME_INVALID', `${label} is invalid.`);
  }
  return date;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function candidateError(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
