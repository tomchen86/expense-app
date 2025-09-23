import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserSimple } from './user-simple.entity';
import { CoupleStatus } from './couple.entity';

@Entity('couples')
@Check('CHK_couples_status', "status IN ('active','pending','archived')")
export class CoupleSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100, nullable: true })
  name?: string;

  @Column({ name: 'invite_code', length: 10, unique: true })
  inviteCode: string;

  @Column({ length: 20, default: 'active' })
  status: CoupleStatus;

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
