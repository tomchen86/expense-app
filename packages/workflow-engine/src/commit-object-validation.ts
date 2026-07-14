import { ExitCode, workflowError } from './errors.ts';
import {
  commitChangedPaths,
  commitFacts,
  managedCommitMessage,
} from './git-transitions.ts';
import type { WorkflowSession } from './session-store.ts';

export function assertCommitObject(
  repositoryRoot: string,
  session: WorkflowSession,
  subject: string,
  facts: ReturnType<typeof commitFacts>,
  expectedTree: string,
  expectedPaths: string[],
): void {
  const expectedMessage = managedCommitMessage(
    subject,
    session.changeId,
    session.taskId,
  );
  if (
    JSON.stringify(facts.parents) !== JSON.stringify([session.baseline.head]) ||
    facts.tree !== expectedTree ||
    facts.message !== `${expectedMessage}\n` ||
    JSON.stringify(commitChangedPaths(repositoryRoot, facts.hash)) !==
      JSON.stringify(expectedPaths)
  ) {
    throw workflowError(
      'COMMIT_POSTCONDITION_FAILED',
      'The created commit does not match the authorized finish projection.',
      ExitCode.staleState,
    );
  }
}
