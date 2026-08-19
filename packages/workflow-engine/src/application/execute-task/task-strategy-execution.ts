import crypto from 'node:crypto';

import { resolveActorIdentity } from '../../modules/provider-orchestration/actor-identity.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  pinCheckRunner,
  runExpectedRedCheck,
} from '../../adapters/consumer/expense-app/work-registry/check-runner.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { createCheckEnvironment } from '../../adapters/consumer/expense-app/work-registry/database-policy.ts';
import { createEvidenceNode } from '../../adapters/compatibility/investigation-v2/evidence-node.ts';
import { writeEvidenceNode } from '../../runtime/storage-journal/evidence-object-store.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { previewExactStaging } from '../../runtime/repository-transaction/git-transitions.ts';
import { runGit } from '../../runtime/repository-transaction/git.ts';
import {
  loadInvestigationRuntimeContext,
  runSessionOperation,
} from '../../lifecycle-context.ts';
import { matchesAllowedPath } from '../../runtime/session-workspace/paths.ts';
import {
  createTaskStrategyTransaction,
  readTaskStrategyTransaction,
  type TaskStrategyFrozenFile,
  type TaskStrategyTransaction,
} from '../../runtime/storage-journal/task-strategy-store.ts';
import { inspectSession } from '../finalize/verification.ts';

const TASK_STRATEGY_RED_POLICY = Object.freeze({
  schemaVersion: 1,
  kind: 'task-strategy-red-policy.v1',
  admittedFailureCategories: ['assertion', 'behavior-mismatch'],
  engineOwnedCheckEvidence: true,
  frozenTestBytes: true,
});

export type SealTaskStrategyRedOptions = Readonly<{
  explicitActor?: string;
  environment?: NodeJS.ProcessEnv;
}>;

export type PreparedTaskStrategyRed = Readonly<{
  transactionInput: Omit<
    TaskStrategyTransaction,
    'schemaVersion' | 'kind' | 'recordDigest'
  >;
  evidenceNode: ReturnType<typeof createEvidenceNode>;
}>;

export type PrepareTaskStrategyRedSuccessorOptions = Readonly<{
  author: TaskStrategyTransaction['author'];
  predecessorCandidateTree: string;
  environment?: NodeJS.ProcessEnv;
}>;

export function inspectTaskStrategyTransaction(
  cwd: string,
  requestedSessionId: string,
): TaskStrategyTransaction | null {
  const context = loadInvestigationRuntimeContext(cwd);
  return readTaskStrategyTransaction(context.runtime, requestedSessionId);
}

export function sealTaskStrategyRed(
  cwd: string,
  requestedSessionId: string,
  options: SealTaskStrategyRedOptions = {},
): TaskStrategyTransaction {
  return runSessionOperation(cwd, requestedSessionId, () =>
    sealTaskStrategyRedUnlocked(cwd, requestedSessionId, options),
  );
}

function sealTaskStrategyRedUnlocked(
  cwd: string,
  requestedSessionId: string,
  options: SealTaskStrategyRedOptions,
): TaskStrategyTransaction {
  const inspection = inspectSession(cwd, requestedSessionId);
  const task = executionTask(inspection);
  const taskContractDigest = sha256(canonicalJson(task));
  const actorResolution = resolveActorIdentity({
    ...(options.explicitActor === undefined
      ? {}
      : { explicitActor: options.explicitActor }),
    environment: options.environment ?? process.env,
  });
  if (actorResolution.outcome !== 'resolved') {
    throw workflowError(
      actorResolution.code,
      'Task strategy RED sealing requires one exact implementation actor.',
      ExitCode.guard,
    );
  }

  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const existing = readTaskStrategyTransaction(
    runtime,
    inspection.session.sessionId,
  );
  if (existing !== null) {
    assertTransactionIdentity(
      existing,
      inspection,
      task,
      taskContractDigest,
      actorResolution.actor,
    );
    const preview = previewExactStaging(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...inspection.changedPaths],
    );
    if (
      preview.tree !== existing.red.candidateTree ||
      canonicalJson(
        readFrozenFiles(
          inspection.git.repositoryRoot,
          preview.tree,
          existing.red.files.map(({ path }) => path),
        ),
      ) !== canonicalJson(existing.red.files)
    ) {
      throw redStale();
    }
    return existing;
  }

  const prepared = prepareTaskStrategyRed(
    cwd,
    requestedSessionId,
    inspection,
    task,
    taskContractDigest,
    actorResolution.actor,
    options.environment ?? process.env,
  );
  writeEvidenceNode(runtime, prepared.evidenceNode);
  return createTaskStrategyTransaction(runtime, prepared.transactionInput);
}

