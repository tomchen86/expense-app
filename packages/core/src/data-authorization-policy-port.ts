export type DataAuthorizationLimits = {
  timeoutMs: number;
  aggregateOutputBytes: number;
  maxConcurrent: number;
};

export type DataAuthorizationProviderPolicy = {
  enabled: boolean;
};

export type DataAuthorizationProviderReservation = {
  providerCostMicros: number;
  providerTokens: number;
};

export type DataAuthorizationRetryAccounting<ProviderId extends string> = {
  maxAttempts: number;
  maxCumulativeRuntimeMs: number;
  maxProviderCostMicros: number;
  maxProviderTokens: number;
  maxSameFailureFingerprint: number;
  maxRepairAttempts: number;
  deadlineMs: number;
  providerLimits: Record<ProviderId, number>;
  reservations: Record<ProviderId, DataAuthorizationProviderReservation>;
};

/**
 * The current repository-owned data-authorization document. Provider identity
 * remains a caller-owned type parameter so core does not own a built-in
 * provider registry or host execution configuration.
 */
export type DataAuthorizationPolicyV4<ProviderId extends string> = {
  schemaVersion: 4;
  mode: 'managed-read-only';
  launchPolicy: 'lifecycle-only';
  requiredControls: string[];
  providers: Record<ProviderId, DataAuthorizationProviderPolicy>;
  limits: DataAuthorizationLimits;
  retryAccounting: DataAuthorizationRetryAccounting<ProviderId>;
};

/** Exact document bytes remain the digest authority for live and replay use. */
export type LoadedDataAuthorizationPolicyV4<ProviderId extends string> = {
  policy: DataAuthorizationPolicyV4<ProviderId>;
  digest: string;
  document: string;
};

/**
 * Current-policy reader port. Historical readers stay outside this contract so
 * an old snapshot grammar cannot become live authorization.
 */
export type DataAuthorizationPolicyPort<ProviderId extends string> = Readonly<{
  readCurrent(
    repositoryRoot: string,
  ): LoadedDataAuthorizationPolicyV4<ProviderId>;
  parseCurrentDocument(
    document: string,
  ): LoadedDataAuthorizationPolicyV4<ProviderId>;
}>;
