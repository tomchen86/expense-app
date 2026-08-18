import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_PATH = path.join(
  REPOSITORY_ROOT,
  'packages/workflow-engine/native/human-gate-macos/client/main.swift',
);
const EXECUTABLE_PATH = path.join(
  REPOSITORY_ROOT,
  'packages/workflow-engine/native/human-gate-macos/bin/human-gate',
);
const MINIMUM_MACOS = '13.0';
const ARCHITECTURES = ['arm64', 'x86_64'] as const;

const mode = process.argv[2];
if (process.argv.length > 3 || (mode !== undefined && mode !== '--check')) {
  fail('Usage: pnpm workflow:build-human-gate-macos [--check]');
}
if (process.platform !== 'darwin') {
  fail('Human Gate macOS binary can only be built or checked on macOS.');
}

const expectedSourceSha256 = sha256(fs.readFileSync(SOURCE_PATH));
if (mode === '--check') {
  assertCommittedBinary(expectedSourceSha256);
  process.stdout.write(
    `Human Gate binary matches its Swift source (${ARCHITECTURES.join('+')}, macOS ${MINIMUM_MACOS}+).\n`,
  );
} else {
  buildUniversalBinary(expectedSourceSha256);
  assertCommittedBinary(expectedSourceSha256);
  process.stdout.write(
    `Built ${path.relative(REPOSITORY_ROOT, EXECUTABLE_PATH)}\n`,
  );
}

function buildUniversalBinary(sourceSha256: string): void {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'human-gate-macos-build-'),
  );
  try {
    const buildInfo = path.join(temporaryRoot, 'build-info.swift');
    fs.writeFileSync(
      buildInfo,
      `let humanGateSourceSha256 = "${sourceSha256}"\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const slices = ARCHITECTURES.map((architecture) => {
      const output = path.join(temporaryRoot, `human-gate-${architecture}`);
      const moduleCache = path.join(
        temporaryRoot,
        `module-cache-${architecture}`,
      );
      fs.mkdirSync(moduleCache, { mode: 0o700 });
      run('/usr/bin/swiftc', [
        '-O',
        '-whole-module-optimization',
        '-target',
        `${architecture}-apple-macosx${MINIMUM_MACOS}`,
        '-module-cache-path',
        moduleCache,
        SOURCE_PATH,
        buildInfo,
        '-framework',
        'AppKit',
        '-framework',
        'LocalAuthentication',
        '-o',
        output,
      ]);
      return output;
    });
    const universal = path.join(temporaryRoot, 'human-gate');
    run('/usr/bin/lipo', ['-create', '-output', universal, ...slices]);
    fs.chmodSync(universal, 0o755);

    const outputDirectory = path.dirname(EXECUTABLE_PATH);
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
    const staged = path.join(outputDirectory, `.human-gate.${process.pid}.tmp`);
    fs.copyFileSync(universal, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, EXECUTABLE_PATH);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertCommittedBinary(expectedSourceSha256: string): void {
  const status = fs.lstatSync(EXECUTABLE_PATH, { throwIfNoEntry: false });
  if (
    !status?.isFile() ||
    status.isSymbolicLink() ||
    (status.mode & 0o111) === 0
  ) {
    fail('Committed Human Gate binary is missing or not executable.');
  }
  const architectures = run('/usr/bin/lipo', ['-archs', EXECUTABLE_PATH])
    .trim()
    .split(/\s+/)
    .sort();
  if (architectures.join(',') !== [...ARCHITECTURES].sort().join(',')) {
    fail('Committed Human Gate binary must contain arm64 and x86_64.');
  }
  for (const architecture of ARCHITECTURES) {
    const loadCommands = run('/usr/bin/otool', [
      '-arch',
      architecture,
      '-l',
      EXECUTABLE_PATH,
    ]);
    if (
      !/LC_BUILD_VERSION[\s\S]*?platform 1[\s\S]*?minos 13\.0/.test(
        loadCommands,
      )
    ) {
      fail(
        `Committed Human Gate ${architecture} slice must target macOS ${MINIMUM_MACOS}.`,
      );
    }
  }
  const embeddedSourceSha256 = run(EXECUTABLE_PATH, [
    '--build-source-sha256',
  ]).trim();
  if (embeddedSourceSha256 !== expectedSourceSha256) {
    fail(
      'Human Gate Swift source changed without rebuilding the committed binary. Run pnpm workflow:build-human-gate-macos.',
    );
  }
}

function run(executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
