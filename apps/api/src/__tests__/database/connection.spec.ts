import { testDataSource, dbHelper } from '../setup';
import { Category } from '../../entities/category.entity';

describe('Database Connection Tests', () => {
  it('should establish test database connection', async () => {
    expect(testDataSource).toBeDefined();
    expect(testDataSource.isInitialized).toBe(true);
  });

  it('should run migrations successfully', async () => {
    const migrations = await testDataSource.showMigrations();
    expect(migrations).toBe(false); // No pending migrations
  });

  it('should seed default categories matching mobile app', async () => {
    const categoryRepo = testDataSource.getRepository(Category);
    const categories = await categoryRepo.find({
      order: { sort_order: 'ASC' },
    });

    expect(categories).toHaveLength(10);

    // Verify mobile app's default categories are present
    const expectedCategories = [
      'Food & Dining',
      'Transportation',
      'Shopping',
      'Entertainment',
      'Bills & Utilities',
      'Healthcare',
      'Travel',
      'Education',
      'Personal Care',
      'Other',
    ];

    const categoryNames = categories.map((cat) => cat.name);
    expect(categoryNames).toEqual(expectedCategories);

    // Verify all categories are marked as system defaults
    categories.forEach((category) => {
      expect(category.is_system_default).toBe(true);
      expect(category.color).toMatch(/^#[0-9A-F]{6}$/i); // Valid hex color
    });
  });

  it('should handle database operations within transactions', async () => {
    await testDataSource.transaction(async (manager) => {
      const categoryRepo = manager.getRepository(Category);
      const testCategory = new Category();
      testCategory.name = 'Test Category';
      testCategory.color = '#FF0000';
      testCategory.sort_order = 999;

      const saved = await categoryRepo.save(testCategory);
      expect(saved.id).toBeDefined();

      const found = await categoryRepo.findOne({
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
    const validMobileKeys = ['id', 'title', 'amount', 'date', 'category'];
    const mockResponse = {
      id: '123',
      title: 'Test Expense',
      amount: 25.5,
      date: '2025-09-25T12:00:00Z',
      category: 'Food & Dining',
    };

    const isValid = dbHelper.validateMobileResponse(
      mockResponse,
      validMobileKeys,
    );
    expect(isValid).toBe(true);
  });
});
