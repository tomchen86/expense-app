# GEMINI.md

## Project Overview

This is a monorepo for an expense tracking application. It consists of three main parts: a mobile application, a web application, and a backend API. The project uses `pnpm` as its package manager and is structured as a pnpm workspace.

- **Mobile App (`apps/mobile`):** A production-ready React Native application built with Expo. It has comprehensive unit, integration, and E2E tests.
- **API (`apps/api`):** A backend API built with NestJS and TypeORM. It uses a PostgreSQL database and is currently in the development phase.
- **Web App (`apps/web`):** A minimal scaffold for a Next.js web application. It is not yet implemented.

## Building and Running

### Prerequisites

- [Node.js](https://nodejs.org/)
- [pnpm](https://pnpm.io/)

### Installation

To install all dependencies for the entire monorepo, run the following command from the root directory:

```bash
pnpm install
```

### Running the Applications

- **API (`apps/api`):**

  ```bash
  # Development mode
  pnpm --filter api start:dev

  # Production mode
  pnpm --filter api start:prod
  ```

- **Mobile App (`apps/mobile`):**

  ```bash
  # Start the Expo development server
  pnpm --filter mobile start

  # Run on Android
  pnpm --filter mobile android

  # Run on iOS
  pnpm --filter mobile ios
  ```

- **Web App (`apps/web`):**

  ```bash
  # Development mode
  pnpm --filter web dev
  ```

### Testing

- **API (`apps/api`):**

  ```bash
  # Unit tests
  pnpm --filter api test

  # E2E tests
  pnpm --filter api test:e2e
  ```

- **Mobile App (`apps/mobile`):**

  ```bash
  # Run all tests
  pnpm --filter mobile test

  # Run E2E tests
  pnpm --filter mobile test:e2e
  ```

## Development Conventions

- **Package Manager:** This project uses `pnpm` for package management. Avoid using `npm` or `yarn` to prevent dependency conflicts.
- **Linting and Formatting:** The project uses ESLint and Prettier for code linting and formatting. You can run the following commands from the root directory to check and fix your code:

  ```bash
  # Format code
  pnpm format

  # Check formatting
  pnpm format:check

  # Lint code
  pnpm lint

  # Fix linting errors
  pnpm lint:fix
  ```

- **Branching and Committing:** Follow standard Git practices for branching and committing. Ensure your work is committed to a feature branch before merging to the main branch.