/**
 * Prepare a successor RED transaction without publishing any descendant.
 * The revision journal must durably bind this exact value before the caller
 * writes the evidence node, transaction object, or current-ref transition.
 * The caller owns the repository and session lifecycle locks.
 */
export function prepareTaskStrategyRedSuccessorUnlocked(
  cwd: string,
  requestedSessionId: string,
  options: PrepareTaskStrategyRedSuccessorOptions,
): PreparedTaskStrategyRed {
  const inspection = inspectSession(cwd, requestedSessionId);
  const task = executionTask(inspection);
  const taskContractDigest = sha256(canonicalJson(task));
  if (inspection.session.state !== 'active') {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_NOT_APPLICABLE',
      'RED revision requires an active task session.',
      ExitCode.staleState,
    );
  }
  const prepared = prepareTaskStrategyRed(
    cwd,
    requestedSessionId,
    inspection,
    task,
    taskContractDigest,
    options.author,
    options.environment ?? process.env,
  );
  if (
    prepared.transactionInput.red.candidateTree ===
    options.predecessorCandidateTree
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_NO_CHANGE',
      'RED revision must change at least one governed test or fixture byte.',
      ExitCode.verification,
    );
  }
  return prepared;
}

function prepareTaskStrategyRed(
  cwd: string,
  requestedSessionId: string,
  inspection: ReturnType<typeof inspectSession>,
  task: CrossAgentTddExecution | TddSingleAgentExecution,
  taskContractDigest: string,
  author: TaskStrategyTransaction['author'],
  environment: NodeJS.ProcessEnv,
): PreparedTaskStrategyRed {
  const classified = classifyRedPaths(inspection.changedPaths, task);
  if (
    classified.implementationPaths.length > 0 ||
    classified.unclassifiedPaths.length > 0 ||
    classified.testPaths.length === 0
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_SCOPE_INVALID',
      'RED sealing permits only declared test and fixture paths before implementation.',
      ExitCode.verification,
      {
        details: {
          implementationPaths: classified.implementationPaths,
          unclassifiedPaths: classified.unclassifiedPaths,
          testPaths: classified.testPaths,
        },
      },
    );
  }
  const definition = inspection.contract.checks.checks[task.redCheck];
  if (!definition || definition.destructiveDatabase) {
    throw workflowError(
      'TASK_STRATEGY_RED_CHECK_UNSAFE',
      'The strategy RED check is missing or declares destructive database access.',
      ExitCode.verification,
    );
  }
  const preview = previewExactStaging(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    [...inspection.changedPaths],
  );
  const runner = pinCheckRunner(
    inspection.git.repositoryRoot,
    task.redCheck,
    definition,
  );
  const result = runExpectedRedCheck(
    inspection.git.repositoryRoot,
    task.redCheck,
    definition,
    runner,
    createCheckEnvironment(environment, false),
  );
  if (
    result.failureCategory !== 'assertion' &&
    result.failureCategory !== 'behavior-mismatch'
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_FAILURE_INVALID',
      'Only an engine-observed behavioral or assertion failure can seal RED.',
      ExitCode.verification,
      { details: { failureCategory: result.failureCategory } },
    );
  }
  if (canonicalJson(result.testPaths) !== canonicalJson(classified.testPaths)) {
    throw workflowError(
      'TASK_STRATEGY_RED_SCOPE_INVALID',
      'The RED result does not cover the exact changed test paths.',
      ExitCode.verification,
      {
        details: {
          expectedTestPaths: classified.testPaths,
          observedTestPaths: result.testPaths,
        },
      },
    );
  }
  const after = inspectSession(cwd, requestedSessionId, {
    expectedSession: inspection.session,
  });
  const afterPreview = previewExactStaging(
    after.git.repositoryRoot,
    after.session.baseline.head,
    [...after.changedPaths],
  );
  if (
    afterPreview.tree !== preview.tree ||
    canonicalJson(after.changedPaths) !== canonicalJson(inspection.changedPaths)
  ) {
    throw redStale();
  }
  const frozenPaths = [
    ...classified.testPaths,
    ...classified.fixturePaths,
  ].sort();
  const files = readFrozenFiles(
    inspection.git.repositoryRoot,
    preview.tree,
    frozenPaths,
  );
  const createdAt = new Date().toISOString();
  const policyDigest = sha256(canonicalJson(TASK_STRATEGY_RED_POLICY));
  const evidenceNode = createEvidenceNode({
    type: 'task-strategy-red-evidence',
    nodeSchema: 'task-strategy-red-evidence.v1',
    evaluator: 'workflow-engine',
    policyDigest,
    exactInputDigests: {
      candidateTree: sha256(preview.tree),
      taskContract: taskContractDigest,
      runner: result.runnerDigest,
      failure: result.failureFingerprint,
      frozenFiles: sha256(canonicalJson(files)),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'task-strategy-red-result.v1',
    output: {
      outcome: 'red-sealed',
      checkId: result.checkId,
      failureCategory: result.failureCategory,
      selector: result.selector,
      testPaths: result.testPaths,
      fixturePaths: classified.fixturePaths,
      author,
    },
    runtimeMetadata: { createdAt },
  });
  return Object.freeze({
    evidenceNode,
    transactionInput: Object.freeze({
      sessionId: inspection.session.sessionId,
      changeId: inspection.session.changeId,
      taskId: inspection.session.taskId,
      baseline: inspection.session.baseline,
      strategy: task.strategy,
      phase: 'red-sealed',
      taskContractDigest,
      author,
      red: {
        candidateTree: preview.tree,
        changedPaths: [...inspection.changedPaths],
        checkId: result.checkId,
        runner: result.runner,
        runnerDigest: result.runnerDigest,
        exitCode: result.exitCode,
        failureCategory: result.failureCategory,
        selector: result.selector,
        testPaths: [...result.testPaths],
        fixturePaths: classified.fixturePaths,
        files,
        stdoutDigest: result.stdoutDigest,
        stderrDigest: result.stderrDigest,
        failureFingerprint: result.failureFingerprint,
        evidenceNodeId: evidenceNode.nodeId,
        evidenceResultDigest: evidenceNode.resultDigest,
        evidenceNode,
      },
      createdAt,
    }),
  });
}

