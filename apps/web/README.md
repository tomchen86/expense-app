# Web Surface Placeholder

`apps/web` is an ordinary monorepo directory, but it does not currently contain
a web application. The repository's former entry at this path was an
unconfigured Git gitlink whose referenced commit and source repository could
not be recovered.

Do not infer a deployed or supported web capability from this placeholder. A
future implementation must use a managed OpenSpec change to either:

- import recovered source with its repository URL and revision recorded, after
  auditing it for secrets and generated artifacts; or
- scaffold a new web workspace from explicit product and architecture
  requirements, with its lint, typecheck, test, and build checks registered.

Do not recreate the malformed gitlink or invent a `.gitmodules` URL.
