import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  loadAiAdapterPolicy,
  MAX_AI_ADAPTER_LIMITS,
} from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  buildClaudeProviderInvocation,
  CLAUDE_EXECUTABLE_CANDIDATES,
  CLAUDE_REQUIRED_HELP_FLAGS,
} from './claude-provider-adapter.ts';
import {
  buildCodexProviderInvocation,
  CODEX_EXECUTABLE_CANDIDATES,
  CODEX_REQUIRED_EXEC_HELP_FLAGS,
  CODEX_REQUIRED_ROOT_HELP_FLAGS,
} from './codex-provider-adapter.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError, WorkflowError } from './errors.ts';
import { createProviderExecutionEnvironment } from './execution-environment.ts';
import { executionJobStatePath } from './execution-store.ts';
import {
  captureGovernedProviderProjection,
  compareGovernedProviderProjections,
  discoverRepository,
  runGit,
  type GovernedProviderProjectionComparison,
  type GovernedRuntimeInput,
} from './git.ts';
import {
  ensurePrivateInvestigationDirectory,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
} from './investigation-session-store.ts';
import {
  assertInvocationId,
  investigationRuntimePaths,
  type InvestigationRuntimePaths,
} from './paths.ts';
import {
  providerExecutionPolicySnapshotPath,
  readProviderExecutionPolicySnapshot,
  readProviderInvocationRequest,
  type ProviderInvocationAcceptanceBinding,
} from './provider-invocation-store.ts';
import type { ProviderId } from './provider-registry.ts';
import {
  assembleProviderPromptManifest,
  assertProviderPromptContextCurrent,
  providerPromptContextStoreRoot,
  readProviderRepairPrompt,
} from './provider-execution-governance.ts';
import {
  assertProviderProcessSucceeded,
  type ProviderInvocationPlan,
  type ProviderInvocationRequest,
  type ProviderOutputValidator,
  type ProviderProcessOutcome,
} from './provider-contracts.ts';

/**
 * The canonical identity of a resolved provider executable: its reviewed
 * candidate path, the canonicalized real path, and the exact file metadata that
 * must remain stable across a launch. It is recorded so the engine can re-check
 * identity around the invocation rather than trusting a first-seen path.
 */
export type ProviderExecutableIdentity = {
  candidatePath: string;
  realPath: string;
  device: string;
  inode: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeNs: string;
  sha256: string;
};

export type ProviderProbeInput = {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ProviderExecuteInput = ProviderProbeInput & {
  stdinSource: string;
  stdinContent: Buffer;
};

/**
 * The injectable host of real operating-system effects. Only the explicitly
 * named `createProviderRunnerForTesting` seam may substitute this; the
 * production `preflightBuiltInProvider`/`runBuiltInProvider` surface always uses
 * the real code-owned operations.
 */
export type ProviderRunnerHost = {
  inspectCandidate(candidatePath: string): ProviderExecutableIdentity | null;
  runProbe(input: ProviderProbeInput): ProviderProcessOutcome;
  execute(input: ProviderExecuteInput): ProviderProcessOutcome;
};

export type ProviderPreflightOptions = {
  platform: NodeJS.Platform;
  enabled: boolean;
  sourceEnvironment: NodeJS.ProcessEnv;
  temporaryDirectory: string;
};

export type ProviderResolutionStatus =
  | 'disabled'
  | 'unsupported-platform'
  | 'absent'
  | 'unsafe-candidate'
  | 'incompatible'
  | 'unauthenticated'
  | 'available';

export type ProviderResolution = {
  status: ProviderResolutionStatus;
  executable?: ProviderExecutableIdentity;
  version?: string;
};

export type ProviderRunInput = {
  providerId: ProviderId;
  repositoryRoot: string;
  invocationDirectory: string;
  request: ProviderInvocationRequest;
  semanticOutputSchema: unknown;
  outputValidator: ProviderOutputValidator;
  governedRuntimeInputs: GovernedRuntimeInput[];
  acceptanceBinding?: ProviderInvocationAcceptanceBinding;
  reviewSnapshotRoot?: string | null;
  sourceEnvironment: NodeJS.ProcessEnv;
};

export type ProviderRunOptions = {
  platform: NodeJS.Platform;
};

/**
 * The non-durable execution observation the runner returns. It carries the
 * adapter-parsed semantic output bound to the request digest and the observed
 * governed projection equality, but it is not the durable authority: the
 * invocation store/lifecycle remains the owner of any durable
 * ProviderProcessResult. `sameUserProcessConfined` is always false and the
 * residuals retain the honest soft-containment caveats.
 */
export type ProviderRunnerReport = {
  invocationId: string;
  providerId: ProviderId;
  purpose: ProviderInvocationRequest['purpose'];
  requestDigest: string;
  semanticOutput: unknown;
  semanticOutputDigest: string;
  assurance: 'unchanged-governed-projection';
  projection: GovernedProviderProjectionComparison;
  sameUserProcessConfined: false;
  residuals: string[];
  executable: ProviderExecutableIdentity;
  elapsedMs: number;
};

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_BYTES = 64 * 1024;

/**
 * The honest residual soft-containment caveats a successful observation still
 * carries: it runs in the same OS user, its subprocess tree is not confined, a
 * provider that transiently rewrites-and-restores a file or swaps its own
 * executable in place cannot be detected here, and unreachable-object writes and
 * global filesystem immutability are outside the observed governed projection.
 */
export const PROVIDER_RUNNER_RESIDUALS = Object.freeze([
  'SAME_USER_PROCESS_NOT_CONFINED',
  'SUBPROCESS_TREE_NOT_CONFINED',
  'TRANSIENT_WRITE_RESTORE_NOT_DETECTABLE',
  'TRANSIENT_EXECUTABLE_SUBSTITUTION_NOT_DETECTABLE',
  'UNREACHABLE_OBJECT_WRITES_NOT_OBSERVABLE',
  'GLOBAL_FILESYSTEM_IMMUTABILITY_NOT_PROVEN',
  'PROVIDER_INPUT_CONSUMPTION_NOT_OBSERVABLE',
  'STALE_CONCURRENCY_SLOT_PID_REUSE_NOT_DETECTABLE',
]);

/**
 * The bounded preflight surface of a reviewed provider. Every field is
 * code-owned: the fixed candidate paths, the ordered version/help probes with
 * their required advertised flags, and the provider's own authentication status
 * command. Reviewed real-path install roots are derived per candidate.
 */
type ProviderPreflightSpec = {
  candidates: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>>;
  helpProbes: ReadonlyArray<{
    args: readonly string[];
    requiredFlags: readonly string[];
  }>;
  authArgs: readonly string[];
};

const PROVIDER_PREFLIGHT: Record<ProviderId, ProviderPreflightSpec> = {
  claude: {
    candidates: CLAUDE_EXECUTABLE_CANDIDATES,
    helpProbes: [
      { args: ['--help'], requiredFlags: CLAUDE_REQUIRED_HELP_FLAGS },
    ],
    authArgs: ['auth', 'status'],
  },
  codex: {
    candidates: CODEX_EXECUTABLE_CANDIDATES,
    helpProbes: [
      { args: ['--help'], requiredFlags: CODEX_REQUIRED_ROOT_HELP_FLAGS },
      {
        args: ['exec', '--help'],
        requiredFlags: CODEX_REQUIRED_EXEC_HELP_FLAGS,
      },
    ],
    authArgs: ['login', 'status'],
  },
};

// The maximum number of concurrency slot files the engine ever inspects. Policy
// may lower the effective limit, but every code-max slot is always counted so a
// lowered limit still observes a slot held above it.
const CODE_MAX_CONCURRENCY = MAX_AI_ADAPTER_LIMITS.maxConcurrent;

const REVIEWED_CANDIDATE_REAL_ROOTS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  '/opt/homebrew/bin/claude': Object.freeze([
    '/opt/homebrew/Caskroom/claude-code',
    '/opt/homebrew/Cellar/claude-code',
  ]),
  '/usr/local/bin/claude': Object.freeze([
    '/usr/local/Caskroom/claude-code',
    '/usr/local/Cellar/claude-code',
  ]),
  '/opt/homebrew/bin/codex': Object.freeze([
    '/opt/homebrew/Caskroom/codex',
    '/opt/homebrew/Cellar/codex',
  ]),
  '/usr/local/bin/codex': Object.freeze([
    '/usr/local/Caskroom/codex',
    '/usr/local/Cellar/codex',
  ]),
});

