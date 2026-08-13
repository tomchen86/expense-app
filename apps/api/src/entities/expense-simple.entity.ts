import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { CoupleSimple } from './couple-simple.entity';
import { ExpenseGroupSimple } from './expense-group-simple.entity';
import { CategorySimple } from './category-simple.entity';
import { ParticipantSimple } from './participant-simple.entity';
import { UserSimple } from './user-simple.entity';
import { ExpenseSplitType } from './expense.entity';

@Entity('expenses')
@Unique('UQ_expenses_id_couple', ['id', 'coupleId'])
@Index('IDX_expenses_couple_updated_id', ['coupleId', 'updatedAt', 'id'])
@Index(
  'UQ_expenses_couple_client_mutation_id',
  ['coupleId', 'clientMutationId'],
  {
    unique: true,
    where: '"client_mutation_id" IS NOT NULL',
  },
)
@Check(
  'CHK_expenses_amount_positive',
  'amount_cents > 0 AND amount_cents <= 9007199254740991',
)
@Check('CHK_expenses_currency', 'length(currency) = 3')
@Check('CHK_expenses_version_positive', 'version > 0')
@Check(
  'CHK_expenses_split_type',
  "split_type IN ('equal','custom','percentage')",
)
export class ExpenseSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'client_mutation_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  clientMutationId?: string;

  @Column({ name: 'couple_id', type: 'text' })
  coupleId: string;

  @Column({ name: 'group_id', type: 'text', nullable: true })
  groupId?: string;

  @Column({ name: 'category_id', type: 'text', nullable: true })
  categoryId?: string;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Column({ name: 'paid_by_participant_id', type: 'text', nullable: true })
  paidByParticipantId?: string;

  @Column({ name: 'description', length: 200 })
  description: string;

  @Column({ name: 'amount_cents', type: 'integer' })
  amountCents: number;

  @Column({ length: 3, default: 'USD' })
  currency: string;

  @Column({ name: 'exchange_rate', type: 'real', nullable: true })
  exchangeRate?: number;

  @Column({ name: 'expense_date', type: 'text' })
  expenseDate: string;

  @Column({ name: 'split_type', length: 20, default: 'equal' })
  splitType: ExpenseSplitType;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ name: 'receipt_url', nullable: true })
  receiptUrl?: string;

  @Column({ nullable: true, length: 200 })
  location?: string;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @VersionColumn({ type: 'integer', default: 1 })
  version: number;

  @ManyToOne(() => CoupleSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: CoupleSimple;

  @ManyToOne(() => ExpenseGroupSimple, {
    nullable: true,
    onDelete: 'NO ACTION',
  })
  @JoinColumn([
    {
      name: 'group_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_expenses_group_couple',
    },
    { name: 'couple_id', referencedColumnName: 'coupleId' },
  ])
  group?: ExpenseGroupSimple;

  @ManyToOne(() => CategorySimple, { nullable: true, onDelete: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'category_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_expenses_category_couple',
    },
    { name: 'couple_id', referencedColumnName: 'coupleId' },
  ])
  category?: CategorySimple;

  @ManyToOne(() => ParticipantSimple, {
    nullable: true,
    onDelete: 'NO ACTION',
  })
  @JoinColumn([
    {
      name: 'paid_by_participant_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_expenses_payer_couple',
    },
    { name: 'couple_id', referencedColumnName: 'coupleId' },
  ])
  payer?: ParticipantSimple;

  @ManyToOne(() => UserSimple)
  @JoinColumn({ name: 'created_by' })
  creator?: UserSimple;
}
