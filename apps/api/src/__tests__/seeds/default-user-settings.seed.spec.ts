import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { User } from '../../entities/user.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { seedDefaultUserSettings } from '../../database/seeds/default-user-settings.seed';

jest.setTimeout(45000);

describe('seedDefaultUserSettings', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let settingsRepository: Repository<UserSettings>;

  beforeEach(async () => {
    dataSource = await createPostgresDataSource();
    userRepository = dataSource.getRepository(User);
    settingsRepository = dataSource.getRepository(UserSettings);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.dropDatabase();
      await dataSource.destroy();
    }
  });

  it('creates settings rows for users without configuration', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'seed-settings@example.com',
        passwordHash: 'hash',
        displayName: 'Seed User',
      }),
    );

    const inserted = await seedDefaultUserSettings(dataSource);

    expect(inserted).toBe(1);
    const settings = await settingsRepository.findOneByOrFail({
      userId: user.id,
    });
    expect(settings.language).toBe('en-US');
  });

  it('is idempotent when invoked multiple times', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'seed-idempotent@example.com',
        passwordHash: 'hash',
        displayName: 'Seed Idempotent User',
      }),
    );

    await seedDefaultUserSettings(dataSource);
    const insertedSecondRun = await seedDefaultUserSettings(dataSource);

    expect(insertedSecondRun).toBe(0);
    const settings = await settingsRepository.findOneByOrFail({
      userId: user.id,
    });
    expect(settings.userId).toBe(user.id);
  });
});
