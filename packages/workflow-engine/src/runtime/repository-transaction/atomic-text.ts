import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class AtomicTextSafetyError extends Error {
  constructor() {
    super('atomic text target is unavailable or unsafe');
    this.name = 'AtomicTextSafetyError';
  }
}

export function replaceTextAtomic(
  filePath: string,
  content: string,
  options: { allowCreate?: boolean; defaultMode?: number } = {},
): void {
  if (options.allowCreate) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    (existing && (!existing.isFile() || existing.isSymbolicLink())) ||
    (!existing && !options.allowCreate)
  ) {
    throw new AtomicTextSafetyError();
  }

  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    if (existing) {
      fs.copyFileSync(filePath, temporary, fs.constants.COPYFILE_EXCL);
      temporaryExists = true;
      const copied = fs.lstatSync(temporary);
      if (!copied.isFile() || copied.isSymbolicLink()) {
        throw new AtomicTextSafetyError();
      }
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      );
      assertOpenFileMatches(descriptor, copied);
      assertTargetState(filePath, existing);
      fs.ftruncateSync(descriptor, 0);
    } else {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_RDWR |
          fs.constants.O_NOFOLLOW,
        options.defaultMode ?? 0o644,
      );
      temporaryExists = true;
      assertSafeOpenFile(descriptor);
    }
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    assertTemporaryState(temporary, descriptor);
    assertTargetState(filePath, existing);
    fs.renameSync(temporary, filePath);
    temporaryExists = false;
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (temporaryExists) {
      fs.rmSync(temporary, { force: true });
    }
    throw error;
  }
}

function assertOpenFileMatches(descriptor: number, expected: fs.Stats): void {
  const opened = fs.fstatSync(descriptor);
  assertSafeStats(opened);
  if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
    throw new AtomicTextSafetyError();
  }
}

function assertSafeOpenFile(descriptor: number): void {
  assertSafeStats(fs.fstatSync(descriptor));
}

function assertTemporaryState(temporary: string, descriptor: number): void {
  const opened = fs.fstatSync(descriptor);
  const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
  assertSafeStats(opened);
  if (
    !current ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw new AtomicTextSafetyError();
  }
}

function assertSafeStats(stats: fs.Stats): void {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new AtomicTextSafetyError();
  }
}

function assertTargetState(
  filePath: string,
  expected: fs.Stats | undefined,
): void {
  const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!expected) {
    if (current) {
      throw new AtomicTextSafetyError();
    }
    return;
  }
  if (
    !current ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new AtomicTextSafetyError();
  }
}
