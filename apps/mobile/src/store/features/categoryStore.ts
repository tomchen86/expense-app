import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Category } from '../../types';
import { DEFAULT_CATEGORIES } from '../../constants/expenses';
import { createUuid } from '../../utils/ids';
import { useExpenseStore } from './expenseStore';

const isProtectedDefault = (category: Category): boolean =>
  category.isDefault === true ||
  DEFAULT_CATEGORIES.some((candidate) => candidate.id === category.id);

export interface CategoryState {
  categories: Category[];

  // Actions
  addCategory: (categoryData: Omit<Category, 'id'>) => Category;
  updateCategory: (category: Category) => void;
  deleteCategory: (categoryId: string) => void;
  getCategoryByName: (name: string) => Category | undefined;
}

export const useCategoryStore = create<CategoryState>()(
  persist(
    (set, get) => ({
      categories: DEFAULT_CATEGORIES,

      addCategory: (categoryData) => {
        const { name, color } = categoryData;
        const existingCategory = get().categories.find((c) => c.name === name);

        if (existingCategory) {
          // Optionally update color if name exists, or throw error/return existing
          console.warn(`Category with name "${name}" already exists.`);
          // For now, let's update the color if it's different
          if (existingCategory.color !== color) {
            const updatedCategory = { ...existingCategory, color };
            set((state) => ({
              categories: state.categories.map((c) =>
                c.id === existingCategory.id ? updatedCategory : c,
              ),
            }));
            return updatedCategory;
          }
          return existingCategory;
        }

        const newCategory: Category = {
          id: createUuid(),
          name,
          color,
          isDefault: false,
        };

        set((state) => ({
          categories: [...state.categories, newCategory],
        }));

        return newCategory;
      },

      updateCategory: (updatedCategory) =>
        set((state) => ({
          categories: state.categories.map((category) =>
            category.id === updatedCategory.id ? updatedCategory : category,
          ),
        })),

      deleteCategory: (categoryId) =>
        set((state) => {
          const categoryToDelete = state.categories.find(
            (c) => c.id === categoryId,
          );
          if (categoryToDelete && isProtectedDefault(categoryToDelete)) {
            console.warn(
              `Cannot delete the default category "${categoryToDelete.name}".`,
            );
            return state;
          }
          if (
            categoryToDelete &&
            useExpenseStore
              .getState()
              .expenses.some(
                (expense) =>
                  !expense.sync?.deletedAt &&
                  (expense.categoryId === categoryId ||
                    (!expense.categoryId &&
                      expense.category === categoryToDelete.name)),
              )
          ) {
            console.warn(
              `Cannot delete category "${categoryToDelete.name}" while active expenses use it.`,
            );
            return state;
          }
          return {
            categories: state.categories.filter(
              (category) => category.id !== categoryId,
            ),
          };
        }),

      getCategoryByName: (name) =>
        get().categories.find((category) => category.name === name),
    }),
    {
      name: 'expense-mobile-categories-v2',
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ categories: state.categories }),
    },
  ),
);
