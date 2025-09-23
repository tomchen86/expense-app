import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { UserSimple } from '../../entities/user-simple.entity';

describe('User Entity', () => {
  let dataSource: DataSource;
  let userRepository: Repository<UserSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    userRepository = dataSource.getRepository(UserSimple);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('should create a user with required fields', async () => {
    const user = userRepository.create({
      email: 'test@example.com',
      passwordHash: 'hashed_password',
      displayName: 'Test User',
    });

    const savedUser = await userRepository.save(user);

    expect(savedUser.id).toBeDefined();
    expect(savedUser.email).toBe('test@example.com');
    expect(savedUser.passwordHash).toBe('hashed_password');
    expect(savedUser.displayName).toBe('Test User');
    expect(savedUser.defaultCurrency).toBe('USD');
    expect(savedUser.timezone).toBe('UTC');
    expect(savedUser.onboardingStatus).toBe('invited');
    expect(savedUser.createdAt).toBeInstanceOf(Date);
    expect(savedUser.updatedAt).toBeInstanceOf(Date);
  });

  it('should fail when creating duplicate email (unique constraint)', async () => {
    const user1 = userRepository.create({
      email: 'duplicate@example.com',
      passwordHash: 'hash1',
      displayName: 'User 1',
    });
    await userRepository.save(user1);

    const user2 = userRepository.create({
      email: 'duplicate@example.com',
      passwordHash: 'hash2',
      displayName: 'User 2',
    });

    await expect(userRepository.save(user2)).rejects.toThrow();
  });

  it('should set default values correctly', async () => {
    const user = userRepository.create({
      email: 'defaults@example.com',
      passwordHash: 'hashed_password',
      displayName: 'Defaults User',
    });

    const savedUser = await userRepository.save(user);

    expect(savedUser.defaultCurrency).toBe('USD');
    expect(savedUser.timezone).toBe('UTC');
    expect(savedUser.onboardingStatus).toBe('invited');
    expect(savedUser.avatarUrl).toBeNull();
    expect(savedUser.emailVerifiedAt).toBeNull();
    expect(savedUser.lastActiveAt).toBeNull();
  });

  it('should handle optional fields properly', async () => {
    const user = userRepository.create({
      email: 'optional@example.com',
      passwordHash: 'hashed_password',
      displayName: 'Optional User',
      avatarUrl: 'https://example.com/avatar.jpg',
      defaultCurrency: 'EUR',
      timezone: 'Europe/London',
      onboardingStatus: 'completed',
      emailVerifiedAt: new Date(),
      lastActiveAt: new Date(),
    });

    const savedUser = await userRepository.save(user);

    expect(savedUser.avatarUrl).toBe('https://example.com/avatar.jpg');
    expect(savedUser.defaultCurrency).toBe('EUR');
    expect(savedUser.timezone).toBe('Europe/London');
    expect(savedUser.onboardingStatus).toBe('completed');
    expect(savedUser.emailVerifiedAt).toBeInstanceOf(Date);
    expect(savedUser.lastActiveAt).toBeInstanceOf(Date);
  });
});
