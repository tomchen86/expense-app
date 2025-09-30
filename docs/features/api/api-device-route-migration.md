# API Device Route Migration Notes

## Summary

- Canonicalize device endpoints under `GET/POST/PUT/DELETE /api/devices`.
- Keep current endpoints under `/api/users/settings/devices` as a temporary alias during migration.
- No payload or response shape changes — only the route prefix changes.

## Canonical Endpoints

- POST `/api/devices` — register device and persistence context
- PUT `/api/devices/:deviceUuid/sync` — update sync heartbeat/snapshot hash and related metadata
- DELETE `/api/devices/:deviceUuid` — remove device registration (logout / local-only switch)
- Optional (recommended): GET `/api/devices` — list devices for current user

## Alias (Backward Compatibility)

- POST `/api/users/settings/devices`
- GET `/api/users/settings/devices`
- PUT `/api/users/settings/devices/:deviceUuid`
- DELETE `/api/users/settings/devices/:deviceUuid`

The alias returns the same response envelopes and uses the same validation rules. Clients may switch routes without any other code changes.

## Request/Response Examples

- Register Device
  - Request (POST `/api/devices`):
    ```json
    {
      "deviceUuid": "ios-simulator-123",
      "deviceName": "iPhone 15 Pro",
      "platform": "ios",
      "appVersion": "1.0.0"
    }
    ```
  - Response:
    ```json
    {
      "success": true,
      "data": {
        "device": {
          "id": "uuid",
          "deviceUuid": "ios-simulator-123",
          "deviceName": "iPhone 15 Pro",
          "platform": "ios",
          "appVersion": "1.0.0",
          "persistenceModeAtSync": "local_only",
          "syncStatus": "idle",
          "lastSyncAt": null,
          "lastSnapshotHash": null,
          "lastError": null,
          "createdAt": "ISO",
          "updatedAt": "ISO"
        }
      }
    }
    ```

- Update Sync Metadata
  - Request (PUT `/api/devices/ios-simulator-123/sync`):
    ```json
    {
      "syncStatus": "syncing",
      "persistenceModeAtSync": "cloud_sync",
      "lastSyncAt": "2025-09-27T10:00:00.000Z",
      "lastSnapshotHash": "abc123"
    }
    ```

- Remove Device
  - Request (DELETE `/api/devices/ios-simulator-123`)
  - Response: `204 No Content`

## Migration Steps (Clients)

1. Replace calls to `/api/users/settings/devices` with `/api/devices` equivalents.
2. Update typed API wrappers and route constants.
3. Verify end-to-end flows: register → list (if used) → sync update → remove.
4. Monitor logs for any unexpected 404 or validation errors.

## Server Rollout Plan

- Phase 1 (now): Implement `/api/devices` as canonical; maintain alias routes.
- Phase 2 (after client migration): Deprecation notice in responses or docs.
- Phase 3 (later): Remove alias routes after the deprecation window.

## Notes

- Authorization and response envelopes remain unchanged (`{ success, data|error }`).
- Device endpoints are no longer nested under settings to reflect their operational role (sync telemetry, heartbeats, snapshots).
- OpenAPI/Swagger doc will list `/api/devices` as canonical once docs generation is enabled.

## Testing Guidance

- Update integration specs to use `/api/devices`.
- Optionally keep a small alias-compat test to guard against regressions until alias removal.