type ProviderRunner = {
  preflight(
    providerId: ProviderId,
    options: ProviderPreflightOptions,
  ): ProviderResolution;
  run(
    input: ProviderRunInput,
    options: ProviderRunOptions,
  ): ProviderRunnerReport;
};

/**
 * The only sanctioned host-injection seam. Tests pass a deterministic host so
 * bounded provider behaviour is exercised without spawning a real process.
 */
export function createProviderRunnerForTesting(
  host: ProviderRunnerHost,
): ProviderRunner {
  return createProviderRunner(host);
}

/**
 * Production preflight using real, code-owned filesystem and process
 * operations. It resolves only the fixed reviewed candidates, canonicalizes and
 * inspects executable identity, and runs bounded version/help/auth probes. It
 * never invokes a model.
 */
export function preflightBuiltInProvider(
  providerId: ProviderId,
  options: ProviderPreflightOptions,
): ProviderResolution {
  return createProviderRunner(realProviderRunnerHost()).preflight(
    providerId,
    options,
  );
}

/**
 * Production run using real, code-owned operations. This is the lifecycle-only
 * launch surface: it never proposes, completes, or persists durable results
 * (those belong to the invocation store/lifecycle); it only performs one bounded
 * read-only launch and returns the non-durable observation.
 */
export function runBuiltInProvider(
  input: ProviderRunInput,
  options: ProviderRunOptions,
): ProviderRunnerReport {
  if (input.acceptanceBinding === undefined) {
    throw requestUnbound();
  }
  return createProviderRunner(realProviderRunnerHost()).run(input, options);
}

