import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../../../foundation/canonical-json/canonical-json.ts';
import type { WorkflowConfig } from './contracts.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  parsePathRoleRegistry,
  resolvePathRole,
  type PathRole,
  type PathRoleRegistry,
} from '../../../../modules/source/path-role-registry.ts';
import {
  matchesAllowedPath,
  normalizePolicyPath,
} from '../../../../runtime/session-workspace/paths.ts';

export type TaskAuthorizationRequirement = Readonly<{
  requiresMandate: boolean;
  mode: 'conditional' | 'legacy-unconditional';
  roles: readonly PathRole[];
  matchedPatterns: readonly string[];
  unclassifiedScope: boolean;
  policyDigest: string;
}>;

export function resolveTaskAuthorizationRequirement(
  repositoryRoot: string,
  config: Pick<WorkflowConfig, 'taskAuthorization'>,
  allowedPaths: readonly string[],
): TaskAuthorizationRequirement {
  if (config.taskAuthorization === undefined) {
    return Object.freeze({
      requiresMandate: true,
      mode: 'legacy-unconditional' as const,
      roles: Object.freeze([]),
      matchedPatterns: Object.freeze([]),
      unclassifiedScope: true,
      policyDigest: digestPolicy({ mode: 'legacy-unconditional' }),
    });
  }
  const registry = readPathRoleRegistry(
    repositoryRoot,
    config.taskAuthorization.pathRoleRegistry,
  );
  const requiredRoles = new Set<PathRole>(
    config.taskAuthorization.mandateRequiredRoles,
  );
  const normalizedAllowed = allowedPaths.map(normalizePolicyPath);
  const intersections = normalizedAllowed.flatMap((allowed) => {
    if (!allowed.endsWith('/**')) {
      const resolution = resolvePathRole(registry, allowed);
      return resolution.registered
        ? [{ pattern: resolution.pattern, role: resolution.role }]
        : [];
    }
    return registry.rules.filter(({ pattern }) =>
      patternsIntersect(allowed, pattern),
    );
  });
  const roles = [...new Set(intersections.map(({ role }) => role))].sort();
  const matchedPatterns = [
    ...new Set(intersections.map(({ pattern }) => pattern)),
  ].sort();
  const unclassifiedScope = normalizedAllowed.some((allowed) => {
    if (!allowed.endsWith('/**')) {
      return !resolvePathRole(registry, allowed).registered;
    }
    return !registry.rules.some(({ pattern }) =>
      patternCovers(pattern, allowed),
    );
  });
  // This registry is the reviewed list of paths that require stronger human
  // authority, not an allowlist for every ordinary repository path. A path
  // without a role remains observable as unclassified, but it does not turn
  // an otherwise ordinary product change into a signing ceremony.
  const requiresMandate = roles.some((role) => requiredRoles.has(role));
  return Object.freeze({
    requiresMandate,
    mode: 'conditional' as const,
    roles: Object.freeze(roles),
    matchedPatterns: Object.freeze(matchedPatterns),
    unclassifiedScope,
    policyDigest: digestPolicy({
      policy: config.taskAuthorization,
      registry,
      allowedPaths: normalizedAllowed,
    }),
  });
}

export function assertTaskMandateOptional(
  repositoryRoot: string,
  config: Pick<WorkflowConfig, 'taskAuthorization'>,
  allowedPaths: readonly string[],
): TaskAuthorizationRequirement {
  const requirement = resolveTaskAuthorizationRequirement(
    repositoryRoot,
    config,
    allowedPaths,
  );
  if (requirement.requiresMandate) {
    throw workflowError(
      'TASK_MANDATE_REQUIRED',
      'This task scope intersects protected repository paths and requires a human-signed Task Mandate.',
      ExitCode.guard,
      {
        details: {
          mode: requirement.mode,
          roles: requirement.roles,
          matchedPatterns: requirement.matchedPatterns,
          unclassifiedScope: requirement.unclassifiedScope,
        },
        recovery:
          'Authorize the change scope, then retry with --mandate <mandate-task-id>.',
      },
    );
  }
  return requirement;
}

function readPathRoleRegistry(
  repositoryRoot: string,
  registryPath: string,
): PathRoleRegistry {
  const absolute = path.join(repositoryRoot, normalizePolicyPath(registryPath));
  try {
    return parsePathRoleRegistry(JSON.parse(fs.readFileSync(absolute, 'utf8')));
  } catch (error) {
    throw workflowError(
      'TASK_AUTHORIZATION_POLICY_INVALID',
      'The configured task path-role registry is missing or malformed.',
      ExitCode.guard,
      {
        details: {
          registryPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function patternsIntersect(left: string, right: string): boolean {
  return patternCovers(left, right) || patternCovers(right, left);
}

function patternCovers(container: string, candidate: string): boolean {
  const normalizedContainer = normalizePolicyPath(container);
  const normalizedCandidate = normalizePolicyPath(candidate);
  if (!normalizedContainer.endsWith('/**')) {
    return normalizedContainer === normalizedCandidate;
  }
  const candidateBase = normalizedCandidate.endsWith('/**')
    ? normalizedCandidate.slice(0, -3)
    : normalizedCandidate;
  return matchesAllowedPath(candidateBase, normalizedContainer);
}

function digestPolicy(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}
