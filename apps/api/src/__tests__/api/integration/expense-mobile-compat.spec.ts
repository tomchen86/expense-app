process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqljs';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SuperTest, Test as SuperTestRequest } from 'supertest';
const supertest = require('supertest');
import { AppModule } from '../../../app.module';
import { PerformanceAssertions } from '../../helpers/performance-assertions';

const PASSWORD = 'TestPassword123!';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('Expense API - Mobile Compatibility', () => {
  let app: INestApplication;
  let httpServer: any;
  let api: SuperTest<SuperTestRequest>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    httpServer = app.getHttpAdapter().getInstance();
    api = supertest(httpServer);
  });

  afterAll(async () => {
    await app.close();
  });

  const registerMobileUser = async (
    overrides: { email?: string; displayName?: string } = {},
  ) => {
    const email = overrides.email ?? uniqueEmail('expense-user');
    const displayName = overrides.displayName ?? 'Expense Test User';

    const response = await api
      .post('/auth/register')
      .send({
        email,
        password: PASSWORD,
        displayName,
      })
      .expect(201);

    return {
      email,
      displayName,
      userId: response.body.data.user.id,
      accessToken: response.body.data.accessToken,
    };
  };

  const createParticipant = async (
    accessToken: string,
    name: string,
  ): Promise<string> => {
    const response = await api
      .post('/api/participants')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name })
      .expect(201);

    return response.body.data.participant.id;
  };

  const fetchSelfParticipant = async (
    accessToken: string,
  ): Promise<{ id: string; name: string }> => {
    const response = await api
      .get('/api/participants')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const [participant] = response.body.data.participants;
    return participant;
  };

  const fetchDefaultCategory = async (accessToken: string): Promise<string> => {
    const response = await api
      .get('/api/categories')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const [firstCategory] = response.body.data.categories;
    return firstCategory.id;
  };

  describe('Expense lifecycle', () => {
    it('should create, fetch, update, list, and delete expenses with splits', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);
      const partnerParticipantId = await createParticipant(
        accessToken,
        'Partner Participant',
      );
      const categoryId = await fetchDefaultCategory(accessToken);

      const createPayload = {
        description: 'Weekend Groceries',
        amount_cents: 12500,
        currency: 'USD',
        expense_date: '2025-09-15',
        category_id: categoryId,
        paid_by_participant_id: selfParticipant.id,
        split_type: 'custom',
        splits: [
          { participant_id: selfParticipant.id, share_cents: 6250 },
          { participant_id: partnerParticipantId, share_cents: 6250 },
        ],
        notes: 'Receipt in shared folder',
        location: 'Local Market',
      };

      const { response: createResponse, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'POST /api/expenses',
          () =>
            api
              .post('/api/expenses')
              .set('Authorization', `Bearer ${accessToken}`)
              .send(createPayload)
              .expect(201),
        );

      expect(metrics).toBeFastOperation();

      const createdExpenseId = createResponse.body.data.expense.id;
      expect(createResponse.body).toEqual({
        success: true,
        data: {
          expense: expect.objectContaining({
            id: createdExpenseId,
            description: 'Weekend Groceries',
            amount_cents: 12500,
            currency: 'USD',
            expense_date: '2025-09-15',
            split_type: 'custom',
            notes: 'Receipt in shared folder',
            location: 'Local Market',
            splits: expect.arrayContaining([
              expect.objectContaining({
                participant_id: selfParticipant.id,
                share_cents: 6250,
              }),
              expect.objectContaining({
                participant_id: partnerParticipantId,
                share_cents: 6250,
              }),
            ]),
          }),
        },
      });

      const getResponse = await api
        .get(`/api/expenses/${createdExpenseId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(getResponse.body.data.expense.id).toBe(createdExpenseId);
      expect(getResponse.body.data.expense.splits).toHaveLength(2);

      const listResponse = await api
        .get('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ limit: 10 })
        .expect(200);

      expect(listResponse.body).toEqual({
        success: true,
        data: {
          expenses: expect.arrayContaining([
            expect.objectContaining({ id: createdExpenseId }),
          ]),
          pagination: expect.objectContaining({
            page: 1,
            limit: 10,
            total: 1,
            hasMore: false,
          }),
        },
      });

      const statsResponse = await api
        .get('/api/expenses/statistics')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ category_id: categoryId })
        .expect(200);

      expect(statsResponse.body).toEqual({
        success: true,
        data: {
          statistics: {
            total_spent_cents: 12500,
            total_transactions: 1,
            totals_by_category: [
              {
                category_id: categoryId,
                amount_cents: 12500,
              },
            ],
            totals_by_participant: [
              {
                participant_id: selfParticipant.id,
                amount_cents: 12500,
              },
            ],
          },
        },
      });

      const updatePayload = {
        amount_cents: 15000,
        splits: [
          { participant_id: selfParticipant.id, share_cents: 5000 },
          { participant_id: partnerParticipantId, share_cents: 10000 },
        ],
        notes: 'Updated split after review',
        exchange_rate: 1,
      };

      const updateResponse = await api
        .put(`/api/expenses/${createdExpenseId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(updatePayload)
        .expect(200);

      expect(updateResponse.body.data.expense).toEqual(
        expect.objectContaining({
          id: createdExpenseId,
          amount_cents: 15000,
          exchange_rate: 1,
          splits: expect.arrayContaining([
            expect.objectContaining({
              participant_id: selfParticipant.id,
              share_cents: 5000,
            }),
            expect.objectContaining({
              participant_id: partnerParticipantId,
              share_cents: 10000,
            }),
          ]),
          notes: 'Updated split after review',
        }),
      );

      await api
        .delete(`/api/expenses/${createdExpenseId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const deletedLookup = await api
        .get(`/api/expenses/${createdExpenseId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(deletedLookup.body).toEqual({
        success: false,
        error: {
          code: 'EXPENSE_NOT_FOUND',
          message: 'Expense not found',
        },
      });
    });
  });

  describe('Validation', () => {
    it('should reject expenses when splits do not sum to amount', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);
      const categoryId = await fetchDefaultCategory(accessToken);

      const response = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          description: 'Invalid Split Expense',
          amount_cents: 5000,
          currency: 'USD',
          expense_date: '2025-09-20',
          category_id: categoryId,
          paid_by_participant_id: selfParticipant.id,
          split_type: 'custom',
          splits: [{ participant_id: selfParticipant.id, share_cents: 3000 }],
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_SPLIT_TOTAL',
          message: 'Split shares must add up to the total amount',
          field: 'splits',
        },
      });
    });
  });
});