function createProviderRunner(host: ProviderRunnerHost): ProviderRunner {
  function preflight(
    providerId: ProviderId,
    options: ProviderPreflightOptions,
  ): ProviderResolution {
    if (!options.enabled) {
      return { status: 'disabled' };
    }
    const spec = PROVIDER_PREFLIGHT[providerId];
    const candidates = spec.candidates[options.platform];
    if (!candidates) {
      return { status: 'unsupported-platform' };
    }

    // Inspect every fixed candidate; never a caller-PATH or dynamic location. A
    // candidate must be a regular executable whose real path is the candidate
    // itself or lives under its own reviewed install root; a symlink escaping to
    // any other real path is unsafe and is never probed.
    const resolved: ProviderExecutableIdentity[] = [];
    let sawUnsafeCandidate = false;
    for (const candidate of candidates) {
      const identity = host.inspectCandidate(candidate);
      if (!identity) {
        continue;
      }
      if (
        !isRegularExecutable(identity.mode) ||
        !isReviewedRealPath(candidate, identity.realPath)
      ) {
        sawUnsafeCandidate = true;
        continue;
      }
      resolved.push(identity);
    }
    if (resolved.length === 0) {
      return { status: sawUnsafeCandidate ? 'unsafe-candidate' : 'absent' };
    }

    const environment = createProviderExecutionEnvironment(
      providerId,
      process.execPath,
      options.temporaryDirectory,
      options.sourceEnvironment,
    );
    const probe = (
      executable: string,
      args: string[],
    ): ProviderProcessOutcome =>
      host.runProbe({
        executable,
        args,
        cwd: options.temporaryDirectory,
        environment,
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_BYTES,
      });

    let fallback: ProviderResolution | undefined;
    for (const executable of resolved) {
      const versionOutcome = probe(executable.realPath, ['--version']);
      if (
        !probeSucceeded(versionOutcome) ||
        versionOutcome.stdout.trim() === ''
      ) {
        fallback ??= { status: 'incompatible', executable };
        continue;
      }
      const version = versionOutcome.stdout.trim();

      let compatible = true;
      for (const helpProbe of spec.helpProbes) {
        const helpOutcome = probe(executable.realPath, [...helpProbe.args]);
        if (
          !probeSucceeded(helpOutcome) ||
          !advertisesFlags(helpProbe.requiredFlags, helpOutcome.stdout)
        ) {
          compatible = false;
          break;
        }
      }
      if (!compatible) {
        fallback ??= { status: 'incompatible', executable, version };
        continue;
      }

      const authOutcome = probe(executable.realPath, [...spec.authArgs]);
      if (!indicatesAuthenticated(providerId, authOutcome)) {
        fallback = { status: 'unauthenticated', executable, version };
        continue;
      }

      return { status: 'available', executable, version };
    }
    return (
      fallback ?? {
        status: sawUnsafeCandidate ? 'unsafe-candidate' : 'absent',
      }
    );
  }

  function run(
    input: ProviderRunInput,
    options: ProviderRunOptions,
  ): ProviderRunnerReport {
    const git = discoverRepository(input.repositoryRoot);
    const config = loadWorkflowConfig(input.repositoryRoot);
    if (
      fileDigestAtBaseline(
        input.repositoryRoot,
        git.head,
        'workflow/config.json',
      ) !==
      readPlainFileDigest(
        path.join(input.repositoryRoot, 'workflow', 'config.json'),
        configBaselineMismatch,
      )
    ) {
      throw configBaselineMismatch();
    }
    const paths = investigationRuntimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const invocationId = assertInvocationId(input.request.invocationId);

    // 1. Accept only the exact configured investigation invocation directory for
    //    this request's invocationId — never the worktree or an arbitrary
    //    Git-common location.
    const expectedDirectory = path.join(paths.invocations, invocationId);
    if (
      canonicalDirectoryOrThrow(input.invocationDirectory) !== expectedDirectory
    ) {
      throw runtimeDirectoryUnsafe(input.invocationDirectory);
    }

    // 2. Reconstruct and match the durable canonical request, validate the
    //    repository identity and provider binding, and validate the canonical
    //    manifest digest against the request before any launch.
    const durableRequest = readProviderInvocationRequest(paths, invocationId);
    if (canonicalJson(durableRequest) !== canonicalJson(input.request)) {
      throw durableRequestMismatch();
    }
    if (input.providerId !== input.request.providerId) {
      throw requestUnbound();
    }
    if (input.request.repositoryId !== config.repositoryName) {
      throw repositoryMismatch();
    }
    const manifestValue = readPrivateCanonicalJson(
      paths,
      path.join(expectedDirectory, 'manifest.json'),
      inputManifestMismatch,
    );
    if (
      sha256(canonicalJson(manifestValue)) !== input.request.inputManifestDigest
    ) {
      throw inputManifestMismatch();
    }
    const expectedReviewSnapshotRoot = path.join(
      expectedDirectory,
      'review-root',
    );
    const reviewSnapshotRoot = input.reviewSnapshotRoot ?? null;
    const manifestHasPlanningTarget =
      isRecord(manifestValue) &&
      manifestValue.kind === 'plan-review-manifest' &&
      isRecord(manifestValue.planningTarget);
    const requiresPlanningSnapshot =
      input.request.purpose === 'plan-review' && manifestHasPlanningTarget;
    if (
      (requiresPlanningSnapshot &&
        (reviewSnapshotRoot === null ||
          canonicalDirectoryOrThrow(reviewSnapshotRoot) !==
            expectedReviewSnapshotRoot)) ||
      (!requiresPlanningSnapshot && reviewSnapshotRoot !== null)
    ) {
      throw inputManifestMismatch();
    }
    const contextStoreRoot = providerPromptContextStoreRoot(expectedDirectory);
    const ownerWorkflowId =
      input.acceptanceBinding?.ownerWorkflowId ??
      'investigation-provider-runner-test';
    if (
      input.acceptanceBinding !== undefined &&
      (input.acceptanceBinding.invocationId !== invocationId ||
        input.acceptanceBinding.requestDigest !== input.request.requestDigest)
    ) {
      throw requestUnbound();
    }
    const currentManifestValue = assembleProviderPromptManifest(
      contextStoreRoot,
      input.request,
      manifestValue,
      ownerWorkflowId,
    );
    const managedPrompt = renderManagedProviderPrompt(
      input.request,
      currentManifestValue,
      reviewSnapshotRoot,
      readProviderRepairPrompt(paths, input.request),
    );

    // 3. Keep the tracked policy bytes pinned to the immutable semantic Git
    //    baseline, then load the separately durable per-Attempt execution policy.
    //    This lets a retry adopt newly authorized execution limits without
    //    rebasing the repository content it is reviewing.
    const baselinePolicy = loadAiAdapterPolicy(input.repositoryRoot);
    if (
      fileDigestAtBaseline(
        input.repositoryRoot,
        git.head,
        'workflow/ai-adapter-policy.json',
      ) !== baselinePolicy.digest
    ) {
      throw policyBaselineMismatch();
    }
    if (
      input.request.baseCommit !== git.head ||
      input.request.baseTree !== git.tree
    ) {
      throw baselineMismatch();
    }
    const { loaded, snapshot } = readProviderExecutionPolicySnapshot(
      paths,
      input.request,
    );
    if (input.request.policyDigest !== loaded.digest) {
      throw policyMismatch();
    }
    const providerPolicy = loaded.policy.providers[input.providerId];
    if (!providerPolicy || !providerPolicy.enabled) {
      throw providerDisabled(input.providerId);
    }
    if (
      (input.request.limits.timeoutMs > loaded.policy.limits.timeoutMs &&
        snapshot.schemaVersion !== 3) ||
      input.request.limits.aggregateOutputBytes >
        loaded.policy.limits.aggregateOutputBytes
    ) {
      throw policyMismatch();
    }
    if (
      sha256(canonicalJson(input.semanticOutputSchema)) !==
      input.request.outputSchema.digest
    ) {
      throw outputSchemaUnbound();
    }

    // 4. Acquire a repository-wide concurrency slot before launch; release it in
    //    finally so a failure never leaks the owned slot.
    const slot = acquireProviderSlot(
      paths,
      loaded.policy.limits.maxConcurrent,
      invocationId,
    );
    try {
      // 5. Create a fresh private runtime directory and engine files with
      //    exclusive no-follow 0600 single-link ownership so a preplanted
      //    symlink or hardlink is rejected without truncation.
      const runtimeDirectory = path.join(expectedDirectory, 'runtime');
      createExclusiveRuntimeDirectory(runtimeDirectory);
      const promptPath = path.join(runtimeDirectory, 'prompt.json');
      const schemaPath = path.join(runtimeDirectory, 'schema.json');
      const semanticOutputPath = path.join(
        runtimeDirectory,
        'semantic-output.json',
      );
      const schemaContent = canonicalJson(input.semanticOutputSchema);
      const promptIdentity = createExclusiveRuntimeFile(
        promptPath,
        managedPrompt,
      );
      const schemaIdentity = createExclusiveRuntimeFile(
        schemaPath,
        schemaContent,
      );
      const semanticOutputIdentity = createExclusiveRuntimeFile(
        semanticOutputPath,
        '',
      );

      // The engine prompt and schema are automatically part of the governed
      // runtime-input fingerprint, so a provider that mutates either is observed
      // as drift and can never yield a successful result.
      const governedRuntimeInputs: GovernedRuntimeInput[] = [
        ...input.governedRuntimeInputs,
        ...(input.acceptanceBinding === undefined
          ? []
          : providerAcceptanceGovernedRuntimeInputs(
              paths,
              input.acceptanceBinding,
            )),
        {
          id: 'engine-durable-manifest',
          path: path.join(expectedDirectory, 'manifest.json'),
        },
        {
          id: 'engine-durable-request',
          path: path.join(expectedDirectory, 'request.json'),
        },
        {
          id: 'engine-durable-execution-policy',
          path: providerExecutionPolicySnapshotPath(paths, invocationId),
        },
        {
          id: 'engine-durable-state',
          path: path.join(expectedDirectory, 'state.json'),
        },
        {
          id: 'engine-runtime-tree',
          path: runtimeDirectory,
          kind: 'directory-closure',
          expectedFiles: ['prompt.json', 'schema.json', 'semantic-output.json'],
          mutableContentPaths: ['semantic-output.json'],
        },
        { id: 'engine-prompt', path: promptPath },
        { id: 'engine-schema', path: schemaPath },
      ];

      // 6. Capture the governed before snapshot before any provider
      //    version/help/auth process, and compare after the whole preflight plus
      //    model execution.
      const before = captureGovernedProviderProjection(
        input.repositoryRoot,
        governedRuntimeInputs,
      );

      const resolution = preflight(input.providerId, {
        platform: options.platform,
        enabled: true,
        sourceEnvironment: input.sourceEnvironment,
        temporaryDirectory: runtimeDirectory,
      });
      if (resolution.status !== 'available' || !resolution.executable) {
        throw providerUnavailable(input.providerId, resolution.status);
      }
      const identityBefore = resolution.executable;

      // Preflight executes provider-owned version/help/auth code. Revalidate all
      // three engine files against their creation-time inode and exact expected
      // bytes before the model process receives any path. The prompt itself is
      // fed from the already-rendered in-memory bytes below.
      assertExclusiveRuntimeFile(promptPath, promptIdentity, managedPrompt);
      assertExclusiveRuntimeFile(schemaPath, schemaIdentity, schemaContent);
      assertExclusiveRuntimeFile(
        semanticOutputPath,
        semanticOutputIdentity,
        '',
      );

      const plan = buildInvocationPlan(input, identityBefore.realPath, {
        promptPath,
        schemaPath,
        semanticOutputPath,
      });
      const environment = createProviderExecutionEnvironment(
        input.providerId,
        process.execPath,
        runtimeDirectory,
        input.sourceEnvironment,
      );

      const outcome = host.execute({
        executable: plan.executable,
        args: plan.args,
        cwd: plan.cwd,
        environment,
        stdinSource: plan.stdinSource,
        stdinContent: Buffer.from(managedPrompt, 'utf8'),
        timeoutMs: input.request.limits.timeoutMs,
        maxOutputBytes: input.request.limits.aggregateOutputBytes,
      });

      if (input.acceptanceBinding !== undefined) {
        assertProviderPromptContextCurrent(
          contextStoreRoot,
          input.acceptanceBinding.context,
        );
      }

      // Re-check executable identity around the launch.
      const identityAfter = host.inspectCandidate(identityBefore.candidatePath);
      if (!identityAfter || !sameIdentity(identityBefore, identityAfter)) {
        throw executableIdentityDrift();
      }

      const after = captureGovernedProviderProjection(
        input.repositoryRoot,
        governedRuntimeInputs,
      );
      const projection = compareGovernedProviderProjections(before, after);

      enforceProcessOutcome(outcome, input.request.limits.timeoutMs);
      enforceRawOutputLimit(outcome, input.request.limits.aggregateOutputBytes);

      if (!projection.unchanged) {
        throw governedProjectionDrift(projection.changedCategories);
      }

      const semanticOutput = readNativeSemanticOutput(
        input.providerId,
        outcome,
        semanticOutputPath,
        input.request.limits.aggregateOutputBytes,
      );
      validateSemanticOutput(input, semanticOutput);

      const report: ProviderRunnerReport = {
        invocationId: input.request.invocationId,
        providerId: input.providerId,
        purpose: input.request.purpose,
        requestDigest: input.request.requestDigest,
        semanticOutput,
        semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
        assurance: 'unchanged-governed-projection',
        projection,
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: identityAfter,
        elapsedMs: outcome.elapsedMs,
      };
      return deepFreeze(report);
    } finally {
      slot.release();
    }
  }

  return { preflight, run };
}

