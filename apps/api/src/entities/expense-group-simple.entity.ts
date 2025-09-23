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
import { CoupleSimple } from './couple-simple.entity';
import { UserSimple } from './user-simple.entity';

@Entity('expense_groups')
@Check('CHK_expense_groups_color', "color IS NULL OR color LIKE '#______'")
@Check(
  'CHK_expense_groups_currency',
  'default_currency IS NULL OR length(default_currency) = 3',
)
export class ExpenseGroupSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'text' })
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

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @ManyToOne(() => CoupleSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: CoupleSimple;

  @ManyToOne(() => UserSimple)
  @JoinColumn({ name: 'created_by' })
  creator?: UserSimple;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;
}
