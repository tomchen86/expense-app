import { ExitCode, workflowError } from './errors.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import { resolveGitExecutable } from './git.ts';

export type DisposableDatabaseEvidence = {
  identity: string;
};

type ValidatedDisposableDatabase = {
  evidence: DisposableDatabaseEvidence;
  testDatabaseUrl: string;
};

type DatabaseIdentity = {
  databaseKey: string;
  redacted: string;
  database: string;
  hostname: string;
};

const disposableTokens = new Set([
  'test',
  'ci',
  'tmp',
  'temp',
  'disposable',
  'ephemeral',
]);

const forbiddenTokens = new Set([
  'dev',
  'development',
  'shared',
  'stage',
  'staging',
  'prod',
  'production',
]);

export function assertDisposableDatabase(
  environment: NodeJS.ProcessEnv,
): DisposableDatabaseEvidence {
  return validateDisposableDatabase(environment).evidence;
}

export function createCheckEnvironment(
  environment: NodeJS.ProcessEnv,
  destructiveDatabase: boolean,
): NodeJS.ProcessEnv {
  const checkEnvironment = createTrustedExecutionEnvironment([
    resolveGitExecutable(),
  ]);
  checkEnvironment.WORKFLOW_CHECK_EXECUTION = '1';

  if (destructiveDatabase) {
    const validated = validateDisposableDatabase(environment);
    checkEnvironment.TEST_DATABASE_URL = validated.testDatabaseUrl;
    checkEnvironment.WORKFLOW_DISPOSABLE_DATABASE = '1';
  }

  return checkEnvironment;
}

function validateDisposableDatabase(
  environment: NodeJS.ProcessEnv,
): ValidatedDisposableDatabase {
  if (environment.WORKFLOW_DISPOSABLE_DATABASE !== '1') {
    throw workflowError(
      'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED',
      'Destructive database checks require WORKFLOW_DISPOSABLE_DATABASE=1.',
      ExitCode.unsafeEnvironment,
    );
  }

  const rawTestUrl = environment.TEST_DATABASE_URL?.trim();
  if (!rawTestUrl) {
    throw workflowError(
      'TEST_DATABASE_URL_REQUIRED',
      'Destructive database checks require an explicit TEST_DATABASE_URL.',
      ExitCode.unsafeEnvironment,
    );
  }

  const testIdentity = parseDatabaseIdentity(
    rawTestUrl,
    'UNSAFE_TEST_DATABASE_URL',
    'TEST_DATABASE_URL is not a valid PostgreSQL database URL.',
  );
  const databaseTokens = tokens(testIdentity.database);
  const identityTokens = tokens(
    `${testIdentity.hostname}-${testIdentity.database}`,
  );

  if (
    !databaseTokens.some((token) => disposableTokens.has(token)) ||
    identityTokens.some((token) => forbiddenTokens.has(token))
  ) {
    throw workflowError(
      'UNSAFE_TEST_DATABASE_IDENTITY',
      'TEST_DATABASE_URL does not identify an explicitly disposable database.',
      ExitCode.unsafeEnvironment,
      { details: { databaseIdentity: testIdentity.redacted } },
    );
  }

  const rawDevelopmentUrl = environment.DATABASE_URL?.trim();
  if (rawDevelopmentUrl) {
    const developmentIdentity = parseDatabaseIdentity(
      rawDevelopmentUrl,
      'DATABASE_URL_UNREADABLE',
      'DATABASE_URL cannot be safely compared with TEST_DATABASE_URL.',
    );
    if (developmentIdentity.databaseKey === testIdentity.databaseKey) {
      throw workflowError(
        'TEST_DATABASE_MATCHES_DATABASE_URL',
        'TEST_DATABASE_URL does not prove a database distinct from DATABASE_URL.',
        ExitCode.unsafeEnvironment,
        { details: { databaseIdentity: testIdentity.redacted } },
      );
    }
  }

  return {
    evidence: { identity: testIdentity.redacted },
    testDatabaseUrl: rawTestUrl,
  };
}

function parseDatabaseIdentity(
  rawUrl: string,
  errorCode: string,
  errorMessage: string,
): DatabaseIdentity {
  try {
    if (hasControlCharacters(rawUrl)) {
      throw new Error('database URL contains a control character');
    }
    const parsed = new URL(rawUrl);
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
      !parsed.hostname ||
      parsed.hostname.includes('%') ||
      parsed.searchParams.has('host') ||
      parsed.searchParams.has('port')
    ) {
      throw new Error('unsupported database URL');
    }

    const encodedDatabase = parsed.pathname.startsWith('/')
      ? parsed.pathname.slice(1)
      : parsed.pathname;
    const database = decodeURI(encodedDatabase);
    if (!database || database.includes('/')) {
      throw new Error('missing or ambiguous database name');
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (!hostname) {
      throw new Error('missing database hostname');
    }
    const port = parsed.port || '5432';
    return {
      databaseKey: database.toLowerCase(),
      redacted: `postgresql://${hostname}:${port}/${encodeURIComponent(database)}`,
      database,
      hostname,
    };
  } catch {
    throw workflowError(errorCode, errorMessage, ExitCode.unsafeEnvironment);
  }
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
