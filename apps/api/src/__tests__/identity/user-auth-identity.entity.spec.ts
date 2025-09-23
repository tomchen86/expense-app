import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { UserSimple } from '../../entities/user-simple.entity';
import { UserAuthIdentitySimple } from '../../entities/user-auth-identity-simple.entity';

describe('UserAuthIdentity Entity (SQLite)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<UserSimple>;
  let identityRepository: Repository<UserAuthIdentitySimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    userRepository = dataSource.getRepository(UserSimple);
    identityRepository = dataSource.getRepository(UserAuthIdentitySimple);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async (email: string) =>
    userRepository.save(
      userRepository.create({
        email,
        passwordHash: 'hash',
        displayName: 'Auth User',
      }),
    );

  it('stores provider credentials and allows optional tokens', async () => {
    const user = await createUser('auth-sqlite@example.com');

    const identity = await identityRepository.save(
      identityRepository.create({
        userId: user.id,
        user,
        provider: 'google',
        providerAccountId: 'abc123',
        accessToken: 'token',
        metadata: { locale: 'en-US' },
      }),
    );

    expect(identity.provider).toBe('google');
    expect(identity.metadata).toEqual({ locale: 'en-US' });
    expect(identity.accessToken).toBe('token');
  });

  it('prevents duplicate provider entries for the same user', async () => {
    const user = await createUser('auth-unique@example.com');

    await identityRepository.insert({
      userId: user.id,
      provider: 'google',
      providerAccountId: 'unique',
    });

    await expect(
      identityRepository.insert({
        userId: user.id,
        provider: 'google',
        providerAccountId: 'another',
      }),
    ).rejects.toThrow();
  });

  it('prevents duplicate provider account IDs across users', async () => {
    const userA = await createUser('auth-user-a@example.com');
    const userB = await createUser('auth-user-b@example.com');

    await identityRepository.insert({
      userId: userA.id,
      provider: 'apple',
      providerAccountId: 'shared-account',
    });

    await expect(
      identityRepository.insert({
        userId: userB.id,
        provider: 'apple',
        providerAccountId: 'shared-account',
      }),
    ).rejects.toThrow();
  });
});