function providerAcceptanceGovernedRuntimeInputs(
  paths: InvestigationRuntimePaths,
  binding: ProviderInvocationAcceptanceBinding,
): GovernedRuntimeInput[] {
  const inputs: GovernedRuntimeInput[] = [
    {
      id: 'engine-durable-execution-job',
      path: executionJobStatePath(paths, binding.executionJobId),
    },
    {
      id: 'engine-provider-repair-lineage',
      path: binding.repair.lineagePath,
    },
    {
      id: 'engine-provider-repair-current-evidence',
      path: binding.repair.currentEvidencePath,
    },
  ];
  if (binding.repair.evidencePath !== null) {
    inputs.push({
      id: 'engine-provider-repair-predecessor-evidence',
      path: binding.repair.evidencePath,
    });
  }
  return inputs;
}

function buildInvocationPlan(
  input: ProviderRunInput,
  executable: string,
  paths: { promptPath: string; schemaPath: string; semanticOutputPath: string },
): ProviderInvocationPlan {
  if (input.providerId === 'codex') {
    return buildCodexProviderInvocation({
      executable,
      repositoryRoot: input.repositoryRoot,
      promptPath: paths.promptPath,
      schemaPath: paths.schemaPath,
      semanticOutputPath: paths.semanticOutputPath,
    });
  }
  return buildClaudeProviderInvocation({
    executable,
    repositoryRoot: input.repositoryRoot,
    promptPath: paths.promptPath,
    schemaPath: paths.schemaPath,
    semanticOutputPath: paths.semanticOutputPath,
    semanticOutputSchema: input.semanticOutputSchema,
  });
}

const PROVIDER_PURPOSE_INSTRUCTIONS: Readonly<
  Record<ProviderInvocationRequest['purpose'], readonly string[]>
> = Object.freeze({
  survey: Object.freeze([
    'Independently survey the repository for load-bearing consumers, sibling mechanisms, configuration keys, literal paths, symbols, and architecture invariants relevant to the bound manifest.',
    'Use only the reviewed read/search capability surface.',
    'Return only output that conforms to the bound output schema.',
    // Advisory only: the engine scans every proposed term across the whole
    // pinned tree under a fixed per-term hit ceiling, and a term that exceeds
    // it currently has no recovery exit. A provider cannot count hits, so this
    // states the strategy it can actually act on rather than the limit it
    // cannot measure.
    'For every proposed search term, prefer a verified, repository-specific exact literal that preserves the relevant relationship. When a concept has a commonly used name, use a longer literal containing repository-specific context, a fully qualified symbol, or a literal path rather than the unqualified identifier. Confirm that each literal exists in the pinned repository; use multiple specific terms when necessary to preserve coverage rather than inventing a broader token.',
    // The bound survey validator enforces three constraints the provider-visible
    // JSON schema cannot express: the reference identity, the per-term byte and
    // character bounds, and term uniqueness. They are stated here because a
    // provider that satisfies only the published schema is otherwise rejected
    // with no way to learn why.
    'Set the output "reference" field to exactly the invocationId carried in this prompt request block; any other value is rejected.',
    'Each term value must be at most 256 UTF-8 bytes with no control characters or lone surrogates, and the terms must be unique by their exact kind and value pair.',
  ]),
  'plan-review': Object.freeze([
    'Independently review the complete bound planning target for missing scope, weak WHY rationale, unsupported invariants, contradictions, and testability gaps.',
    'Use only the reviewed read/search capability surface.',
    'Return only output that conforms to the bound output schema.',
    // The bound schema cannot express coverage uniqueness: a structured-output
    // endpoint rejects `uniqueItems`, so the constraint lives only in
    // `assertCoverage`. A duplicated area is rejected after the provider has
    // already spent an attempt; retry preserves that failure and requires a
    // fresh, explicitly cost-acknowledged replacement, so prevent it here.
    'The output "coverage" array must list every one of the seven coverage areas exactly once; a repeated area is rejected.',
    'The output "scopeAssessment" is scope-only: set kind "challenges" if and only if at least one "findings" entry has category "missing-scope" or "missing-consumers"; otherwise set kind "no-challenge" with at least one evidence item, even when "findings" contains challenges in other categories.',
    // Advisory only: the engine scans every proposed term across the whole
    // pinned tree under a fixed per-term hit ceiling, and a term that exceeds
    // it currently has no recovery exit. A provider cannot count hits, so this
    // states the strategy it can actually act on rather than the limit it
    // cannot measure.
    'For every proposed search term, prefer a verified, repository-specific exact literal that preserves the relevant relationship. When a concept has a commonly used name, use a longer literal containing repository-specific context, a fully qualified symbol, or a literal path rather than the unqualified identifier. Confirm that each literal exists in the pinned repository; use multiple specific terms when necessary to preserve coverage rather than inventing a broader token.',
    'Read every planning artifact only from the immutable planningSnapshot artifact readPath supplied in this prompt. Never substitute the worktree path or the baseline-tree copy for a planning artifact.',
    'If the immutable investigation.json contains an evidence node whose type is "plan-review-coverage-requirement", treat its output.requiredTargetIds as mandatory. For every required target, find the matching output.targetBindings row and cite that row\'s exact evidenceKind and path at least once in scopeAssessment, a finding, or a suggestion. Extra evidence is allowed; omitting a required row is rejected at plan commit.',
    'Cite a planningSnapshot member with kind "planning-location" and its logical path. Cite any other repository file with kind "repository-location"; repository-location lines are validated against the pinned baseline tree. The two namespaces are disjoint and a citation in the wrong namespace is rejected.',
    'Treat planningSnapshot.migration as a binding remediation constraint: preserved-byte-identical artifacts cannot be proposed as editable in this generation, replaceable-on-replanning artifacts may change only through a new planning generation, and engine-managed artifacts are not author-editable.',
  ]),
  'task-diff-review': Object.freeze([
    'Independently review the exact bound candidate tree and its base-to-candidate blob and mode transitions.',
    'Use only the reviewed read/search capability surface and do not mutate the worktree, index, refs, runtime, or any repository file.',
    'Return only output that conforms to the bound task-diff-review output schema.',
    'The output "coverage" array must list every required review area exactly once; duplicate or omitted coverage is rejected.',
    'Inspect correctness and invariants, plan alignment, test adequacy, path scope, trust boundaries, dangling consumers, and generated or mirror consistency.',
    'Every challenge must cite exact repository, check-report, or planning-node evidence. A no-challenge scope assessment must still cite affirmative evidence.',
    'Classify current-change blockers as challenges and independent follow-up ideas as suggestions. The advisory verdict never authorizes completion.',
    'Treat the manifest subject, candidate tree, check evidence, task contract, planning generation, and review policy as immutable bindings; do not substitute live runtime metadata.',
  ]),
  'task-implementation': Object.freeze([
    'Implement only the exact engine-sealed RED subject and reviewed behavior contract carried by the bound manifest.',
    'Treat every frozen test and fixture path as authoritative and immutable; do not include changes to those paths in the returned patch.',
    'Return one unified binary-safe Git patch whose derived changes remain inside the reviewed implementation path scopes.',
    'Use only the reviewed read/search capability surface and do not mutate the worktree, index, refs, runtime, or any repository file.',
    'Return only output that conforms to the bound task-strategy implementation output schema.',
    'Do not report GREEN as authority; the workflow engine independently imports the patch and runs every registered GREEN check.',
  ]),
});

