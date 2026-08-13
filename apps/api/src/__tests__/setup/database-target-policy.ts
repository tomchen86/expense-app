type AvailabilityProbe = (connectionString: string) => Promise<boolean>;

export const resolvePostgresTestDatabaseUrl = async (
  environment: NodeJS.ProcessEnv,
  isAvailable: AvailabilityProbe,
): Promise<string> => {
  const explicitUrl = environment.TEST_DATABASE_URL?.trim();

  if (explicitUrl) {
    let available: boolean;
    try {
      available = await isAvailable(explicitUrl);
    } catch {
      available = false;
    }

    if (!available) {
      throw new Error(
        'Explicit TEST_DATABASE_URL is unavailable; fallback is disabled.',
      );
    }
    return explicitUrl;
  }

  throw new Error(
    'Explicit TEST_DATABASE_URL is required for PostgreSQL-writing tests.',
  );
};
