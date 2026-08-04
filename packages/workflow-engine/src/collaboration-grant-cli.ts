import {
  issueCollaborationGrant,
  type CollaborationAvailableActor,
  type CollaborationDegradedForm,
  type CollaborationGrantRequest,
  type CollaborationLifecyclePhase,
  type CollaborationRolePair,
} from './collaboration-grant.ts';
import {
  inspectCollaborationGrants,
  revokeCollaborationGrant,
} from './collaboration-grant-store.ts';
import type { ActorAssurance } from './actor-identity.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import { isProviderId } from './provider-registry.ts';

type CollaborationGrantCommandResult = Record<string, unknown>;

export function isCollaborationGrantCommand(args: string[]): boolean {
  return (
    args[0] === 'collaboration-grant' ||
    args[0] === 'collaboration-inspect' ||
    args[0] === 'collaboration-revoke'
  );
}

export function dispatchCollaborationGrantCommand(
  args: string[],
  cwd: string,
): CollaborationGrantCommandResult {
  switch (args[0]) {
    case 'collaboration-grant': {
      const request = parseCollaborationGrantArguments(args, cwd);
      const issued = issueCollaborationGrant(cwd, request);
      return {
        action: 'collaboration-grant',
        ok: true,
        grantId: issued.grantId,
        expiresAt: issued.envelope.payload.expiresAt,
        changeId: issued.envelope.payload.changeId,
        taskId: issued.envelope.payload.taskId,
        lifecyclePhase: issued.envelope.payload.lifecyclePhase,
        rolePair: issued.envelope.payload.rolePair,
        degradedForm: issued.envelope.payload.degradedForm,
        authorizedEffect: issued.envelope.payload.authorizedEffect,
      };
    }
    case 'collaboration-inspect': {
      if (args.length > 2) {
        throw collaborationUsage();
      }
      const repository = discoverRepository(cwd);
      return {
        action: 'collaboration-inspect',
        ok: true,
        grants: inspectCollaborationGrants(
          repository.gitCommonDirectory,
          args[1],
        ),
      };
    }
    case 'collaboration-revoke': {
      if (args.length !== 4 || args[2] !== '--reason' || !args[3]?.trim()) {
        throw collaborationUsage();
      }
      return {
        action: 'collaboration-revoke',
        ok: true,
        grant: revokeCollaborationGrant(cwd, args[1]!, {
          reason: args[3],
        }),
      };
    }
    default:
      throw collaborationUsage();
  }
}

