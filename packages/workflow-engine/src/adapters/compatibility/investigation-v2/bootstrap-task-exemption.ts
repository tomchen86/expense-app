import { parseTasks } from '../../consumer/expense-app/work-registry/contracts.ts';
import {
  commitFacts,
  planningCommitMessage,
} from '../../../runtime/repository-transaction/git-transitions.ts';
import { runGit } from '../../../runtime/repository-transaction/git.ts';
import {
  protectedActivationBaselines,
  resolveInvestigationPlanningActivation,
} from '../../planning/openspec/documents/openspec-schema-contract.ts';

/**
 * Task IDs already completed in the before tree of the change's earliest
 * canonical plan commit reachable from the given tip. Ordinary changes are
 * born through plan introductions whose tasks must all be unchecked, so this
 * set is empty for every change created under the canonical regime; only
 * bootstrap-era completions can appear in it.
 */
export function preEpochCompletedTaskIds(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  tip: string,
): ReadonlySet<string> {
  const expectedMessage = `${planningCommitMessage(changeId)}\n`;
  const values = runGit(repositoryRoot, [
    'log',
    tip,
    '--format=%H%x00%B%x00',
  ]).split('\0');
  const matches: string[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    const hash = values[index].trimStart();
    if (!/^[0-9a-f]{40,64}$/.test(hash)) {
      continue;
    }
    if (values[index + 1] === expectedMessage) {
      matches.push(hash);
    }
  }
  // Log order is date-based and forgeable; only ancestry proves which plan
  // commit came first. Without one commit that precedes every other match,
  // no epoch exists and nothing is exempt.
  const earliest = matches.find((candidate) =>
    matches.every(
      (other) =>
        other === candidate ||
        runGit(
          repositoryRoot,
          ['merge-base', candidate, other],
          true,
        ).trim() === candidate,
    ),
  );
  if (!earliest) {
    return new Set();
  }
  const activations = [tip, ...protectedActivationBaselines(repositoryRoot)]
    .filter((baseline, index, values) => values.indexOf(baseline) === index)
    .map((baseline) =>
      resolveInvestigationPlanningActivation(repositoryRoot, [baseline]),
    )
    .filter(({ activated }) => activated);
  if (
    activations.some(
      ({ anchor }) =>
        anchor === null ||
        anchor === earliest ||
        runGit(
          repositoryRoot,
          ['merge-base', earliest, anchor],
          true,
        ).trim() !== earliest,
    )
  ) {
    // Once a reviewed cutover exists, compatibility is anchored to it rather
    // than to a commit message an actor can mint later. A stale side branch
    // created after the protected base activated likewise cannot manufacture
    // a pre-epoch plan. Repositories that have not cut over yet retain their
    // genuine legacy behavior.
    return new Set();
  }
  const facts = commitFacts(repositoryRoot, earliest);
  if (facts.parents.length !== 1) {
    return new Set();
  }
  let beforeTasks: string;
  try {
    beforeTasks = runGit(repositoryRoot, [
      'show',
      `${facts.parents[0]}:${changeRoot}/${changeId}/tasks.md`,
    ]);
  } catch {
    return new Set();
  }
  return new Set(
    parseTasks(beforeTasks)
      .filter(({ completed }) => completed)
      .map(({ id }) => id),
  );
}
