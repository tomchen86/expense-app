import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserSimple } from './user-simple.entity';
import { CoupleKind, CoupleStatus, SpaceSyncPolicy } from './couple.entity';

@Entity('couples')
@Index('UQ_couples_active_personal_creator', ['createdBy'], {
  unique: true,
  where: '"kind" = \'personal\' AND "status" = \'active\'',
})
@Check('CHK_couples_status', "status IN ('active','pending','archived')")
@Check('CHK_couples_kind', "kind IN ('personal','shared')")
@Check('CHK_couples_sync_policy', "sync_policy IN ('local_only','cloud_sync')")
@Check(
  'CHK_couples_shared_cloud_sync',
  "kind <> 'shared' OR sync_policy = 'cloud_sync'",
)
export class CoupleSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100, nullable: true })
  name?: string;

  @Column({ name: 'invite_code', length: 10, unique: true })
  inviteCode: string;

  @Column({ length: 20, default: 'active' })
  status: CoupleStatus;

  @Column({ length: 20, default: 'personal' })
  kind: CoupleKind;

  @Column({ name: 'sync_policy', length: 20, default: 'local_only' })
  syncPolicy: SpaceSyncPolicy;

  @Column({ name: 'created_by' })
  createdBy: string;

  @ManyToOne(() => UserSimple)
  @JoinColumn({ name: 'created_by' })
  creator?: UserSimple;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
