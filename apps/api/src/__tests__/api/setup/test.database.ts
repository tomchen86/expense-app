import { TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { User } from '../../entities/user.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { Category } from '../../entities/category.entity';
import { Expense } from '../../entities/expense.entity';
import { ExpenseSplit } from '../../entities/expense-split.entity';

export const createTestModule = async (entities: (new () => any)[] = []) => {
  const module: TestingModule = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'sqlite',
        database: ':memory:',
        entities: [
          User,
          UserSettings,
          Category,
          Expense,
          ExpenseSplit,
          ...entities,
        ],
        synchronize: true,
        logging: false,
      }),
    ],
  }).compile();

  return module;
};

export const resetTestDatabase = async (dataSource: DataSource) => {
  const entities = dataSource.entityMetadatas;
  for (const entity of entities) {
    const repository = dataSource.getRepository(entity.name);
    await repository.query(`DELETE FROM ${entity.tableName}`);
  }
};
