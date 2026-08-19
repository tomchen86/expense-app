import fs from 'node:fs';
import path from 'node:path';

import {
  assertUnique,
  invalidPayload,
  record,
} from './openspec-payload-primitives.ts';

export type OpenSpecDiagnostic = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  target?: string;
  fix?: string;
  causeCode?: string;
};

export type OpenSpecDoctor = {
  resolved: boolean;
  healthy: boolean;
  root: {
    path: string;
    source: 'nearest';
    healthy: boolean;
  } | null;
  diagnostics: OpenSpecDiagnostic[];
};

type DiagnosticRule = {
  severity: OpenSpecDiagnostic['severity'];
  target?: string;
};

const ROOT_DIAGNOSTICS: Readonly<Record<string, DiagnosticRule>> = {
  openspec_root_missing: { severity: 'error', target: 'openspec.root' },
  openspec_root_not_directory: {
    severity: 'error',
    target: 'openspec.root',
  },
  openspec_config_missing: { severity: 'error', target: 'openspec.config' },
  openspec_config_not_file: {
    severity: 'error',
    target: 'openspec.config',
  },
  openspec_specs_not_directory: {
    severity: 'error',
    target: 'openspec.specs',
  },
  openspec_changes_not_directory: {
    severity: 'error',
    target: 'openspec.changes',
  },
  openspec_archive_not_directory: {
    severity: 'error',
    target: 'openspec.archive',
  },
};

const RELATIONSHIP_DIAGNOSTICS: Readonly<Record<string, DiagnosticRule>> = {
  relationship_registry_unreadable: {
    severity: 'warning',
    target: 'relationships',
  },
  root_pointer_ignored: { severity: 'warning', target: 'relationships' },
  root_pointer_invalid: { severity: 'warning', target: 'relationships' },
  pointer_declarations_inert: {
    severity: 'warning',
    target: 'relationships',
  },
};

const REFERENCE_DIAGNOSTICS: Readonly<Record<string, DiagnosticRule>> = {
  reference_invalid_id: { severity: 'warning', target: 'references' },
  reference_registry_unreadable: {
    severity: 'warning',
    target: 'references',
  },
  reference_unresolved: { severity: 'warning', target: 'references' },
  reference_root_unhealthy: { severity: 'warning', target: 'references' },
};

const FAILURE_DIAGNOSTICS: Readonly<Record<string, DiagnosticRule>> = {
  no_openspec_root: { severity: 'error', target: 'openspec.root' },
  no_root_with_registered_stores: {
    severity: 'error',
    target: 'openspec.root',
  },
  invalid_store_pointer: { severity: 'error', target: 'store.pointer' },
  invalid_store_id: { severity: 'error', target: 'store.id' },
  no_registered_stores: { severity: 'error', target: 'store.id' },
  unknown_store: { severity: 'error', target: 'store.id' },
  store_identity_mismatch: { severity: 'error', target: 'store.metadata' },
  unhealthy_store_root: { severity: 'error', target: 'openspec.root' },
  doctor_failed: { severity: 'error' },
};

export function parseDoctor(
  value: unknown,
  repositoryRoot: string,
  processStatus: number,
): OpenSpecDoctor {
  const payload = record(value);
  assertExactKeys(payload, ['references', 'root', 'status', 'store']);
  if (!Array.isArray(payload.references) || !Array.isArray(payload.status)) {
    throw invalidPayload();
  }

  if (processStatus === 1) {
    if (
      payload.root !== null ||
      payload.store !== null ||
      payload.references.length !== 0 ||
      payload.status.length !== 1
    ) {
      throw invalidPayload();
    }
    const diagnostics = payload.status.map((entry) =>
      parseDiagnostic(entry, FAILURE_DIAGNOSTICS),
    );
    return { resolved: false, healthy: false, root: null, diagnostics };
  }

  if (processStatus !== 0 || payload.root === null || payload.store !== null) {
    throw invalidPayload();
  }
  const rootPayload = record(payload.root);
  assertExactKeys(rootPayload, ['healthy', 'path', 'source', 'status']);
  if (
    rootPayload.path !== repositoryRoot ||
    rootPayload.source !== 'nearest' ||
    typeof rootPayload.healthy !== 'boolean' ||
    !Array.isArray(rootPayload.status)
  ) {
    throw invalidPayload();
  }
  const rootDiagnostics = rootPayload.status.map((entry) =>
    parseDiagnostic(entry, ROOT_DIAGNOSTICS),
  );
  if (rootPayload.healthy !== (rootDiagnostics.length === 0)) {
    throw invalidPayload();
  }

  const referenceDiagnostics = parseDoctorReferences(payload.references);
  const relationshipDiagnostics = payload.status.map((entry) =>
    parseDiagnostic(entry, RELATIONSHIP_DIAGNOSTICS),
  );
  const diagnostics = [
    ...rootDiagnostics,
    ...referenceDiagnostics,
    ...relationshipDiagnostics,
  ];
  return {
    resolved: true,
    healthy: rootPayload.healthy && diagnostics.length === 0,
    root: {
      path: repositoryRoot,
      source: 'nearest',
      healthy: rootPayload.healthy,
    },
    diagnostics,
  };
}

