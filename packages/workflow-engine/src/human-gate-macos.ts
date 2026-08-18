import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { canonicalJson } from './canonical-json.ts';
import { isRecord } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { VerifiedApprovalProof } from './grant-approval.ts';
import type {
  GrantApprovalSession,
  GrantAuthenticationRequest,
  GrantHumanDecision,
  TrustedGrantPresentation,
} from './grant-coordinator.ts';
import {
  copyGrantDate,
  freezeGrantCanonical,
  GRANT_SESSION_NONCE,
  GRANT_SHA256_DIGEST,
  GRANT_STABLE_ID,
  GRANT_UUID_V4,
  grantHasExactKeys,
  grantSha256,
  parseGrantTimestamp,
} from './grant-primitives.ts';

const MAX_PROTOCOL_BYTES = 262_144;
const MAX_PROOF_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const NATIVE_EXECUTABLE =
  'packages/workflow-engine/native/human-gate-macos/bin/human-gate';

export const HUMAN_GATE_MACOS_PROTOCOL_VERSION = 1 as const;

export type MacOsHumanGateRuntime = Readonly<{
  protocolVersion: 1;
  executablePath: string;
}>;

export function inspectMacOsHumanGateRuntime(
  repositoryRoot: string,
): MacOsHumanGateRuntime {
  assertMacOs();
  const executablePath = nativeExecutablePath(repositoryRoot);
  const executable = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (
    !executable?.isFile() ||
    executable.isSymbolicLink() ||
    (executable.mode & 0o111) === 0 ||
    executable.size < 1 ||
    executable.size > 2 * 1024 * 1024
  ) {
    throw humanGateInvalid(
      'HUMAN_GATE_UNAVAILABLE',
      'The fixed macOS Human Gate executable is missing or unsafe.',
    );
  }
  return freezeGrantCanonical({
    protocolVersion: HUMAN_GATE_MACOS_PROTOCOL_VERSION,
    executablePath,
  });
}

export function openMacOsHumanGateApprovalSession(
  repositoryRoot: string,
  presentation: TrustedGrantPresentation,
): GrantApprovalSession {
  const runtime = inspectMacOsHumanGateRuntime(repositoryRoot);
  const sessionId = crypto.randomUUID();
  const child = spawn(runtime.executablePath, [], {
    cwd: '/',
    env: humanGateRuntimeEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const channel = createHumanGateProcessChannel(child);
  const initialWrite = channel.write(
    `${canonicalJson({
      schemaVersion: HUMAN_GATE_MACOS_PROTOCOL_VERSION,
      kind: 'human-gate-macos-presentation.v1',
      sessionId,
      challengeDigest: presentation.challenge.challengeDigest,
      failureCode: presentation.failureCode,
      factsDocument: canonicalJson(presentation.facts),
      expiresAt: presentation.expiresAt,
      approvalMethods: presentation.approvalMethods,
      choices: presentation.choices,
    })}\n`,
  );
  let decision: GrantHumanDecision | null = null;
  let authenticated = false;

  return Object.freeze({
    async collectDecision() {
      await initialWrite;
      if (decision !== null) {
        throw humanGateInvalid(
          'HUMAN_GATE_PROTOCOL_INVALID',
          'macOS Human Gate decision was requested more than once.',
        );
      }
      decision = parseHumanGateDecisionDocument(await channel.read(), {
        sessionId,
        challengeDigest: presentation.challenge.challengeDigest,
      });
      const selected = presentation.choices.find(
        ({ choiceId }) => choiceId === decision?.choiceId,
      );
      if (
        selected === undefined ||
        !presentation.approvalMethods.includes(decision.approvalMethod) ||
        !selected.allowedReasonCodes.includes(decision.reasonCode) ||
        (selected.reasonRequired && decision.reason.length < 1)
      ) {
        throw humanGateInvalid(
          'HUMAN_GATE_PROTOCOL_INVALID',
          'macOS Human Gate selected an unavailable method, transition, or reason.',
        );
      }
      return decision;
    },

    async authenticate(request: GrantAuthenticationRequest) {
      if (
        decision === null ||
        authenticated ||
        decision.approvalMethod !== 'human-presence'
      ) {
        throw humanGateInvalid(
          'HUMAN_GATE_PROTOCOL_INVALID',
          'macOS Human Gate authentication is out of sequence.',
        );
      }
      assertAuthenticationMatchesDecision(
        request,
        decision,
        presentation.challenge.challengeDigest,
      );
      await channel.write(
        `${canonicalJson({
          schemaVersion: HUMAN_GATE_MACOS_PROTOCOL_VERSION,
          kind: 'human-gate-macos-authenticate.v1',
          sessionId,
          approvalSubjectDocument: canonicalJson(request.approvalSubject),
          approvalSubjectDigest: request.approvalSubjectDigest,
        })}\n`,
      );
      const proof = verifyHumanGateProofDocument(await channel.read(), {
        approvalSubjectDigest: request.approvalSubjectDigest,
        sessionNonce: decision.sessionNonce,
        now: new Date(),
      });
      authenticated = true;
      return [proof];
    },

    async close() {
      await channel.close();
    },
  });
}

export function parseHumanGateDecisionDocument(
  document: string,
  expected: Readonly<{
    sessionId: string;
    challengeDigest: `sha256:${string}`;
  }>,
): GrantHumanDecision {
  const value = parseProtocolDocument(document, 'HUMAN_GATE_PROTOCOL_INVALID');
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'sessionId',
      'challengeDigest',
      'choiceId',
      'approvalMethod',
      'reasonCode',
      'reason',
      'sessionNonce',
    ]) ||
    value.schemaVersion !== HUMAN_GATE_MACOS_PROTOCOL_VERSION ||
    value.kind !== 'human-gate-macos-decision.v1' ||
    typeof value.sessionId !== 'string' ||
    !GRANT_UUID_V4.test(value.sessionId) ||
    value.sessionId !== expected.sessionId ||
    typeof value.challengeDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.challengeDigest) ||
    value.challengeDigest !== expected.challengeDigest ||
    typeof value.choiceId !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.choiceId) ||
    (value.approvalMethod !== 'human-presence' &&
      value.approvalMethod !== 'ssh') ||
    typeof value.reasonCode !== 'string' ||
    !GRANT_STABLE_ID.test(value.reasonCode) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length > 2_048 ||
    /[\0\r]/.test(value.reason) ||
    typeof value.sessionNonce !== 'string' ||
    !GRANT_SESSION_NONCE.test(value.sessionNonce)
  ) {
    throw humanGateInvalid(
      'HUMAN_GATE_PROTOCOL_INVALID',
      'macOS Human Gate returned a malformed or mismatched decision.',
    );
  }
  return freezeGrantCanonical({
    choiceId: value.choiceId,
    approvalMethod: value.approvalMethod,
    reasonCode: value.reasonCode,
    reason: value.reason,
    sessionNonce: value.sessionNonce,
  });
}

