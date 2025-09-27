import { DataSource, ObjectLiteral, Repository, EntityTarget } from 'typeorm';
import { resolveDriver } from '../../config/database.config';
import type { EntityCollection } from '../../entities/entity-sets';
import { getEntityCollection } from '../../entities/entity-sets';

type CategoryEntity = InstanceType<EntityCollection['Category']>;
type UserEntity = InstanceType<EntityCollection['User']>;
type UserSettingsEntity = InstanceType<EntityCollection['UserSettings']>;
type UserAuthIdentityEntity = InstanceType<
  EntityCollection['UserAuthIdentity']
>;
type ExpenseGroupEntity = InstanceType<EntityCollection['ExpenseGroup']>;
type ParticipantEntity = InstanceType<EntityCollection['Participant']>;
type ExpenseEntity = InstanceType<EntityCollection['Expense']>;
type CoupleEntity = InstanceType<EntityCollection['Couple']>;

// Mobile app's default categories for seeding test data
const MOBILE_DEFAULT_CATEGORIES = [
  { name: 'Food & Dining', color: '#FF6B6B' },
  { name: 'Transportation', color: '#4ECDC4' },
  { name: 'Shopping', color: '#45B7D1' },
  { name: 'Entertainment', color: '#96CEB4' },
  { name: 'Bills & Utilities', color: '#FFEAA7' },
  { name: 'Healthcare', color: '#DDA0DD' },
  { name: 'Travel', color: '#98D8C8' },
  { name: 'Education', color: '#F7DC6F' },
  { name: 'Personal Care', color: '#BB8FCE' },
  { name: 'Other', color: '#AED6F1' },
];

export class DatabaseTestHelper {
  private dataSource: DataSource;
  private usingPostgres = false;
  public entityRefs: EntityCollection;
  private repositories: {
    category?: Repository<CategoryEntity>;
    user?: Repository<UserEntity>;
    userSettings?: Repository<UserSettingsEntity>;
    userAuthIdentity?: Repository<UserAuthIdentityEntity>;
    expenseGroup?: Repository<ExpenseGroupEntity>;
    participant?: Repository<ParticipantEntity>;
    expense?: Repository<ExpenseEntity>;
    couple?: Repository<CoupleEntity>;
  } = {};

