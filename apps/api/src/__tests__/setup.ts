import { DataSource } from 'typeorm';
import { DatabaseTestHelper } from './helpers/database-test-helper';

// Global test database instance
export let testDataSource: DataSource;
export let dbHelper: DatabaseTestHelper;

// Setup before all tests
beforeAll(async () => {
  dbHelper = new DatabaseTestHelper();
  testDataSource = await dbHelper.createTestDatabase();

  // Run migrations on test database
  await testDataSource.runMigrations();

  // Seed with default categories matching mobile app
  await dbHelper.seedDefaultCategories();
});

// Cleanup after each test
afterEach(async () => {
  if (dbHelper) {
    await dbHelper.cleanupTestData();
  }
});

// Final cleanup
afterAll(async () => {
  if (testDataSource) {
    await testDataSource.destroy();
  }
});

// Increase timeout for database operations
jest.setTimeout(30000);

// Mock external services for testing
global.console = {
  ...console,
  // Suppress test noise but keep errors visible
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: console.warn,
  error: console.error,
};
