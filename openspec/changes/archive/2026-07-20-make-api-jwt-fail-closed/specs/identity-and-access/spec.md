## ADDED Requirements

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
