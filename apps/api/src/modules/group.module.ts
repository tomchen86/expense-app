import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GroupController } from '../controllers/group.controller';
import { GroupService } from '../services/group.service';
import { Entities } from '../entities/runtime-entities';
import { LedgerModule } from './ledger.module';
import { ParticipantModule } from './participant.module';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Entities.ExpenseGroup,
      Entities.GroupMember,
      Entities.Participant,
    ]),
    LedgerModule,
    ParticipantModule,
  ],
  controllers: [GroupController],
  providers: [GroupService, JwtAuthGuard],
})
export class GroupModule {}
