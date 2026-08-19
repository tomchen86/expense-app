import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  consumeExternalEffectGrant,
  inspectExternalEffectGrantForExecutor,
  markExternalEffectDispatchIssued,
  PUBLISH_TRANSACTION_ENV,
  recordExternalEffectObservation,
  reserveExternalEffectGrant,
  terminalizeExternalEffectGrant,
  type ExternalEffectGitRefTarget,
  type ExternalEffectGrantInspection,
  type ExternalEffectTransitionOptions,
  type Sha256Digest,
} from '../../../modules/authority/external-effect-grant.ts';
import {
  discoverRepository,
  runGit,
} from '../../../runtime/repository-transaction/git.ts';
import type { MaintainerSignerProvider } from '../../signing/ssh/maintainer-signer.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type PublishRunnerObservation = {
  externalReceiptId: string;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest;
  observedAt: string;
};

export type PublishRunnerRequest = {
  repositoryRoot: string;
  grantId: string;
  transactionId: string;
  idempotencyKey: string;
  target: ExternalEffectGitRefTarget;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  environment: NodeJS.ProcessEnv;
};

export type PublishRunnerOutcome =
  | { state: 'observed'; observation: PublishRunnerObservation }
  | { state: 'not-issued'; reason: string }
  | { state: 'unknown'; reason: string };

export type PublishRunnerQuery =
  | { state: 'observed'; observation: PublishRunnerObservation }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string };

export type PublishRunner = {
  dispatch(request: PublishRunnerRequest): PublishRunnerOutcome;
  query?(request: PublishRunnerRequest): PublishRunnerQuery;
};

export type ExecutePublishOptions = {
  now?: Date;
  runner?: PublishRunner;
  signer?: MaintainerSignerProvider;
  onAuditRecord?: ExternalEffectTransitionOptions['onAuditRecord'];
  testAuditServiceHooks?: ExternalEffectTransitionOptions['testAuditServiceHooks'];
  environment?: NodeJS.ProcessEnv;
  testAfterDispatchIssued?: (request: PublishRunnerRequest) => void;
  testAfterRunnerResult?: (
    outcome: PublishRunnerOutcome | PublishRunnerQuery,
  ) => void;
};

export type ExecutePublishResult = {
  state:
    | 'consumed'
    | 'revoked'
    | 'expired'
    | 'failed'
    | 'manual-reconciliation'
    | 'reconciled-succeeded'
    | 'reconciled-rolled-back'
    | 'reconciled-failed';
  grantId: string;
  transactionId: string | null;
  replayed: boolean;
  observation: ExternalEffectGrantInspection['observation'];
};

export function publishArtifactDigest(sourceOid: string): Sha256Digest {
  return digest(
    canonicalJson({
      kind: 'git-publish-artifact.v1',
      sourceOid: assertOid(sourceOid),
    }),
  );
}

export function publishPrestateDigest(
  expectedRemoteOid: string | null,
): Sha256Digest {
  return digest(
    canonicalJson({
      kind: 'git-publish-prestate.v1',
      expectedRemoteOid:
        expectedRemoteOid === null ? null : assertOid(expectedRemoteOid),
    }),
  );
}

export function publishPoststateDigest(sourceOid: string): Sha256Digest {
  return digest(
    canonicalJson({
      kind: 'git-publish-poststate.v1',
      sourceOid: assertOid(sourceOid),
    }),
  );
}

