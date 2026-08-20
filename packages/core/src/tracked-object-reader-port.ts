export type TrackedObjectSkipReasonV1 =
  | 'symlink'
  | 'submodule'
  | 'binary'
  | 'invalid-utf8'
  | 'oversize'
  | 'sensitive-path'
  | 'sensitive-suppressed'
  | 'total-budget'
  | 'unsupported';

export interface TrackedObjectPathIdentityV1 {
  readonly rawBase64: string;
  readonly utf8: string | null;
}

export interface TrackedObjectEntryV1 {
  readonly path: TrackedObjectPathIdentityV1;
  readonly objectId: string;
  readonly objectType: string;
  readonly mode: string;
  readonly byteSize: number | null;
  readonly content?: Uint8Array;
  readonly contentSha256?: string;
  readonly skipReason?: TrackedObjectSkipReasonV1;
}

export interface TrackedObjectSnapshotV1 {
  readonly treeOid: string;
  readonly treeDigest: string;
  readonly entries: readonly TrackedObjectEntryV1[];
  readonly totalScannedBlobBytes: number;
  readonly budgetExceeded: boolean;
}

export interface TrackedObjectReadLimitsV1 {
  readonly maxBlobBytes: number;
  readonly maxTotalScannedBytes: number;
}

export interface TrackedObjectOperationalDeadlineV1 {
  readonly expiresAtMonotonicMillis: number;
}

export interface TrackedObjectReadRequestV1 {
  readonly repositoryRoot: string;
  readonly treeOid: string;
  readonly limits?: TrackedObjectReadLimitsV1;
  readonly operationalDeadline?: TrackedObjectOperationalDeadlineV1;
}

export interface TrackedObjectReaderPortV1 {
  readonly contractVersion: 'jigwright.tracked-object-reader-port.v1';
  readPinnedTree(request: TrackedObjectReadRequestV1): TrackedObjectSnapshotV1;
}
