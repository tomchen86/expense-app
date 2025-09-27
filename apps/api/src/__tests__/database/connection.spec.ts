import { testDataSource, dbHelper } from '../setup';
import { Category } from '../../entities/category.entity';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';

describe('Database Connection Tests', () => {
  it('should establish test database connection', () => {
    expect(testDataSource).toBeDefined();
    expect(testDataSource.isInitialized).toBe(true);
  });

  it('should run migrations successfully', async () => {
    const migrations = await testDataSource.showMigrations();
    expect(migrations).toBe(false); // No pending migrations
  });

  it('should seed default categories matching mobile app', async () => {
    const categoryRepo = dbHelper.getRepository('Category');
    const categories = await categoryRepo.find({
      order: { name: 'ASC' },
    });

    expect(categories).toHaveLength(10);

    // Verify mobile app's default categories are present (alphabetical order)
    const expectedCategories = [
      'Bills & Utilities',
      'Education',
      'Entertainment',
      'Food & Dining',
      'Healthcare',
      'Other',
      'Personal Care',
      'Shopping',
      'Transportation',
      'Travel',
    ];

    const categoryNames = categories.map((cat: Category) => cat.name);
    expect(categoryNames).toEqual(expectedCategories);

    // Verify all categories are marked as defaults
    categories.forEach((category: Category) => {
      expect(category.isDefault).toBe(true);
      expect(category.color).toMatch(/^#[0-9A-F]{6}$/i); // Valid hex color
    });
  });

  it('should handle database operations within transactions', async () => {
    await testDataSource.transaction(async (manager) => {
      // Create valid couple fixture first
      const CoupleEntity = dbHelper['entityRefs'].Couple;
      const UserEntity = dbHelper['entityRefs'].User;

      // Create user first (required for couple.createdBy FK)
      const testUser = new UserEntity();
      testUser.displayName = 'Test User';
      testUser.email = 'test@transaction.com';
      testUser.passwordHash = 'hashed';
      const savedUser: User = await manager.save(testUser);

      // Create couple
      const testCouple = new CoupleEntity();
      testCouple.name = 'Test Couple';
      testCouple.inviteCode = 'TEST123';
      testCouple.createdBy = savedUser.id;
      testCouple.status = 'active';
      const savedCouple: Couple = await manager.save(testCouple);

      // Now create category with valid coupleId
      const CategoryEntity = dbHelper['entityRefs'].Category;
      const testCategory = new CategoryEntity();
      testCategory.name = 'Test Category';
      testCategory.color = '#FF0000';
      testCategory.coupleId = savedCouple.id;
      testCategory.isDefault = false;

      const savedCategory: Category = await manager.save(testCategory);
      expect(savedCategory.id).toBeDefined();

      const found: Category | null = await manager.findOne(CategoryEntity, {
        where: { name: 'Test Category' },
      });
      expect(found).toBeDefined();
      expect(found?.color).toBe('#FF0000');
    });
  });

  it('should validate mobile response format helpers', () => {
    const centsToDollars = dbHelper.convertCentsToDollars(2550);
    expect(centsToDollars).toBe(25.5);

    const dollarsToCents = dbHelper.convertDollarsToCents(25.5);
    expect(dollarsToCents).toBe(2550);

    // Test mobile response validation
    const mockResponse = {
      id: '123',
      title: 'Test Expense',
      amount: 25.5,
      date: '2025-09-25T12:00:00Z',
      category: 'Food & Dining',
    };
    const validMobileKeys: (keyof typeof mockResponse)[] = [
      'id',
      'title',
      'amount',
      'date',
      'category',
    ];

    const isValid = dbHelper.validateMobileResponse(
      mockResponse,
      validMobileKeys,
    );
    expect(isValid).toBe(true);
  });
});
