import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CategoryController } from '../controllers/category.controller';
import { CategoryService } from '../services/category.service';
import { Entities } from '../entities/runtime-entities';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { LedgerModule } from './ledger.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Entities.Category, Entities.Expense]),
    LedgerModule,
  ],
  controllers: [CategoryController],
  providers: [CategoryService, JwtAuthGuard],
  exports: [CategoryService],
})
export class CategoryModule {}
