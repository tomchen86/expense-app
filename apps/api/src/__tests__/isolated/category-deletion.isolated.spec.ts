import { CategoryService } from '../../services/category.service';

const repository = () => ({
  findOne: jest.fn(),
  save: jest.fn(async (value) => value),
  createQueryBuilder: jest.fn(),
});

describe('CategoryService deletion safety', () => {
  const categoryRepository = repository();
  const expenseRepository = repository();
  const ledgerService = {
    resolveSpaceForUser: jest.fn(async () => ({
      coupleId: 'space-1',
      spaceId: 'space-1',
      kind: 'personal',
      participantId: 'participant-1',
      role: 'owner',
    })),
  };

  const service = new CategoryService(
    categoryRepository as never,
    expenseRepository as never,
    ledgerService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects deletion of every protected default category before usage lookup', async () => {
    categoryRepository.findOne.mockResolvedValue({
      id: 'category-food',
      coupleId: 'space-1',
      name: 'Food & Dining',
      isDefault: true,
      deletedAt: null,
    });

    await expect(
      service.deleteCategoryForUser('user-1', 'category-food', 'space-1'),
    ).rejects.toMatchObject({
      response: {
        success: false,
        error: expect.objectContaining({
          code: 'DEFAULT_CATEGORY_PROTECTED',
        }),
      },
    });

    expect(expenseRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(categoryRepository.save).not.toHaveBeenCalled();
  });
});