export function verifyHumanGateProofDocument(
  document: string,
  expected: Readonly<{
    approvalSubjectDigest: `sha256:${string}`;
    sessionNonce: string;
    now: Date;
  }>,
): VerifiedApprovalProof {
  const value = parseProtocolDocument(document, 'HUMAN_GATE_PROOF_INVALID');
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'moduleId',
      'version',
      'approvalSubjectDigest',
      'sessionNonce',
      'authenticatedAt',
      'authorityClass',
      'identity',
      'identityAssurance',
      'presenceAssurance',
      'authenticationPolicy',
    ]) ||
    value.schemaVersion !== HUMAN_GATE_MACOS_PROTOCOL_VERSION ||
    value.kind !== 'human-gate-macos-proof.v1' ||
    value.moduleId !== 'human-gate-macos' ||
    value.version !== '1' ||
    value.approvalSubjectDigest !== expected.approvalSubjectDigest ||
    value.sessionNonce !== expected.sessionNonce ||
    value.authorityClass !== 'local-device-owner' ||
    value.identity !== null ||
    value.identityAssurance !== 'not-asserted' ||
    value.presenceAssurance !== 'fresh-os-authentication' ||
    value.authenticationPolicy !== 'device-owner-authentication'
  ) {
    throw humanGateInvalid(
      'HUMAN_GATE_PROOF_INVALID',
      'macOS Human Gate proof is malformed or subject-mismatched.',
    );
  }
  const now = copyGrantDate(expected.now);
  const authenticatedAt = parseGrantTimestamp(value.authenticatedAt);
  if (
    now === null ||
    authenticatedAt === null ||
    authenticatedAt.getTime() < now.getTime() - MAX_PROOF_AGE_MS ||
    authenticatedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS
  ) {
    throw humanGateInvalid(
      'HUMAN_GATE_PROOF_INVALID',
      'macOS Human Gate proof is not fresh.',
    );
  }
  return freezeGrantCanonical({
    moduleId: 'human-gate-macos',
    version: '1',
    claims: ['fresh-local-device-owner'],
    approvalSubjectDigest: expected.approvalSubjectDigest,
    proofDigest: grantSha256(canonicalJson(value)),
    verifiedAt: authenticatedAt.toISOString(),
    identity: null,
  });
}

