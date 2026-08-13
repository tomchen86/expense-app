# Identity and Access Specification

## Purpose

Define stable user, installation, participant, and authentication identities
used by the offline-first mobile client and cloud API. Local persistence SHALL
survive process restarts, and account linkage SHALL preserve locally created
record identifiers and financial history.

## Delivery Status

Durable local installation/user/space/participant identifiers and API account,
password, access-token, and stateless refresh-token flows exist today. The
local-identity adoption transaction and refresh-session family persistence,
rotation/reuse detection, logout/revocation, and credential throttling below
remain target security behavior and are not claims about the current API.

## Requirements

### Requirement: Durable Mobile Identity

Before account registration, a mobile installation SHALL maintain a durable
local identity and personal-space identifier. The Settings surface SHALL
accept a non-empty trimmed display name and synchronize it into a distinct,
stable participant record for the personal space. A local installation
identity, an authenticated account ID, a space ID, and a per-space participant
ID SHALL NOT be conflated. Process restart SHALL NOT create new identities.

#### Scenario: User saves a display name

- GIVEN the mobile Settings surface is open
- WHEN the user submits a name containing at least one non-whitespace character
- THEN the trimmed name becomes the durable local display name
- AND the local user representation retains its stable identifier
- AND a separately identified participant linked to that identity is created
  or updated in the personal space
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
password as a bcrypt hash, and create default user settings. A successful
registration SHALL return the stable user identifier,
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

### Requirement: Local Identity Account Linkage

Registering or signing in from a local-first installation SHALL link the local
identity to the authenticated account without rewriting financial allocation
identities. Enabling cloud sync for an existing personal space SHALL preserve
client-generated expense, participant, category, and space identifiers where
they do not conflict. A conflict SHALL produce an explicit deterministic
mapping or user-visible resolution; it SHALL NOT silently duplicate records.

#### Scenario: Local-only user enables cloud sync

- GIVEN the device contains a personal space and expenses created before login
- WHEN the local identity is linked to an account and cloud sync is enabled
- THEN the server either adopts the non-conflicting stable identifiers or
  returns an explicit mapping for conflicts
- AND payment/share references continue to point at the same logical participants
- AND the personal ledger does not gain duplicate expenses

### Requirement: API Login and Token Refresh

The API SHALL authenticate an existing account by comparing the submitted
password with its stored hash. A successful login SHALL issue a short-lived
access token and a refresh-session token. Refresh tokens SHALL rotate on use,
support logout and revocation, and detect reuse of an already rotated token.

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

#### Scenario: Refresh token is reused

- GIVEN a refresh token has already been exchanged
- WHEN the same token is presented again
- THEN the API rejects the request
- AND revokes or blocks the affected token family

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

### Requirement: Space Storage Policy

The API SHALL get or create per-user presentation and notification settings
without dropping unspecified values. Storage policy SHALL be explicit per
space rather than a single user-wide switch: a personal space MAY be
`local_only` or `cloud_sync`, while a shared space SHALL be `cloud_sync`.
Only the space owner SHALL change that policy.

#### Scenario: User partially updates notifications

- GIVEN the user has existing notification preferences
- WHEN the authenticated user changes one notification flag
- THEN the API preserves the other notification flags
- AND returns the merged settings

#### Scenario: User enables cloud backup for a personal space

- GIVEN the user's personal space is local-only
- WHEN its owner enables cloud sync for that space
- THEN its existing local records are queued for idempotent upload
- AND later mutations use local and cloud replicas

#### Scenario: User attempts to make a shared space local-only

- GIVEN a space has multiple active account members
- WHEN a client requests `local_only`
- THEN the API rejects the change
- AND the shared space remains cloud-synchronized

#### Scenario: Owner disables cloud backup for a personal space

- GIVEN the personal space has a complete durable local replica
- WHEN its owner requests `local_only`
- THEN the API records the per-space policy change
- AND it does not treat the policy change as permission to erase cloud history

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