function renderManagedProviderPrompt(
  request: ProviderInvocationRequest,
  manifest: unknown,
  reviewSnapshotRoot: string | null,
  repairContext: unknown,
): string {
  return canonicalJson({
    schemaVersion: 1,
    kind: 'managed-provider-prompt',
    request,
    manifest,
    repairContext,
    planningSnapshot: renderPlanningSnapshotPrompt(
      request,
      manifest,
      reviewSnapshotRoot,
    ),
    instructions: providerPurposeInstructions(request, manifest),
  });
}

function providerPurposeInstructions(
  request: ProviderInvocationRequest,
  manifest: unknown,
): readonly string[] {
  if (
    request.purpose === 'task-diff-review' &&
    isRecord(manifest) &&
    manifest.kind === 'task-diff-review-continuation-manifest'
  ) {
    return Object.freeze([
      'Re-review the exact immutable candidate in light of every bound challenge and implementer response.',
      'Use only the reviewed read/search capability surface and do not mutate the worktree, index, refs, runtime, or any repository file.',
      'Return structured proposed dispositions under the code-owned continuation schema; these recommendations are evidence and do not themselves accept, close, waive, or otherwise disposition any challenge.',
      'Bind every recommendation to the exact review, response, and complete challenge set, with a concise rationale for each decision.',
      'The workflow engine alone applies the shared authenticated challenge-closure verifier and may mint a Final Assurance record from an eligible result.',
    ]);
  }
  return PROVIDER_PURPOSE_INSTRUCTIONS[request.purpose];
}

function renderPlanningSnapshotPrompt(
  request: ProviderInvocationRequest,
  manifest: unknown,
  reviewSnapshotRoot: string | null,
): unknown {
  if (request.purpose !== 'plan-review') return null;
  if (!isRecord(manifest) || manifest.kind !== 'plan-review-manifest') {
    throw inputManifestMismatch();
  }
  if (manifest.planningTarget === undefined) return null;
  if (
    reviewSnapshotRoot === null ||
    !isRecord(manifest.planningTarget) ||
    !Array.isArray(manifest.planningTarget.artifacts)
  ) {
    throw inputManifestMismatch();
  }
  return {
    snapshotDigest: manifest.planningTarget.snapshotDigest,
    migration: manifest.planningTarget.migration,
    citationContract: {
      planning: {
        kind: 'planning-location',
        lineSource: 'immutable-planning-snapshot',
      },
      repository: {
        kind: 'repository-location',
        lineSource: 'pinned-investigation-baseline-tree',
      },
    },
    artifacts: manifest.planningTarget.artifacts.map((value) => {
      if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        typeof value.snapshotFile !== 'string'
      ) {
        throw inputManifestMismatch();
      }
      return {
        ...value,
        readPath: path.join(reviewSnapshotRoot, value.snapshotFile),
      };
    }),
  };
}

function fileDigestAtBaseline(
  repositoryRoot: string,
  baseCommit: string,
  repositoryPath: string,
): string {
  const committed = runGit(repositoryRoot, [
    'show',
    `${baseCommit}:${repositoryPath}`,
  ]);
  return sha256(committed);
}

function readPlainFileDigest(
  filePath: string,
  makeError: () => WorkflowError,
): string {
  const before = fs.lstatSync(filePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw makeError();
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw makeError();
    }
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(descriptor))
      .digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalDirectoryOrThrow(directory: string): string {
  try {
    const absolute = path.resolve(directory);
    const real = fs.realpathSync(absolute);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      !path.isAbsolute(directory) ||
      directory !== absolute ||
      real !== absolute ||
      !stats?.isDirectory() ||
      stats.isSymbolicLink()
    ) {
      throw new Error('not a directory');
    }
    return absolute;
  } catch {
    throw runtimeDirectoryUnsafe(directory);
  }
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

/**
 * A reviewed candidate's real path may only be the candidate executable itself
 * or a file under the exact reviewed package roots for that candidate. Any
 * sibling package or broader prefix path is unsafe.
 */
function isReviewedRealPath(candidatePath: string, realPath: string): boolean {
  if (realPath === candidatePath) {
    return true;
  }
  return (REVIEWED_CANDIDATE_REAL_ROOTS[candidatePath] ?? []).some(
    (installRoot) => isWithinDirectory(installRoot, realPath),
  );
}

function advertisesFlags(
  requiredFlags: readonly string[],
  helpText: string,
): boolean {
  return requiredFlags.every((flag) => helpText.includes(flag));
}

function indicatesAuthenticated(
  providerId: ProviderId,
  outcome: ProviderProcessOutcome,
): boolean {
  if (!probeSucceeded(outcome)) {
    return false;
  }
  const text = outcome.stdout.trim();
  if (providerId === 'claude') {
    try {
      const parsed = JSON.parse(text);
      return isRecord(parsed) && parsed.loggedIn === true;
    } catch {
      return false;
    }
  }
  // `codex login status` writes its human-readable confirmation to stderr
  // whenever stdout is not a TTY, which it never is under the engine's
  // sanitized non-interactive probe environment. Reading stdout alone
  // therefore misclassified an authenticated Codex as `unauthenticated` and
  // made the provider-independent role path unreachable. Accept the exact
  // confirmation from either stream; a zero exit is still required, and no
  // other output shape is admitted.
  return [text, outcome.stderr.trim()].some((line) =>
    /^logged in(?:\s+using\b.*)?$/i.test(line),
  );
}

function probeSucceeded(outcome: ProviderProcessOutcome): boolean {
  return (
    outcome.exitCode === 0 &&
    !outcome.timedOut &&
    outcome.signal === null &&
    outcome.spawnErrorCode === null
  );
}

function enforceProcessOutcome(
  outcome: ProviderProcessOutcome,
  timeoutMs: number,
): void {
  assertProviderProcessSucceeded(outcome, timeoutMs);
}

function enforceRawOutputLimit(
  outcome: ProviderProcessOutcome,
  aggregateOutputBytes: number,
): void {
  const bytes =
    Buffer.byteLength(outcome.stdout, 'utf8') +
    Buffer.byteLength(outcome.stderr, 'utf8');
  if (bytes > aggregateOutputBytes) {
    throw outputLimitExceeded();
  }
}

