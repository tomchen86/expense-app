// Test data factories that match mobile app's data patterns exactly

import { User } from '../../entities/user.entity';
import { Category } from '../../entities/category.entity';
import { Expense } from '../../entities/expense.entity';
import { ExpenseGroup } from '../../entities/expense-group.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { Participant } from '../../entities/participant.entity';

/**
 * Factory for creating test users matching mobile app patterns
 */
export class UserFactory {
  static create(overrides: Partial<User> = {}): User {
    const user = new User();
    user.displayName =
      overrides.displayName ||
      `Test User ${Math.random().toString(36).substring(7)}`;
    user.email = overrides.email || `test${Date.now()}@example.com`;
    user.passwordHash = overrides.passwordHash || 'hashed_password';
    return user;
  }

  static createMobileCompatible(): User {
    // Matches mobile app's internal user ID format
    const user = new User();
    user.displayName = 'Mobile Test User';
    user.email = 'mobile@test.com';
    user.passwordHash = 'hashed_password';
    return user;
  }
}

/**
 * Factory for creating test user settings matching mobile app defaults
 */
export class UserSettingsFactory {
  static create(
    user: User,
    overrides: Partial<UserSettings> = {},
  ): UserSettings {
    const settings = new UserSettings();
    settings.user = user;
    settings.userId = user.id;
    settings.language = overrides.language || 'en-US';
    settings.persistenceMode = overrides.persistenceMode || 'local_only';
    settings.pushEnabled = overrides.pushEnabled ?? true;
    return settings;
  }

  static createMobileDefaults(user: User): UserSettings {
    // Exact defaults from mobile app
    const settings = new UserSettings();
    settings.user = user;
    settings.userId = user.id;
    settings.language = 'en-US';
    settings.persistenceMode = 'local_only'; // Mobile starts with local-only
    settings.pushEnabled = true;
    return settings;
  }
}

/**
 * Factory for creating test expenses matching mobile app format
 */
export class ExpenseFactory {
  static create(
    user: User,
    category: Category,
    overrides: Partial<Expense> = {},
  ): Expense {
    const expense = new Expense();
    expense.title =
      overrides.title ||
      `Test Expense ${Math.random().toString(36).substring(7)}`;
    expense.amount_cents =
      overrides.amount_cents || Math.floor(Math.random() * 10000) + 100; // $1-$100
    expense.expense_date = overrides.expense_date || new Date();
    expense.category = category;
    expense.created_by = user;
    expense.notes = overrides.notes || null;
    return expense;
  }

  static createMobileTypical(user: User, category: Category): Expense {
    // Typical expense as created by mobile app
    const expense = new Expense();
    expense.title = 'Lunch at Cafe';
    expense.amount_cents = 1850; // $18.50
    expense.expense_date = new Date();
    expense.category = category;
    expense.created_by = user;
    expense.notes = null;
    return expense;
  }

  static createWithDollarAmount(
    user: User,
    category: Category,
    dollarAmount: number,
    title?: string,
  ): Expense {
    const expense = new Expense();
    expense.title = title || `Expense $${dollarAmount.toFixed(2)}`;
    expense.amount_cents = Math.round(dollarAmount * 100); // Convert to cents
    expense.expense_date = new Date();
    expense.category = category;
    expense.created_by = user;
    expense.notes = null;
    return expense;
  }
}

/**
 * Factory for creating test expense groups matching mobile app format
 */
export class ExpenseGroupFactory {
  static create(
    createdBy: User,
    overrides: Partial<ExpenseGroup> = {},
  ): ExpenseGroup {
    const group = new ExpenseGroup();
    group.group_name =
      overrides.group_name ||
      `Test Group ${Math.random().toString(36).substring(7)}`;
    group.group_description =
      overrides.group_description || 'Test group for sharing expenses';
    group.created_by = createdBy;
    group.is_active = overrides.is_active ?? true;
    return group;
  }

  static createMobileTypical(createdBy: User): ExpenseGroup {
    // Typical group as created by mobile app
    const group = new ExpenseGroup();
    group.group_name = 'Weekend Trip';
    group.group_description = 'Shared expenses for our weekend getaway';
    group.created_by = createdBy;
    group.is_active = true;
    return group;
  }
}

/**
 * Factory for creating test categories
 */
export class CategoryFactory {
  static create(coupleId: string, overrides: Partial<Category> = {}): Category {
    const category = new Category();
    category.name =
      overrides.name ||
      `Test Category ${Math.random().toString(36).substring(7)}`;
    category.color =
      overrides.color ||
      '#' +
        Math.floor(Math.random() * 16777215)
          .toString(16)
          .padStart(6, '0');
    category.coupleId = coupleId;
    category.isDefault = overrides.isDefault ?? false;
    return category;
  }

  static createFoodDining(coupleId: string): Category {
    const category = new Category();
    category.name = 'Food & Dining';
    category.color = '#FF6B6B';
    category.coupleId = coupleId;
    category.isDefault = true;
    return category;
  }
}

/**
 * Factory for creating test participants
 */
export class ParticipantFactory {
  static create(user: User, overrides: Partial<Participant> = {}): Participant {
    const participant = new Participant();
    participant.user = user;
    participant.display_name = overrides.display_name || user.display_name;
    participant.email_address = overrides.email_address || user.email_address;
    participant.is_active = overrides.is_active ?? true;
    return participant;
  }

  static createFromUser(user: User): Participant {
    // Create participant directly from user (common mobile app pattern)
    const participant = new Participant();
    participant.user = user;
    participant.display_name = user.display_name;
    participant.email_address = user.email_address;
    participant.is_active = true;
    return participant;
  }
}

/**
 * Combined factory for creating complete test scenarios
 */
export class ScenarioFactory {
  static async createUserWithBasics(dbHelper: any) {
    const user = UserFactory.createMobileCompatible();
    const savedUser = await dbHelper.getRepository(User).save(user);

    const settings = UserSettingsFactory.createMobileDefaults(savedUser);
    const savedSettings = await dbHelper
      .getRepository(UserSettings)
      .save(settings);

    const participant = ParticipantFactory.createFromUser(savedUser);
    const savedParticipant = await dbHelper
      .getRepository(Participant)
      .save(participant);

    return {
      user: savedUser,
      settings: savedSettings,
      participant: savedParticipant,
    };
  }

  static async createExpenseScenario(
    dbHelper: any,
    user: User,
    category: Category,
  ) {
    const group = ExpenseGroupFactory.createMobileTypical(user);
    const savedGroup = await dbHelper.getRepository(ExpenseGroup).save(group);

    const expense = ExpenseFactory.createWithDollarAmount(
      user,
      category,
      25.5,
      'Test Restaurant',
    );
    expense.expense_group = savedGroup;
    const savedExpense = await dbHelper.getRepository(Expense).save(expense);

    return {
      group: savedGroup,
      expense: savedExpense,
    };
  }
}
