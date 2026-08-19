import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  freezeGrantCanonical as freezeCanonical,
  grantHasExactKeys as hasExactKeys,
  grantSha256 as sha256,
} from '../../authority/grant-primitives.ts';
import {
  parseInvestigationV3Blocker as parseBlocker,
  type InvestigationV3Blocker,
} from '../manifest/investigation-manifest.ts';
import {
  investigationManifestPublicationFailureEmissionDigest,
  investigationManifestPublicationGitStateDigest,
  investigationManifestPublicationSourceMatchesLifecycle,
  investigationManifestPublicationStateDigest,
  observeInvestigationManifestPublicationState,
  type InvestigationManifestPublicationFailure,
  type InvestigationManifestPublicationObservationSource,
} from '../../../investigation-publication.ts';
import {
  readCurrentInvestigationRef,
  readInvestigationSession,
} from '../../../investigation-session-store.ts';
import {
  isProposeExemptionInvestigationId,
  readCurrentProposeExemptionSession,
  readProposeExemptionSession,
} from '../../../propose-exemption-store.ts';
import { readInvestigationV3ShadowFailureObservation } from '../../../investigation-shadow-store.ts';
import { loadInvestigationRuntimeContext } from '../../../lifecycle-context.ts';

export const INVESTIGATION_V3_SHADOW_FAILURE_OBSERVER =
  'investigation-v3.shadow-failure.v1' as const;
export const INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER =
  'investigation-v3.publication-state.v1' as const;

export type InvestigationV3FailureIdentity = Readonly<{
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  blocker: InvestigationV3Blocker;
}>;

export type InvestigationV3FailureSource =
  | Readonly<{
      schemaVersion: 1;
      observerId: typeof INVESTIGATION_V3_SHADOW_FAILURE_OBSERVER;
    }>
  | Readonly<{
      schemaVersion: 1;
      observerId: typeof INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER;
      source: InvestigationManifestPublicationFailure['source'];
    }>;

export type InvestigationV3ObservedFailureSource = Readonly<{
  identity: InvestigationV3FailureIdentity;
  sourceStateDigest: `sha256:${string}`;
  publicationRecoveryKind:
    'none' | 'pre-ref' | 'post-ref' | 'committed' | 'blocked' | null;
}>;

export function investigationV3ShadowFailureSource(): InvestigationV3FailureSource {
  return freezeCanonical({
    schemaVersion: 1,
    observerId: INVESTIGATION_V3_SHADOW_FAILURE_OBSERVER,
  });
}

export function investigationV3PublicationFailureSource(
  failure: InvestigationManifestPublicationFailure,
): InvestigationV3FailureSource {
  const parsed = assertInvestigationManifestPublicationFailure(failure);
  return assertInvestigationV3FailureSource({
    schemaVersion: 1,
    observerId: INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER,
    source: parsed.source,
  });
}

export function assertInvestigationManifestPublicationFailure(
  value: unknown,
): InvestigationManifestPublicationFailure {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'lifecycle',
      'blocker',
      'source',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-manifest-publication-failure' ||
    !isRecord(value.lifecycle) ||
    !hasExactKeys(value.lifecycle, [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
    ]) ||
    !isRecord(value.source) ||
    !hasExactKeys(value.source, [
      'schemaVersion',
      'observation',
      'failureIdentity',
      'emittedPublicationStateDigest',
      'emittedGitStateDigest',
      'recoveryPolicy',
      'emissionDigest',
    ]) ||
    value.source.schemaVersion !== 1 ||
    typeof value.source.failureIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.source.failureIdentity) ||
    typeof value.source.emittedPublicationStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.source.emittedPublicationStateDigest) ||
    typeof value.source.emittedGitStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.source.emittedGitStateDigest) ||
    (value.source.recoveryPolicy !== 'central-grant' &&
      value.source.recoveryPolicy !== 'idempotent-post-ref') ||
    typeof value.source.emissionDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.source.emissionDigest)
  ) {
    throw sourceInvalid('Investigation v3 publication failure is malformed.');
  }
  const blocker = parseBlocker(value.blocker);
  const identity = assertFailureIdentity({
    ...value.lifecycle,
    blocker,
  });
  const observation = assertPublicationSource(value.source.observation);
  if (
    !investigationManifestPublicationSourceMatchesLifecycle(
      observation,
      identity,
    )
  ) {
    throw sourceInvalid(
      'Investigation v3 publication source is outside its lifecycle namespace.',
    );
  }
  const sourceWithoutEmission = {
    schemaVersion: 1 as const,
    observation,
    failureIdentity: value.source.failureIdentity,
    emittedPublicationStateDigest: value.source
      .emittedPublicationStateDigest as `sha256:${string}`,
    emittedGitStateDigest: value.source
      .emittedGitStateDigest as `sha256:${string}`,
    recoveryPolicy: value.source.recoveryPolicy as
      'central-grant' | 'idempotent-post-ref',
  };
  const parsed = freezeCanonical({
    schemaVersion: 1 as const,
    kind: 'investigation-manifest-publication-failure' as const,
    lifecycle: {
      repositoryId: identity.repositoryId,
      changeId: identity.changeId,
      investigationId: identity.investigationId,
      sessionRevision: identity.sessionRevision,
      sessionSnapshotDigest: identity.sessionSnapshotDigest,
    },
    blocker,
    source: {
      ...sourceWithoutEmission,
      emissionDigest: value.source.emissionDigest as `sha256:${string}`,
    },
  });
  if (
    parsed.source.failureIdentity !== parsed.blocker.failureIdentity ||
    investigationManifestPublicationFailureEmissionDigest({
      schemaVersion: parsed.schemaVersion,
      kind: parsed.kind,
      lifecycle: parsed.lifecycle,
      blocker: parsed.blocker,
      source: sourceWithoutEmission,
    }) !== parsed.source.emissionDigest
  ) {
    throw sourceInvalid(
      'Investigation v3 publication blocker and source do not match.',
    );
  }
  return parsed;
}