/**
 * Read and parse the provider-native output, enforcing the aggregate cap over
 * raw stdout, raw stderr, the provider-native semantic file/wrapper, and the
 * canonical normalized semantic output. Claude's native wrapper is the raw
 * stdout (already counted); Codex's is a bounded no-follow read of the
 * `--output-last-message` file, so a large semantic file fails even when the
 * event stdout is tiny.
 */
function readNativeSemanticOutput(
  providerId: ProviderId,
  outcome: ProviderProcessOutcome,
  semanticOutputPath: string,
  aggregateOutputBytes: number,
): unknown {
  const stdoutBytes = Buffer.byteLength(outcome.stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(outcome.stderr, 'utf8');

  let output: unknown;
  let nativeBytes: number;
  if (providerId === 'claude') {
    output = parseClaudeNativeOutput(outcome.stdout);
    nativeBytes = 0;
  } else {
    const file = readCodexSemanticFile(
      semanticOutputPath,
      stdoutBytes + stderrBytes,
      aggregateOutputBytes,
    );
    output = parseJsonOrInvalid(file.content);
    nativeBytes = file.bytes;
  }

  let normalized: string;
  try {
    normalized = canonicalJson(output);
  } catch {
    throw nativeOutputInvalid();
  }
  const aggregate =
    stdoutBytes +
    stderrBytes +
    nativeBytes +
    Buffer.byteLength(normalized, 'utf8');
  if (aggregate > aggregateOutputBytes) {
    throw outputLimitExceeded();
  }
  return output;
}

function parseClaudeNativeOutput(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_JSON_PARSE_FAILED',
        'Provider native output was not valid JSON; return one complete object matching the target schema.',
      ),
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== 'result' ||
    parsed.subtype !== 'success' ||
    !('structured_output' in parsed)
  ) {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_WRAPPER_INVALID',
        'Provider native output did not contain the required successful structured-output wrapper; return one complete object matching the target schema.',
      ),
    );
  }
  return parsed.structured_output;
}

function readCodexSemanticFile(
  semanticOutputPath: string,
  consumedBytes: number,
  aggregateOutputBytes: number,
): { content: string; bytes: number } {
  const descriptor = openNoFollowRead(semanticOutputPath);
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw nativeOutputInvalid();
    }
    const size = stats.size;
    // Bound the read: a semantic file that alone pushes the aggregate over the
    // cap fails before it is read into memory.
    if (consumedBytes + size > aggregateOutputBytes) {
      throw outputLimitExceeded();
    }
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        read,
        size - read,
        read,
      );
      if (bytesRead <= 0) {
        break;
      }
      read += bytesRead;
    }
    return { content: buffer.subarray(0, read).toString('utf8'), bytes: read };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseJsonOrInvalid(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_JSON_PARSE_FAILED',
        'Provider native output was not valid JSON; return one complete object matching the target schema.',
      ),
    );
  }
}

function validateSemanticOutput(input: ProviderRunInput, value: unknown): void {
  const validator = input.outputValidator;
  if (
    validator.id !== input.request.outputSchema.id ||
    validator.version !== input.request.outputSchema.version ||
    validator.digest !== input.request.outputSchema.digest
  ) {
    throw nativeOutputInvalid();
  }
  const frozen = deepFreeze(structuredClone(value));
  let valid: boolean;
  try {
    valid = validator.validate(frozen);
  } catch {
    throw nativeOutputInvalid();
  }
  if (valid !== true) {
    const validationErrors = collectSchemaValidationErrors(
      input.semanticOutputSchema,
      frozen,
    );
    throw nativeOutputInvalid({
      repairKind: validationErrors.length === 0 ? 'semantic' : 'schema',
      previousOutput: frozen,
      validationErrors:
        validationErrors.length === 0
          ? [
              {
                path: '/',
                code: 'SEMANTIC_VALIDATION_FAILED',
                message:
                  'Output matched the structural schema but failed the bound semantic validator.',
              },
            ]
          : validationErrors,
    });
  }
}

type ProviderValidationError = {
  path: string;
  code: string;
  message: string;
};

function collectSchemaValidationErrors(
  schema: unknown,
  value: unknown,
): ProviderValidationError[] {
  const errors: ProviderValidationError[] = [];
  const visit = (
    candidate: unknown,
    current: unknown,
    pointer: string,
  ): void => {
    if (errors.length >= 64 || !isRecord(candidate)) return;
    if (Array.isArray(candidate.enum)) {
      const match = candidate.enum.some(
        (allowed) => canonicalJson(allowed) === canonicalJson(current),
      );
      if (!match) {
        errors.push({
          path: pointer || '/',
          code: 'ENUM_MISMATCH',
          message: 'Value is not one of the schema enum alternatives.',
        });
        return;
      }
    }
    if (candidate.type === 'object') {
      if (!isRecord(current)) {
        errors.push({
          path: pointer || '/',
          code: 'TYPE_OBJECT_REQUIRED',
          message: 'Expected an object.',
        });
        return;
      }
      const properties = isRecord(candidate.properties)
        ? candidate.properties
        : {};
      if (Array.isArray(candidate.required)) {
        for (const name of candidate.required) {
          if (typeof name === 'string' && !Object.hasOwn(current, name)) {
            errors.push({
              path: appendJsonPointer(pointer, name),
              code: 'REQUIRED_FIELD_MISSING',
              message: `Required field ${name} is missing.`,
            });
          }
        }
      }
      for (const [name, child] of Object.entries(current)) {
        if (Object.hasOwn(properties, name)) {
          visit(properties[name], child, appendJsonPointer(pointer, name));
        } else if (candidate.additionalProperties === false) {
          errors.push({
            path: appendJsonPointer(pointer, name),
            code: 'ADDITIONAL_PROPERTY_FORBIDDEN',
            message: `Property ${name} is not allowed.`,
          });
        }
      }
      return;
    }
    if (candidate.type === 'array') {
      if (!Array.isArray(current)) {
        errors.push({
          path: pointer || '/',
          code: 'TYPE_ARRAY_REQUIRED',
          message: 'Expected an array.',
        });
        return;
      }
      if (
        Number.isSafeInteger(candidate.minItems) &&
        current.length < Number(candidate.minItems)
      ) {
        errors.push({
          path: pointer || '/',
          code: 'MIN_ITEMS',
          message: `Expected at least ${String(candidate.minItems)} items.`,
        });
      }
      if (
        Number.isSafeInteger(candidate.maxItems) &&
        current.length > Number(candidate.maxItems)
      ) {
        errors.push({
          path: pointer || '/',
          code: 'MAX_ITEMS',
          message: `Expected at most ${String(candidate.maxItems)} items.`,
        });
      }
      if (candidate.items !== undefined) {
        current.forEach((child, index) =>
          visit(
            candidate.items,
            child,
            appendJsonPointer(pointer, String(index)),
          ),
        );
      }
      return;
    }
    if (candidate.type === 'string' && typeof current !== 'string') {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_STRING_REQUIRED',
        message: 'Expected a string.',
      });
    } else if (candidate.type === 'number' && typeof current !== 'number') {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_NUMBER_REQUIRED',
        message: 'Expected a number.',
      });
    } else if (candidate.type === 'integer' && !Number.isSafeInteger(current)) {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_INTEGER_REQUIRED',
        message: 'Expected an integer.',
      });
    } else if (candidate.type === 'boolean' && typeof current !== 'boolean') {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_BOOLEAN_REQUIRED',
        message: 'Expected a boolean.',
      });
    }
  };
  visit(schema, value, '');
  return errors
    .slice(0, 64)
    .sort((left, right) =>
      `${left.path}\0${left.code}`.localeCompare(
        `${right.path}\0${right.code}`,
      ),
    );
}

