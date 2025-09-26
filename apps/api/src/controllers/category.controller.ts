import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CategoryService } from '../services/category.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryResponse,
  DefaultCategoryResponse,
} from '../dto/category.dto';
import { ApiBadRequestException } from '../common/api-error';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
  };
}

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
}

@Controller('api/categories')
@UseGuards(JwtAuthGuard)
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  async listCategories(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<{ categories: CategoryResponse[] }>> {
    const categories = await this.categoryService.listCategoriesForUser(
      req.user.id,
    );

    return {
      success: true,
      data: {
        categories,
      },
    };
  }

  @Get('default')
  async getDefaultCategories(): Promise<
    ApiResponse<{ categories: DefaultCategoryResponse[] }>
  > {
    const categories = await this.categoryService.getDefaultCategories();

    return {
      success: true,
      data: {
        categories,
      },
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createCategory(
    @Req() req: AuthenticatedRequest,
    @Body() body: any,
  ): Promise<ApiResponse<{ category: CategoryResponse }>> {
    const dto = this.validateDto(CreateCategoryDto, body, {
      messageOverride: 'Invalid category payload',
    });

    const category = await this.categoryService.createCategoryForUser(
      req.user.id,
      dto,
    );

    return {
      success: true,
      data: {
        category,
      },
    };
  }

  @Put(':categoryId')
  async updateCategory(
    @Req() req: AuthenticatedRequest,
    @Param('categoryId') categoryId: string,
    @Body() body: any,
  ): Promise<ApiResponse<{ category: CategoryResponse }>> {
    const dto = this.validateDto(UpdateCategoryDto, body, {
      skipMissingProperties: true,
      messageOverride: 'Invalid category payload',
    });

    const category = await this.categoryService.updateCategoryForUser(
      req.user.id,
      categoryId,
      dto,
    );

    return {
      success: true,
      data: {
        category,
      },
    };
  }

  @Delete(':categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCategory(
    @Req() req: AuthenticatedRequest,
    @Param('categoryId') categoryId: string,
  ): Promise<void> {
    await this.categoryService.deleteCategoryForUser(req.user.id, categoryId);
  }

  private validateDto<T>(
    cls: new () => T,
    payload: any,
    options: {
      skipMissingProperties?: boolean;
      messageOverride?: string;
    } = {},
  ): T {
    const instance = plainToInstance(cls, payload);
    const errors = validateSync(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
      skipMissingProperties: options.skipMissingProperties ?? false,
    });

    if (errors.length > 0) {
      const primaryError = errors[0];
      const constraintMessage = primaryError.constraints
        ? Object.values(primaryError.constraints)[0]
        : 'Invalid payload';

      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        options.messageOverride ?? constraintMessage,
        { field: primaryError.property },
      );
    }

    return instance;
  }
}
