import { resolvePostgresTestDatabaseUrl } from '../setup/database-target-policy';

const mockEnsureTestPostgresUri = jest.fn(() =>
  Promise.reject(new Error('Legacy database provisioning was called')),
);
const mockPgClient = jest.fn(() => ({
  connect: jest.fn(() =>
    Promise.reject(new Error('Database probe was called')),
  ),
  query: jest.fn(() => Promise.resolve()),
  end: jest.fn(() => Promise.resolve()),
}));

jest.mock('../setup/postgres-test-container', () => ({
  ensureTestPostgresUri: mockEnsureTestPostgresUri,
}));
jest.mock('pg', () => ({ Client: mockPgClient }));

describe('Postgres test database target policy', () => {
  const explicitUrl =
    'postgres://runner:marker-secret@127.0.0.1:5433/expense_test';

  it('uses an available explicit TEST_DATABASE_URL without trying fallbacks', async () => {
    const attempted: string[] = [];
    let provisionCalled = false;

    const selected = await resolvePostgresTestDatabaseUrl(
      {
        TEST_DATABASE_URL: explicitUrl,
        COMPOSE_TEST_DATABASE_URL:
          'postgres://compose:secret@127.0.0.1/compose_test',
      },
      (candidate) => {
        attempted.push(candidate);
        return Promise.resolve(true);
      },
      () => {
        provisionCalled = true;
        return Promise.resolve('postgres://dev:secret@127.0.0.1/expense_dev');
      },
    );

    expect(selected).toBe(explicitUrl);
    expect(attempted).toEqual([explicitUrl]);
    expect(provisionCalled).toBe(false);
  });

  it('fails closed when an explicit TEST_DATABASE_URL is unavailable', async () => {
    const attempted: string[] = [];
    let provisionCalled = false;

    await expect(
      resolvePostgresTestDatabaseUrl(
        {
          TEST_DATABASE_URL: explicitUrl,
          COMPOSE_TEST_DATABASE_URL:
            'postgres://compose:secret@127.0.0.1/compose_test',
        },
        (candidate) => {
          attempted.push(candidate);
          return Promise.resolve(false);
        },
        () => {
          provisionCalled = true;
          return Promise.resolve('postgres://dev:secret@127.0.0.1/expense_dev');
        },
      ),
    ).rejects.toThrow('Explicit TEST_DATABASE_URL is unavailable');

    expect(attempted).toEqual([explicitUrl]);
    expect(provisionCalled).toBe(false);
  });

  it('requires TEST_DATABASE_URL when the workflow disposable marker is set', async () => {
    let probeCalled = false;
    let provisionCalled = false;

    await expect(
      resolvePostgresTestDatabaseUrl(
        {
          WORKFLOW_DISPOSABLE_DATABASE: '1',
          COMPOSE_TEST_DATABASE_URL:
            'postgres://compose:secret@127.0.0.1/compose_test',
        },
        () => {
          probeCalled = true;
          return Promise.resolve(true);
        },
        () => {
          provisionCalled = true;
          return Promise.resolve('postgres://dev:secret@127.0.0.1/expense_dev');
        },
      ),
    ).rejects.toThrow('Explicit TEST_DATABASE_URL is required');

    expect(probeCalled).toBe(false);
    expect(provisionCalled).toBe(false);
  });

  it('blocks legacy fallback for every workflow check execution', async () => {
    let provisionCalled = false;

    await expect(
      resolvePostgresTestDatabaseUrl(
        { WORKFLOW_CHECK_EXECUTION: '1' },
        () => Promise.resolve(true),
        () => {
          provisionCalled = true;
          return Promise.resolve('postgres://dev:secret@127.0.0.1/expense_dev');
        },
      ),
    ).rejects.toThrow('Explicit TEST_DATABASE_URL is required');

    expect(provisionCalled).toBe(false);
  });

  it('preserves legacy provisioning outside a workflow database check', async () => {
    let probeCalls = 0;
    let provisionCalls = 0;

    const selected = await resolvePostgresTestDatabaseUrl(
      {},
      () => {
        probeCalls += 1;
        return Promise.resolve(false);
      },
      () => {
        provisionCalls += 1;
        return Promise.resolve('postgres://local:secret@127.0.0.1/local_test');
      },
    );

    expect(selected).toBe('postgres://local:secret@127.0.0.1/local_test');
    expect(probeCalls).toBe(0);
    expect(provisionCalls).toBe(1);
  });

  it('does not include the explicit URL or credentials in failure messages', async () => {
    await expect(
      resolvePostgresTestDatabaseUrl(
        { TEST_DATABASE_URL: explicitUrl },
        () => Promise.resolve(false),
        () => Promise.resolve('postgres://dev:secret@127.0.0.1/expense_dev'),
      ),
    ).rejects.toThrow(
      new Error(
        'Explicit TEST_DATABASE_URL is unavailable; fallback is disabled.',
      ),
    );
  });

  it('redacts errors thrown by the availability probe', async () => {
    await expect(
      resolvePostgresTestDatabaseUrl(
        { TEST_DATABASE_URL: explicitUrl },
        () => Promise.reject(new Error(`Connection failed for ${explicitUrl}`)),
        () => Promise.resolve('postgres://dev:secret@127.0.0.1/expense_dev'),
      ),
    ).rejects.toThrow(
      new Error(
        'Explicit TEST_DATABASE_URL is unavailable; fallback is disabled.',
      ),
    );
  });

  it('wires the workflow marker through the Postgres datasource factory', async () => {
    const originalMarker = process.env.WORKFLOW_CHECK_EXECUTION;
    const originalTestUrl = process.env.TEST_DATABASE_URL;
    const originalComposeUrl = process.env.COMPOSE_TEST_DATABASE_URL;
    try {
      process.env.WORKFLOW_CHECK_EXECUTION = '1';
      delete process.env.TEST_DATABASE_URL;
      delete process.env.COMPOSE_TEST_DATABASE_URL;
      mockEnsureTestPostgresUri.mockClear();
      mockPgClient.mockClear();
      const { createPostgresDataSource } =
        await import('../setup/datasource.factory');

      await expect(createPostgresDataSource()).rejects.toThrow(
        'Explicit TEST_DATABASE_URL is required',
      );
      expect(mockPgClient).not.toHaveBeenCalled();
      expect(mockEnsureTestPostgresUri).not.toHaveBeenCalled();
    } finally {
      restoreEnvironment('WORKFLOW_CHECK_EXECUTION', originalMarker);
      restoreEnvironment('TEST_DATABASE_URL', originalTestUrl);
      restoreEnvironment('COMPOSE_TEST_DATABASE_URL', originalComposeUrl);
    }
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
