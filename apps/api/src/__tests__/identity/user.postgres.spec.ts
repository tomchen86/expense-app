import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { User } from '../../entities/user.entity';

jest.setTimeout(30000);

describe('User Entity (Postgres)', () => {
  let dataSource: DataSource;
  let repository: Repository<User>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    repository = dataSource.getRepository(User);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('preserves email casing while enforcing case-insensitive uniqueness via citext', async () => {
    const original = await repository.save(
      repository.create({
        email: 'Person.One@example.com',
        passwordHash: 'hash',
        displayName: 'Person One',
      }),
    );

    expect(original.email).toBe('Person.One@example.com');

    await expect(
      repository.save(
        repository.create({
          email: 'person.one@example.com',
          passwordHash: 'hash2',
          displayName: 'Person Duplicate',
        }),
      ),
    ).rejects.toThrow(/duplicate key value|users_email_key/i);
  });
});