function executionTask(
  inspection: ReturnType<typeof inspectSession>,
): CrossAgentTddExecution | TddSingleAgentExecution {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  if (
    task?.strategy !== 'cross-agent-tdd' &&
    task?.strategy !== 'tdd-single-agent'
  ) {
    throw workflowError(
      'TASK_STRATEGY_RED_NOT_APPLICABLE',
      'The active task does not use a TDD execution strategy.',
      ExitCode.guard,
    );
  }
  return task;
}

function classifyRedPaths(
  changedPaths: readonly string[],
  task: CrossAgentTddExecution | TddSingleAgentExecution,
): {
  testPaths: string[];
  fixturePaths: string[];
  implementationPaths: string[];
  unclassifiedPaths: string[];
} {
  const testPaths: string[] = [];
  const fixturePaths: string[] = [];
  const implementationPaths: string[] = [];
  const unclassifiedPaths: string[] = [];
  for (const changedPath of changedPaths) {
    if (
      task.fixturePathScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      )
    ) {
      fixturePaths.push(changedPath);
    } else if (
      task.testPathScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      )
    ) {
      testPaths.push(changedPath);
    } else if (
      task.implementationPathScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      )
    ) {
      implementationPaths.push(changedPath);
    } else {
      unclassifiedPaths.push(changedPath);
    }
  }
  return {
    testPaths: testPaths.sort(),
    fixturePaths: fixturePaths.sort(),
    implementationPaths: implementationPaths.sort(),
    unclassifiedPaths: unclassifiedPaths.sort(),
  };
}

function readFrozenFiles(
  repositoryRoot: string,
  tree: string,
  paths: readonly string[],
): TaskStrategyFrozenFile[] {
  return paths.map((candidatePath) => {
    const output = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      tree,
      '--',
      `:(literal)${candidatePath}`,
    ]);
    const match =
      /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
        output,
      );
    if (!match || match[3] !== candidatePath) {
      throw workflowError(
        'TASK_STRATEGY_RED_FILE_INVALID',
        'A RED test or fixture is absent or is not a regular executable/plain file.',
        ExitCode.verification,
        { details: { path: candidatePath } },
      );
    }
    return {
      path: candidatePath,
      mode: match[1] as TaskStrategyFrozenFile['mode'],
      objectId: match[2]!,
    };
  });
}

function assertTransactionIdentity(
  transaction: TaskStrategyTransaction,
  inspection: ReturnType<typeof inspectSession>,
  task: CrossAgentTddExecution | TddSingleAgentExecution,
  taskContractDigest: string,
  actor: TaskStrategyTransaction['author'],
): void {
  if (
    transaction.sessionId !== inspection.session.sessionId ||
    transaction.changeId !== inspection.session.changeId ||
    transaction.taskId !== inspection.session.taskId ||
    canonicalJson(transaction.baseline) !==
      canonicalJson(inspection.session.baseline) ||
    transaction.strategy !== task.strategy ||
    transaction.taskContractDigest !== taskContractDigest ||
    canonicalJson(transaction.author) !== canonicalJson(actor)
  ) {
    throw redStale();
  }
}

function redStale() {
  return workflowError(
    'TASK_STRATEGY_RED_STALE',
    'The sealed RED transaction no longer matches the exact task, actor, or frozen candidate bytes.',
    ExitCode.staleState,
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
