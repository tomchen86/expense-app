import {
  createProductionWorkflowGrantCoordinator,
  requestInvestigationGrant,
  requestInvestigationV3Grant,
} from './grant-production.ts';
import type { GrantCoordinator } from './grant-coordinator.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';

type HumanGrantCliDependencies = Readonly<{
  coordinator(cwd: string): GrantCoordinator;
  requestInvestigation(
    cwd: string,
    investigationId: string,
    proposedReason: string,
  ): Promise<unknown>;
  requestInvestigationV3(
    cwd: string,
    investigationId: string,
    proposedReason: string,
  ): Promise<unknown>;
}>;

const PRODUCTION_DEPENDENCIES: HumanGrantCliDependencies = Object.freeze({
  coordinator: createProductionWorkflowGrantCoordinator,
  requestInvestigation: requestInvestigationGrant,
  requestInvestigationV3: requestInvestigationV3Grant,
});

export function isHumanGrantCliInvocation(argv: readonly string[]): boolean {
  return argv[0] === 'grant' && argv[1] === 'human';
}

export async function dispatchHumanGrantCli(
  argv: readonly string[],
  cwd: string,
  dependencies: HumanGrantCliDependencies = PRODUCTION_DEPENDENCIES,
): Promise<Record<string, unknown>> {
  if (!isHumanGrantCliInvocation(argv)) throw humanGrantUsage();
  const action = argv[2];
  if (
    (action === 'request-investigation' ||
      action === 'request-investigation-v3') &&
    argv.length === 6 &&
    argv[4] === '--reason'
  ) {
    const request =
      action === 'request-investigation'
        ? dependencies.requestInvestigation
        : dependencies.requestInvestigationV3;
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await request(cwd, argv[3]!, argv[5]!),
    };
  }
  if (action === 'inspect' && argv.length === 4) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: dependencies.coordinator(cwd).inspectChallenge(argv[3]!),
    };
  }
  if (action === 'decide' && argv.length === 4) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await dependencies.coordinator(cwd).resolveChallenge(argv[3]!),
    };
  }
  if (action === 'recover' && argv.length === 4) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await dependencies.coordinator(cwd).recoverChallenge(argv[3]!),
    };
  }
  throw humanGrantUsage();
}

export async function runHumanGrantCli(
  argv: readonly string[],
  cwd = process.cwd(),
): Promise<number> {
  const json = argv.at(-1) === '--json';
  const args = json ? argv.slice(0, -1) : [...argv];
  try {
    const result = await dispatchHumanGrantCli(args, cwd);
    process.stdout.write(
      json
        ? `${JSON.stringify(result)}\n`
        : `${JSON.stringify(result, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    const failure =
      error instanceof WorkflowError
        ? error
        : workflowError(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error),
            ExitCode.internal,
          );
    const rendered = {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
      },
    };
    process.stderr.write(
      json
        ? `${JSON.stringify(rendered)}\n`
        : `${JSON.stringify(rendered, null, 2)}\n`,
    );
    return failure.exitCode;
  }
}

function humanGrantUsage(): WorkflowError {
  return workflowError(
    'USAGE',
    'Usage: pnpm workflow grant human <request-investigation <investigation-id> --reason <agent-proposed-reason>|request-investigation-v3 <investigation-id> --reason <agent-proposed-reason>|inspect <challenge-id>|decide <challenge-id>|recover <challenge-id>> [--json]',
    ExitCode.usage,
  );
}