function appendJsonPointer(pointer: string, segment: string): string {
  const escaped = segment.replaceAll('~', '~0').replaceAll('/', '~1');
  return `${pointer}/${escaped}`;
}

// --- Repository-wide concurrency slots ------------------------------------

type ProviderSlot = { release(): void };

type SlotOwner = {
  pid: number;
  device: bigint;
  inode: bigint;
  marker: string;
};

/**
 * Acquire one of the repository-wide concurrency slots under the configured
 * Git-common runtime root. All code-max slots are inspected — so a lowered
 * policy limit still counts a slot held above it — dead owners are safely
 * reclaimed, and the returned handle releases only the exact inode/token it owns.
 */
function acquireProviderSlot(
  paths: InvestigationRuntimePaths,
  policyMaxConcurrent: number,
  invocationId: string,
): ProviderSlot {
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, 'provider-slot-acquire.lock'),
    () =>
      acquireProviderSlotUnderGuard(paths, policyMaxConcurrent, invocationId),
    'PROVIDER_CONCURRENCY_SLOT_GUARD_CONFLICT',
    concurrencySlotFailed,
  );
}

function acquireProviderSlotUnderGuard(
  paths: InvestigationRuntimePaths,
  policyMaxConcurrent: number,
  invocationId: string,
): ProviderSlot {
  const slotsDirectory = path.join(paths.root, 'provider-slots');
  ensurePrivateInvestigationDirectory(
    paths,
    slotsDirectory,
    concurrencySlotFailed,
  );
  const limit =
    Number.isInteger(policyMaxConcurrent) && policyMaxConcurrent > 0
      ? Math.min(policyMaxConcurrent, CODE_MAX_CONCURRENCY)
      : 1;
  const freeSlotPaths: string[] = [];
  let occupied = 0;
  for (let index = 0; index < CODE_MAX_CONCURRENCY; index += 1) {
    const slotPath = path.join(slotsDirectory, `slot-${index}.lock`);
    const owner = readSlotOwner(slotPath);
    if (owner === 'free') {
      freeSlotPaths.push(slotPath);
    } else if (owner === 'opaque') {
      occupied += 1;
    } else if (isProcessAlive(owner.pid)) {
      occupied += 1;
    } else if (reclaimDeadSlot(slotPath, owner)) {
      freeSlotPaths.push(slotPath);
    } else {
      occupied += 1;
    }
  }
  if (occupied >= limit) {
    throw concurrencyLimitExceeded();
  }
  for (const slotPath of freeSlotPaths) {
    const claimed = claimProviderSlot(slotPath, invocationId);
    if (claimed) {
      return claimed;
    }
  }
  throw concurrencyLimitExceeded();
}

function readSlotOwner(slotPath: string): SlotOwner | 'free' | 'opaque' {
  const linkStats = fs.lstatSync(slotPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!linkStats) {
    return 'free';
  }
  if (
    !linkStats.isFile() ||
    linkStats.isSymbolicLink() ||
    linkStats.nlink !== 1n ||
    (Number(linkStats.mode) & 0o777) !== 0o600
  ) {
    return 'opaque';
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(slotPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    return 'opaque';
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== linkStats.dev || opened.ino !== linkStats.ino) {
      return 'opaque';
    }
    const marker = fs.readFileSync(descriptor, 'utf8');
    const value = JSON.parse(marker);
    if (
      isRecord(value) &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.ownerToken === 'string'
    ) {
      return {
        pid: value.pid,
        device: opened.dev,
        inode: opened.ino,
        marker,
      };
    }
    return 'opaque';
  } catch {
    return 'opaque';
  } finally {
    fs.closeSync(descriptor);
  }
}

