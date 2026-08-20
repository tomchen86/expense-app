import path from 'node:path';

const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const UNSUPPORTED_GLOB_PATTERN = /[*?[\]{}!]/;

export type RepositoryPathErrorCode =
  'INVALID_POLICY_PATH' | 'INVALID_REPOSITORY_PATH';

export class RepositoryPathError extends TypeError {
  readonly code: RepositoryPathErrorCode;
  readonly value: string;

  constructor(code: RepositoryPathErrorCode, value: string) {
    super(
      code === 'INVALID_POLICY_PATH'
        ? `Invalid policy path: ${value}`
        : `Invalid repository path: ${value}`,
    );
    this.name = 'RepositoryPathError';
    this.code = code;
    this.value = value;
  }
}

export function normalizePolicyPath(value: string): string {
  if (
    !value ||
    value.trim() !== value ||
    value.includes('\\') ||
    containsControlCharacter(value)
  ) {
    throw invalidPolicyPath(value);
  }

  const isPrefix = value.endsWith('/**');
  const candidate = isPrefix ? value.slice(0, -3) : value;
  if (
    !candidate ||
    candidate.normalize('NFC') !== candidate ||
    path.posix.isAbsolute(candidate) ||
    WINDOWS_ABSOLUTE_PATTERN.test(candidate) ||
    candidate.startsWith('./') ||
    candidate.endsWith('/') ||
    UNSUPPORTED_GLOB_PATTERN.test(candidate)
  ) {
    throw invalidPolicyPath(value);
  }

  const segments = candidate.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git',
    )
  ) {
    throw invalidPolicyPath(value);
  }
  return isPrefix ? `${candidate}/**` : candidate;
}

export function normalizeChangedPath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    containsControlCharacter(value) ||
    path.posix.isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATTERN.test(value) ||
    value.startsWith('./') ||
    value.endsWith('/')
  ) {
    throw invalidRepositoryPath(value);
  }

  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git',
    )
  ) {
    throw invalidRepositoryPath(value);
  }
  return value;
}

export function normalizeExactRepositoryPath(value: string): string {
  const normalized = normalizeChangedPath(value);
  if (
    UNSUPPORTED_GLOB_PATTERN.test(normalized) ||
    normalized.normalize('NFC') !== normalized
  ) {
    throw invalidRepositoryPath(value);
  }
  return normalized;
}

export function matchesAllowedPath(
  changedPath: string,
  allowedPath: string,
): boolean {
  const changed = normalizeChangedPath(changedPath);
  const allowed = normalizePolicyPath(allowedPath);
  if (!allowed.endsWith('/**')) return changed === allowed;
  const base = allowed.slice(0, -3);
  return changed === base || changed.startsWith(`${base}/`);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function invalidPolicyPath(value: string): RepositoryPathError {
  return new RepositoryPathError('INVALID_POLICY_PATH', value);
}

function invalidRepositoryPath(value: string): RepositoryPathError {
  return new RepositoryPathError('INVALID_REPOSITORY_PATH', value);
}
