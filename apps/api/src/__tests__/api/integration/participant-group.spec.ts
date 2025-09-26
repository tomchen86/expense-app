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

describe('Participants & Groups API - Mobile Compatibility', () => {
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
    const email = overrides.email ?? uniqueEmail('collab-user');
    const displayName = overrides.displayName ?? 'Collaboration User';

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

  describe('Participants API', () => {
    it('should list the authenticated user as the initial participant', async () => {
      const { accessToken, displayName } = await registerMobileUser({
        displayName: 'Solo Ledger User',
      });

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'GET /api/participants',
          () =>
            api
              .get('/api/participants')
              .set('Authorization', `Bearer ${accessToken}`)
              .expect(200),
          200,
        );

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data.participants)).toBe(true);
      expect(response.body.data.participants.length).toBeGreaterThanOrEqual(1);
      const owner = response.body.data.participants[0];
      expect(owner).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: displayName,
          isRegistered: true,
          notifications: expect.objectContaining({
            expenses: true,
            invites: true,
            reminders: true,
          }),
        }),
      );

      expect(metrics).toBeFastOperation();
    });

    it('should create, update, and protect participant records', async () => {
      const { accessToken } = await registerMobileUser();

      const createResponse = await api
        .post('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Pat Guest',
          email: 'pat.guest@example.com',
          defaultCurrency: 'EUR',
          notifications: {
            expenses: false,
          },
        })
        .expect(201);

      expect(createResponse.body).toEqual({
        success: true,
        data: {
          participant: {
            id: expect.any(String),
            name: 'Pat Guest',
            email: 'pat.guest@example.com',
            avatar: null,
            isRegistered: false,
            defaultCurrency: 'EUR',
            lastActiveAt: null,
            notifications: {
              expenses: false,
              invites: true,
              reminders: true,
            },
          },
        },
      });

      const participantId = createResponse.body.data.participant.id;

      const updateResponse = await api
        .put(`/api/participants/${participantId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Patricia Guest',
          notifications: {
            invites: false,
          },
        })
        .expect(200);

      expect(updateResponse.body.data.participant).toEqual({
        id: participantId,
        name: 'Patricia Guest',
        email: 'pat.guest@example.com',
        avatar: null,
        isRegistered: false,
        defaultCurrency: 'EUR',
        lastActiveAt: null,
        notifications: {
          expenses: false,
          invites: false,
          reminders: true,
        },
      });

      const deleteGuestResponse = await api
        .delete(`/api/participants/${updateResponse.body.data.participant.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      expect(deleteGuestResponse.body).toEqual({});

      const deleteOwnerAttempt = await api
        .get('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const ownerId = deleteOwnerAttempt.body.data.participants[0].id;

      const ownerDelete = await api
        .delete(`/api/participants/${ownerId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);

      expect(ownerDelete.body).toEqual({
        success: false,
        error: {
          code: 'CANNOT_REMOVE_SELF',
          message: 'You cannot remove yourself from the ledger',
        },
      });
    });
  });

  describe('Groups API', () => {
    it('should manage groups with participant membership', async () => {
      const { accessToken } = await registerMobileUser({
        displayName: 'Group Owner',
      });

      const participantsResponse = await api
        .get('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const ownerParticipant = participantsResponse.body.data.participants[0];

      const guestResponse = await api
        .post('/api/participants')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Roommate Riley' })
        .expect(201);

      const guestParticipant = guestResponse.body.data.participant;

      const createGroupResponse = await api
        .post('/api/groups')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Household Budget',
          description: 'Monthly shared expenses',
          color: '#4F46E5',
          participantIds: [guestParticipant.id],
        })
        .expect(201);

      expect(createGroupResponse.body).toEqual({
        success: true,
        data: {
          group: {
            id: expect.any(String),
            name: 'Household Budget',
            description: 'Monthly shared expenses',
            color: '#4F46E5',
            defaultCurrency: 'USD',
            isArchived: false,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            participants: expect.arrayContaining([
              expect.objectContaining({ id: ownerParticipant.id }),
              expect.objectContaining({ id: guestParticipant.id }),
            ]),
          },
        },
      });

      const groupId = createGroupResponse.body.data.group.id;

      const listGroups = await api
        .get('/api/groups')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(listGroups.body.data.groups[0].participants).toHaveLength(2);

      const updateGroup = await api
        .put(`/api/groups/${groupId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Primary Household',
          participantIds: [ownerParticipant.id],
        })
        .expect(200);

      expect(updateGroup.body.data.group.participants).toEqual([
        expect.objectContaining({ id: ownerParticipant.id }),
      ]);

      await api
        .delete(`/api/groups/${groupId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const listAfterDelete = await api
        .get('/api/groups')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(listAfterDelete.body.data.groups.length).toBe(0);
    });
  });
});
