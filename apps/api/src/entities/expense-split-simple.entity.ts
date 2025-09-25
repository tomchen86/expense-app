import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { ExpenseSimple } from './expense-simple.entity';
import { ParticipantSimple } from './participant-simple.entity';

@Entity('expense_splits')
@Unique('UQ_expense_splits_expense_participant', ['expenseId', 'participantId'])
@Check('CHK_expense_splits_share_cents', 'share_cents >= 0')
@Check(
  'CHK_expense_splits_share_percent',
  'share_percent IS NULL OR (share_percent >= 0 AND share_percent <= 100)',
)
export class ExpenseSplitSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'expense_id', type: 'text' })
  expenseId: string;

  @Column({ name: 'participant_id', type: 'text' })
  participantId: string;

  @Column({ name: 'share_cents', type: 'integer' })
  shareCents: number;

  @Column({ name: 'share_percent', type: 'real', nullable: true })
  sharePercent?: number;

  @Column({ name: 'settled_at', nullable: true })
  settledAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => ExpenseSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'expense_id' })
  expense?: ExpenseSimple;

  @ManyToOne(() => ParticipantSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'participant_id' })
  participant?: ParticipantSimple;
}
