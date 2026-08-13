process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqljs';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import * as http from 'http';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { PerformanceAssertions } from '../../helpers/performance-assertions';
import { Entities } from '../../../entities/runtime-entities';

const PASSWORD = 'TestPassword123!';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
  };
}

describe('Expense API - Mobile Compatibility', () => {
  let app: INestApplication;
  let httpServer: http.Server;
  let api: ReturnType<typeof supertest>;

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

    const body = response.body as ApiResponse<{
      user: { id: string };
      accessToken: string;
    }>;
    if (!body.success || !body.data) {
      throw new Error('Failed to register user');
    }

    return {
      email,
      displayName,
      userId: body.data.user.id,
      accessToken: body.data.accessToken,
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

    const body = response.body as ApiResponse<{ participant: { id: string } }>;
    if (!body.success || !body.data) {
      throw new Error('Failed to create participant');
    }
    return body.data.participant.id;
  };

  const fetchSelfParticipant = async (
    accessToken: string,
  ): Promise<{ id: string; name: string }> => {
    const response = await api
      .get('/api/participants')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const body = response.body as ApiResponse<{
      participants: { id: string; name: string }[];
    }>;
    if (!body.success || !body.data) {
      throw new Error('Failed to fetch participants');
    }
    const [participant] = body.data.participants;
    return participant;
  };

  const fetchDefaultCategory = async (accessToken: string): Promise<string> => {
    const response = await api
      .get('/api/categories')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const body = response.body as ApiResponse<{ categories: { id: string }[] }>;
    if (!body.success || !body.data) {
      throw new Error('Failed to fetch categories');
    }
    const [firstCategory] = body.data.categories;
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

      const createBody = createResponse.body as ApiResponse<{
        expense: { id: string; version: number };
      }>;
      if (!createBody.success || !createBody.data) {
        throw new Error('Failed to create expense');
      }
      const createdExpenseId = createBody.data.expense.id;
      expect(createBody).toEqual({
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

      const getBody = getResponse.body as ApiResponse<{
        expense: { id: string; splits: any[] };
      }>;
      if (getBody.success && getBody.data) {
        expect(getBody.data.expense.id).toBe(createdExpenseId);
        expect(getBody.data.expense.splits).toHaveLength(2);
      }

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
            total_transactions: 1,
            totals_by_currency: [
              {
                currency: 'USD',
                amount_cents: '12500',
              },
            ],
            totals_by_category: [
              {
                category_id: categoryId,
                currency: 'USD',
                amount_cents: '12500',
              },
            ],
            totals_by_participant: [
              {
                participant_id: selfParticipant.id,
                currency: 'USD',
                amount_cents: '12500',
              },
            ],
          },
        },
      });

      const updatePayload = {
        expected_version: createBody.data.expense.version,
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

      const updateBody = updateResponse.body as ApiResponse<{ expense: any }>;
      let latestVersion = createBody.data.expense.version;
      if (updateBody.success && updateBody.data) {
        latestVersion = updateBody.data.expense.version as number;
        expect(updateBody.data.expense).toEqual(
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
      }

      await api
        .delete(`/api/expenses/${createdExpenseId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ expected_version: latestVersion })
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
    it.each([
      ['fractional', 5000.5],
      ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ])('should reject %s cent amounts', async (_caseName, amountCents) => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);

      const response = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          description: 'Invalid cent amount',
          amount_cents: amountCents,
          currency: 'USD',
          expense_date: '2025-09-20',
          paid_by_participant_id: selfParticipant.id,
          split_type: 'custom',
          splits: [
            {
              participant_id: selfParticipant.id,
              share_cents: amountCents,
            },
          ],
        })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          field: 'amount_cents',
        },
      });
    });

    it('should require the deterministic remainder allocation for equal splits', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);
      const partnerParticipantId = await createParticipant(
        accessToken,
        'Equal Split Partner',
      );

      const response = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          description: 'Non-canonical equal split',
          amount_cents: 5,
          currency: 'USD',
          expense_date: '2025-09-20',
          paid_by_participant_id: selfParticipant.id,
          split_type: 'equal',
          splits: [
            { participant_id: selfParticipant.id, share_cents: 2 },
            { participant_id: partnerParticipantId, share_cents: 3 },
          ],
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_EQUAL_SPLITS',
          message:
            'Equal split shares must use the canonical remainder allocation',
          field: 'splits',
        },
      });
    });

    it('should reject percentage shares that contradict share cents', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);
      const partnerParticipantId = await createParticipant(
        accessToken,
        'Percentage Split Partner',
      );

      const response = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          description: 'Contradictory percentage split',
          amount_cents: 1000,
          currency: 'USD',
          expense_date: '2025-09-20',
          paid_by_participant_id: selfParticipant.id,
          split_type: 'percentage',
          splits: [
            {
              participant_id: selfParticipant.id,
              share_cents: 400,
              share_percent: 50,
            },
            {
              participant_id: partnerParticipantId,
              share_cents: 600,
              share_percent: 50,
            },
          ],
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_PERCENTAGE_SPLITS',
          message:
            'Percentage split cents must match the canonical percentage allocation',
          field: 'splits',
        },
      });
    });

    it('should allow a payer who does not consume any share', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);
      const partnerParticipantId = await createParticipant(
        accessToken,
        'Sponsored Participant',
      );

      const response = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          description: 'Gift for a friend',
          amount_cents: 5000,
          currency: 'USD',
          expense_date: '2025-09-20',
          paid_by_participant_id: selfParticipant.id,
          split_type: 'custom',
          splits: [{ participant_id: partnerParticipantId, share_cents: 5000 }],
        })
        .expect(201);

      expect(response.body.data.expense).toMatchObject({
        paid_by_participant_id: selfParticipant.id,
        splits: [{ participant_id: partnerParticipantId, share_cents: 5000 }],
      });
    });

    it('should preserve split identity and settlement on non-split updates', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);

      const createResponse = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          description: 'Settled expense',
          amount_cents: 2500,
          currency: 'USD',
          expense_date: '2025-09-20',
          paid_by_participant_id: selfParticipant.id,
          split_type: 'custom',
          splits: [{ participant_id: selfParticipant.id, share_cents: 2500 }],
        })
        .expect(201);

      const expenseId = createResponse.body.data.expense.id as string;
      const expectedVersion = createResponse.body.data.expense
        .version as number;
      const splitRepository = app
        .get(DataSource)
        .getRepository(Entities.ExpenseSplit);
      const [before] = await splitRepository.find({ where: { expenseId } });
      const settledAt = new Date('2025-09-21T00:00:00.000Z');
      before.settledAt = settledAt;
      await splitRepository.save(before);

      await api
        .put(`/api/expenses/${expenseId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          expected_version: expectedVersion,
          notes: 'Description-only metadata update',
        })
        .expect(200);

      const [after] = await splitRepository.find({ where: { expenseId } });
      expect(after.id).toBe(before.id);
      expect(new Date(after.settledAt as Date).toISOString()).toBe(
        settledAt.toISOString(),
      );
    });

    it('should return the same expense when a client mutation is retried', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);
      const clientExpenseId = '951fe698-5c66-4bcc-90a2-96962c8baf71';
      const payload = {
        id: clientExpenseId,
        client_mutation_id: `expense-retry-${Date.now()}`,
        description: 'Idempotent mobile retry',
        amount_cents: 3200,
        currency: 'USD',
        expense_date: '2025-09-20',
        paid_by_participant_id: selfParticipant.id,
        split_type: 'custom',
        splits: [{ participant_id: selfParticipant.id, share_cents: 3200 }],
      };

      const first = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(payload)
        .expect(201);
      const second = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(payload)
        .expect(201);

      expect(second.body.data.expense.id).toBe(first.body.data.expense.id);
      expect(first.body.data.expense.id).toBe(clientExpenseId);

      const list = await api
        .get('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ search: 'Idempotent mobile retry' })
        .expect(200);
      expect(list.body.data.expenses).toHaveLength(1);
    });

    it('should reject an update made from a stale expense version', async () => {
      const { accessToken } = await registerMobileUser();
      const selfParticipant = await fetchSelfParticipant(accessToken);

      const created = await api
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          description: 'Versioned expense',
          amount_cents: 4100,
          currency: 'USD',
          expense_date: '2025-09-20',
          paid_by_participant_id: selfParticipant.id,
          split_type: 'custom',
          splits: [{ participant_id: selfParticipant.id, share_cents: 4100 }],
        })
        .expect(201);

      const expense = created.body.data.expense as {
        id: string;
        version: number;
      };
      const firstUpdate = await api
        .put(`/api/expenses/${expense.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ expected_version: expense.version, notes: 'First writer' })
        .expect(200);
      expect(firstUpdate.body.data.expense.version).toBe(expense.version + 1);

      const stale = await api
        .put(`/api/expenses/${expense.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ expected_version: expense.version, notes: 'Stale writer' })
        .expect(409);
      expect(stale.body).toEqual({
        success: false,
        error: {
          code: 'EXPENSE_VERSION_CONFLICT',
          message: 'Expense was modified by another request',
          field: 'expected_version',
        },
      });
    });

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
