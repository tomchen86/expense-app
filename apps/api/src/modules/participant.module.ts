import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ParticipantController } from '../controllers/participant.controller';
import { ParticipantService } from '../services/participant.service';
import { Entities } from '../entities/runtime-entities';
import { LedgerModule } from './ledger.module';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Entities.Participant, Entities.GroupMember]),
    LedgerModule,
  ],
  controllers: [ParticipantController],
  providers: [ParticipantService, JwtAuthGuard],
  exports: [ParticipantService],
})
export class ParticipantModule {}
