import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { User } from '../../entities/user.entity';
import { UserDevice } from '../../entities/user-device.entity';

jest.setTimeout(30000);

describe('UserDevice Entity (Postgres)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let deviceRepository: Repository<UserDevice>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    userRepository = dataSource.getRepository(User);
    deviceRepository = dataSource.getRepository(UserDevice);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query(
      'TRUNCATE TABLE "user_devices" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async () =>
    userRepository.save(
      userRepository.create({
        email: 'postgres-device@example.com',
        passwordHash: 'hash',
        displayName: 'Postgres Device User',
      }),
    );

  it('stores metadata with defaults for persistence and sync status', async () => {
    const user = await createUser();

    const device = await deviceRepository.save(
      deviceRepository.create({
        userId: user.id,
        deviceUuid: 'pg-device-001',
      }),
    );

    expect(device.persistenceModeAtSync).toBe('local_only');
    expect(device.syncStatus).toBe('idle');
  });

  it('rejects unsupported sync status values via constraint', async () => {
    const user = await createUser();

    await expect(
      deviceRepository.insert({
        userId: user.id,
        deviceUuid: 'pg-invalid-status',
        syncStatus: 'unknown' as never,
      }),
    ).rejects.toThrow(/CHK_user_devices_sync_status/i);
  });

  it('enforces unique device uuid per user', async () => {
    const user = await createUser();

    await deviceRepository.insert({
      userId: user.id,
      deviceUuid: 'duplicate-per-user',
    });

    await expect(
      deviceRepository.insert({
        userId: user.id,
        deviceUuid: 'duplicate-per-user',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});
