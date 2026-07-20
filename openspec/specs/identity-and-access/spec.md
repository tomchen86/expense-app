# Identity and Access Specification

## Purpose

This specification records the mobile session-local identity and the API
account/access capabilities that exist today. The mobile app does not yet use
the API authentication flow, and this specification does not assert local
identity persistence across restarts, token revocation/logout, or working
cloud synchronization.
## Requirements
### Requirement: Mobile Session Identity

Each mobile user-store instance SHALL generate an internal identifier with the
`user_` prefix. The Settings surface SHALL accept a non-empty trimmed display
name, keep it for the lifetime of the in-memory store, and synchronize that
name and identifier into the local participant store.

#### Scenario: User saves a display name

- GIVEN the mobile Settings surface is open
- WHEN the user submits a name containing at least one non-whitespace character
- THEN the trimmed name becomes the session's display name
- AND the local user representation uses the session's internal identifier
- AND a participant with that identifier and name is created or updated
- AND the app displays a success alert

#### Scenario: User submits an empty display name

- GIVEN the mobile Settings surface is open
- WHEN the submitted name is empty or whitespace only
- THEN the app reports that a name is required
- AND does not update the session identity

### Requirement: Mobile Settings Navigation

The mobile Settings surface SHALL provide an entry that navigates to the
Manage Categories route.

#### Scenario: User opens category management from Settings

- GIVEN the mobile Settings surface is open
- WHEN the user selects `Manage Categories`
- THEN the app navigates to `/manage-categories`

### Requirement: API Account Registration

The API SHALL register an account from non-empty `email`, `password`, and
`displayName` fields, reject an email already assigned to an account, store the
password as a bcrypt hash, and create default user settings in `local_only`
mode. A successful registration SHALL return the stable user identifier,
display name, email, access token, and refresh token.

#### Scenario: User registers successfully

- GIVEN the submitted email is not assigned to an existing account
- WHEN the user submits all three required registration fields
- THEN the API creates a UUID-backed user account
- AND creates default settings for that user
- AND returns the user representation and a signed access/refresh token pair

#### Scenario: Required registration field is missing

- GIVEN at least one of email, password, or display name is absent
- WHEN registration is requested
- THEN the API rejects the request with `VALIDATION_ERROR`
- AND identifies the missing fields in the error details

#### Scenario: Email is already registered

- GIVEN an account already uses the submitted email
- WHEN registration is requested again with that email
- THEN the API rejects the request with `EMAIL_ALREADY_EXISTS`

### Requirement: API Login and Token Refresh

The API SHALL authenticate an existing account by comparing the submitted
password with its stored hash. A successful login SHALL issue a 15-minute
access token and a seven-day refresh token and return current user settings. A
valid refresh token for an existing user SHALL produce a new access/refresh
token pair.

#### Scenario: Credentials are valid

- GIVEN an account exists for the submitted email
- AND the submitted password matches the stored hash
- WHEN login is requested
- THEN the API returns the user, settings, access token, and refresh token

#### Scenario: Credentials are invalid

- GIVEN the submitted email is unknown or its password does not match
- WHEN login is requested
- THEN the API rejects the request with `INVALID_CREDENTIALS`
- AND does not reveal which credential was incorrect

#### Scenario: Refresh token is invalid

- GIVEN a refresh token is invalid, expired, or refers to a missing user
- WHEN token refresh is requested
- THEN the API rejects the request with `INVALID_REFRESH_TOKEN`

### Requirement: Protected API Access

Protected API controllers SHALL require a verifiable access token in the
request's authorization header. Successful verification SHALL attach the
token's stable user identifier, email, and display name to the request for
ledger and user scoping.

#### Scenario: Authorization header is missing

- GIVEN a client requests a protected endpoint
- WHEN no authorization header is provided
- THEN the API returns an unauthorized error
- AND the protected controller action does not run

#### Scenario: Access token is invalid or expired

- GIVEN a client supplies a token that cannot be verified as an access token
- WHEN a protected endpoint is requested
- THEN the API rejects the request with `INVALID_TOKEN`

#### Scenario: Access token is valid

- GIVEN a client supplies a valid access token
- WHEN a protected endpoint is requested
- THEN the endpoint executes in the identity scope of the token's user ID

