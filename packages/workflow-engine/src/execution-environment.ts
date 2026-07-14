import fs from 'node:fs';
import path from 'node:path';

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