function parseDoctorReferences(value: unknown[]): OpenSpecDiagnostic[] {
  const identifiers: string[] = [];
  const diagnostics: OpenSpecDiagnostic[] = [];
  for (const entry of value) {
    const reference = record(entry);
    assertExactKeys(reference, ['root', 'status', 'store_id'], ['root']);
    if (
      !diagnosticText(reference.store_id) ||
      reference.store_id.length > 256 ||
      !Array.isArray(reference.status)
    ) {
      throw invalidPayload();
    }
    const parsed = reference.status.map((item) =>
      parseDiagnostic(item, REFERENCE_DIAGNOSTICS),
    );
    const identifierIsValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(
      reference.store_id,
    );
    const reportsInvalidIdentifier = parsed.some(
      ({ code }) => code === 'reference_invalid_id',
    );
    if (
      identifierIsValid === reportsInvalidIdentifier ||
      (parsed.length > 0 && Object.hasOwn(reference, 'root'))
    ) {
      throw invalidPayload();
    }
    if (parsed.length === 0) {
      assertCanonicalReferenceRoot(reference.root);
      diagnostics.push({
        severity: 'error',
        code: 'OPENSPEC_REFERENCE_STORE_REJECTED',
        message:
          'OpenSpec resolved a reference store outside the repository diagnostic trust boundary.',
        target: 'references',
      });
    }
    identifiers.push(reference.store_id);
    diagnostics.push(...parsed);
  }
  assertUnique(identifiers);
  return diagnostics;
}

function assertCanonicalReferenceRoot(value: unknown): void {
  try {
    if (
      typeof value !== 'string' ||
      value !== path.resolve(value) ||
      !diagnosticText(value)
    ) {
      throw new Error('invalid reference root');
    }
    const stats = fs.lstatSync(value);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(value) !== value
    ) {
      throw new Error('non-canonical reference root');
    }
  } catch {
    throw invalidPayload();
  }
}

function parseDiagnostic(
  value: unknown,
  rules: Readonly<Record<string, DiagnosticRule>>,
): OpenSpecDiagnostic {
  const diagnostic = record(value);
  assertExactKeys(
    diagnostic,
    ['code', 'fix', 'message', 'severity', 'target'],
    ['fix', 'target'],
  );
  if (typeof diagnostic.code !== 'string') {
    throw invalidPayload();
  }
  const rule = rules[diagnostic.code];
  if (
    !rule ||
    diagnostic.severity !== rule.severity ||
    diagnostic.target !== rule.target ||
    !diagnosticText(diagnostic.message) ||
    (Object.hasOwn(diagnostic, 'fix') && !diagnosticText(diagnostic.fix))
  ) {
    throw invalidPayload();
  }
  return {
    severity: rule.severity,
    code: diagnostic.code,
    message: diagnostic.message as string,
    ...(rule.target ? { target: rule.target } : {}),
    ...(typeof diagnostic.fix === 'string' ? { fix: diagnostic.fix } : {}),
  };
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  optional: string[] = [],
): void {
  const keys = Object.keys(value);
  const required = allowed.filter((key) => !optional.includes(key));
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidPayload();
  }
}

function diagnosticText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8_192 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
  );
}
