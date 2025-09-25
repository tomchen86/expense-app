import { Category } from './category.entity';
import { CategorySimple } from './category-simple.entity';
import { CoupleInvitation } from './couple-invitation.entity';
import { CoupleInvitationSimple } from './couple-invitation-simple.entity';
import { CoupleMember } from './couple-member.entity';
import { CoupleMemberSimple } from './couple-member-simple.entity';
import { Couple } from './couple.entity';
import { CoupleSimple } from './couple-simple.entity';
import { ExpenseAttachment } from './expense-attachment.entity';
import { ExpenseAttachmentSimple } from './expense-attachment-simple.entity';
import { ExpenseGroup } from './expense-group.entity';
import { ExpenseGroupSimple } from './expense-group-simple.entity';
import { ExpenseSplit } from './expense-split.entity';
import { ExpenseSplitSimple } from './expense-split-simple.entity';
import { Expense } from './expense.entity';
import { ExpenseSimple } from './expense-simple.entity';
import { GroupMember } from './group-member.entity';
import { GroupMemberSimple } from './group-member-simple.entity';
import { Participant } from './participant.entity';
import { ParticipantSimple } from './participant-simple.entity';
import { UserAuthIdentity } from './user-auth-identity.entity';
import { UserAuthIdentitySimple } from './user-auth-identity-simple.entity';
import { UserDevice } from './user-device.entity';
import { UserDeviceSimple } from './user-device-simple.entity';
import { UserSettings } from './user-settings.entity';
import { UserSettingsSimple } from './user-settings-simple.entity';
import { User } from './user.entity';
import { UserSimple } from './user-simple.entity';

export type EntityCollection = {
  Category: typeof Category;
  CoupleInvitation: typeof CoupleInvitation;
  CoupleMember: typeof CoupleMember;
  Couple: typeof Couple;
  ExpenseAttachment: typeof ExpenseAttachment;
  ExpenseGroup: typeof ExpenseGroup;
  ExpenseSplit: typeof ExpenseSplit;
  Expense: typeof Expense;
  GroupMember: typeof GroupMember;
  Participant: typeof Participant;
  UserAuthIdentity: typeof UserAuthIdentity;
  UserDevice: typeof UserDevice;
  UserSettings: typeof UserSettings;
  User: typeof User;
};

const postgresCollection: EntityCollection = {
  Category,
  CoupleInvitation,
  CoupleMember,
  Couple,
  ExpenseAttachment,
  ExpenseGroup,
  ExpenseSplit,
  Expense,
  GroupMember,
  Participant,
  UserAuthIdentity,
  UserDevice,
  UserSettings,
  User,
};

const simpleCollection: EntityCollection = {
  Category: CategorySimple as unknown as typeof Category,
  CoupleInvitation:
    CoupleInvitationSimple as unknown as typeof CoupleInvitation,
  CoupleMember: CoupleMemberSimple as unknown as typeof CoupleMember,
  Couple: CoupleSimple as unknown as typeof Couple,
  ExpenseAttachment:
    ExpenseAttachmentSimple as unknown as typeof ExpenseAttachment,
  ExpenseGroup: ExpenseGroupSimple as unknown as typeof ExpenseGroup,
  ExpenseSplit: ExpenseSplitSimple as unknown as typeof ExpenseSplit,
  Expense: ExpenseSimple as unknown as typeof Expense,
  GroupMember: GroupMemberSimple as unknown as typeof GroupMember,
  Participant: ParticipantSimple as unknown as typeof Participant,
  UserAuthIdentity:
    UserAuthIdentitySimple as unknown as typeof UserAuthIdentity,
  UserDevice: UserDeviceSimple as unknown as typeof UserDevice,
  UserSettings: UserSettingsSimple as unknown as typeof UserSettings,
  User: UserSimple as unknown as typeof User,
};

export const getEntityCollection = (
  driver: 'postgres' | 'sqlite' | 'sqljs',
): EntityCollection =>
  driver === 'postgres' ? postgresCollection : simpleCollection;

export const getEntityArray = (driver: 'postgres' | 'sqlite' | 'sqljs') =>
  Object.values(getEntityCollection(driver));
