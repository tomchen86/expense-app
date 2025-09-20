// Category form validation logic tests
import { validCategoryForm, invalidCategoryForm } from '../../__tests__/fixtures';

describe('CategoryForm Logic', () => {
  describe('form validation', () => {
    it('should validate category name', () => {
      const validateCategoryName = (name: string) => {
        if (!name || name.trim().length === 0) {
          return 'Category name is required';
        }
        if (name.trim().length > 50) {
          return 'Category name must be 50 characters or less';
        }
        return null;
      };

      expect(validateCategoryName('Food & Dining')).toBeNull();
      expect(validateCategoryName('')).toBe('Category name is required');
      expect(validateCategoryName('   ')).toBe('Category name is required');
      expect(validateCategoryName('A'.repeat(51))).toBe('Category name must be 50 characters or less');
    });

    it('should validate color format', () => {
      const validateColor = (color: string) => {
        if (!color) {
          return 'Color is required';
        }
        if (!/^#[0-9A-F]{6}$/i.test(color)) {
          return 'Color must be a valid hex code';
        }
        return null;
      };

      expect(validateColor('#FF5722')).toBeNull();
      expect(validateColor('#2196F3')).toBeNull();
      expect(validateColor('')).toBe('Color is required');
      expect(validateColor('red')).toBe('Color must be a valid hex code');
      expect(validateColor('#FFF')).toBe('Color must be a valid hex code');
    });

    it('should validate complete form', () => {
      const validateCategoryForm = (form: { name: string; color: string }) => {
        const errors: { name?: string; color?: string } = {};

        if (!form.name || form.name.trim().length === 0) {
          errors.name = 'Category name is required';
        }

        if (!form.color || !/^#[0-9A-F]{6}$/i.test(form.color)) {
          errors.color = 'Valid color is required';
        }

        return Object.keys(errors).length === 0 ? null : errors;
      };

      expect(validateCategoryForm(validCategoryForm)).toBeNull();
      expect(validateCategoryForm(invalidCategoryForm)).toEqual({
        name: 'Category name is required',
        color: 'Valid color is required'
      });
    });
  });

  describe('category utilities', () => {
    it('should generate unique category ID', () => {
      const generateCategoryId = (name: string) => {
        return `cat-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`;
      };

      const id1 = generateCategoryId('Food & Dining');
      const id2 = generateCategoryId('Transportation');

      expect(id1).toMatch(/^cat-food---dining-\d+$/);
      expect(id2).toMatch(/^cat-transportation-\d+$/);
      expect(id1).not.toBe(id2);
    });

    it('should check for duplicate names', () => {
      const existingCategories = [
        { id: '1', name: 'Food & Dining', color: '#FF5722' },
        { id: '2', name: 'Transportation', color: '#2196F3' }
      ];

      const isDuplicateName = (name: string, categories: typeof existingCategories, excludeId?: string) => {
        return categories.some(cat =>
          cat.name.toLowerCase() === name.toLowerCase() && cat.id !== excludeId
        );
      };

      expect(isDuplicateName('Food & Dining', existingCategories)).toBe(true);
      expect(isDuplicateName('food & dining', existingCategories)).toBe(true); // Case insensitive
      expect(isDuplicateName('New Category', existingCategories)).toBe(false);
      expect(isDuplicateName('Food & Dining', existingCategories, '1')).toBe(false); // Exclude self
    });

    it('should provide default colors', () => {
      const defaultColors = [
        '#FF5722', '#2196F3', '#4CAF50', '#FF9800',
        '#9C27B0', '#F44336', '#795548', '#607D8B'
      ];

      const getNextDefaultColor = (usedColors: string[]) => {
        return defaultColors.find(color => !usedColors.includes(color)) || defaultColors[0];
      };

      expect(getNextDefaultColor([])).toBe('#FF5722');
      expect(getNextDefaultColor(['#FF5722'])).toBe('#2196F3');
      expect(getNextDefaultColor(['#FF5722', '#2196F3'])).toBe('#4CAF50');
      expect(getNextDefaultColor(defaultColors)).toBe('#FF5722'); // Fallback to first
    });
  });

  describe('form state management', () => {
    it('should handle form state updates', () => {
      interface FormState {
        name: string;
        color: string;
        isDefault: boolean;
      }

      const initialState: FormState = {
        name: '',
        color: '#FF5722',
        isDefault: false
      };

      const updateFormField = (state: FormState, field: keyof FormState, value: any): FormState => {
        return { ...state, [field]: value };
      };

      let state = initialState;
      state = updateFormField(state, 'name', 'Food & Dining');
      state = updateFormField(state, 'color', '#2196F3');

      expect(state).toEqual({
        name: 'Food & Dining',
        color: '#2196F3',
        isDefault: false
      });
    });

    it('should reset form to initial state', () => {
      const resetForm = () => ({
        name: '',
        color: '#FF5722',
        isDefault: false
      });

      const form = resetForm();
      expect(form.name).toBe('');
      expect(form.color).toBe('#FF5722');
      expect(form.isDefault).toBe(false);
    });
  });
});