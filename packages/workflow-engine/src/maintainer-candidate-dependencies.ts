import crypto from 'node:crypto';

import {
  bootstrapInterventionStateRoot,
  resolveControlPlaneEngineSelection,
  resolveLocalEngineSelection,
} from '../bootstrap/control-plane-trust.ts';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.ts';
import { canonicalJson } from './canonical-json.ts';
import { pinCheckRunner } from './check-runner.ts';
import type { CheckDefinition } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import type {
  CandidateChecksAttestationV3,
  CandidateDependencySnapshot,
} from './maintainer-candidate.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export function currentCandidateDependencySnapshot(input: {
  cwd: string;
  repositoryId: string;
  candidateTree: string;
  baseCommit: string;
  policyDigest: string;
  checks: CandidateChecksAttestationV3['checks'];
  environment?: NodeJS.ProcessEnv;
  externalStateDigests?: Readonly<Record<string, string>>;
}): CandidateDependencySnapshot {
  const repository = discoverRepository(input.cwd);
  if (repository.head !== input.baseCommit) {
    throw workflowError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Candidate dependency freshness requires the exact trust-base commit.',
      ExitCode.staleState,
    );
  }
  const policyContent = runGit(repository.repositoryRoot, [
    'show',
    `${input.baseCommit}:workflow/maintainer-policy.json`,
  ]);
  const policy = parseMaintainerPolicy(JSON.parse(policyContent));
  const policyDigest = digest(policyContent);
  if (
    policy.repository.id !== input.repositoryId ||
    policyDigest !== input.policyDigest
  ) {
    throw workflowError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Candidate dependency freshness differs from its trust-base policy.',
      ExitCode.staleState,
    );
  }
  const definitions = loadCandidateCheckDefinitions(
    repository.repositoryRoot,
    input.baseCommit,
    input.checks.map(({ checkId }) => checkId),
  );
  const runnerDigests = Object.fromEntries(
    input.checks.map(({ checkId }) => [
      checkId,
      pinCheckRunner(repository.repositoryRoot, checkId, definitions[checkId]!)
        .digest,
    ]),
  );
  const externalStateDigests = Object.fromEntries(
    input.checks.map((check) => {
      const current = input.externalStateDigests?.[check.checkId];
      if (!check.dependsOn.includes('external-state')) {
        return [check.checkId, null];
      }
      if (typeof current !== 'string' || !DIGEST.test(current)) {
        throw workflowError(
          'APPLY_ATTESTATION_EXTERNAL_STATE_REQUIRED',
          `Check ${check.checkId} requires a trusted current external-state snapshot.`,
          ExitCode.staleState,
        );
      }
      return [check.checkId, current];
    }),
  );
  return {
    schemaVersion: 1,
    sourceTree: input.candidateTree,
    baseCommit: input.baseCommit,
    harnessEngineDigest: resolveCandidateHarnessEngineDigest(
      repository,
      input.repositoryId,
      input.environment ?? process.env,
    ),
    policyDigest,
    runnerDigests,
    externalStateDigests,
  };
}

export function sealedCandidateDependencySnapshot(input: {
  candidateTree: string;
  baseCommit: string;
  harnessEngineDigest: string;
  policyDigest: string;
  checks: CandidateChecksAttestationV3['checks'];
}): CandidateDependencySnapshot {
  return {
    schemaVersion: 1,
    sourceTree: input.candidateTree,
    baseCommit: input.baseCommit,
    harnessEngineDigest: input.harnessEngineDigest,
    policyDigest: input.policyDigest,
    runnerDigests: Object.fromEntries(
      input.checks.map((check) => [check.checkId, check.runnerDigest]),
    ),
    externalStateDigests: Object.fromEntries(
      input.checks.map((check) => [
        check.checkId,
        check.dependsOn.includes('external-state')
          ? check.externalSnapshotDigest
          : null,
      ]),
    ),
  };
}

export function resolveCandidateHarnessEngineDigest(
  repository: ReturnType<typeof discoverRepository>,
  repositoryId: string,
  environment: NodeJS.ProcessEnv,
): string {
  const storageRoot = bootstrapInterventionStateRoot(
    repository.gitCommonDirectory,
  );
  const identity = {
    worktreeRoot: repository.repositoryRealPath,
    branchRef: repository.branch ? `refs/heads/${repository.branch}` : null,
  };
  const local = resolveLocalEngineSelection(storageRoot, identity);
  if (local !== null) {
    const raw = environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
    let parsed: unknown;
    try {
      parsed = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (
      parsed === undefined ||
      canonicalJson(parsed) !== canonicalJson(local.resumeBinding)
    ) {
      throw workflowError(
        'APPLY_ATTESTATION_ENGINE_BINDING_INVALID',
        'Candidate checks were not launched through the bootstrap-selected local engine.',
        ExitCode.staleState,
      );
    }
    return rawDigest(local.resumeBinding.engineDigest);
  }
  const global = resolveControlPlaneEngineSelection(storageRoot, repositoryId);
  return rawDigest(
    global?.activeArtifact.closureDigest ??
      BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadCandidateCheckDefinitions(
  repositoryRoot: string,
  baseCommit: string,
  requiredChecks: string[],
): Record<string, CheckDefinition> {
  try {
    const raw = JSON.parse(
      runGit(repositoryRoot, ['show', `${baseCommit}:workflow/checks.json`]),
    ) as { schemaVersion?: unknown; checks?: unknown };
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.checks !== 'object' ||
      raw.checks === null ||
      Array.isArray(raw.checks)
    ) {
      throw new Error('invalid base checks');
    }
    const checks = raw.checks as Record<string, unknown>;
    return Object.fromEntries(
      requiredChecks.map((checkId) => {
        const definition = checks[checkId] as
          Partial<CheckDefinition> | undefined;
        if (
          !definition ||
          !Array.isArray(definition.command) ||
          !definition.command.every((part) => typeof part === 'string') ||
          typeof definition.destructiveDatabase !== 'boolean'
        ) {
          throw new Error(`invalid base check ${checkId}`);
        }
        return [
          checkId,
          {
            command: [...definition.command],
            destructiveDatabase: definition.destructiveDatabase,
          },
        ];
      }),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw workflowError(
      'AUTHORITY_CHECK_INVALID',
      'Required check definitions are unavailable from the exact grant base.',
      ExitCode.guard,
    );
  }
}

function rawDigest(value: string): string {
  const raw = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!DIGEST.test(raw)) {
    throw workflowError(
      'APPLY_ATTESTATION_ENGINE_BINDING_INVALID',
      'Candidate harness-engine dependency digest is invalid.',
      ExitCode.staleState,
    );
  }
  return raw;
}
