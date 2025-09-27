// Integration tests for Group API (aligned with /api/groups routes)

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { AppModule } from '../../../app.module';
import { PerformanceAssertions } from '../../helpers/performance-assertions';

interface PerformanceMetrics {
  duration: number;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
    details?: string[];
  };
}

interface GroupResponse {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  defaultCurrency: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  participants: Array<{
    id: string;
    name: string;
    email: string | null;
    avatar: string | null;
    isRegistered: boolean;
    defaultCurrency: string;
    lastActiveAt: string | null;
    notifications: { expenses: boolean; invites: boolean; reminders: boolean };
  }>;
}

describe('Expense Group API', () => {
  let app: INestApplication;
  let httpServer: any;
  let api: ReturnType<typeof supertest>;
  let accessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    httpServer = app.getHttpAdapter().getInstance();
    api = supertest(httpServer);

    // Register a user and obtain a valid JWT for guarded routes
    const uniqueEmail = (prefix: string) =>
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const registerRes = await api
      .post('/auth/register')
      .send({
        email: uniqueEmail('group-user'),
        password: 'TestPassword123!',
        displayName: 'Group Test User',
      })
      .expect(201);
    accessToken = registerRes.body.data.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/groups', () => {
    it('should create a new expense group', async () => {
      // Create a friend participant first
      const friendRes = await api
        .post('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Friend One', email: 'friend1@example.com' })
        .expect(201);
      const friendId = (friendRes.body?.data?.participant?.id ||
        friendRes.body?.data?.participant?.id) as string;

      const payload = {
        name: 'Test Group',
        participantIds: [friendId],
      };

      const perfPost = (await PerformanceAssertions.testEndpointPerformance(
        'POST /api/groups',
        () =>
          api
            .post('/api/groups')
            .set('Authorization', `Bearer ${accessToken}`)
            .send(payload)
            .expect(201),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { response, metrics } = perfPost;

      const body = response.body as ApiResponse<{ group: GroupResponse }>;
      expect(body).toMatchObject({
        success: true,
        data: {
          group: expect.objectContaining({
            id: expect.any(String),
            name: 'Test Group',
            participants: expect.arrayContaining([
              expect.objectContaining({ name: 'Friend One' }),
            ]),
          }),
        },
      });

      expect(metrics).toBeFastOperation();
    });

    it('should return 401 if no token is provided', async () => {
      const response = await api
        .post('/api/groups')
        .send({ name: 'Unauthed Group', participantIds: [] })
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        },
      });
    });
  });

  describe('GET /api/groups', () => {
    it('should list groups including the newly created one', async () => {
      // Create a group first
      const friendRes = await api
        .post('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Friend Two' })
        .expect(201);
      const friendId = friendRes.body.data.participant.id as string;

      const createRes = await api
        .post('/api/groups')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'List Group', participantIds: [friendId] })
        .expect(201);
      const createdId = createRes.body.data.group.id as string;

      const perfGet = (await PerformanceAssertions.testEndpointPerformance(
        'GET /api/groups',
        () =>
          api
            .get('/api/groups')
            .set('Authorization', `Bearer ${accessToken}`)
            .expect(200),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { response, metrics } = perfGet;

      const body = response.body as ApiResponse<{ groups: GroupResponse[] }>;
      const found = body.data?.groups.find((g) => g.id === createdId);
      expect(found).toBeTruthy();
      expect(found?.name).toBe('List Group');
      expect(metrics).toBeFastOperation();
    });
  });

  describe('PUT /api/groups/:id', () => {
    it('should update a expense group', async () => {
      // Create two friend participants
      const p1 = await api
        .post('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Friend A' })
        .expect(201);
      const p2 = await api
        .post('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Friend B' })
        .expect(201);
      const id1 = p1.body.data.participant.id as string;
      const id2 = p2.body.data.participant.id as string;

      const createRes = await api
        .post('/api/groups')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Updatable Group', participantIds: [id1] })
        .expect(201);
      const groupId = createRes.body.data.group.id as string;

      const perfPut = (await PerformanceAssertions.testEndpointPerformance(
        'PUT /api/groups/:id',
        () =>
          api
            .put(`/api/groups/${groupId}`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ name: 'Updated Group Name', participantIds: [id1, id2] })
            .expect(200),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { response, metrics } = perfPut;

      const body = response.body as ApiResponse<{ group: GroupResponse }>;
      expect(body).toMatchObject({
        success: true,
        data: {
          group: expect.objectContaining({
            id: groupId,
            name: 'Updated Group Name',
            participants: expect.arrayContaining([
              expect.objectContaining({ name: 'Friend A' }),
              expect.objectContaining({ name: 'Friend B' }),
            ]),
          }),
        },
      });

      expect(metrics).toBeFastOperation();
    });

    it('should return 404 if group not found', async () => {
      const response = await api
        .put(`/api/groups/${'non-existent-id'}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Non Existent' })
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'GROUP_NOT_FOUND',
          message: 'Group not found',
        },
      });
    });
  });

  describe('DELETE /api/groups/:id', () => {
    it('should delete a expense group', async () => {
      const friend = await api
        .post('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Friend C' })
        .expect(201);
      const friendId = friend.body.data.participant.id as string;

      const createRes = await api
        .post('/api/groups')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Deletable Group', participantIds: [friendId] })
        .expect(201);
      const groupId = createRes.body.data.group.id as string;

      const perfDelete = (await PerformanceAssertions.testEndpointPerformance(
        'DELETE /api/groups/:id',
        () =>
          api
            .delete(`/api/groups/${groupId}`)
            .set('Authorization', `Bearer ${accessToken}`)
            .expect(204),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { metrics } = perfDelete;

      expect(metrics).toBeFastOperation();

      // Verify group no longer appears in list
      const listRes = await api
        .get('/api/groups')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const groups = listRes.body.data.groups as GroupResponse[];
      expect(groups.find((g) => g.id === groupId)).toBeUndefined();
    });

    it('should return 404 if group not found', async () => {
      const response = await api
        .delete(`/api/groups/${'non-existent-id'}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'GROUP_NOT_FOUND',
          message: 'Group not found',
        },
      });
    });
  });
});
