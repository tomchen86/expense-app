import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ObjectLiteral, Repository } from 'typeorm';
import { ApiConflictException } from '../../common/api-error';
import { CreateCategoryDto } from '../../dto/category.dto';
import { Entities } from '../../entities/runtime-entities';
import { CategoryService } from '../../services/category.service';
import { LedgerService } from '../../services/ledger.service';

type QueryBuilderMock = {
  where: jest.Mock;
  andWhere: jest.Mock;
  getOne: jest.Mock;
};

type RepositoryMock = {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

const repositoryMock = (): RepositoryMock => {
  const queryBuilder: QueryBuilderMock = {
    where: jest.fn(),
    andWhere: jest.fn(),
    getOne: jest.fn(),
  };
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  queryBuilder.getOne.mockResolvedValue(null);

  return {
    findOne: jest.fn(),
    create: jest.fn(() => ({})),
    save: jest.fn(async (value) => value),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
};

const asRepository = <T extends ObjectLiteral>(
  value: RepositoryMock,
): Repository<T> => value as unknown as Repository<T>;

describe('Category client identity', () => {
  const categoryRepository = repositoryMock();
  const expenseRepository = repositoryMock();
  const ledgerService = {
    resolveSpaceForUser: jest.fn(),
  } as unknown as LedgerService;
  const service = new CategoryService(
    asRepository<InstanceType<typeof Entities.Category>>(categoryRepository),
    asRepository<InstanceType<typeof Entities.Expense>>(expenseRepository),
    ledgerService,
  );
  const categoryId = 'f3af3622-e6b6-4a70-8cf6-a81b8fa675a5';

  const existingCategory = (overrides: Record<string, unknown> = {}) => ({
    id: categoryId,
    coupleId: 'space-1',
    name: 'Dining',
    color: '#FFAA00',
    icon: 'restaurant',
    isDefault: false,
    deletedAt: undefined,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    categoryRepository.findOne.mockResolvedValue(null);
    categoryRepository.save.mockImplementation(async (value) => value);
    const queryBuilder = categoryRepository.createQueryBuilder();
    queryBuilder.getOne.mockResolvedValue(null);
    (ledgerService.resolveSpaceForUser as jest.Mock).mockResolvedValue({
      coupleId: 'space-1',
    });
  });

  it('accepts only an optional client-generated UUIDv4 ID', () => {
    const valid = plainToInstance(CreateCategoryDto, {
      id: categoryId,
      name: 'Dining',
      color: '#FFAA00',
    });
    const invalid = plainToInstance(CreateCategoryDto, {
      id: 'category-local-1',
      name: 'Dining',
      color: '#FFAA00',
    });

    expect(validateSync(valid)).toHaveLength(0);
    expect(validateSync(invalid)).toEqual([
      expect.objectContaining({ property: 'id' }),
    ]);
  });

  it('preserves a new client-generated category ID', async () => {
    await service.createCategoryForUser(
      'user-1',
      {
        id: categoryId,
        name: ' Dining ',
        color: '#ffaa00',
        icon: 'restaurant',
      } as CreateCategoryDto,
      'space-1',
    );

    expect(categoryRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: categoryId,
        coupleId: 'space-1',
        name: 'Dining',
        color: '#FFAA00',
        icon: 'restaurant',
      }),
    );
  });

  it('returns an exact same-space retry without inserting again', async () => {
    categoryRepository.findOne.mockResolvedValue(existingCategory());

    await expect(
      service.createCategoryForUser(
        'user-1',
        {
          id: categoryId,
          name: ' Dining ',
          color: '#ffaa00',
          icon: 'restaurant',
        } as CreateCategoryDto,
        'space-1',
      ),
    ).resolves.toEqual(expect.objectContaining({ id: categoryId }));
    expect(categoryRepository.save).not.toHaveBeenCalled();
  });

  it.each([
    ['another space', { coupleId: 'space-2' }],
    ['a soft-deleted row', { deletedAt: new Date('2025-01-01') }],
    ['a default category', { isDefault: true }],
    ['different payload', { color: '#000000' }],
  ])('conflicts when the client ID refers to %s', async (_label, overrides) => {
    categoryRepository.findOne.mockResolvedValue(existingCategory(overrides));

    await expect(
      service.createCategoryForUser(
        'user-1',
        {
          id: categoryId,
          name: 'Dining',
          color: '#FFAA00',
          icon: 'restaurant',
        } as CreateCategoryDto,
        'space-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: 'CATEGORY_ID_CONFLICT' }),
      }),
    });
    expect(categoryRepository.save).not.toHaveBeenCalled();
  });

  it('converges on the existing category after a concurrent ID insert', async () => {
    categoryRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingCategory());
    categoryRepository.save.mockRejectedValueOnce({ code: '23505' });

    await expect(
      service.createCategoryForUser(
        'user-1',
        {
          id: categoryId,
          name: 'Dining',
          color: '#FFAA00',
          icon: 'restaurant',
        } as CreateCategoryDto,
        'space-1',
      ),
    ).resolves.toEqual(expect.objectContaining({ id: categoryId }));
  });

  it('conflicts after a concurrent ID insert with different payload', async () => {
    categoryRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingCategory({ icon: 'takeaway' }));
    categoryRepository.save.mockRejectedValueOnce({ code: '23505' });

    await expect(
      service.createCategoryForUser(
        'user-1',
        {
          id: categoryId,
          name: 'Dining',
          color: '#FFAA00',
          icon: 'restaurant',
        } as CreateCategoryDto,
        'space-1',
      ),
    ).rejects.toBeInstanceOf(ApiConflictException);
  });
});
