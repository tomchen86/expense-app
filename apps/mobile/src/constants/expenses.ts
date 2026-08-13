// Centralized constants related to expenses
import { Category } from '../types'; // Import the Category type

export const DEFAULT_CATEGORIES: Category[] = [
  {
    id: 'Food & Dining',
    name: 'Food & Dining',
    color: '#FF6384',
    isDefault: true,
  },
  {
    id: 'Transportation',
    name: 'Transportation',
    color: '#36A2EB',
    isDefault: true,
  },
  { id: 'Shopping', name: 'Shopping', color: '#FFCE56', isDefault: true },
  {
    id: 'Entertainment',
    name: 'Entertainment',
    color: '#4BC0C0',
    isDefault: true,
  },
  {
    id: 'Bills & Utilities',
    name: 'Bills & Utilities',
    color: '#9966FF',
    isDefault: true,
  },
  { id: 'Health', name: 'Health', color: '#FF9F40', isDefault: true },
  { id: 'Travel', name: 'Travel', color: '#C9CBCF', isDefault: true },
  { id: 'Other', name: 'Other', color: '#61C0BF', isDefault: true },
];
