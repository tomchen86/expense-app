import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { User } from '../../entities/user.entity';
import { UserAuthIdentity } from '../../entities/user-auth-identity.entity';

jest.setTimeout(30000);

describe('UserAuthIdentity Entity (Postgres)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let identityRepository: Repository<UserAuthIdentity>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    userRepository = dataSource.getRepository(User);
    identityRepository = dataSource.getRepository(UserAuthIdentity);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query('TRUNCATE TABLE "user_auth_identities" RESTART IDENTITY CASCADE;');
    await dataSource.query('TRUNCATE TABLE "user_settings" RESTART IDENTITY CASCADE;');
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;');
  });

  afterAll(async () => {
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

  it('enforces provider uniqueness per user', async () => {
    const user = await createUser('auth-pg@example.com');

    await identityRepository.insert({
      userId: user.id,
      provider: 'google',
      providerAccountId: 'abc',
    });

    await expect(
      identityRepository.insert({
        userId: user.id,
        provider: 'google',
        providerAccountId: 'def',
      }),
    ).rejects.toThrow(/duplicate key value|user_auth_identities_user_id_provider_key/i);
  });

  it('enforces unique provider account identifiers globally', async () => {
    const [userA, userB] = await Promise.all([
      createUser('auth-pg-a@example.com'),
      createUser('auth-pg-b@example.com'),
    ]);

    await identityRepository.insert({
      userId: userA.id,
      provider: 'apple',
      providerAccountId: 'global-123',
    });

    await expect(
      identityRepository.insert({
        userId: userB.id,
        provider: 'apple',
        providerAccountId: 'global-123',
      }),
    ).rejects.toThrow(/duplicate key value|user_auth_identities_provider_provider_account_id_key/i);
  });

  it('persists metadata as jsonb', async () => {
    const user = await createUser('auth-metadata@example.com');

    const identity = await identityRepository.save(
      identityRepository.create({
        userId: user.id,
        user,
        provider: 'email',
        providerAccountId: 'metadata@example.com',
        metadata: { verified: true, method: 'magic-link' },
      }),
    );

    expect(identity.metadata).toEqual({ verified: true, method: 'magic-link' });
  });
});
