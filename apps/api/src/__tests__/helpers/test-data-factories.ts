// Test data factories that match mobile app's data patterns exactly

import { randomUUID } from 'crypto';
import { User } from '../../entities/user.entity';
import { Category } from '../../entities/category.entity';
import { Expense } from '../../entities/expense.entity';
import { ExpenseGroup } from '../../entities/expense-group.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { Participant } from '../../entities/participant.entity';
import { DatabaseTestHelper } from './database-test-helper';

/**
 * Factory for creating test users matching mobile app patterns
 */
export class UserFactory {
  static create(overrides: Partial<User> = {}): User {
    const user = new User();
    user.displayName =
      overrides.displayName ??
      `Test User ${Math.random().toString(36).substring(7)}`;
    user.email = overrides.email ?? `test${Date.now()}@example.com`;
    user.passwordHash = overrides.passwordHash ?? 'hashed_password';
    user.timezone = overrides.timezone ?? 'UTC';
    user.defaultCurrency = overrides.defaultCurrency ?? 'USD';
    return user;
  }

  static createMobileCompatible(): User {
    // Matches mobile app's internal user ID format
    const user = new User();
    user.displayName = 'Mobile Test User';
    user.email = 'mobile@test.com';
    user.passwordHash = 'hashed_password';
    user.timezone = 'UTC';
    user.defaultCurrency = 'USD';
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
    settings.language = overrides.language ?? 'en-US';
    settings.persistenceMode = overrides.persistenceMode ?? 'local_only';
    settings.pushEnabled = overrides.pushEnabled ?? true;
    settings.notifications = overrides.notifications ?? {
      expenses: true,
      invites: true,
      reminders: true,
    };
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
    settings.notifications = {
      expenses: true,
      invites: true,
      reminders: true,
    };
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
    expense.description =
      overrides.description ??
      `Test Expense ${Math.random().toString(36).substring(7)}`;
    const randomAmount = Math.floor(Math.random() * 10000) + 100;
    expense.amountCents = overrides.amountCents ?? randomAmount.toString();
    expense.currency = overrides.currency ?? 'USD';
    expense.expenseDate =
      overrides.expenseDate ?? new Date().toISOString().split('T')[0];
    const inferredCoupleId = overrides.coupleId ?? category.coupleId;
    expense.category = overrides.category ?? category;
    expense.categoryId = overrides.categoryId ?? category.id;
    expense.coupleId = inferredCoupleId ?? randomUUID();
    expense.createdBy = overrides.createdBy ?? user.id;
    expense.creator = overrides.creator ?? user;
    expense.notes = overrides.notes ?? undefined;
    expense.group = overrides.group;
    expense.groupId = overrides.groupId ?? overrides.group?.id;
    expense.paidByParticipantId = overrides.paidByParticipantId;
    expense.payer = overrides.payer;
    expense.exchangeRate = overrides.exchangeRate;
    expense.splitType = overrides.splitType ?? 'equal';
    expense.receiptUrl = overrides.receiptUrl;
    expense.location = overrides.location;
    return expense;
  }

  static createMobileTypical(user: User, category: Category): Expense {
    // Typical expense as created by mobile app
    const expense = new Expense();
    expense.description = 'Lunch at Cafe';
    expense.amountCents = '1850'; // $18.50
    expense.expenseDate = new Date().toISOString().split('T')[0];
    expense.category = category;
    expense.categoryId = category.id;
    expense.coupleId = category.coupleId ?? randomUUID();
    expense.createdBy = user.id;
    expense.creator = user;
    expense.currency = 'USD';
    expense.splitType = 'equal';
    return expense;
  }