export function assertInvestigationV3FailureSource(
  value: unknown,
): InvestigationV3FailureSource {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.observerId !== 'string'
  ) {
    throw sourceInvalid('Investigation v3 failure source is malformed.');
  }
  if (value.observerId === INVESTIGATION_V3_SHADOW_FAILURE_OBSERVER) {
    if (!hasExactKeys(value, ['schemaVersion', 'observerId'])) {
      throw sourceInvalid('Investigation v3 shadow source is malformed.');
    }
    return freezeCanonical({
      schemaVersion: 1 as const,
      observerId: INVESTIGATION_V3_SHADOW_FAILURE_OBSERVER,
    });
  }
  if (value.observerId !== INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER) {
    throw sourceInvalid('Investigation v3 failure source observer is unknown.');
  }
  if (!hasExactKeys(value, ['schemaVersion', 'observerId', 'source'])) {
    throw sourceInvalid('Investigation v3 publication source is malformed.');
  }
  return freezeCanonical({
    schemaVersion: 1 as const,
    observerId: INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER,
    source: assertPublicationFailureSource(value.source),
  });
}

export function initialInvestigationV3FailureSourceObservation(input: {
  cwd: string | null;
  identity: InvestigationV3FailureIdentity;
  source: InvestigationV3FailureSource;
}): InvestigationV3ObservedFailureSource {
  if (input.source.observerId === INVESTIGATION_V3_SHADOW_FAILURE_OBSERVER) {
    return observedShadow(input.identity);
  }
  if (input.cwd === null) {
    throw sourceInvalid(
      'Investigation v3 publication source requires a repository observation.',
    );
  }
  const observed = observedPublication(input.cwd, input.identity, input.source);
  if (!sameFailureIdentity(observed.identity, input.identity)) {
    const fields = failureIdentityDifferences(
      observed.identity,
      input.identity,
    );
    throw workflowError(
      'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
      `Investigation v3 publication lifecycle identity changed before the central challenge was created: ${fields.join(', ')}.`,
      ExitCode.staleState,
    );
  }
  if (!observed.lifecycleCurrent) {
    throw workflowError(
      'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
      'Investigation v3 publication lifecycle is no longer current.',
      ExitCode.staleState,
    );
  }
  if (
    observed.publicationStateDigest !==
    input.source.source.emittedPublicationStateDigest
  ) {
    throw workflowError(
      'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
      'Investigation v3 publication failure source changed before the central challenge was created.',
      ExitCode.staleState,
    );
  }
  if (observed.gitStateDigest !== input.source.source.emittedGitStateDigest) {
    throw workflowError(
      'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
      'Investigation v3 publication Git state changed before the central challenge was created.',
      ExitCode.staleState,
    );
  }
  return observed;
}