  async createTestDatabase(): Promise<DataSource> {
    const driver = resolveDriver();
    const collection = getEntityCollection(driver);

    if (driver === 'postgres') {
      this.usingPostgres = true;
      this.entityRefs = collection;
      this.dataSource = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DB_URL,
        host: process.env.TEST_DB_HOST || process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.TEST_DB_PORT || '5432', 10),
        username:
          process.env.TEST_DB_USERNAME || process.env.DB_USERNAME || 'dev_user',
        password:
          process.env.TEST_DB_PASSWORD ||
          process.env.DB_PASSWORD ||
          'dev_password',
        database:
          process.env.TEST_DB_DATABASE ||
          process.env.DB_DATABASE ||
          'expense_tracker_test',
        synchronize: false,
        entities: Object.values(this.entityRefs),
        migrations: ['src/database/migrations/*.ts'],
        logging: true,
      });
    } else {
      this.entityRefs = collection;
      this.dataSource = new DataSource({
        type: 'sqljs',
        autoSave: false,
        synchronize: true, // Generate schema for simplified entities
        entities: Object.values(this.entityRefs),
        migrations: [],
        logging: true, // Disable SQL logging in tests
      });
    }

    await this.dataSource.initialize();
    this.initializeRepositories();
    return this.dataSource;
  }

  private initializeRepositories(): void {
    this.repositories.category = this.dataSource.getRepository(
      this.entityRefs.Category,
    );
    this.repositories.user = this.dataSource.getRepository(
      this.entityRefs.User,
    );
    this.repositories.userSettings = this.dataSource.getRepository(
      this.entityRefs.UserSettings,
    );
    this.repositories.userAuthIdentity = this.dataSource.getRepository(
      this.entityRefs.UserAuthIdentity,
    );
    this.repositories.expenseGroup = this.dataSource.getRepository(
      this.entityRefs.ExpenseGroup,
    );
    this.repositories.participant = this.dataSource.getRepository(
      this.entityRefs.Participant,
    );
    this.repositories.expense = this.dataSource.getRepository(
      this.entityRefs.Expense,
    );
    this.repositories.couple = this.dataSource.getRepository(
      this.entityRefs.Couple,
    );
  }

  async seedDefaultCategories(coupleId?: string): Promise<CategoryEntity[]> {
    const categoryRepo = this.repositories.category;
    if (!categoryRepo) throw new Error('Category repository not initialized');

    // If no coupleId provided, create a test couple for global categories
    let actualCoupleId = coupleId;
    if (!actualCoupleId) {
      const testUser = await this.createTestUser({
        displayName: 'System User',
        email: 'system@test.com',
      });
      const testCouple = await this.createTestCouple(testUser);
      actualCoupleId = testCouple.id;
    }

    const CategoryEntity = this.entityRefs.Category;
    const categories = MOBILE_DEFAULT_CATEGORIES.map((cat) => {
      const category = new CategoryEntity();
      category.name = cat.name;
      category.color = cat.color;
      category.coupleId = actualCoupleId;
      category.isDefault = true;
      return category;
    });

    return await categoryRepo.save(categories);
  }

  async createTestUser(
    overrides: Partial<UserEntity> = {},
  ): Promise<UserEntity> {
    const userRepo = this.repositories.user;
    if (!userRepo) throw new Error('User repository not initialized');

    const UserEntity = this.entityRefs.User;
    const user = new UserEntity();
    user.displayName = overrides.displayName || 'Test User';
    user.email = overrides.email || 'test@example.com';
    user.passwordHash = overrides.passwordHash || 'hashed_password';

    return await userRepo.save(user);
  }

  async createTestCouple(
    user: UserEntity,
    overrides: Partial<CoupleEntity> = {},
  ): Promise<CoupleEntity> {
    const coupleRepo = this.repositories.couple;
    if (!coupleRepo) throw new Error('Couple repository not initialized');

    const CoupleEntity = this.entityRefs.Couple;
    const couple = new CoupleEntity();
    couple.name = overrides.name || 'Test Couple';
    if (overrides.inviteCode && overrides.inviteCode.length > 10) {
      throw new Error('inviteCode overrides must be 10 characters or fewer');
    }

    const randomSuffix = Date.now().toString(36).toUpperCase().padStart(8, '0');
    couple.inviteCode = overrides.inviteCode || `TC${randomSuffix.slice(-8)}`;
    couple.createdBy = user.id;
    couple.status = overrides.status || 'active';

    return await coupleRepo.save(couple);
  }

  async createTestUserSettings(
    user: UserEntity,
    overrides: Partial<UserSettingsEntity> = {},
  ): Promise<UserSettingsEntity> {
    const userSettingsRepo = this.repositories.userSettings;
    if (!userSettingsRepo)
      throw new Error('UserSettings repository not initialized');

    const SettingsEntity = this.entityRefs.UserSettings;
    const settings = new SettingsEntity();
    settings.user = user;
    settings.userId = user.id;
    settings.language = overrides.language || 'en-US';
    settings.persistenceMode = overrides.persistenceMode || 'local_only';
    settings.pushEnabled = overrides.pushEnabled ?? true;

    return await userSettingsRepo.save(settings);
  }

  async createTestExpenseGroup(
    user: UserEntity,
    coupleId: string,
    overrides: Partial<ExpenseGroupEntity> = {},
  ): Promise<ExpenseGroupEntity> {
    const groupRepo = this.repositories.expenseGroup;
    if (!groupRepo) throw new Error('ExpenseGroup repository not initialized');

    const GroupEntity = this.entityRefs.ExpenseGroup;
    const group = new GroupEntity();
    group.name = overrides.name || 'Test Group';
    group.description = overrides.description || 'Test group description';
    group.createdBy = user.id;
    group.coupleId = coupleId;
    group.isArchived = overrides.isArchived ?? false;

    return await groupRepo.save(group);
  }

  async createTestExpense(
    user: UserEntity,
    category: CategoryEntity,
    coupleId: string,
    overrides: Partial<ExpenseEntity> = {},
  ): Promise<ExpenseEntity> {
    const expenseRepo = this.repositories.expense;
    if (!expenseRepo) throw new Error('Expense repository not initialized');

    const ExpenseEntity = this.entityRefs.Expense;
    const expense = new ExpenseEntity();
    expense.description = overrides.description || 'Test Expense';
    expense.amountCents = overrides.amountCents || '2550'; // $25.50 in cents
    expense.expenseDate =
      overrides.expenseDate || new Date().toISOString().split('T')[0];
    expense.categoryId = category.id;
    expense.createdBy = user.id;
    expense.coupleId = coupleId;
    expense.notes = overrides.notes;

    return await expenseRepo.save(expense);
  }

  // Mobile app compatibility validator
  validateMobileResponse<T extends object>(
    response: T,
    expectedKeys: (keyof T)[],
  ): boolean {
    if (typeof response !== 'object' || response === null) {
      return false;
    }

    const responseKeys = Object.keys(response);
    return expectedKeys.every((key) => responseKeys.includes(key as string));
  }

  // Convert database cents to mobile dollars format
  convertCentsToDollars(cents: number): number {
    return Number((cents / 100).toFixed(2));
  }

  // Convert mobile dollars to database cents
  convertDollarsToCents(dollars: number): number {
    return Math.round(dollars * 100);
  }

  // Clean up test data after each test
  async cleanupTestData(): Promise<void> {
    const tables = [
      'expense_attachments',
      'expense_splits',
      'expenses',
      'group_members',
      'expense_groups',
      'participants',
      'couple_members',
      'couple_invitations',
      'user_devices',
      'user_settings',
      'user_auth_identities',
      'couples',
      'users',
    ];

    if (this.usingPostgres) {
      const tableNames = tables.join(', ');
      await this.dataSource.query(
        `TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`,
      );
    } else {
      // Clean in reverse dependency order to avoid FK constraints
      await this.dataSource.query('PRAGMA foreign_keys = OFF');
      for (const table of tables) {
        await this.dataSource.query(`DELETE FROM ${table}`);
      }
      await this.dataSource.query('PRAGMA foreign_keys = ON');
    }
  }

  // Overloads provide precise typing for both class constructors and
  // string keys that reference entries on entityRefs.
  getRepository<K extends keyof EntityCollection>(
    entity: K,
  ): Repository<InstanceType<EntityCollection[K]>>;
  getRepository<T extends ObjectLiteral>(entity: new () => T): Repository<T>;
  getRepository<T extends ObjectLiteral>(entity: string): Repository<T>;
  getRepository(entity: any): Repository<any> {
    if (typeof entity === 'string') {
      const key = entity as keyof EntityCollection;
      const target = (this.entityRefs as Record<string, EntityTarget<any>>)[
        key as string
      ];
      if (!target) {
        throw new Error(`Unknown entity requested: ${String(entity)}`);
      }
      return this.dataSource.getRepository(
        target as EntityTarget<ObjectLiteral>,
      );
    }
    return this.dataSource.getRepository(entity as EntityTarget<ObjectLiteral>);
  }
}
