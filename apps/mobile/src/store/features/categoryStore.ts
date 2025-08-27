import { create } from "zustand";
import { Category } from "../../types";
import { DEFAULT_CATEGORIES } from "../../constants/expenses";

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export interface CategoryState {
  categories: Category[];
  
  // Actions
  addCategory: (categoryData: Omit<Category, "id">) => Category;
  updateCategory: (category: Category) => void;
  deleteCategory: (categoryId: string) => void;
  getCategoryByName: (name: string) => Category | undefined;
}

export const useCategoryStore = create<CategoryState>((set, get) => ({
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
            c.id === existingCategory.id ? updatedCategory : c
          ),
        }));
        return updatedCategory;
      }
      return existingCategory;
    }
    
    const newCategory: Category = {
      id: name, // Use name as ID for simplicity, ensure it's unique
      name,
      color,
    };
    
    set((state) => ({
      categories: [...state.categories, newCategory],
    }));
    
    return newCategory;
  },

  updateCategory: (updatedCategory) =>
    set((state) => ({
      categories: state.categories.map((category) =>
        category.id === updatedCategory.id ? updatedCategory : category
      ),
    })),

  deleteCategory: (categoryId) =>
    set((state) => {
      // Before deleting, check if it's a default category or "Other"
      const categoryToDelete = state.categories.find(
        (c) => c.id === categoryId
      );
      if (categoryToDelete && categoryToDelete.name === "Other") {
        console.warn("Cannot delete the 'Other' category.");
        return state; // Prevent deletion of "Other"
      }
      return {
        categories: state.categories.filter(
          (category) => category.id !== categoryId
        ),
      };
    }),

  getCategoryByName: (name) =>
    get().categories.find((category) => category.name === name),
}));