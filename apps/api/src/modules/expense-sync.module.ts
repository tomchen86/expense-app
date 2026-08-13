import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExpenseSyncController } from '../controllers/expense-sync.controller';
import { Entities } from '../entities/runtime-entities';
import { ExpenseSyncService } from '../services/expense-sync.service';
import { LedgerModule } from './ledger.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Entities.Expense, Entities.ExpenseSplit]),
    LedgerModule,
  ],
  controllers: [ExpenseSyncController],
  providers: [ExpenseSyncService],
})
export class ExpenseSyncModule {}
