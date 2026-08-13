import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryResponse,
  DefaultCategoryResponse,
} from '../dto/category.dto';
import {
  ApiBadRequestException,
  ApiConflictException,
  ApiNotFoundException,
} from '../common/api-error';
import { LedgerService } from './ledger.service';

const HEX_COLOR_REGEX = /^#[0-9A-F]{6}$/i;

type CategoryEntity = InstanceType<typeof Entities.Category>;
type ExpenseEntity = InstanceType<typeof Entities.Expense>;

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Entities.Category)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(Entities.Expense)
    private readonly expenseRepository: Repository<ExpenseEntity>,
    private readonly ledgerService: LedgerService,
  ) {}

  async listCategoriesForUser(
    userId: string,
    spaceId?: string,
  ): Promise<CategoryResponse[]> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      {
        ensureDefaultCategories: true,
        ensureParticipant: true,
      },
    );

    const categories = await this.categoryRepository
      .createQueryBuilder('category')
      .where('category.coupleId = :coupleId', { coupleId })
      .andWhere('category.deletedAt IS NULL')
      .orderBy('category.name', 'ASC')
      .getMany();

    return categories.map((category) => this.mapCategory(category));
  }

  getDefaultCategories(): DefaultCategoryResponse[] {
    return this.ledgerService.getDefaultCategories().map((definition) => ({
      name: definition.name,
      color: definition.color,
      icon: definition.icon ?? null,
    }));
  }

  async createCategoryForUser(
    userId: string,
    payload: CreateCategoryDto,
    spaceId?: string,
  ): Promise<CategoryResponse> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      {
        ensureDefaultCategories: true,
        ensureParticipant: true,
      },
    );

    const normalizedName = payload.name.trim();
    const normalizedColor = payload.color.toUpperCase();

    if (!normalizedName) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Category name is required',
        { field: 'name' },
      );
    }

    if (!HEX_COLOR_REGEX.test(normalizedColor)) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Invalid category payload',
        { field: 'color' },
      );
    }

    if (payload.id) {
      const existingById = await this.categoryRepository.findOne({
        where: { id: payload.id },
        withDeleted: true,
      });
      if (existingById) {
        return this.resolveCreateReplay(
          existingById,
          coupleId,
          normalizedName,
          normalizedColor,
          payload.icon,
        );
      }
    }

    const existing = await this.categoryRepository
      .createQueryBuilder('category')
      .where('category.coupleId = :coupleId', { coupleId })
      .andWhere('category.deletedAt IS NULL')
      .andWhere('LOWER(category.name) = LOWER(:name)', {
        name: normalizedName,
      })
      .getOne();

    if (existing) {
      throw new ApiConflictException(
        'CATEGORY_EXISTS',
        'Category with this name already exists',
        { field: 'name' },
      );
    }

    const category = this.categoryRepository.create();
    if (payload.id) {
      category.id = payload.id;
    }
    category.name = normalizedName;
    category.color = normalizedColor;
    category.icon = payload.icon ?? null;
    category.coupleId = coupleId;
    category.createdBy = userId;
    category.isDefault = false;

    try {
      const saved = await this.categoryRepository.save(category);
      return this.mapCategory(saved);
    } catch (error) {
      if (payload.id && this.isUniqueConstraintViolation(error)) {
        const existingById = await this.categoryRepository.findOne({
          where: { id: payload.id },
          withDeleted: true,
        });
        if (existingById) {
          return this.resolveCreateReplay(
            existingById,
            coupleId,
            normalizedName,
            normalizedColor,
            payload.icon,
          );
        }
      }
      throw error;
    }
  }

  async updateCategoryForUser(
    userId: string,
    categoryId: string,
    payload: UpdateCategoryDto,
    spaceId?: string,
  ): Promise<CategoryResponse> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      {
        ensureDefaultCategories: true,
        ensureParticipant: true,
      },
    );

    const category = await this.categoryRepository.findOne({
      where: { id: categoryId, coupleId },
    });

    if (!category || category.deletedAt) {
      throw new ApiNotFoundException(
        'CATEGORY_NOT_FOUND',
        'Category not found',
      );
    }

    if (payload.name && payload.name.trim() !== category.name) {
      const normalizedName = payload.name.trim();
      if (!normalizedName) {
        throw new ApiBadRequestException(
          'VALIDATION_ERROR',
          'Category name is required',
          { field: 'name' },
        );
      }

      const existing = await this.categoryRepository
        .createQueryBuilder('category')
        .where('category.coupleId = :coupleId', { coupleId })
        .andWhere('category.deletedAt IS NULL')
        .andWhere('category.id != :categoryId', { categoryId: category.id })
        .andWhere('LOWER(category.name) = LOWER(:name)', {
          name: normalizedName,
        })
        .getOne();

      if (existing) {
        throw new ApiConflictException(
          'CATEGORY_EXISTS',
          'Category with this name already exists',
          { field: 'name' },
        );
      }

      category.name = normalizedName;
    }

    if (payload.color) {
      const normalizedColor = payload.color.toUpperCase();
      if (!HEX_COLOR_REGEX.test(normalizedColor)) {
        throw new ApiBadRequestException(
          'VALIDATION_ERROR',
          'Invalid category payload',
          { field: 'color' },
        );
      }
      category.color = normalizedColor;
    }

    if (payload.icon !== undefined) {
      category.icon = payload.icon || null;
    }

    const saved = await this.categoryRepository.save(category);
    return this.mapCategory(saved);
  }

  async deleteCategoryForUser(
    userId: string,
    categoryId: string,
    spaceId?: string,
  ): Promise<void> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      {
        ensureDefaultCategories: true,
        ensureParticipant: true,
      },
    );

    const category = await this.categoryRepository.findOne({
      where: { id: categoryId, coupleId },
    });

    if (!category || category.deletedAt) {
      throw new ApiNotFoundException(
        'CATEGORY_NOT_FOUND',
        'Category not found',
      );
    }

    if (category.isDefault) {
      throw new ApiBadRequestException(
        'DEFAULT_CATEGORY_PROTECTED',
        'Default categories cannot be deleted',
      );
    }

    const expenseCount = await this.expenseRepository
      .createQueryBuilder('expense')
      .where('expense.categoryId = :categoryId', { categoryId: category.id })
      .andWhere('expense.deletedAt IS NULL')
      .getCount();

    if (expenseCount > 0) {
      throw new ApiBadRequestException(
        'CATEGORY_IN_USE',
        'Cannot delete category that is being used by expenses',
      );
    }

    category.deletedAt = new Date();
    await this.categoryRepository.save(category);
  }

  private resolveCreateReplay(
    category: CategoryEntity,
    coupleId: string,
    normalizedName: string,
    normalizedColor: string,
    icon: string | null | undefined,
  ): CategoryResponse {
    const isExactReplay =
      category.coupleId === coupleId &&
      !category.deletedAt &&
      category.isDefault === false &&
      category.name === normalizedName &&
      category.color === normalizedColor &&
      (category.icon ?? null) === (icon ?? null);

    if (!isExactReplay) {
      throw new ApiConflictException(
        'CATEGORY_ID_CONFLICT',
        'Category ID is already in use by a different category',
        { field: 'id' },
      );
    }

    return this.mapCategory(category);
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const candidate = error as { code?: unknown; message?: unknown };
    return (
      candidate.code === '23505' ||
      (typeof candidate.message === 'string' &&
        /duplicate key|unique constraint failed/i.test(candidate.message))
    );
  }

  private mapCategory(category: CategoryEntity): CategoryResponse {
    return {
      id: category.id,
      name: category.name,
      color: category.color,
      icon: category.icon ?? null,
      isDefault: category.isDefault ?? false,
      createdAt: category.createdAt?.toISOString?.()
        ? category.createdAt.toISOString()
        : new Date().toISOString(),
      updatedAt: category.updatedAt?.toISOString?.()
        ? category.updatedAt.toISOString()
        : new Date().toISOString(),
    };
  }
}