export function executePublishGrant(
  cwd: string,
  grantId: string,
  options: ExecutePublishOptions,
): ExecutePublishResult {
  const now = exactDate(options.now ?? new Date());
  const runner = options.runner ?? createProductionPublishRunner();
  let inspection = inspectExternalEffectGrantForExecutor(cwd, grantId, {
    now,
    signer: options.signer,
  });
  assertPublishGrant(cwd, inspection);
  if (inspection.state === 'expired') {
    inspection = reserveExternalEffectGrant(cwd, grantId, {
      ...transitionOptions(options, now),
    });
  }
  if (isTerminal(inspection)) return terminalResult(inspection, false);

  let freshDispatch = false;
  if (inspection.state === 'available') {
    inspection = reserveExternalEffectGrant(cwd, grantId, {
      ...transitionOptions(options, now),
    });
  }
  if (isTerminal(inspection)) return terminalResult(inspection, false);
  if (inspection.state === 'reserved') {
    inspection = markExternalEffectDispatchIssued(
      cwd,
      grantId,
      requireTransactionId(inspection),
      {
        ...transitionOptions(options, now),
      },
    );
    freshDispatch = inspection.state === 'dispatch-issued';
  }
  if (isTerminal(inspection)) return terminalResult(inspection, false);
  if (inspection.state === 'effect-observed') {
    assertPublishObservation(inspection);
    return terminalResult(
      consumeExternalEffectGrant(
        cwd,
        grantId,
        requireTransactionId(inspection),
        {
          ...transitionOptions(options, now),
        },
      ),
      true,
    );
  }
  if (inspection.state !== 'dispatch-issued') throw publishStateInvalid();

  const request = publishRunnerRequest(
    cwd,
    inspection,
    options.environment ?? process.env,
  );
  if (freshDispatch) {
    options.testAfterDispatchIssued?.(request);
    return dispatchAndFinalize(
      cwd,
      inspection,
      request,
      runner,
      options,
      false,
    );
  }

  if (!runner.query) {
    return terminalResult(
      terminalizeExternalEffectGrant(
        cwd,
        grantId,
        request.transactionId,
        'manual-reconciliation',
        'Dispatch was durably issued, but no queryable idempotency receipt is available.',
        transitionOptions(options, now),
      ),
      true,
    );
  }

  let queried: PublishRunnerQuery;
  try {
    queried = runner.query(request);
  } catch {
    queried = {
      state: 'unknown',
      reason: 'Queryable publish state could not be read.',
    };
  }
  options.testAfterRunnerResult?.(queried);
  if (queried.state === 'observed') {
    return observeAndConsume(
      cwd,
      inspection,
      queried.observation,
      options,
      true,
    );
  }
  if (queried.state === 'unknown') {
    return terminalResult(
      terminalizeExternalEffectGrant(
        cwd,
        grantId,
        request.transactionId,
        'manual-reconciliation',
        boundedReason(queried.reason),
        transitionOptions(options, now),
      ),
      true,
    );
  }
  if (now.getTime() >= Date.parse(inspection.payload.expiresAt)) {
    return terminalResult(
      terminalizeExternalEffectGrant(
        cwd,
        grantId,
        request.transactionId,
        'failed',
        'The publish activation window expired before a safe idempotent replay.',
        transitionOptions(options, now),
      ),
      true,
    );
  }
  return dispatchAndFinalize(cwd, inspection, request, runner, options, true);
}

