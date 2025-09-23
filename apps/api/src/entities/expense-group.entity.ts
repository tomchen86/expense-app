import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Couple } from './couple.entity';
import { User } from './user.entity';

@Entity('expense_groups')
@Check(
  'CHK_expense_groups_color',
  "color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'",
)
@Check(
  'CHK_expense_groups_currency',
  "default_currency IS NULL OR default_currency ~ '^[A-Z]{3}$'",
)
export class ExpenseGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'uuid' })
  coupleId: string;

  @Column({ length: 100 })
  name: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ length: 7, nullable: true })
  color?: string;

  @Column({ name: 'default_currency', length: 3, nullable: true })
  defaultCurrency?: string;

  @Column({ name: 'is_archived', default: false })
  isArchived: boolean;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy: string;

  @ManyToOne(() => Couple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: Couple;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by' })
  creator?: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