  static createWithDollarAmount(
    user: User,
    category: Category,
    dollarAmount: number,
    title?: string,
  ): Expense {
    const expense = new Expense();
    expense.description = title || `Expense $${dollarAmount.toFixed(2)}`;
    expense.amountCents = Math.round(dollarAmount * 100).toString();
    expense.expenseDate = new Date().toISOString().split('T')[0];
    expense.category = category;
    expense.categoryId = category.id;
    expense.coupleId = category.coupleId ?? randomUUID();
    expense.createdBy = user.id;
    expense.creator = user;
    expense.currency = 'USD';
    expense.splitType = 'equal';
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
    group.name =
      overrides.name ?? `Test Group ${Math.random().toString(36).substring(7)}`;
    group.description =
      overrides.description ?? 'Test group for sharing expenses';
    group.color = overrides.color;
    group.defaultCurrency = overrides.defaultCurrency ?? 'USD';
    group.createdBy = overrides.createdBy ?? createdBy.id;
    group.creator = overrides.creator ?? createdBy;
    group.coupleId = overrides.coupleId ?? randomUUID();
    group.isArchived = overrides.isArchived ?? false;
    return group;
  }

  static createMobileTypical(createdBy: User, coupleId?: string): ExpenseGroup {
    // Typical group as created by mobile app
    const group = new ExpenseGroup();
    group.name = 'Weekend Trip';
    group.description = 'Shared expenses for our weekend getaway';
    group.createdBy = createdBy.id;
    group.creator = createdBy;
    group.isArchived = false;
    group.coupleId = coupleId ?? randomUUID();
    group.defaultCurrency = 'USD';
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
  static create(
    user: User & { coupleId?: string },
    coupleId: string,
    overrides: Partial<Participant> = {},
  ): Participant {
    const participant = new Participant();
    participant.user = user;
    participant.displayName = overrides.displayName ?? user.displayName;
    participant.email = overrides.email ?? user.email;
    participant.isRegistered = overrides.isRegistered ?? true;
    const inferredCoupleId = overrides.coupleId ?? user.coupleId ?? undefined;
    participant.coupleId = inferredCoupleId ?? randomUUID();
    participant.defaultCurrency = overrides.defaultCurrency ?? 'USD';
    participant.notificationPreferences = overrides.notificationPreferences ?? {
      expenses: true,
      invites: true,
      reminders: true,
    };
    return participant;
  }

  static createFromUser(user: User, coupleId: string): Participant {
    // Create participant directly from user (common mobile app pattern)
    const participant = new Participant();
    participant.user = user;
    participant.displayName = user.displayName;
    participant.email = user.email;
    participant.isRegistered = true;
    participant.coupleId = coupleId;
    participant.defaultCurrency = 'USD';
    participant.notificationPreferences = {
      expenses: true,
      invites: true,
      reminders: true,
    };
    return participant;
  }
}

/**
 * Combined factory for creating complete test scenarios
 */
export class ScenarioFactory {
  static async createUserWithBasics(dbHelper: DatabaseTestHelper) {
    const user = UserFactory.createMobileCompatible();
    const savedUser = await dbHelper.getRepository(User).save(user);

    const couple = await dbHelper.createTestCouple(savedUser);

    const settings = UserSettingsFactory.createMobileDefaults(savedUser);
    const savedSettings = await dbHelper
      .getRepository(UserSettings)
      .save(settings);

    const participant = ParticipantFactory.createFromUser(savedUser, couple.id);
    const savedParticipant = await dbHelper
      .getRepository(Participant)
      .save(participant);

    return {
      user: savedUser,
      settings: savedSettings,
      participant: savedParticipant,
      couple,
    };
  }

  static async createExpenseScenario(
    dbHelper: DatabaseTestHelper,
    user: User,
    category: Category,
  ) {
    const coupleId = category.coupleId ?? randomUUID();
    const group = ExpenseGroupFactory.createMobileTypical(user, coupleId);
    const savedGroup = await dbHelper.getRepository(ExpenseGroup).save(group);

    const expense = ExpenseFactory.createWithDollarAmount(
      user,
      category,
      25.5,
      'Test Restaurant',
    );
    expense.group = savedGroup;
    expense.groupId = savedGroup.id;
    expense.coupleId = expense.coupleId || category.coupleId || coupleId;
    const savedExpense = await dbHelper.getRepository(Expense).save(expense);

    return {
      group: savedGroup,
      expense: savedExpense,
    };
  }
}
