# API Group Routes – Migration Notes

## Summary

- Consolidate group endpoints under `GET/POST/PUT/DELETE /api/groups`.
- Replace legacy `/expense-groups` test routes with `/api/groups`.
- Align response envelopes with API-wide pattern `{ success, data, error }`.
- Use valid JWTs via `/auth/register` or `/auth/login` for guarded routes.

## Changes

- Routes
  - Create: `POST /api/groups` with body `{ name, description?, color?, participantIds: string[] }`.
  - List: `GET /api/groups` → `{ success: true, data: { groups: GroupResponse[] } }`.
  - Update: `PUT /api/groups/:groupId` with partial of Create payload → `{ success: true, data: { group: GroupResponse } }`.
  - Delete: `DELETE /api/groups/:groupId` → `204 No Content`.
- Error model
  - Not found → `{ success: false, error: { code: 'GROUP_NOT_FOUND', message: 'Group not found' } }`.
  - Validation errors use `VALIDATION_ERROR` with `field` set when applicable.

## Rationale

- Keep a single canonical `/api` surface for web + mobile.
- Avoid duplicate controllers and drift between `/expense-groups` and `/api/groups`.
- Leverage existing `Api*Exception` helpers for consistent error envelopes.

## Test Updates

- Integration spec `participant-group.spec.ts` updated to:
  - Obtain JWT by registering a user in `beforeAll`.
  - Create participants via `POST /api/participants` and pass `participantIds` when creating groups.
  - Expect `{ data: { group } }` on create/update and `204` on delete.
  - Use `app.getHttpAdapter().getInstance()` for SuperTest (no port bind).

## Client Impact

- Mobile/web clients should call `/api/groups` and send `participantIds`.
- If a temporary `/expense-groups` alias is needed for rollout, add a thin compatibility controller delegating to `GroupService` and translating payloads.

## Example

- Create group
  - Request: `POST /api/groups` `{ "name": "Trip", "participantIds": ["p1", "p2"] }`
  - Response: `{ "success": true, "data": { "group": { "id": "g1", "name": "Trip", ... } } }`

- Delete group
  - Request: `DELETE /api/groups/g1`
  - Response: `204 No Content`

## Follow-ups

- Confirm no remaining references to `/expense-groups` in tests or docs.
- Consider an e2e spec covering all CRUD flows under `/api/groups`.
