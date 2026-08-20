import { isRecord, isStringArray } from './contract-values.ts';
import { RepositoryPathError, normalizePolicyPath } from './repository-path.ts';
import type {
  CheckDefinitionV1,
  CheckRegistryV1,
} from './check-registry-port.ts';

const CHECK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type CheckDefinition = CheckDefinitionV1;
export type ChecksConfig = CheckRegistryV1;

export type ChecksConfigParseResult =
  | Readonly<{ ok: true; value: ChecksConfig }>
  | Readonly<{
      ok: false;
      reason: 'invalid-registry' | 'invalid-definition';
      checkId: string | null;
    }>;

export type ParsedCheckCommand =
  | {
      runner: 'node';
      args: string[];
      entrypoints: string[];
    }
  | {
      runner: 'node-package-bin';
      workspace: string;
      packageName: string;
      binName: string;
      args: string[];
    };

export function parseCheckCommand(
  command: string[],
): ParsedCheckCommand | undefined {
  if (
    command.length < 2 ||
    command.some(
      (part) =>
        part.trim() !== part ||
        [...part].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        }),
    )
  ) {
    return undefined;
  }

  if (command[0] === 'node') {
    const args = command.slice(1);
    const entrypoints = nodeEntrypoints(args);
    return entrypoints ? { runner: 'node', args, entrypoints } : undefined;
  }
  if (command[0] !== 'node-package-bin' || command.length < 4) {
    return undefined;
  }

  const [, workspace, packageName, binName, ...args] = command;
  if (
    (workspace !== '.' && !isExactPolicyPath(workspace)) ||
    !isPackageName(packageName) ||
    !isPackageSegment(binName)
  ) {
    return undefined;
  }

  return {
    runner: 'node-package-bin',
    workspace,
    packageName,
    binName,
    args,
  };
}

/** Parse the complete code-owned checks registry without consulting a worktree. */
export function parseChecksConfigSource(
  value: unknown,
): ChecksConfigParseResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.checks)
  ) {
    return Object.freeze({
      ok: false as const,
      reason: 'invalid-registry' as const,
      checkId: null,
    });
  }

  for (const [checkId, definition] of Object.entries(value.checks)) {
    if (
      !CHECK_ID_PATTERN.test(checkId) ||
      !isRecord(definition) ||
      !Object.keys(definition).every((key) =>
        ['command', 'destructiveDatabase', 'liveStderr'].includes(key),
      ) ||
      !isStringArray(definition.command) ||
      parseCheckCommand(definition.command) === undefined ||
      typeof definition.destructiveDatabase !== 'boolean' ||
      (definition.liveStderr !== undefined &&
        typeof definition.liveStderr !== 'boolean')
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'invalid-definition' as const,
        checkId,
      });
    }
  }

  return Object.freeze({
    ok: true as const,
    value: value as unknown as ChecksConfig,
  });
}

function nodeEntrypoints(args: string[]): string[] | undefined {
  let entrypoints: string[];
  if (args[0] === '--test') {
    entrypoints = nodeTestEntrypoints(args, 1);
  } else if (args[0] === '--experimental-strip-types' && args[1] === '--test') {
    entrypoints = nodeTestEntrypoints(args, 2);
  } else if (
    args[0] === '--experimental-strip-types' &&
    args[1] &&
    !args[1].startsWith('-')
  ) {
    entrypoints = [args[1]];
  } else {
    if (!args[0] || args[0].startsWith('-')) {
      return undefined;
    }
    entrypoints = [args[0]];
  }

  return entrypoints.length > 0 && entrypoints.every(isExactPolicyPath)
    ? entrypoints
    : undefined;
}

function nodeTestEntrypoints(args: string[], start: number): string[] {
  return args.slice(args[start] === '--test-concurrency=4' ? start + 1 : start);
}

function isExactPolicyPath(value: string): boolean {
  if (value.startsWith('-') || !isPolicyPath(value)) {
    return false;
  }
  return value !== '.' && !value.endsWith('/**');
}

function isPolicyPath(value: string): boolean {
  try {
    return normalizePolicyPath(value) === value;
  } catch (error) {
    if (error instanceof RepositoryPathError) return false;
    throw error;
  }
}

function isPackageName(value: string): boolean {
  if (value.length > 214) {
    return false;
  }
  const segments = value.startsWith('@') ? value.slice(1).split('/') : [value];
  return (
    (segments.length === 1 || segments.length === 2) &&
    segments.every(isPackageSegment)
  );
}

function isPackageSegment(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}