export function createProductionPublishRunner(): PublishRunner {
  return {
    dispatch(request) {
      const lease = `${request.target.refName}:${request.target.expectedRemoteOid ?? ''}`;
      const refspec = `${request.target.sourceOid}:${request.target.refName}`;
      const result = spawnSync(
        'git',
        [
          'push',
          `--force-with-lease=${lease}`,
          '--porcelain',
          '--',
          request.target.remoteName,
          refspec,
        ],
        {
          cwd: request.repositoryRoot,
          encoding: 'utf8',
          env: request.environment,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      if (result.error) {
        return {
          state: 'not-issued',
          reason: 'Git publish process could not be started.',
        };
      }
      if (result.status !== 0) {
        return {
          state: 'unknown',
          reason:
            'Git publish returned failure after dispatch; remote state must be queried.',
        };
      }
      const observed = queryPublishedRef(request);
      return observed.state === 'absent'
        ? {
            state: 'unknown',
            reason:
              'Git reported success but the exact remote artifact was not observable.',
          }
        : observed;
    },
    query(request) {
      return queryPublishedRef(request);
    },
  };
}

function dispatchAndFinalize(
  cwd: string,
  inspection: ExternalEffectGrantInspection,
  request: PublishRunnerRequest,
  runner: PublishRunner,
  options: ExecutePublishOptions,
  replayed: boolean,
): ExecutePublishResult {
  let outcome: PublishRunnerOutcome;
  try {
    outcome = runner.dispatch(request);
  } catch {
    return terminalResult(
      terminalizeExternalEffectGrant(
        cwd,
        inspection.grantId,
        request.transactionId,
        'manual-reconciliation',
        'Publish runner failed after dispatch and external state is unknown.',
        {
          ...transitionOptions(options),
        },
      ),
      replayed,
    );
  }
  options.testAfterRunnerResult?.(outcome);
  if (outcome.state === 'observed') {
    return observeAndConsume(
      cwd,
      inspection,
      outcome.observation,
      options,
      replayed,
    );
  }
  return terminalResult(
    terminalizeExternalEffectGrant(
      cwd,
      inspection.grantId,
      request.transactionId,
      outcome.state === 'not-issued' ? 'failed' : 'manual-reconciliation',
      boundedReason(outcome.reason),
      {
        ...transitionOptions(options),
      },
    ),
    replayed,
  );
}

function observeAndConsume(
  cwd: string,
  inspection: ExternalEffectGrantInspection,
  observation: PublishRunnerObservation,
  options: ExecutePublishOptions,
  replayed: boolean,
): ExecutePublishResult {
  const transactionId = requireTransactionId(inspection);
  let observed: ExternalEffectGrantInspection;
  try {
    assertRunnerObservation(inspection, observation);
    observed = recordExternalEffectObservation(
      cwd,
      inspection.grantId,
      transactionId,
      observation,
      {
        ...transitionOptions(options),
      },
    );
  } catch {
    return terminalResult(
      terminalizeExternalEffectGrant(
        cwd,
        inspection.grantId,
        transactionId,
        'manual-reconciliation',
        'Publish produced a receipt that could not be bound to the signed exact effect.',
        {
          ...transitionOptions(options),
        },
      ),
      replayed,
    );
  }
  assertPublishObservation(observed);
  return terminalResult(
    consumeExternalEffectGrant(cwd, inspection.grantId, transactionId, {
      ...transitionOptions(options),
    }),
    replayed,
  );
}

function queryPublishedRef(request: PublishRunnerRequest): PublishRunnerQuery {
  const result = spawnSync(
    'git',
    [
      'ls-remote',
      '--refs',
      '--',
      request.target.remoteName,
      request.target.refName,
    ],
    {
      cwd: request.repositoryRoot,
      encoding: 'utf8',
      env: request.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error || result.status !== 0) {
    return {
      state: 'unknown',
      reason: 'Remote ref query failed after publish dispatch.',
    };
  }
  const lines = String(result.stdout).trim().split('\n').filter(Boolean);
  if (lines.length > 1) {
    return { state: 'unknown', reason: 'Remote ref query was ambiguous.' };
  }
  const observedOid = lines.length === 0 ? null : lines[0]!.split(/\s+/)[0];
  if (observedOid === request.target.sourceOid) {
    return {
      state: 'observed',
      observation: {
        externalReceiptId: digest(
          canonicalJson({
            kind: 'git-ls-remote-receipt.v1',
            idempotencyKey: request.idempotencyKey,
            refName: request.target.refName,
            sourceOid: request.target.sourceOid,
          }),
        ),
        artifactDigest: request.artifactDigest,
        prestateDigest: request.prestateDigest,
        poststateDigest: publishPoststateDigest(request.target.sourceOid),
        observedAt: new Date().toISOString(),
      },
    };
  }
  if (observedOid === request.target.expectedRemoteOid) {
    return { state: 'absent' };
  }
  return {
    state: 'unknown',
    reason: 'Remote ref differs from both the exact prestate and artifact.',
  };
}

function publishRunnerRequest(
  cwd: string,
  inspection: ExternalEffectGrantInspection,
  environment: NodeJS.ProcessEnv,
): PublishRunnerRequest {
  if (
    inspection.payload.target.kind !== 'git-ref' ||
    !inspection.transactionId ||
    !inspection.transactionToken
  ) {
    throw publishStateInvalid();
  }
  const repository = discoverRepository(cwd);
  return {
    repositoryRoot: repository.repositoryRoot,
    grantId: inspection.grantId,
    transactionId: inspection.transactionId,
    idempotencyKey: inspection.payload.idempotencyKey,
    target: inspection.payload.target,
    artifactDigest: inspection.payload.artifactDigest,
    prestateDigest: inspection.payload.prestateDigest,
    environment: {
      ...environment,
      [PUBLISH_TRANSACTION_ENV]: inspection.transactionToken,
    },
  };
}

function assertPublishGrant(
  cwd: string,
  inspection: ExternalEffectGrantInspection,
): void {
  const { payload } = inspection;
  if (
    payload.effectKind !== 'publish-git-ref' ||
    payload.target.kind !== 'git-ref' ||
    payload.artifactDigest !==
      publishArtifactDigest(payload.target.sourceOid) ||
    payload.prestateDigest !==
      publishPrestateDigest(payload.target.expectedRemoteOid)
  ) {
    throw workflowError(
      'PUBLISH_GRANT_INVALID',
      'External effect grant does not describe one exact ordinary Git publish.',
      ExitCode.guard,
    );
  }
  const repository = discoverRepository(cwd);
  const resolved = runGit(repository.repositoryRoot, [
    'rev-parse',
    '--verify',
    payload.target.sourceOid,
  ]).trim();
  const remoteUrl = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    payload.target.remoteName,
  ]).trim();
  if (
    resolved !== payload.target.sourceOid ||
    repository.head !== payload.target.sourceOid ||
    remoteUrl !== payload.target.remoteUrl
  ) {
    throw workflowError(
      'PUBLISH_GRANT_STALE',
      'Repository artifact or remote differs from the signed publish grant.',
      ExitCode.staleState,
    );
  }
}

function assertRunnerObservation(
  inspection: ExternalEffectGrantInspection,
  observation: PublishRunnerObservation,
): void {
  if (
    !observation ||
    typeof observation.externalReceiptId !== 'string' ||
    observation.externalReceiptId.length < 1 ||
    observation.externalReceiptId.length > 512 ||
    observation.artifactDigest !== inspection.payload.artifactDigest ||
    observation.prestateDigest !== inspection.payload.prestateDigest ||
    inspection.payload.target.kind !== 'git-ref' ||
    observation.poststateDigest !==
      publishPoststateDigest(inspection.payload.target.sourceOid) ||
    typeof observation.observedAt !== 'string' ||
    new Date(Date.parse(observation.observedAt)).toISOString() !==
      observation.observedAt
  ) {
    throw workflowError(
      'PUBLISH_RECEIPT_INVALID',
      'Publish observation is not the exact signed artifact poststate.',
      ExitCode.verification,
    );
  }
}

function assertPublishObservation(
  inspection: ExternalEffectGrantInspection,
): void {
  if (!inspection.observation) throw publishStateInvalid();
  assertRunnerObservation(inspection, inspection.observation);
}

function terminalResult(
  inspection: ExternalEffectGrantInspection,
  replayed: boolean,
): ExecutePublishResult {
  if (!isTerminal(inspection)) throw publishStateInvalid();
  return {
    state: inspection.state,
    grantId: inspection.grantId,
    transactionId: inspection.transactionId,
    replayed,
    observation: inspection.observation,
  };
}

function isTerminal(
  inspection: ExternalEffectGrantInspection,
): inspection is ExternalEffectGrantInspection & {
  state: ExecutePublishResult['state'];
} {
  return [
    'consumed',
    'revoked',
    'expired',
    'failed',
    'manual-reconciliation',
    'reconciled-succeeded',
    'reconciled-rolled-back',
    'reconciled-failed',
  ].includes(inspection.state);
}

function requireTransactionId(
  inspection: ExternalEffectGrantInspection,
): string {
  if (!inspection.transactionId) throw publishStateInvalid();
  return inspection.transactionId;
}

function transitionOptions(
  options: ExecutePublishOptions,
  now: Date = exactDate(options.now ?? new Date()),
): ExternalEffectTransitionOptions {
  return {
    now,
    signer: options.signer,
    onAuditRecord: options.onAuditRecord,
    testAuditServiceHooks: options.testAuditServiceHooks,
  };
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw publishStateInvalid();
  }
  return new Date(value.getTime());
}

function assertOid(value: string): string {
  if (!COMMIT_OID.test(value)) {
    throw workflowError(
      'PUBLISH_GRANT_INVALID',
      'Publish commit identity is malformed.',
      ExitCode.guard,
    );
  }
  return value;
}

function boundedReason(value: string): string {
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 1024 || /[\0\r]/.test(normalized)) {
    return 'Publish runner returned an invalid bounded failure reason.';
  }
  return normalized;
}

function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function publishStateInvalid() {
  return workflowError(
    'PUBLISH_TRANSACTION_INVALID',
    'Publish grant is not in an exact executable or recoverable state.',
    ExitCode.guard,
  );
}
