// SettingsScreen integration tests - user workflow validation
import { useExpenseStore } from '../../store/composedExpenseStore';
import { mockUser } from '../../__tests__/fixtures';

describe('SettingsScreen Integration', () => {
  beforeEach(() => {
    // Reset to completely clean state
    useExpenseStore.setState({
      expenses: [],
      groups: [],
      participants: [],
      categories: [],
      user: null,
      settings: {
        theme: 'light',
        currency: 'USD',
        dateFormat: 'MM/DD/YYYY',
        notifications: true,
      },
    });
  });

  describe('user setup workflow', () => {
    it('should complete new user onboarding flow', () => {
      const store = useExpenseStore.getState();

      // Step 1: User enters display name
      store.updateUser({ displayName: 'Test User' });

      // Verify user was created
      const updatedUser = useExpenseStore.getState().user;
      expect(updatedUser?.displayName).toBe('Test User');
      expect(updatedUser?.id).toBeDefined();
    });

    it('should validate display name requirements during setup', () => {
      const validateDisplayName = (name: string) => {
        if (!name || name.trim().length === 0) {
          return 'Display name is required';
        }
        if (name.trim().length > 50) {
          return 'Display name must be 50 characters or less';
        }
        return null;
      };

      // Test valid names
      expect(validateDisplayName('John Doe')).toBeNull();
      expect(validateDisplayName('Alice Smith')).toBeNull();
      expect(validateDisplayName('José María')).toBeNull(); // Unicode support

      // Test invalid names
      expect(validateDisplayName('')).toBe('Display name is required');
      expect(validateDisplayName('   ')).toBe('Display name is required');
      expect(validateDisplayName('A'.repeat(51))).toBe(
        'Display name must be 50 characters or less',
      );
    });

    it('should handle settings persistence workflow', () => {
      const store = useExpenseStore.getState();

      // Update multiple settings
      const newSettings = {
        theme: 'dark' as const,
        currency: 'EUR',
        dateFormat: 'DD/MM/YYYY',
      };

      store.updateSettings(newSettings);

      // Verify settings were persisted
      const settings = useExpenseStore.getState().settings;
      expect(settings.theme).toBe('dark');
      expect(settings.currency).toBe('EUR');
      expect(settings.dateFormat).toBe('DD/MM/YYYY');
    });
  });

  describe('group creation workflow', () => {
    beforeEach(() => {
      // Setup user first
      const store = useExpenseStore.getState();
      store.updateUser({ displayName: 'Test User' });
    });

    it('should create group after username setup', () => {
      const store = useExpenseStore.getState();

      // Verify user is set up
      const user = useExpenseStore.getState().user;
      expect(user?.displayName).toBe('Test User');

      // Create a group (addGroup takes just the name)
      store.addGroup('Test Group');

      // Verify group was created
      const groups = useExpenseStore.getState().groups;
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Test Group');
      expect(groups[0].participants).toHaveLength(1); // Creator is automatically added
    });

    it('should require user before group creation', () => {
      const validateGroupCreation = (user: any) => {
        if (!user || !user.displayName) {
          return 'User must be set up before creating groups';
        }
        return null;
      };

      // Reset user to null
      useExpenseStore.setState({ user: null });

      // Test without user
      const store = useExpenseStore.getState();
      const userValidation = validateGroupCreation(store.user);
      expect(userValidation).toBe('User must be set up before creating groups');

      // Set up user and test with user
      const store2 = useExpenseStore.getState();
      store2.updateUser({ displayName: 'Valid User' });
      const validUserValidation = validateGroupCreation(
        useExpenseStore.getState().user,
      );
      expect(validUserValidation).toBeNull();
    });

    it('should handle participant management in groups', () => {
      // Reset state completely for this isolated test
      useExpenseStore.setState({
        expenses: [],
        groups: [],
        participants: [],
        categories: [],
        user: null,
        settings: {
          theme: 'light',
          currency: 'USD',
          dateFormat: 'MM/DD/YYYY',
          notifications: true,
        },
      });

      const store = useExpenseStore.getState();
      // Set up user
      store.updateUser({ displayName: 'Test User' });

      // Create group (participants are managed separately)
      const groupId = store.addGroup('Family Group');

      const groups = useExpenseStore.getState().groups;
      const familyGroup = groups.find(g => g.id === groupId);

      expect(familyGroup?.participants).toHaveLength(1); // Creator only initially
      expect(familyGroup?.name).toBe('Family Group');
    });
  });

  describe('settings management workflow', () => {
    it('should handle theme switching', () => {
      const store = useExpenseStore.getState();

      // Start with light theme
      expect(store.settings.theme).toBe('light');

      // Switch to dark theme
      store.updateSettings({ theme: 'dark' });

      // Verify theme changed
      const updatedSettings = useExpenseStore.getState().settings;
      expect(updatedSettings.theme).toBe('dark');

      // Switch back to light
      store.updateSettings({ theme: 'light' });
      expect(useExpenseStore.getState().settings.theme).toBe('light');
    });

    it('should handle currency settings', () => {
      const store = useExpenseStore.getState();

      const supportedCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];

      supportedCurrencies.forEach((currency) => {
        store.updateSettings({ currency });
        const settings = useExpenseStore.getState().settings;
        expect(settings.currency).toBe(currency);
      });
    });

    it('should handle date format preferences', () => {
      const store = useExpenseStore.getState();

      const dateFormats = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];

      dateFormats.forEach((format) => {
        store.updateSettings({ dateFormat: format });
        const settings = useExpenseStore.getState().settings;
        expect(settings.dateFormat).toBe(format);
      });
    });

    it('should validate settings before saving', () => {
      const validateSettings = (settings: any) => {
        const errors: Record<string, string> = {};

        const validThemes = ['light', 'dark'];
        if (!validThemes.includes(settings.theme)) {
          errors.theme = 'Invalid theme selection';
        }

        const validCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
        if (!validCurrencies.includes(settings.currency)) {
          errors.currency = 'Invalid currency selection';
        }

        const validDateFormats = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
        if (!validDateFormats.includes(settings.dateFormat)) {
          errors.dateFormat = 'Invalid date format';
        }

        return Object.keys(errors).length === 0 ? null : errors;
      };

      // Test valid settings
      const validSettings = {
        theme: 'dark',
        currency: 'EUR',
        dateFormat: 'DD/MM/YYYY',
      };
      expect(validateSettings(validSettings)).toBeNull();

      // Test invalid settings
      const invalidSettings = {
        theme: 'purple',
        currency: 'INVALID',
        dateFormat: 'WRONG',
      };
      const errors = validateSettings(invalidSettings);
      expect(errors).toEqual({
        theme: 'Invalid theme selection',
        currency: 'Invalid currency selection',
        dateFormat: 'Invalid date format',
      });
    });
  });

  describe('navigation and state transitions', () => {
    it('should handle unsaved changes warning', () => {
      const getNavigationOptions = (hasUnsavedChanges: boolean) => {
        return {
          headerLeft: hasUnsavedChanges ? 'Cancel' : 'Back',
          headerRight: hasUnsavedChanges ? 'Save' : null,
          gestureEnabled: !hasUnsavedChanges,
        };
      };

      // No unsaved changes
      const cleanState = getNavigationOptions(false);
      expect(cleanState.headerLeft).toBe('Back');
      expect(cleanState.headerRight).toBeNull();
      expect(cleanState.gestureEnabled).toBe(true);

      // With unsaved changes
      const dirtyState = getNavigationOptions(true);
      expect(dirtyState.headerLeft).toBe('Cancel');
      expect(dirtyState.headerRight).toBe('Save');
      expect(dirtyState.gestureEnabled).toBe(false);
    });

    it('should handle save confirmation workflow', () => {
      const shouldShowSaveConfirmation = (
        hasUnsavedChanges: boolean,
        isNavigatingAway: boolean,
      ) => {
        return hasUnsavedChanges && isNavigatingAway;
      };

      expect(shouldShowSaveConfirmation(true, true)).toBe(true);
      expect(shouldShowSaveConfirmation(true, false)).toBe(false);
      expect(shouldShowSaveConfirmation(false, true)).toBe(false);
      expect(shouldShowSaveConfirmation(false, false)).toBe(false);
    });

    it('should handle settings migration on load', () => {
      const migrateSettings = (storedSettings: any) => {
        // Handle legacy settings format
        if (!storedSettings.version) {
          return {
            ...storedSettings,
            theme: storedSettings.theme || 'light',
            currency: storedSettings.currency || 'USD',
            dateFormat: storedSettings.dateFormat || 'MM/DD/YYYY',
            version: '1.0',
          };
        }
        return storedSettings;
      };

      const legacySettings = { theme: 'dark' };
      const migrated = migrateSettings(legacySettings);

      expect(migrated).toEqual({
        theme: 'dark',
        currency: 'USD',
        dateFormat: 'MM/DD/YYYY',
        version: '1.0',
      });

      // Test modern settings (no migration needed)
      const modernSettings = {
        theme: 'light',
        currency: 'EUR',
        dateFormat: 'DD/MM/YYYY',
        version: '1.0',
      };
      const notMigrated = migrateSettings(modernSettings);
      expect(notMigrated).toEqual(modernSettings);
    });
  });
});
