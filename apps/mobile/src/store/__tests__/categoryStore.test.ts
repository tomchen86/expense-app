import { useCategoryStore } from '../features/categoryStore';
import { DEFAULT_CATEGORIES } from '../../constants/expenses';

describe('CategoryStore', () => {
  beforeEach(() => {
    useCategoryStore.setState({
      categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('adds a new category when the name is unique', () => {
    const { addCategory } = useCategoryStore.getState();

    const result = addCategory({ name: 'Fitness', color: '#111111' });
    const categories = useCategoryStore.getState().categories;

    expect(result).toMatchObject({
      id: 'Fitness',
      name: 'Fitness',
      color: '#111111',
    });
    expect(categories).toContainEqual(result);
  });

  it('warns and returns the existing category when adding a duplicate name', () => {
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const existing = useCategoryStore.getState().categories[0];

    const result = useCategoryStore
      .getState()
      .addCategory({ name: existing.name, color: existing.color });

    const categories = useCategoryStore
      .getState()
      .categories.filter((category) => category.name === existing.name);

    expect(result).toEqual(existing);
    expect(categories).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Category with name "${existing.name}" already exists.`,
      ),
    );
  });

  it('updates the color when adding an existing category with a new color', () => {
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    useCategoryStore
      .getState()
      .addCategory({ name: 'Transportation', color: '#ABCDEF' });

    const updated = useCategoryStore
      .getState()
      .categories.find((category) => category.name === 'Transportation');

    expect(updated?.color).toBe('#ABCDEF');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Category with name "Transportation" already exists.',
      ),
    );
  });

  it("prevents deleting the reserved 'Other' category", () => {
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const otherCategory = useCategoryStore
      .getState()
      .categories.find((category) => category.name === 'Other');

    expect(otherCategory).toBeDefined();

    useCategoryStore.getState().deleteCategory(otherCategory!.id);

    const categories = useCategoryStore.getState().categories;

    expect(
      categories.find((category) => category.name === 'Other'),
    ).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith("Cannot delete the 'Other' category.");
  });

  it('retrieves categories by name after updates', () => {
    const { addCategory, updateCategory, getCategoryByName } =
      useCategoryStore.getState();

    const created = addCategory({ name: 'Outdoors', color: '#123456' });
    expect(getCategoryByName('Outdoors')).toEqual(created);

    const updated = { ...created, color: '#654321' };
    updateCategory(updated);

    expect(getCategoryByName('Outdoors')?.color).toBe('#654321');
  });
});
