process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqljs';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SuperTest, Test as SuperTestRequest } from 'supertest';
const supertest = require('supertest');
import { AppModule } from '../../../app.module';
import { PerformanceAssertions } from '../../helpers/performance-assertions';

const PASSWORD = 'TestPassword123!';
const DEFAULT_CATEGORY_COUNT = 8;

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('Category API - Mobile Compatibility', () => {
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
    const email = overrides.email ?? uniqueEmail('category-user');
    const displayName = overrides.displayName ?? 'Category Test User';

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

  describe('GET /api/categories', () => {
    it('should return default categories seeded for a new user ledger', async () => {
      const { accessToken } = await registerMobileUser();

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'GET /api/categories',
          () =>
            api
              .get('/api/categories')
              .set('Authorization', `Bearer ${accessToken}`)
              .expect(200),
          200,
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          categories: expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(String),
              name: 'Food & Dining',
              color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
              icon: expect.any(String),
              isDefault: true,
            }),
          ]),
        },
      });

      expect(response.body.data.categories).toHaveLength(
        DEFAULT_CATEGORY_COUNT,
      );
      expect(metrics).toBeFastOperation();
    });
  });

  describe('POST /api/categories', () => {
    it('should create a new category with mobile-compatible response', async () => {
      const { accessToken } = await registerMobileUser();

      const createPayload = {
        name: 'Groceries',
        color: '#A1B2C3',
        icon: 'cart',
      };

      const createResponse = await api
        .post('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(createPayload)
        .expect(201);

      expect(createResponse.body).toEqual({
        success: true,
        data: {
          category: {
            id: expect.any(String),
            name: 'Groceries',
            color: '#A1B2C3',
            icon: 'cart',
            isDefault: false,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        },
      });

      const listResponse = await api
        .get('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const created = listResponse.body.data.categories.find(
        (cat: any) => cat.name === 'Groceries',
      );
      expect(created).toBeDefined();
      expect(created.color).toBe('#A1B2C3');
    });

    it('should prevent duplicate category names within the same ledger', async () => {
      const { accessToken } = await registerMobileUser();

      await api
        .post('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Subscriptions', color: '#112233' })
        .expect(201);

      const response = await api
        .post('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'subscriptions', color: '#445566' })
        .expect(409);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'CATEGORY_EXISTS',
          message: 'Category with this name already exists',
          field: 'name',
        },
      });
    });

    it('should validate hex color format', async () => {
      const { accessToken } = await registerMobileUser();

      const response = await api
        .post('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Invalid', color: 'blue' })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid category payload',
          field: 'color',
        },
      });
    });
  });

  describe('PUT /api/categories/:id', () => {
    it('should update category attributes while preserving ledger association', async () => {
      const { accessToken } = await registerMobileUser();

      const createResponse = await api
        .post('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Utilities', color: '#13579B' })
        .expect(201);

      const categoryId = createResponse.body.data.category.id;

      const updateResponse = await api
        .put(`/api/categories/${categoryId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ color: '#97531B', icon: 'bolt' })
        .expect(200);

      expect(updateResponse.body).toEqual({
        success: true,
        data: {
          category: {
            id: categoryId,
            name: 'Utilities',
            color: '#97531B',
            icon: 'bolt',
            isDefault: false,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        },
      });
    });
  });

  describe('DELETE /api/categories/:id', () => {
    it('should soft delete a custom category not linked to expenses', async () => {
      const { accessToken } = await registerMobileUser();

      const { body } = await api
        .post('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Temp Delete', color: '#ABCDEF' })
        .expect(201);

      const categoryId = body.data.category.id;

      await api
        .delete(`/api/categories/${categoryId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const listResponse = await api
        .get('/api/categories')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const deleted = listResponse.body.data.categories.find(
        (cat: any) => cat.id === categoryId,
      );
      expect(deleted).toBeUndefined();
    });
  });

  describe('GET /api/categories/default', () => {
    it('should expose default categories for client bootstrapping', async () => {
      const { accessToken } = await registerMobileUser();

      const response = await api
        .get('/api/categories/default')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          categories: expect.arrayContaining([
            expect.objectContaining({
              name: 'Food & Dining',
              color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
            }),
          ]),
        },
      });
      expect(response.body.data.categories).toHaveLength(
        DEFAULT_CATEGORY_COUNT,
      );
    });
  });
});
