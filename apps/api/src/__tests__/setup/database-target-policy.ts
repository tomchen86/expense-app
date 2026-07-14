type AvailabilityProbe = (connectionString: string) => Promise<boolean>;
type DatabaseProvisioner = () => Promise<string>;

export const resolvePostgresTestDatabaseUrl = async (
  environment: NodeJS.ProcessEnv,
  isAvailable: AvailabilityProbe,
  provision: DatabaseProvisioner,
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

  if (
    environment.WORKFLOW_CHECK_EXECUTION === '1' ||
    environment.WORKFLOW_DISPOSABLE_DATABASE === '1'
  ) {
    throw new Error(
      'Explicit TEST_DATABASE_URL is required for workflow database checks.',
    );
  }

  return provision();
};
