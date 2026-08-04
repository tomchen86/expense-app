import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  bootstrapInterventionStateRoot,
  resolveControlPlaneEngineSelection,
  resolveLocalEngineSelection,
  verifyBuiltInEngineClosure,
} from './control-plane-trust.ts';
import { canonicalJson } from './canonical-json.ts';

const ENGINE_PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

try {
  const repository = discoverRepositoryIdentity(process.cwd());
  const stateRoot = bootstrapInterventionStateRoot(
    repository.gitCommonDirectory,
  );
  const local = resolveLocalEngineSelection(stateRoot, repository);
  const global =
    local === null ? resolveControlPlaneEngineSelection(stateRoot) : null;
  const invocation = local
    ? {
        executable: local.executablePath,
        argv: process.argv.slice(2),
      }
    : global === null
      ? builtInInvocation(process.argv.slice(2))
      : {
          executable: global.activeArtifact.executablePath,
          argv: process.argv.slice(2),
        };
  const result = childProcess.spawnSync(
    invocation.executable,
    invocation.argv,
    {
      cwd: process.cwd(),
      env: launchEnvironment(local?.resumeBinding ?? null),
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({
      kind: 'workflow-launcher-error.v1',
      code,
      message,
    })}\n`,
  );
  process.exit(errorExitCode(error));
}

function builtInInvocation(argv: string[]): {
  executable: string;
  argv: string[];
} {
  const builtInEngine = verifyBuiltInEngineClosure(ENGINE_PACKAGE_ROOT);
  return {
    executable: process.execPath,
    argv: ['--experimental-strip-types', builtInEngine, ...argv],
  };
}

function discoverRepositoryIdentity(cwd: string): {
  gitCommonDirectory: string;
  worktreeRoot: string;
  branchRef: string | null;
} {
  const gitExecutable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const gitCommonDirectory = exactGitDirectory(
    gitExecutable,
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    'common directory',
  );
  const worktreeRoot = exactGitDirectory(
    gitExecutable,
    cwd,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    'worktree root',
  );
  const branch = childProcess.spawnSync(
    gitExecutable,
    ['symbolic-ref', '--quiet', 'HEAD'],
    {
      cwd,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
    },
  );
  if (
    branch.status === 1 &&
    branch.error === undefined &&
    branch.signal === null
  ) {
    return { gitCommonDirectory, worktreeRoot, branchRef: null };
  }
  if (
    branch.error !== undefined ||
    branch.signal !== null ||
    branch.status !== 0 ||
    typeof branch.stdout !== 'string'
  ) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNAVAILABLE',
      'Workflow launcher could not resolve the repository branch.',
    );
  }
  const branchRef = branch.stdout.trim();
  if (
    branchRef.length === 0 ||
    branchRef.includes('\0') ||
    branchRef.includes('\n')
  ) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git returned an invalid branch ref.',
    );
  }
  return { gitCommonDirectory, worktreeRoot, branchRef };
}

function exactGitDirectory(
  gitExecutable: string,
  cwd: string,
  argv: string[],
  label: string,
): string {
  const result = childProcess.spawnSync(gitExecutable, argv, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string'
  ) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNAVAILABLE',
      `Workflow launcher could not resolve the repository ${label}.`,
    );
  }
  const output = result.stdout.trim();
  if (output.length === 0 || output.includes('\0') || output.includes('\n')) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git returned an invalid common-directory path.',
    );
  }
  const candidate = path.isAbsolute(output)
    ? output
    : path.resolve(cwd, output);
  const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git common directory is missing, indirect, or unsafe.',
    );
  }
  return fs.realpathSync(candidate);
}

function launchEnvironment(
  resumeBinding: {
    kind: 'local-engine-resume-binding.v1';
    parentChangeId: string;
    checkpointId: string;
    engineDigest: string;
  } | null,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
  delete environment.WORKFLOW_LOCAL_ENGINE_TX_ID;
  delete environment.WORKFLOW_LOCAL_ENGINE_CHILD_WORKTREE;
  if (resumeBinding !== null) {
    environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING =
      canonicalJson(resumeBinding);
  }
  return environment;
}

function launcherError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'WORKFLOW_LAUNCHER_FAILED';
}

function errorExitCode(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'exitCode' in error &&
    Number.isSafeInteger(error.exitCode) &&
    Number(error.exitCode) > 0 &&
    Number(error.exitCode) <= 255
  ) {
    return Number(error.exitCode);
  }
  return 1;
}
