import { defaultCategories } from '../../database/seeds/default-categories.seed';

describe('default category catalog', () => {
  it('matches the canonical eight-category mobile catalog', () => {
    expect(defaultCategories).toEqual([
      { name: 'Food & Dining', color: '#FF6384', icon: 'restaurant' },
      { name: 'Transportation', color: '#36A2EB', icon: 'directions-car' },
      { name: 'Shopping', color: '#FFCE56', icon: 'shopping-cart' },
      { name: 'Entertainment', color: '#4BC0C0', icon: 'movie' },
      { name: 'Bills & Utilities', color: '#9966FF', icon: 'receipt' },
      { name: 'Health', color: '#FF9F40', icon: 'local-hospital' },
      { name: 'Travel', color: '#C9CBCF', icon: 'flight' },
      { name: 'Other', color: '#61C0BF', icon: 'category' },
    ]);
  });
});