function reclaimDeadSlot(slotPath: string, owner: SlotOwner): boolean {
  const stats = fs.lstatSync(slotPath, { bigint: true, throwIfNoEntry: false });
  if (!stats) {
    return true;
  }
  if (stats.dev !== owner.device || stats.ino !== owner.inode) {
    return false;
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(slotPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    return false;
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== owner.device ||
      opened.ino !== owner.inode ||
      fs.readFileSync(descriptor, 'utf8') !== owner.marker
    ) {
      return false;
    }
    const observed = fs.lstatSync(slotPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      !observed ||
      observed.dev !== owner.device ||
      observed.ino !== owner.inode
    ) {
      return false;
    }
    fs.unlinkSync(slotPath);
    fsyncDirectory(path.dirname(slotPath));
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}

function claimProviderSlot(
  slotPath: string,
  invocationId: string,
): ProviderSlot | null {
  const marker = `${canonicalJson({
    schemaVersion: 1,
    ownerToken: crypto.randomUUID(),
    invocationId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      slotPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return null;
    }
    throw concurrencySlotFailed();
  }
  let owned: fs.BigIntStats;
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, marker);
    fs.fsyncSync(descriptor);
    owned = fs.fstatSync(descriptor, { bigint: true });
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(slotPath));
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      releaseOwnedSlot(slotPath, owned, marker);
    },
  };
}

function releaseOwnedSlot(
  slotPath: string,
  owned: fs.BigIntStats,
  marker: string,
): void {
  const linkStats = fs.lstatSync(slotPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !linkStats ||
    linkStats.dev !== owned.dev ||
    linkStats.ino !== owned.ino
  ) {
    throw concurrencySlotFailed();
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(slotPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw concurrencySlotFailed();
  }
  let owns = false;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev === owned.dev && opened.ino === owned.ino) {
      owns = fs.readFileSync(descriptor, 'utf8') === marker;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (owns) {
    try {
      fs.unlinkSync(slotPath);
      fsyncDirectory(path.dirname(slotPath));
    } catch {
      throw concurrencySlotFailed();
    }
  } else {
    throw concurrencySlotFailed();
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}

// --- Real host, filesystem, and process primitives ------------------------

function realProviderRunnerHost(): ProviderRunnerHost {
  return {
    inspectCandidate: inspectRealCandidate,
    runProbe: (input) => spawnBoundedProcess(input),
    execute: (input) => spawnBoundedProcess(input, input.stdinContent),
  };
}

function inspectRealCandidate(
  candidatePath: string,
): ProviderExecutableIdentity | null {
  if (!fs.lstatSync(candidatePath, { throwIfNoEntry: false })) {
    return null;
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(candidatePath);
  } catch {
    return null;
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(realPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    return null;
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) {
      return null;
    }
    const sha256Digest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(descriptor))
      .digest('hex');
    const observedRealPath = fs.realpathSync(candidatePath);
    const observed = fs.statSync(realPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      observedRealPath !== realPath ||
      !observed ||
      observed.dev !== opened.dev ||
      observed.ino !== opened.ino
    ) {
      return null;
    }
    return {
      candidatePath,
      realPath,
      device: String(opened.dev),
      inode: String(opened.ino),
      mode: Number(opened.mode),
      uid: Number(opened.uid),
      gid: Number(opened.gid),
      size: Number(opened.size),
      mtimeNs: String(opened.mtimeNs),
      sha256: sha256Digest,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function spawnBoundedProcess(
  input: ProviderProbeInput,
  stdinContent?: Buffer,
): ProviderProcessOutcome {
  const start = process.hrtime.bigint();
  const result = spawnSync(input.executable, input.args, {
    cwd: input.cwd,
    env: input.environment,
    shell: false,
    input: stdinContent,
    timeout: input.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: input.maxOutputBytes + 1,
    encoding: 'utf8',
  });
  const elapsedMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
  const timedOut =
    result.error !== undefined &&
    (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const spawnErrorCode =
    result.error !== undefined && !timedOut
      ? ((result.error as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED')
      : null;
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut,
    spawnErrorCode,
    elapsedMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function createExclusiveRuntimeDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o700 ||
      fs.realpathSync(directory) !== path.resolve(directory)
    ) {
      throw runtimePathUnsafe(directory);
    }
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw runtimePathUnsafe(directory);
  }
}

type RuntimeFileIdentity = {
  device: bigint;
  inode: bigint;
};

function createExclusiveRuntimeFile(
  filePath: string,
  content: string,
): RuntimeFileIdentity {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
  } catch {
    // A preplanted symlink, hardlink, or any other existing entry (EEXIST/ELOOP)
    // is rejected without following or truncating its target.
    throw runtimePathUnsafe(filePath);
  }
  try {
    const stats = fs.fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n) {
      throw runtimePathUnsafe(filePath);
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor, { bigint: true });
    return { device: written.dev, inode: written.ino };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertExclusiveRuntimeFile(
  filePath: string,
  identity: RuntimeFileIdentity,
  expectedContent: string,
): void {
  const linked = fs.lstatSync(filePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !linked?.isFile() ||
    linked.isSymbolicLink() ||
    linked.nlink !== 1n ||
    linked.dev !== identity.device ||
    linked.ino !== identity.inode ||
    (linked.mode & 0o777n) !== 0o600n
  ) {
    throw runtimePathUnsafe(filePath);
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw runtimePathUnsafe(filePath);
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== identity.device ||
      opened.ino !== identity.inode ||
      (opened.mode & 0o777n) !== 0o600n ||
      !fs.readFileSync(descriptor).equals(Buffer.from(expectedContent, 'utf8'))
    ) {
      throw runtimePathUnsafe(filePath);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function openNoFollowRead(filePath: string): number {
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_OUTPUT_FILE_MISSING_OR_UNSAFE',
        'Provider native output file was missing or unsafe; return one complete object matching the target schema.',
      ),
    );
  }
}

function noFollowFlag(): number {
  return process.platform !== 'win32' &&
    typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
}

function isRegularExecutable(mode: number): boolean {
  return (mode & 0o170000) === 0o100000 && (mode & 0o111) !== 0;
}

function sameIdentity(
  before: ProviderExecutableIdentity,
  after: ProviderExecutableIdentity,
): boolean {
  return canonicalJson(before) === canonicalJson(after);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// --- Typed error constructors ---------------------------------------------

function providerUnavailable(
  providerId: ProviderId,
  status: ProviderResolutionStatus,
): WorkflowError {
  return workflowError(
    'PROVIDER_UNAVAILABLE',
    `Provider "${providerId}" is not available: ${status}.`,
    ExitCode.unsafeEnvironment,
    { details: { status } },
  );
}

function requestUnbound(): WorkflowError {
  return workflowError(
    'PROVIDER_REQUEST_UNBOUND',
    'Provider invocation input is not bound to the request provider.',
    ExitCode.guard,
  );
}

function repositoryMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_REPOSITORY_MISMATCH',
    'Provider request repository identity does not match this repository.',
    ExitCode.guard,
  );
}

function durableRequestMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_DURABLE_REQUEST_MISMATCH',
    'Launch request does not match the durable canonical invocation request.',
    ExitCode.staleState,
  );
}

function inputManifestMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_INPUT_MANIFEST_MISMATCH',
    'Durable input manifest does not match the request manifest digest.',
    ExitCode.staleState,
  );
}

function policyMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_POLICY_MISMATCH',
    'Provider request is not bound to the current adapter policy or its limits.',
    ExitCode.guard,
  );
}

function policyBaselineMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_POLICY_BASELINE_MISMATCH',
    'Live adapter policy bytes differ from the pinned baseline commit.',
    ExitCode.staleState,
  );
}

function configBaselineMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_CONFIG_BASELINE_MISMATCH',
    'Live workflow configuration bytes differ from the pinned baseline commit.',
    ExitCode.staleState,
  );
}

function providerDisabled(providerId: ProviderId): WorkflowError {
  return workflowError(
    'PROVIDER_DISABLED',
    `Provider "${providerId}" is disabled by the adapter policy.`,
    ExitCode.guard,
  );
}

function baselineMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_BASELINE_MISMATCH',
    'Provider request baseline does not match the current repository HEAD/tree.',
    ExitCode.staleState,
  );
}

function outputSchemaUnbound(): WorkflowError {
  return workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNBOUND',
    'Provider semantic output schema does not match the request output schema digest.',
    ExitCode.guard,
  );
}

function runtimeDirectoryUnsafe(directory: string): WorkflowError {
  return workflowError(
    'PROVIDER_RUNTIME_DIRECTORY_UNSAFE',
    'Provider runtime directory is not the configured investigation invocation directory.',
    ExitCode.unsafeEnvironment,
    { details: { directory } },
  );
}

function runtimePathUnsafe(filePath: string): WorkflowError {
  return workflowError(
    'PROVIDER_RUNTIME_PATH_UNSAFE',
    'Provider runtime file is not an exclusively created no-follow single-link regular file.',
    ExitCode.unsafeEnvironment,
    { details: { path: filePath } },
  );
}

function concurrencyLimitExceeded(): WorkflowError {
  return workflowError(
    'PROVIDER_CONCURRENCY_LIMIT',
    'Provider concurrency limit reached for this repository.',
    ExitCode.conflict,
  );
}

function concurrencySlotFailed(): WorkflowError {
  return workflowError(
    'PROVIDER_CONCURRENCY_SLOT_FAILED',
    'Unable to acquire a repository-wide provider concurrency slot.',
    ExitCode.unsafeEnvironment,
  );
}

function executableIdentityDrift(): WorkflowError {
  return workflowError(
    'PROVIDER_EXECUTABLE_IDENTITY_DRIFT',
    'Provider executable identity changed around the invocation.',
    ExitCode.unsafeEnvironment,
  );
}

function governedProjectionDrift(changedCategories: string[]): WorkflowError {
  return workflowError(
    'PROVIDER_GOVERNED_PROJECTION_DRIFT',
    'Governed projection changed during the provider invocation.',
    ExitCode.verification,
    { details: { changedCategories } },
  );
}

function outputLimitExceeded(): WorkflowError {
  return workflowError(
    'PROVIDER_OUTPUT_LIMIT_EXCEEDED',
    'Provider aggregate output exceeded the bounded byte limit.',
    ExitCode.verification,
  );
}

type NativeOutputRepair = {
  repairKind: 'schema' | 'semantic';
  previousOutput: unknown;
  validationErrors: ProviderValidationError[];
};

function nativeOutputRepair(
  reasonCode: string,
  message: string,
): NativeOutputRepair {
  return {
    repairKind: 'schema',
    // Native bytes may contain prompts, credentials, or other provider output
    // that is not safe to persist. Repair lineage therefore records only this
    // fixed diagnostic sentinel and never copies raw stdout/file content.
    previousOutput: {
      kind: 'provider-native-output-unavailable',
      reasonCode,
    },
    validationErrors: [{ path: '/', code: reasonCode, message }],
  };
}

function nativeOutputInvalid(
  repair: NativeOutputRepair = nativeOutputRepair(
    'NATIVE_OUTPUT_INVALID',
    'Provider native output was malformed; return one complete object matching the target schema.',
  ),
): WorkflowError {
  return workflowError(
    'PROVIDER_NATIVE_OUTPUT_INVALID',
    'Provider native output was malformed or failed its bound output schema.',
    ExitCode.verification,
    { details: { repair } },
  );
}