export function observeInvestigationV3FailureSource(input: {
  cwd: string;
  expectedIdentity: InvestigationV3FailureIdentity;
  source: InvestigationV3FailureSource;
}): InvestigationV3ObservedFailureSource {
  if (input.source.observerId === INVESTIGATION_V3_SHADOW_FAILURE_OBSERVER) {
    const context = loadInvestigationRuntimeContext(input.cwd);
    const observation = readInvestigationV3ShadowFailureObservation(
      context.runtime,
      input.expectedIdentity.investigationId,
    );
    return observedShadow({
      repositoryId: observation.repositoryId,
      changeId: observation.changeId,
      investigationId: observation.investigationId,
      sessionRevision: observation.sessionRevision,
      sessionSnapshotDigest: observation.sessionSnapshotDigest,
      blocker: observation.result.blocker,
    });
  }
  return observedPublication(input.cwd, input.expectedIdentity, input.source);
}

function observedShadow(
  identity: InvestigationV3FailureIdentity,
): InvestigationV3ObservedFailureSource {
  const frozen = freezeCanonical(identity);
  return freezeCanonical({
    identity: frozen,
    sourceStateDigest: sha256(
      canonicalJson({
        schema: 'investigation-v3-shadow-failure-source-state.v1',
        identity: frozen,
      }),
    ),
    publicationRecoveryKind: null,
  });
}

function observedPublication(
  cwd: string,
  identity: InvestigationV3FailureIdentity,
  source: Extract<
    InvestigationV3FailureSource,
    { observerId: typeof INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER }
  >,
): InvestigationV3ObservedFailureSource & {
  lifecycleCurrent: boolean;
  publicationStateDigest: `sha256:${string}`;
  gitStateDigest: `sha256:${string}`;
} {
  const context = loadInvestigationRuntimeContext(cwd);
  const lifecycle = observePublicationLifecycle(context, identity);
  const publication = observeInvestigationManifestPublicationState({
    repositoryRoot: context.git.repositoryRoot,
    source: source.source.observation,
  });
  const publicationStateDigest =
    investigationManifestPublicationStateDigest(publication);
  const gitStateDigest = investigationManifestPublicationGitStateDigest(
    context.git,
  );
  return freezeCanonical({
    identity: freezeCanonical({
      ...lifecycle.identity,
      blocker: identity.blocker,
    }),
    sourceStateDigest: sha256(
      canonicalJson({
        schema: 'investigation-v3-publication-failure-source-state.v3',
        repository: {
          repositoryRealPath: context.git.repositoryRealPath,
          gitCommonDirectory: context.git.gitCommonDirectory,
          branch: context.git.branch,
          head: context.git.head,
          tree: context.git.tree,
          statusEntries: [...context.git.statusEntries].sort(),
          gitStateDigest,
        },
        lifecycle: lifecycle.sourceState,
        failureSource: source.source,
        publication,
      }),
    ),
    publicationRecoveryKind: publication.recoveryKind,
    lifecycleCurrent: lifecycle.current,
    publicationStateDigest,
    gitStateDigest,
  });
}

function observePublicationLifecycle(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  expected: InvestigationV3FailureIdentity,
): Readonly<{
  identity: Omit<InvestigationV3FailureIdentity, 'blocker'>;
  current: boolean;
  sourceState: unknown;
}> {
  if (isProposeExemptionInvestigationId(expected.investigationId)) {
    const session = readProposeExemptionSession(
      context.runtime,
      expected.investigationId,
    );
    const current = readCurrentProposeExemptionSession(
      context.runtime,
      session.changeId,
    );
    const sessionSnapshotDigest = rawSha256(`${canonicalJson(session)}\n`);
    return freezeCanonical({
      identity: {
        repositoryId: context.config.repositoryName,
        changeId: session.changeId,
        investigationId: session.investigationId,
        sessionRevision: session.revision,
        sessionSnapshotDigest,
      },
      current: current?.investigationId === session.investigationId,
      sourceState: {
        kind: 'propose-exemption-session',
        session,
        currentInvestigationId: current?.investigationId ?? null,
      },
    });
  }
  const session = readInvestigationSession(
    context.runtime,
    expected.investigationId,
  );
  const current = readCurrentInvestigationRef(
    context.runtime,
    session.changeId,
  );
  const sessionSnapshotDigest = rawSha256(`${canonicalJson(session)}\n`);
  return freezeCanonical({
    identity: {
      repositoryId: context.config.repositoryName,
      changeId: session.changeId,
      investigationId: session.investigationId,
      sessionRevision: session.revision,
      sessionSnapshotDigest,
    },
    current: current?.investigationId === session.investigationId,
    sourceState: {
      kind: 'investigation-session',
      session,
      currentInvestigationId: current?.investigationId ?? null,
    },
  });
}