function parseProtocolDocument(document: string, code: string): unknown {
  if (
    typeof document !== 'string' ||
    Buffer.byteLength(document) > MAX_PROTOCOL_BYTES ||
    !document.endsWith('\n') ||
    document.slice(0, -1).includes('\n')
  ) {
    throw humanGateInvalid(code, 'macOS Human Gate protocol is invalid.');
  }
  try {
    return JSON.parse(document);
  } catch {
    throw humanGateInvalid(code, 'macOS Human Gate protocol is invalid.');
  }
}

function assertAuthenticationMatchesDecision(
  request: GrantAuthenticationRequest,
  decision: GrantHumanDecision,
  challengeDigest: `sha256:${string}`,
): void {
  const subject = request.approvalSubject;
  if (
    subject.challengeDigest !== challengeDigest ||
    subject.choiceId !== decision.choiceId ||
    subject.approvalMethod !== decision.approvalMethod ||
    subject.reasonCode !== decision.reasonCode ||
    subject.reason !== decision.reason ||
    subject.sessionNonce !== decision.sessionNonce ||
    grantSha256(canonicalJson(subject)) !== request.approvalSubjectDigest
  ) {
    throw humanGateInvalid(
      'HUMAN_GATE_PROTOCOL_INVALID',
      'Approval subject does not match the visible Human Gate decision.',
    );
  }
}

function createHumanGateProcessChannel(
  child: ChildProcessWithoutNullStreams,
): Readonly<{
  write(document: string): Promise<void>;
  read(): Promise<string>;
  close(): Promise<void>;
}> {
  const lines: string[] = [];
  const readers: Array<{
    resolve(value: string): void;
    reject(error: Error): void;
  }> = [];
  let closed = false;
  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  let stderr = '';
  const lineReader = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length);
  });
  child.stdin.on('error', () => undefined);
  lineReader.on('line', (line) => {
    const next = readers.shift();
    if (next) next.resolve(`${line}\n`);
    else lines.push(`${line}\n`);
  });
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve();
    });
    child.once('exit', (code) => {
      exitCode = code;
      resolve();
    });
  });
  lineReader.once('close', async () => {
    await exited;
    closed = true;
    while (readers.length > 0) {
      readers.shift()!.reject(processFailure(exitCode, spawnError, stderr));
    }
  });

  return Object.freeze({
    async write(document) {
      if (
        closed ||
        typeof document !== 'string' ||
        Buffer.byteLength(document) > MAX_PROTOCOL_BYTES ||
        !document.endsWith('\n') ||
        document.slice(0, -1).includes('\n')
      ) {
        throw humanGateInvalid(
          'HUMAN_GATE_PROTOCOL_INVALID',
          'macOS Human Gate request is invalid.',
        );
      }
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(document, 'utf8', (error) => {
          if (error) reject(processFailure(exitCode, error, stderr));
          else resolve();
        });
      });
    },

    async read() {
      const available = lines.shift();
      if (available !== undefined) return available;
      if (closed) throw processFailure(exitCode, spawnError, stderr);
      return new Promise<string>((resolve, reject) => {
        readers.push({ resolve, reject });
      });
    },

    async close() {
      if (!child.stdin.destroyed) child.stdin.end();
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      lineReader.close();
    },
  });
}

function processFailure(
  exitCode: number | null,
  spawnError: Error | null,
  stderr: string,
): Error {
  if (exitCode === 21) {
    return humanGateInvalid(
      'HUMAN_GATE_CANCELLED',
      'The human cancelled the Human Gate decision.',
    );
  }
  const detail = stderr.trim().slice(0, 512);
  return workflowError(
    'HUMAN_GATE_FAILED',
    detail
      ? `macOS Human Gate failed: ${detail}`
      : `macOS Human Gate failed${spawnError ? `: ${spawnError.message}` : '.'}`,
    ExitCode.guard,
  );
}

function humanGateRuntimeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
  for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR'] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function nativeExecutablePath(repositoryRoot: string): string {
  return path.join(path.resolve(repositoryRoot), NATIVE_EXECUTABLE);
}

function assertMacOs(): void {
  if (process.platform !== 'darwin') {
    throw humanGateInvalid(
      'HUMAN_GATE_UNAVAILABLE',
      'The default Human Gate requires macOS device-owner authentication.',
    );
  }
}

function humanGateInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
