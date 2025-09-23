import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { UserSimple } from '../../entities/user-simple.entity';
import { UserSettingsSimple } from '../../entities/user-settings-simple.entity';

describe('UserSettings Entity (SQLite)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<UserSimple>;
  let settingsRepository: Repository<UserSettingsSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    userRepository = dataSource.getRepository(UserSimple);
    settingsRepository = dataSource.getRepository(UserSettingsSimple);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async () =>
    userRepository.save(
      userRepository.create({
        email: 'settings-user@example.com',
        passwordHash: 'hash',
        displayName: 'Settings User',
      }),
    );

  it('persists defaults for notification and persistence preferences', async () => {
    const user = await createUser();

    const settings = await settingsRepository.save(
      settingsRepository.create({
        user,
        userId: user.id,
      }),
    );

    expect(settings.language).toBe('en-US');
    expect(settings.notifications).toEqual({
      expenses: true,
      invites: true,
      reminders: true,
    });
    expect(settings.pushEnabled).toBe(true);
    expect(settings.persistenceMode).toBe('local_only');
    expect(settings.lastPersistenceChange).toBeInstanceOf(Date);
  });

  it('enforces one settings row per user', async () => {
    const user = await createUser();

    await settingsRepository.insert({ userId: user.id });

    await expect(
      settingsRepository.insert({ userId: user.id }),
    ).rejects.toThrow();
  });
});
