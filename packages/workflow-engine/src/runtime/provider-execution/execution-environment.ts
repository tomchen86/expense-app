import fs from 'node:fs';
import path from 'node:path';

import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';

/**
 * Build the minimized, provider-specific environment for a bounded read-only
 * provider probe or invocation. The caller's `PATH` and every unreviewed
 * variable (API keys, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, an attacker
 * `GIT_CONFIG_GLOBAL`, arbitrary secrets) are dropped. Only the code-owned
 * executable directories, a pinned canonical temporary directory, neutral
 * locale/terminal settings (including `CI=1`/`GIT_PAGER=cat`), the Git hardening
 * set, the user identity (an absolute `HOME` plus `USER`/`LOGNAME`), and the
 * single reviewed provider config directory survive. A non-absolute `HOME` is
 * omitted rather than trusted. Authentication remains user-level and is part of
 * the documented soft containment boundary.
 */
export function createProviderExecutionEnvironment(
  providerId: ProviderId,
  nodeExecutable: string,
  temporaryDirectory: string,
  sourceEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const nodeDirectory = path.dirname(fs.realpathSync(nodeExecutable));
  const temporary = fs.realpathSync(temporaryDirectory);
  const environment: NodeJS.ProcessEnv = {
    PATH: [...new Set([nodeDirectory, ...systemExecutableDirectories()])].join(
      path.delimiter,
    ),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    TERM: 'dumb',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  };

  // Only an absolute HOME is trusted; a relative HOME is dropped rather than
  // inherited into the provider process.
  const home = sourceEnvironment.HOME;
  if (typeof home === 'string' && path.isAbsolute(home)) {
    environment.HOME = home;
  }
  for (const key of ['USER', 'LOGNAME'] as const) {
    const value = sourceEnvironment[key];
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }

  const configVariable =
    providerId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const configValue = sourceEnvironment[configVariable];
  if (typeof configValue === 'string' && isExistingDirectory(configValue)) {
    environment[configVariable] = configValue;
  }

  if (process.platform === 'win32') {
    environment.SystemRoot = 'C:\\Windows';
    environment.WINDIR = 'C:\\Windows';
    environment.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }

  return environment;
}

function isExistingDirectory(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) {
    return false;
  }
  const stats = fs.statSync(candidate, { throwIfNoEntry: false });
  return stats?.isDirectory() ?? false;
}

export function createTrustedExecutionEnvironment(
  executables: string[] = [],
): NodeJS.ProcessEnv {
  const nodeExecutable = fs.realpathSync(process.execPath);
  const executableDirectories = [
    path.dirname(nodeExecutable),
    ...executables.map((executable) =>
      path.dirname(fs.realpathSync(executable)),
    ),
    ...systemExecutableDirectories(),
  ];
  const temporaryDirectory = fs.realpathSync(
    process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp',
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: [...new Set(executableDirectories)].join(path.delimiter),
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  };

  if (process.platform === 'win32') {
    environment.SystemRoot = 'C:\\Windows';
    environment.WINDIR = 'C:\\Windows';
    environment.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }

  return environment;
}

function systemExecutableDirectories(): string[] {
  if (process.platform === 'win32') {
    return ['C:\\Windows\\System32'];
  }
  return ['/usr/bin', '/bin'];
}
