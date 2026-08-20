export interface CheckDefinitionV1 {
  command: string[];
  destructiveDatabase: boolean;
  liveStderr?: boolean;
}

export interface CheckRegistryV1 {
  readonly schemaVersion: 1;
  readonly checks: Record<string, CheckDefinitionV1>;
}

export interface CheckRegistryPortV1 {
  readonly contractVersion: 'jigwright.check-registry-port.v1';
  load(repositoryRoot: string): CheckRegistryV1;
}