function assertPublicationFailureSource(
  value: unknown,
): InvestigationManifestPublicationFailure['source'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'observation',
      'failureIdentity',
      'emittedPublicationStateDigest',
      'emittedGitStateDigest',
      'recoveryPolicy',
      'emissionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.failureIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.failureIdentity) ||
    typeof value.emittedPublicationStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.emittedPublicationStateDigest) ||
    typeof value.emittedGitStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.emittedGitStateDigest) ||
    (value.recoveryPolicy !== 'central-grant' &&
      value.recoveryPolicy !== 'idempotent-post-ref') ||
    typeof value.emissionDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.emissionDigest)
  ) {
    throw sourceInvalid('Investigation v3 publication source is malformed.');
  }
  return freezeCanonical({
    schemaVersion: 1 as const,
    observation: assertPublicationSource(value.observation),
    failureIdentity: value.failureIdentity,
    emittedPublicationStateDigest:
      value.emittedPublicationStateDigest as `sha256:${string}`,
    emittedGitStateDigest: value.emittedGitStateDigest as `sha256:${string}`,
    recoveryPolicy: value.recoveryPolicy as
      'central-grant' | 'idempotent-post-ref',
    emissionDigest: value.emissionDigest as `sha256:${string}`,
  });
}

function assertPublicationSource(
  value: unknown,
): InvestigationManifestPublicationObservationSource {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw sourceInvalid(
      'Investigation v3 publication observer input is malformed.',
    );
  }
  if (value.operation === 'read-ref') {
    if (
      !hasExactKeys(value, ['operation', 'currentRefPath']) ||
      !boundedPath(value.currentRefPath)
    ) {
      throw sourceInvalid('Investigation v3 current-ref source is malformed.');
    }
    return freezeCanonical({
      operation: 'read-ref' as const,
      currentRefPath: value.currentRefPath,
    });
  }
  if (!['publish', 'inspect', 'resume'].includes(value.operation)) {
    throw sourceInvalid('Investigation v3 publication operation is unknown.');
  }
  if (!hasExactKeys(value, ['operation', 'paths']) || !isRecord(value.paths)) {
    throw sourceInvalid('Investigation v3 publication paths are malformed.');
  }
  const paths = value.paths;
  if (
    !hasExactKeys(paths, ['manifestPath', 'currentRefPath', 'journalPath']) ||
    !boundedPath(paths.manifestPath) ||
    !boundedPath(paths.currentRefPath) ||
    !boundedPath(paths.journalPath)
  ) {
    throw sourceInvalid('Investigation v3 publication paths are malformed.');
  }
  return freezeCanonical({
    operation: value.operation as 'publish' | 'inspect' | 'resume',
    paths: {
      manifestPath: paths.manifestPath,
      currentRefPath: paths.currentRefPath,
      journalPath: paths.journalPath,
    },
  });
}

function boundedPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4_096 &&
    !/[\0\r\n]/.test(value)
  );
}

function assertFailureIdentity(value: unknown): InvestigationV3FailureIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'blocker',
    ]) ||
    typeof value.repositoryId !== 'string' ||
    value.repositoryId.length === 0 ||
    value.repositoryId.trim() !== value.repositoryId ||
    Buffer.byteLength(value.repositoryId) > 256 ||
    /[\0\r\n]/.test(value.repositoryId) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
    typeof value.investigationId !== 'string' ||
    !/^investigation-[a-zA-Z0-9-]+$/.test(value.investigationId) ||
    typeof value.sessionRevision !== 'number' ||
    !Number.isSafeInteger(value.sessionRevision) ||
    value.sessionRevision < 0 ||
    typeof value.sessionSnapshotDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sessionSnapshotDigest)
  ) {
    throw sourceInvalid('Investigation v3 failure identity is malformed.');
  }
  return freezeCanonical({
    repositoryId: value.repositoryId,
    changeId: value.changeId,
    investigationId: value.investigationId,
    sessionRevision: value.sessionRevision,
    sessionSnapshotDigest: value.sessionSnapshotDigest,
    blocker: parseBlocker(value.blocker),
  });
}

function sameFailureIdentity(
  left: InvestigationV3FailureIdentity,
  right: InvestigationV3FailureIdentity,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function failureIdentityDifferences(
  observed: InvestigationV3FailureIdentity,
  expected: InvestigationV3FailureIdentity,
): string[] {
  return [
    'repositoryId',
    'changeId',
    'investigationId',
    'sessionRevision',
    'sessionSnapshotDigest',
    'blocker',
  ].filter(
    (field) =>
      canonicalJson(observed[field as keyof InvestigationV3FailureIdentity]) !==
      canonicalJson(expected[field as keyof InvestigationV3FailureIdentity]),
  );
}

function rawSha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceInvalid(message: string) {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_SOURCE_INVALID',
    message,
    ExitCode.guard,
  );
}
