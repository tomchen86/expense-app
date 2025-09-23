import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { UserSimple } from '../../entities/user-simple.entity';
import { UserDeviceSimple } from '../../entities/user-device-simple.entity';

describe('UserDevice Entity (SQLite)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<UserSimple>;
  let deviceRepository: Repository<UserDeviceSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    userRepository = dataSource.getRepository(UserSimple);
    deviceRepository = dataSource.getRepository(UserDeviceSimple);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async () =>
    userRepository.save(
      userRepository.create({
        email: 'device-user@example.com',
        passwordHash: 'hash',
        displayName: 'Device User',
      }),
    );

  it('applies default sync metadata values on insert', async () => {
    const user = await createUser();

    const device = await deviceRepository.save(
      deviceRepository.create({
        userId: user.id,
        user,
        deviceUuid: 'device-123',
      }),
    );

    expect(device.persistenceModeAtSync).toBe('local_only');
    expect(device.syncStatus).toBe('idle');
    expect(device.createdAt).toBeInstanceOf(Date);
    expect(device.updatedAt).toBeInstanceOf(Date);
  });

  it('prevents duplicate device registrations per user', async () => {
    const user = await createUser();

    await deviceRepository.insert({
      userId: user.id,
      deviceUuid: 'duplicate-device',
    });

    await expect(
      deviceRepository.insert({
        userId: user.id,
        deviceUuid: 'duplicate-device',
      }),
    ).rejects.toThrow();
  });
});
