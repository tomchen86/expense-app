import { projectExpenseForParticipant } from '../../services/personal-ledger-projection';

describe('personal ledger projection', () => {
  it('separates what the user paid from what the user spent', () => {
    const projected = projectExpenseForParticipant(
      {
        id: 'expense-1',
        spaceId: 'trip-1',
        amountMinor: '10000',
        currency: 'AUD',
        payerParticipantId: 'me',
        shares: [
          { participantId: 'me', amountMinor: '2000' },
          { participantId: 'friend', amountMinor: '8000' },
        ],
      },
      'me',
    );

    expect(projected).toEqual({
      expenseId: 'expense-1',
      myPaidMinor: '10000',
      mySpentMinor: '2000',
      myBalanceMinor: '8000',
      currency: 'AUD',
    });
  });

  it('includes consumption paid by somebody else', () => {
    const projected = projectExpenseForParticipant(
      {
        id: 'expense-2',
        spaceId: 'trip-1',
        amountMinor: '10000',
        currency: 'AUD',
        payerParticipantId: 'friend',
        shares: [{ participantId: 'me', amountMinor: '2000' }],
      },
      'me',
    );

    expect(projected).toMatchObject({
      myPaidMinor: '0',
      mySpentMinor: '2000',
      myBalanceMinor: '-2000',
    });
  });

  it('omits an unrelated expense', () => {
    expect(
      projectExpenseForParticipant(
        {
          id: 'expense-3',
          spaceId: 'trip-1',
          amountMinor: '10000',
          currency: 'AUD',
          payerParticipantId: 'friend',
          shares: [{ participantId: 'other', amountMinor: '10000' }],
        },
        'me',
      ),
    ).toBeNull();
  });

  it('keeps an unallocated personal-space expense in the base ledger', () => {
    expect(
      projectExpenseForParticipant(
        {
          id: 'expense-personal',
          spaceId: 'personal-1',
          amountMinor: '4200',
          currency: 'AUD',
          payerParticipantId: 'guest',
          shares: [{ participantId: 'guest', amountMinor: '4200' }],
        },
        'me',
        { includeWhenUnallocated: true },
      ),
    ).toEqual({
      expenseId: 'expense-personal',
      myPaidMinor: '0',
      mySpentMinor: '0',
      myBalanceMinor: '0',
      currency: 'AUD',
    });
  });
});
