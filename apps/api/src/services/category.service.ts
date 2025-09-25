import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from '../entities/category.entity';
import { Expense } from '../entities/expense.entity';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryResponseDto,
} from '../dto/category.dto';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private categoryRepository: Repository<Category>,
    @InjectRepository(Expense)
    private expenseRepository: Repository<Expense>,
  ) {}

  async findAll(coupleId: string): Promise<CategoryResponseDto[]> {
    const categories = await this.categoryRepository.find({
      where: {
        couple_id: coupleId,
        deleted_at: null,
      },
      order: { created_at: 'DESC' },
    });

    return categories.map(this.toResponseDto);
  }

  async findById(id: string, coupleId: string): Promise<CategoryResponseDto> {
    const category = await this.categoryRepository.findOne({
      where: {
        id,
        couple_id: coupleId,
        deleted_at: null,
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return this.toResponseDto(category);
  }

  async create(
    createCategoryDto: CreateCategoryDto,
    coupleId: string,
    createdBy: string,
  ): Promise<CategoryResponseDto> {
    // Check if category name already exists for this couple
    const existingCategory = await this.categoryRepository.findOne({
      where: {
        couple_id: coupleId,
        name: createCategoryDto.name,
        deleted_at: null,
      },
    });

    if (existingCategory) {
      throw new ConflictException('Category with this name already exists');
    }

    const category = this.categoryRepository.create({
      ...createCategoryDto,
      couple_id: coupleId,
      created_by: createdBy,
    });

    const savedCategory = await this.categoryRepository.save(category);
    return this.toResponseDto(savedCategory);
  }

  async update(
    id: string,
    updateCategoryDto: UpdateCategoryDto,
    coupleId: string,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoryRepository.findOne({
      where: {
        id,
        couple_id: coupleId,
        deleted_at: null,
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Check if new name conflicts with existing category
    if (updateCategoryDto.name && updateCategoryDto.name !== category.name) {
      const existingCategory = await this.categoryRepository.findOne({
        where: {
          couple_id: coupleId,
          name: updateCategoryDto.name,
          deleted_at: null,
        },
      });

      if (existingCategory && existingCategory.id !== id) {
        throw new ConflictException('Category with this name already exists');
      }
    }

    await this.categoryRepository.update(id, updateCategoryDto);
    const updatedCategory = await this.categoryRepository.findOne({
      where: { id },
    });

    return this.toResponseDto(updatedCategory!);
  }

  async delete(id: string, coupleId: string): Promise<void> {
    const category = await this.categoryRepository.findOne({
      where: {
        id,
        couple_id: coupleId,
        deleted_at: null,
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Check if category is being used by any expenses
    const expenseCount = await this.expenseRepository.count({
      where: {
        category_id: id,
        deleted_at: null,
      },
    });

    if (expenseCount > 0) {
      throw new BadRequestException(
        'Cannot delete category that is being used by expenses',
      );
    }

    // Soft delete the category
    await this.categoryRepository.update(id, {
      deleted_at: new Date(),
    });
  }

  async getDefaultCategories(): Promise<CategoryResponseDto[]> {
    const defaultCategories = await this.categoryRepository.find({
      where: { is_default: true },
      order: { name: 'ASC' },
    });

    return defaultCategories.map(this.toResponseDto);
  }

  async createDefaultCategoriesForCouple(
    coupleId: string,
    createdBy: string,
  ): Promise<void> {
    const defaultCategories = [
      { name: 'Food & Dining', color: '#FF5722', icon: 'restaurant' },
      { name: 'Transportation', color: '#2196F3', icon: 'directions-car' },
      { name: 'Shopping', color: '#9C27B0', icon: 'shopping-cart' },
      { name: 'Entertainment', color: '#FF9800', icon: 'movie' },
      { name: 'Bills & Utilities', color: '#F44336', icon: 'receipt' },
      { name: 'Healthcare', color: '#4CAF50', icon: 'local-hospital' },
      { name: 'Travel', color: '#00BCD4', icon: 'flight' },
      { name: 'Other', color: '#607D8B', icon: 'category' },
    ];

    const categories = defaultCategories.map((cat) =>
      this.categoryRepository.create({
        ...cat,
        couple_id: coupleId,
        created_by: createdBy,
        is_default: false, // These are couple-specific, not global defaults
      }),
    );

    await this.categoryRepository.save(categories);
  }

  private toResponseDto(category: Category): CategoryResponseDto {
    return {
      id: category.id,
      couple_id: category.couple_id,
      name: category.name,
      color: category.color,
      icon: category.icon,
      is_default: category.is_default,
      created_by: category.created_by,
      created_at: category.created_at,
      updated_at: category.updated_at,
    };
  }
}
