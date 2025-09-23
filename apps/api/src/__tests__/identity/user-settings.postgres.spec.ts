import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { User } from '../../entities/user.entity';
import { UserSettings } from '../../entities/user-settings.entity';

jest.setTimeout(30000);

describe('UserSettings Entity (Postgres)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let settingsRepository: Repository<UserSettings>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    userRepository = dataSource.getRepository(User);
    settingsRepository = dataSource.getRepository(UserSettings);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query(
      'TRUNCATE TABLE "user_auth_identities" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query(
      'TRUNCATE TABLE "user_settings" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async (overrides: Partial<User> = {}) =>
    userRepository.save(
      userRepository.create({
        email: overrides.email ?? `postgres-settings-${Date.now()}@example.com`,
        passwordHash: overrides.passwordHash ?? 'hash',
        displayName: overrides.displayName ?? 'Settings User',
      }),
    );

  it('stores notifications JSON with defaults while preserving casing', async () => {
    const user = await createUser();

    const settings = await settingsRepository.save(
      settingsRepository.create({
        userId: user.id,
        user,
      }),
    );

    expect(settings.notifications).toEqual({
      expenses: true,
      invites: true,
      reminders: true,
    });
    expect(settings.pushEnabled).toBe(true);
    expect(settings.persistenceMode).toBe('local_only');
  });

  it('rejects persistence modes outside the supported set', async () => {
    const user = await createUser({ email: 'settings-enum@example.com' });

    await expect(
      settingsRepository.insert({
        userId: user.id,
        persistenceMode: 'invalid' as UserSettings['persistenceMode'],
      }),
    ).rejects.toThrow(/check constraint|persistence/i);
  });

  it('enforces a single settings record per user', async () => {
    const user = await createUser({ email: 'unique-settings@example.com' });

    await settingsRepository.insert({ userId: user.id });

    await expect(
      settingsRepository.insert({ userId: user.id }),
    ).rejects.toThrow(/duplicate key value|user_settings_pkey/i);
  });
});
