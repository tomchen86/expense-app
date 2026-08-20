import path from 'node:path';

export const SESSION_RUNTIME_LAYOUT_PORT_CONTRACT_VERSION_V1 =
  'jigwright.session-runtime-layout-port.v1' as const;

export type SessionRuntimeLocationV1 = Readonly<{
  gitCommonDirectory: string;
  runtimeDirectory: string;
}>;

export type SessionRuntimeLayoutV1 = Readonly<{
  root: string;
  locks: string;
  operations: string;
  sessions: string;
  reports: string;
  taskRevisions: string;
}>;

/**
 * Resolve consumer-owned durable session paths without owning session state,
 * locking, persistence, or transition authority.
 */
export interface SessionRuntimeLayoutPortV1 {
  readonly contractVersion: typeof SESSION_RUNTIME_LAYOUT_PORT_CONTRACT_VERSION_V1;
  resolve(input: SessionRuntimeLocationV1): SessionRuntimeLayoutV1;
}

/** Generic layout used by the embedded engine and external consumers. */
export const defaultSessionRuntimeLayoutPort: SessionRuntimeLayoutPortV1 = {
  contractVersion: SESSION_RUNTIME_LAYOUT_PORT_CONTRACT_VERSION_V1,
  resolve({ gitCommonDirectory, runtimeDirectory }) {
    const root = path.join(gitCommonDirectory, runtimeDirectory);
    return {
      root,
      locks: path.join(root, 'locks'),
      operations: path.join(root, 'operations'),
      sessions: path.join(root, 'sessions'),
      reports: path.join(root, 'reports'),
      taskRevisions: path.join(root, 'task-revisions'),
    };
  },
};
