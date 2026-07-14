import { ExitCode, workflowError } from './errors.ts';
import {
  addIssue,
  closeIssue,
  renderIssues,
  updateIssue,
  validateIssueLog,
  type Issue,
  type IssueUpdateField,
} from './issues.ts';

export function dispatchIssueCommand(
  args: string[],
  repositoryRoot: string,
): Record<string, unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case 'add': {
      const options = parseOptions(rest);
      const requirementLabel = single(options, 'requirement-label', false);
      const requirementHref = single(options, 'requirement-href', false);
      if (
        (requirementLabel === undefined) !==
        (requirementHref === undefined)
      ) {
        throw usage('Requirement label and href must be provided together.');
      }
      const issue: Issue = {
        id: single(options, 'id'),
        category: single(options, 'category') as Issue['category'],
        title: single(options, 'title'),
        status: single(options, 'status') as Issue['status'],
        priority: single(options, 'priority') as Issue['priority'],
        requirement:
          requirementLabel && requirementHref
            ? { label: requirementLabel, href: requirementHref }
            : null,
        references: options.get('reference') ?? [],
        notes: single(options, 'notes'),
      };
      const data = addIssue(repositoryRoot, issue);
      return { action, issueId: issue.id, issueCount: data.issues.length };
    }
    case 'update': {
      const issueId = rest[0];
      if (!issueId) {
        throw usage('Issue update requires an issue ID.');
      }
      const options = parseOptions(rest.slice(1));
      const field = single(options, 'field') as IssueUpdateField;
      if (!['title', 'status', 'priority', 'notes'].includes(field)) {
        throw usage('Issue update field is not supported.');
      }
      updateIssue(repositoryRoot, issueId, field, single(options, 'value'));
      return { action, issueId, field };
    }
    case 'close': {
      const issueId = rest[0];
      if (!issueId) {
        throw usage('Issue close requires an issue ID.');
      }
      const options = parseOptions(rest.slice(1));
      closeIssue(
        repositoryRoot,
        issueId,
        single(options, 'date'),
        single(options, 'notes'),
      );
      return { action, issueId };
    }
    case 'render':
      if (rest.length !== 0) {
        throw usage('Issue render takes no arguments.');
      }
      renderIssues(repositoryRoot);
      return { action, path: 'docs/ISSUE_LOG.md' };
    case 'validate':
      if (rest.length !== 0) {
        throw usage('Issue validate takes no arguments.');
      }
      validateIssueLog(repositoryRoot);
      return { action, valid: true };
    default:
      throw usage(
        'Usage: pnpm workflow issue <add|update|close|render|validate> ...',
      );
  }
}

function parseOptions(args: string[]): Map<string, string[]> {
  if (args.length % 2 !== 0) {
    throw usage('Issue options must be --name value pairs.');
  }
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option.startsWith('--') || !value || value.startsWith('--')) {
      throw usage('Issue options must be --name value pairs.');
    }
    const name = option.slice(2);
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  return options;
}

function single(options: Map<string, string[]>, name: string): string;
function single(
  options: Map<string, string[]>,
  name: string,
  required: false,
): string | undefined;
function single(
  options: Map<string, string[]>,
  name: string,
  required = true,
): string | undefined {
  const values = options.get(name);
  if (!values && !required) {
    return undefined;
  }
  if (values?.length !== 1) {
    throw usage(`Issue option --${name} must appear exactly once.`);
  }
  return values[0];
}

function usage(message: string) {
  return workflowError('INVALID_ISSUE_USAGE', message, ExitCode.usage);
}