export function parseCollaborationGrantArguments(
  args: string[],
  cwd = process.cwd(),
): CollaborationGrantRequest {
  if (args[0] !== 'collaboration-grant') {
    throw collaborationUsage();
  }
  const values = args.slice(1);
  if (values.length === 0 || values.length % 2 !== 0) {
    throw collaborationUsage();
  }
  const single = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option || !value || !option.startsWith('--') || single.has(option)) {
      throw collaborationUsage();
    }
    single.set(option, value);
  }
  const allowed = new Set([
    '--change',
    '--task',
    '--base',
    '--target',
    '--phase',
    '--author-role',
    '--conflicting-role',
    '--provider',
    '--caller',
    '--direct-human',
    '--actor-assurance',
    '--degraded',
    '--reason',
    '--ttl',
    '--uses',
  ]);
  if ([...single.keys()].some((option) => !allowed.has(option))) {
    throw collaborationUsage();
  }

  const changeId = single.get('--change');
  const baselineCommit = single.get('--base');
  const targetDigest = single.get('--target');
  const lifecyclePhase = single.get('--phase');
  const authorRole = single.get('--author-role');
  const conflictingRole = single.get('--conflicting-role');
  const degradedForm = single.get('--degraded');
  const reason = single.get('--reason');
  if (
    !changeId ||
    !baselineCommit ||
    !targetDigest ||
    !isLifecyclePhase(lifecyclePhase) ||
    !isRolePair(lifecyclePhase, authorRole, conflictingRole) ||
    !isDegradedForm(degradedForm) ||
    !reason
  ) {
    throw collaborationUsage();
  }

  const actor = parseAvailableActor(single, degradedForm);
  const repository = discoverRepository(cwd);
  const baselineTree = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${baselineCommit}^{tree}`,
  ]).trim();
  const ttl = single.get('--ttl');
  const uses = single.get('--uses');
  if (
    (ttl !== undefined && !/^[1-9][0-9]*m$/.test(ttl)) ||
    (uses !== undefined && !/^[1-9][0-9]*$/.test(uses))
  ) {
    throw collaborationUsage();
  }

  return {
    changeId,
    taskId: single.get('--task') ?? null,
    baselineCommit,
    baselineTree,
    targetDigest,
    lifecyclePhase,
    rolePair: {
      authorRole,
      conflictingRole,
    } as CollaborationRolePair,
    availableActor: actor,
    degradedForm,
    reason,
    ...(ttl ? { ttlMinutes: Number.parseInt(ttl.slice(0, -1), 10) } : {}),
    ...(uses ? { maxUses: Number.parseInt(uses, 10) } : {}),
  };
}

function parseAvailableActor(
  options: Map<string, string>,
  degradedForm: CollaborationDegradedForm,
): CollaborationAvailableActor {
  const provider = options.get('--provider');
  const caller = options.get('--caller');
  const directHuman = options.get('--direct-human');
  const assurance = options.get('--actor-assurance');
  const selected = [provider, caller, directHuman].filter(
    (value) => value !== undefined,
  );
  if (selected.length !== 1) {
    throw collaborationUsage();
  }
  if (
    degradedForm === 'same-provider-fresh-session' &&
    provider &&
    isProviderId(provider) &&
    isActorAssurance(assurance)
  ) {
    return { kind: 'provider', providerId: provider, assurance };
  }
  if (
    degradedForm === 'caller-supplied' &&
    caller &&
    isActorAssurance(assurance)
  ) {
    return { kind: 'caller', callerId: caller, assurance };
  }
  if (
    degradedForm === 'direct-human-review' &&
    directHuman === 'true' &&
    assurance === undefined
  ) {
    // The real signer identity replaces this placeholder before any payload is
    // validated or signed.
    return {
      kind: 'direct-human',
      identity: 'pending-interactive-signer',
      assurance: 'maintainer-signed',
    };
  }
  throw collaborationUsage();
}

function isLifecyclePhase(
  value: string | undefined,
): value is CollaborationLifecyclePhase {
  return value === 'blind-survey' || value === 'plan-review';
}

function isRolePair(
  phase: CollaborationLifecyclePhase,
  authorRole: string | undefined,
  conflictingRole: string | undefined,
): boolean {
  return (
    (phase === 'blind-survey' &&
      authorRole === 'investigation-author' &&
      conflictingRole === 'blind-surveyor') ||
    (phase === 'plan-review' &&
      authorRole === 'plan-author' &&
      conflictingRole === 'plan-reviewer')
  );
}

function isDegradedForm(
  value: string | undefined,
): value is CollaborationDegradedForm {
  return (
    value === 'same-provider-fresh-session' ||
    value === 'caller-supplied' ||
    value === 'direct-human-review'
  );
}

function isActorAssurance(value: string | undefined): value is ActorAssurance {
  return (
    value === 'self-declared' ||
    value === 'runtime-hint' ||
    value === 'adapter-assigned'
  );
}

export function collaborationUsage() {
  return workflowError(
    'INVALID_USAGE',
    [
      'Usage:',
      '  pnpm workflow maintainer collaboration-grant --change <id> [--task <task-id>] --base <commit> --target <digest> --phase <blind-survey|plan-review> --author-role <role> --conflicting-role <role> (--provider <codex|claude> --actor-assurance <grade>|--caller <id> --actor-assurance <grade>|--direct-human true) --degraded <same-provider-fresh-session|caller-supplied|direct-human-review> --reason <text> [--ttl <minutes>m] [--uses 1] [--json]',
      '  pnpm workflow maintainer collaboration-inspect [grant-id] [--json]',
      '  pnpm workflow maintainer collaboration-revoke <grant-id> --reason <text> [--json]',
    ].join('\n'),
    ExitCode.usage,
  );
}
