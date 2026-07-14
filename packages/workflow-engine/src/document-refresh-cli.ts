import {
  applyDocumentRefresh,
  inspectDocumentRefreshProposal,
  proposeDocumentRefresh,
  reviewDocumentRefresh,
} from './document-refresh.ts';
import { ExitCode, workflowError } from './errors.ts';

export function dispatchDocumentRefreshCommand(
  args: string[],
  cwd: string,
): Record<string, unknown> {
  const [action, ...rest] = args;
  const options = parseOptions(rest);
  switch (action) {
    case 'show': {
      requireExactOptions(options, ['proposal']);
      return {
        action,
        proposal: inspectDocumentRefreshProposal(
          cwd,
          required(options, 'proposal'),
        ),
      };
    }
    case 'propose': {
      requireExactOptions(options, ['target', 'section', 'replacement']);
      return {
        action,
        ...proposeDocumentRefresh(
          cwd,
          required(options, 'target'),
          required(options, 'section'),
          required(options, 'replacement'),
        ),
      };
    }
    case 'review': {
      requireExactOptions(options, ['proposal', 'decision', 'reviewer']);
      return {
        action,
        ...reviewDocumentRefresh(
          cwd,
          required(options, 'proposal'),
          required(options, 'decision') as 'approve' | 'reject',
          required(options, 'reviewer'),
        ),
      };
    }
    case 'apply': {
      requireExactOptions(options, ['proposal', 'review']);
      return {
        action,
        ...applyDocumentRefresh(
          cwd,
          required(options, 'proposal'),
          required(options, 'review'),
        ),
      };
    }
    default:
      throw usage();
  }
}

function requireExactOptions(
  options: Map<string, string>,
  expected: string[],
): void {
  if (
    options.size !== expected.length ||
    expected.some((name) => !options.has(name))
  ) {
    throw usage();
  }
}

function parseOptions(args: string[]): Map<string, string> {
  if (args.length % 2 !== 0) {
    throw usage();
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option.startsWith('--') || !value || options.has(option.slice(2))) {
      throw usage();
    }
    options.set(option.slice(2), value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) {
    throw usage();
  }
  return value;
}

function usage() {
  return workflowError(
    'INVALID_DOCUMENT_REFRESH_USAGE',
    'Usage: pnpm workflow document-refresh <propose|show|review|apply> with the required named options.',
    ExitCode.usage,
  );
}