### Requirement: API User Profile

The API SHALL allow an authenticated user to retrieve their stable ID, email,
display name, avatar URL, default currency, timezone, and settings. It SHALL
allow that user to update the implemented mutable profile fields: display
name, avatar URL, three-letter default currency, and timezone.

#### Scenario: User retrieves their profile

- GIVEN an authenticated account exists
- WHEN the user requests `/api/users/profile`
- THEN the API returns only that user's profile and settings

#### Scenario: User updates profile fields

- GIVEN an authenticated account exists
- WHEN the user submits valid mutable profile fields
- THEN the API persists those fields for that account
- AND returns the updated profile representation

#### Scenario: Currency format is invalid

- GIVEN an authenticated user
- WHEN a profile update contains a default currency that is not three uppercase
  letters
- THEN the API rejects the update as invalid

### Requirement: API User Preferences

The API SHALL get or create per-user settings and SHALL support partial updates
to language, expense/invite/reminder notification preferences, and push
enablement without dropping unspecified notification values. It SHALL accept
only `local_only` or `cloud_sync` as the stored persistence-mode preference and
record the time at which that preference changes.

#### Scenario: User partially updates notifications

- GIVEN the user has existing notification preferences
- WHEN the authenticated user changes one notification flag
- THEN the API preserves the other notification flags
- AND returns the merged settings

#### Scenario: User changes persistence preference

- GIVEN an authenticated user has settings
- WHEN the user selects the other supported persistence mode
- THEN the API stores that mode
- AND returns the settings and persistence-change timestamp

#### Scenario: Persistence value is unsupported

- GIVEN an authenticated user
- WHEN a persistence-mode update is neither `local_only` nor `cloud_sync`
- THEN the API rejects the request with `VALIDATION_ERROR`

### Requirement: API Device Records

The API SHALL scope device records by authenticated user and device UUID. It
SHALL support idempotent registration, newest-update-first listing, sync
metadata updates, and removal for the requesting user's devices.

#### Scenario: User registers the same device again

- GIVEN a device UUID is already registered to the authenticated user
- WHEN that user registers the same UUID with updated metadata
- THEN the API updates the existing user/device record
- AND does not create a duplicate for that user

#### Scenario: User updates device sync state

- GIVEN the device UUID belongs to the authenticated user
- WHEN valid persistence mode, sync status, timestamp, snapshot hash, or error
  metadata is submitted
- THEN the API persists and returns the updated device representation

#### Scenario: Device belongs to no record for the user

- GIVEN the requested device UUID is not registered to the authenticated user
- WHEN an update is requested
- THEN the API rejects the request with `DEVICE_NOT_FOUND`

### Requirement: Authenticated User Search

The API SHALL allow an authenticated user to search account display names and
emails with a non-empty query, SHALL exclude the requesting user's account,
and SHALL limit the result count to at most 25.

#### Scenario: Search finds other users

- GIVEN other accounts match a non-empty display-name or email query
- WHEN an authenticated user searches with that query
- THEN matching user summaries are returned in display-name order
- AND the requesting user's own account is absent

#### Scenario: Search query is empty

- GIVEN an authenticated user
- WHEN user search is requested without a non-empty query
- THEN the API rejects the request with `VALIDATION_ERROR`

### Requirement: API authentication secrets fail closed

The API SHALL resolve JWT access and refresh secrets only from explicit
configuration. Startup and every token operation MUST fail when either
secret is missing, blank, equal to a published development fallback value,
or equal to the other secret. No fallback value may exist in production
code.

#### Scenario: Missing secret fails startup

- GIVEN `JWT_SECRET` or `JWT_REFRESH_SECRET` is unset or blank
- WHEN the API application boots
- THEN bootstrap fails with an error naming the missing variable
- AND no endpoint is served

#### Scenario: Published development literals are forbidden

- GIVEN an environment sets a JWT secret to a published development
  fallback value
- WHEN secrets are resolved
- THEN resolution fails as if the secret were missing

#### Scenario: Explicitly configured secrets serve tokens

- GIVEN both secrets are explicitly set, distinct, and not forbidden
- WHEN a user authenticates, refreshes, or presents an access token
- THEN signing and verification use exactly the configured secrets

