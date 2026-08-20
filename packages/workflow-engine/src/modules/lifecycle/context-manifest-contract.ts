export type ContextManifestItemReference = {
  identity: string;
  digest: string;
};

export type ContextManifest = {
  schemaVersion: 1;
  kind: 'epoch-context-manifest';
  workflowId: string;
  epoch: number;
  contractVersion: number;
  baselineDigest: string;
  intentDigest: string;
  termSetDigest: string;
  planningSnapshotDigest: string;
  contextDigest: string;
  items: ContextManifestItemReference[];
};
