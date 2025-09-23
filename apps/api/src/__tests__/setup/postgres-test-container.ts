import { spawnSync } from 'child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { createServer } from 'net';
import { Client } from 'pg';

type ConnectionOptions = {
  connectionString: string;
};

const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'postgres';
const POSTGRES_DB = 'app_test';

type HarnessState = {
  port: number;
  dataDir: string;
};

const globalState = globalThis as unknown as {
  __postgresHarness?: HarnessState;
  __postgresCleanupRegistered?: boolean;
  __postgresExternalUrl?: string;
};

const runCommand = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `${command} ${args.join(' ')}`,
    );
  }

  return result.stdout.trim();
};

const getAvailablePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(
          new Error('Failed to determine available port for Postgres server'),
        );
      }
      server.close();
    });
  });

const initializeCluster = async (dataDir: string) => {
  const passwordDir = await mkdtemp(path.join(tmpdir(), 'postgres-pass-'));
  const passwordFile = path.join(passwordDir, 'pwfile');
  await writeFile(passwordFile, `${POSTGRES_PASSWORD}\n`, {
    encoding: 'utf-8',
  });

  await rm(dataDir, { recursive: true, force: true });

  runCommand('initdb', [
    '-D',
    dataDir,
    '--username',
    POSTGRES_USER,
    '--pwfile',
    passwordFile,
    '--auth=password',
  ]);

  const pgHbaPath = path.join(dataDir, 'pg_hba.conf');
  await appendFile(pgHbaPath, '\nhost all all 127.0.0.1/32 scram-sha-256\n');

  await rm(passwordDir, { recursive: true, force: true });
};

const startServer = (dataDir: string, port: number) => {
  runCommand('pg_ctl', [
    '-D',
    dataDir,
    '-o',
    `-p ${port} -h 127.0.0.1`,
    '-w',
    'start',
  ]);
};

const stopServer = async (dataDir: string) => {
  try {
    runCommand('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureDatabaseExists = async (client: Client, databaseName: string) => {
  const exists = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [databaseName],
  );

  if (!exists.rowCount) {
    await client.query(`CREATE DATABASE "${databaseName}"`);
  }
};

const waitForPostgres = async (
  connectionOptions: ConnectionOptions & { databaseName: string },
) => {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  const { connectionString, databaseName } = connectionOptions;

  while (Date.now() < deadline) {
    const adminUrl = new URL(connectionString);
    adminUrl.pathname = '/postgres';
    const client = new Client({ connectionString: adminUrl.toString() });

    try {
      await client.connect();
      await ensureDatabaseExists(client, databaseName);
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await sleep(500);
    }
  }

  throw new Error(
    `Timed out waiting for Postgres server (${connectionString}). Last error: ${String(lastError)}`,
  );
};

const registerCleanup = () => {
  if (globalState.__postgresCleanupRegistered) {
    return;
  }

  const cleanup = async () => {
    if (globalState.__postgresExternalUrl) {
      return;
    }
    const harness = globalState.__postgresHarness;
    if (harness) {
      try {
        await stopServer(harness.dataDir);
      } catch (error) {
        console.warn(
          'Failed to stop Postgres test server during cleanup',
          error,
        );
      }
      delete globalState.__postgresHarness;
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
    process.once(signal, () => {
      cleanup().catch(() => undefined);
    });
  }

  process.once('exit', () => {
    void cleanup();
  });

  globalState.__postgresCleanupRegistered = true;
};

export const ensureTestPostgresUri = async (): Promise<string> => {
  if (process.env.TEST_DATABASE_URL) {
    const url = process.env.TEST_DATABASE_URL;
    await waitForPostgres({
      connectionString: url,
      databaseName: new URL(url).pathname.replace('/', '') || POSTGRES_DB,
    });
    globalState.__postgresExternalUrl = url;
    return url;
  }

  const preferredUrls = [
    process.env.COMPOSE_TEST_DATABASE_URL,
    'postgres://dev_user:dev_password@127.0.0.1:5432/expense_tracker_dev',
  ].filter((value): value is string => Boolean(value));

  for (const connectionString of preferredUrls) {
    try {
      const databaseName =
        new URL(connectionString).pathname.replace('/', '') || POSTGRES_DB;
      await waitForPostgres({ connectionString, databaseName });
      process.env.TEST_DATABASE_URL = connectionString;
      globalState.__postgresExternalUrl = connectionString;
      return connectionString;
    } catch (error) {
      console.warn('Failed to reuse existing Postgres instance', error);
    }
  }

  if (!globalState.__postgresHarness) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'postgres-test-'));
    const port = await getAvailablePort();

    await initializeCluster(dataDir);
    startServer(dataDir, port);
    await waitForPostgres({
      connectionString: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`,
      databaseName: POSTGRES_DB,
    });

    globalState.__postgresHarness = { port, dataDir };
    registerCleanup();
  } else {
    const { port } = globalState.__postgresHarness;
    await waitForPostgres({
      connectionString: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`,
      databaseName: POSTGRES_DB,
    });
  }

  const uri = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${globalState.__postgresHarness.port}/${POSTGRES_DB}`;
  process.env.TEST_DATABASE_URL = uri;
  return uri;
};
