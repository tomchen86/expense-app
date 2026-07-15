import { evaluateAiAdapter } from './ai-adapter-evaluation.ts';
import { ExitCode, workflowError } from './errors.ts';

export function dispatchAiAdapterCommand(
  args: string[],
  repositoryRoot: string,
): Record<string, unknown> {
  if (args.length !== 1 || args[0] !== 'evaluate') {
    throw workflowError(
      'INVALID_AI_ADAPTER_USAGE',
      'Usage: pnpm workflow adapter evaluate [--json]',
      ExitCode.usage,
    );
  }
  return {
    action: 'evaluate',
    ...evaluateAiAdapter(repositoryRoot),
  };
}
