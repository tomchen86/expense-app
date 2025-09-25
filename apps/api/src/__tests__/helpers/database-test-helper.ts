import { DataSource, Repository } from 'typeorm';
import { Category } from '../../entities/category.entity';
import { User } from '../../entities/user.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { UserAuthIdentity } from '../../entities/user-auth-identity.entity';
import { ExpenseGroup } from '../../entities/expense-group.entity';
import { Participant } from '../../entities/participant.entity';
import { Expense } from '../../entities/expense.entity';
import { Couple } from '../../entities/couple.entity';

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
  private repositories: {
    category?: Repository<Category>;
    user?: Repository<User>;
    userSettings?: Repository<UserSettings>;
    userAuthIdentity?: Repository<UserAuthIdentity>;
    expenseGroup?: Repository<ExpenseGroup>;
    participant?: Repository<Participant>;
    expense?: Repository<Expense>;
    couple?: Repository<Couple>;
  } = {};

  async createTestDatabase(): Promise<DataSource> {
    this.dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:', // In-memory database for tests
      dropSchema: true,
      synchronize: false, // Use migrations instead
      entities: ['src/entities/*.entity.ts'],
      migrations: ['src/database/migrations/*.ts'],
      logging: false, // Disable SQL logging in tests
    });

    await this.dataSource.initialize();
    this.initializeRepositories();
    return this.dataSource;
  }

  private initializeRepositories(): void {
    this.repositories.category = this.dataSource.getRepository(Category);
    this.repositories.user = this.dataSource.getRepository(User);
    this.repositories.userSettings =
      this.dataSource.getRepository(UserSettings);
    this.repositories.userAuthIdentity =
      this.dataSource.getRepository(UserAuthIdentity);
    this.repositories.expenseGroup =
      this.dataSource.getRepository(ExpenseGroup);
    this.repositories.participant = this.dataSource.getRepository(Participant);
    this.repositories.expense = this.dataSource.getRepository(Expense);
    this.repositories.couple = this.dataSource.getRepository(Couple);
  }

  async seedDefaultCategories(coupleId?: string): Promise<Category[]> {
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

    const categories = MOBILE_DEFAULT_CATEGORIES.map((cat, index) => {
      const category = new Category();
      category.name = cat.name;
      category.color = cat.color;
      category.coupleId = actualCoupleId;
      category.isDefault = true;
      return category;
    });

    return await categoryRepo.save(categories);
  }

  async createTestUser(overrides: Partial<User> = {}): Promise<User> {
    const userRepo = this.repositories.user;
    if (!userRepo) throw new Error('User repository not initialized');

    const user = new User();
    user.displayName = overrides.displayName || 'Test User';
    user.email = overrides.email || 'test@example.com';
    user.passwordHash = overrides.passwordHash || 'hashed_password';

    return await userRepo.save(user);
  }

  async createTestCouple(
    user: User,
    overrides: Partial<Couple> = {},
  ): Promise<Couple> {
    const coupleRepo = this.repositories.couple;
    if (!coupleRepo) throw new Error('Couple repository not initialized');

    const couple = new Couple();
    couple.name = overrides.name || 'Test Couple';
    couple.inviteCode = overrides.inviteCode || `TC${Date.now()}`;
    couple.createdBy = user.id;
    couple.status = overrides.status || 'active';

    return await coupleRepo.save(couple);
  }

  async createTestUserSettings(
    user: User,
    overrides: Partial<UserSettings> = {},
  ): Promise<UserSettings> {
    const userSettingsRepo = this.repositories.userSettings;
    if (!userSettingsRepo)
      throw new Error('UserSettings repository not initialized');

    const settings = new UserSettings();
    settings.user = user;
    settings.userId = user.id;
    settings.language = overrides.language || 'en-US';
    settings.persistenceMode = overrides.persistenceMode || 'local_only';
    settings.pushEnabled = overrides.pushEnabled ?? true;

    return await userSettingsRepo.save(settings);
  }

  async createTestExpenseGroup(
    user: User,
    coupleId: string,
    overrides: Partial<ExpenseGroup> = {},
  ): Promise<ExpenseGroup> {
    const groupRepo = this.repositories.expenseGroup;
    if (!groupRepo) throw new Error('ExpenseGroup repository not initialized');

    const group = new ExpenseGroup();
    group.name = overrides.name || 'Test Group';
    group.description = overrides.description || 'Test group description';
    group.createdBy = user.id;
    group.coupleId = coupleId;
    group.isArchived = overrides.isArchived ?? false;

    return await groupRepo.save(group);
  }

  async createTestExpense(
    user: User,
    category: Category,
    coupleId: string,
    overrides: Partial<Expense> = {},
  ): Promise<Expense> {
    const expenseRepo = this.repositories.expense;
    if (!expenseRepo) throw new Error('Expense repository not initialized');

    const expense = new Expense();
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
  validateMobileResponse<T>(response: T, expectedKeys: string[]): boolean {
    if (typeof response !== 'object' || response === null) {
      return false;
    }

    const responseKeys = Object.keys(response as object);
    return expectedKeys.every((key) => responseKeys.includes(key));
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
      'expense_splits',
      'expenses',
      'expense_groups',
      'participants',
      'user_settings',
      'user_auth_identities',
      'users',
    ];

    // Clean in reverse dependency order to avoid FK constraints
    for (const table of tables) {
      await this.dataSource.query(`DELETE FROM ${table}`);
    }
  }

  getRepository<T>(entity: string | (new () => T)): Repository<any> {
    if (typeof entity === 'string') {
      // Handle string entity names for backward compatibility
      const entityMap: { [key: string]: any } = {
        User: User,
        UserSettings: UserSettings,
        Category: Category,
        ExpenseGroup: ExpenseGroup,
        Participant: Participant,
        Expense: Expense,
        Couple: Couple,
      };
      return this.dataSource.getRepository(entityMap[entity]);
    }
    return this.dataSource.getRepository(entity);
  }
}
