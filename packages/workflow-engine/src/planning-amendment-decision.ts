import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';

const MARKER_TOKEN = '<!-- workflow-plan-amendment.v1';
const MARKER_START = `${MARKER_TOKEN}\n`;
const MARKER_END = '\n-->';
const MAX_MARKER_BYTES = 8 * 1024;
const MAX_RATIONALE_BYTES = 4 * 1024;
const DECISION_KEYS = [
  'amendsPlanningGeneration',
  'decisionDigest',
  'executionImpact',
  'kind',
  'rationale',
  'reason',
  'schemaVersion',
] as const;

export type PlanningAmendmentDecision = Readonly<{
  schemaVersion: 1;
  kind: 'planning-amendment-decision';
  reason: string;
  executionImpact: 'none' | 'required';
  rationale: string;
  amendsPlanningGeneration: string;
  decisionDigest: string;
}>;

export type PlanningAmendmentDecisionInput = Omit<
  PlanningAmendmentDecision,
  'decisionDigest' | 'kind' | 'schemaVersion'
>;

export function createPlanningAmendmentDecision(
  input: PlanningAmendmentDecisionInput,
): PlanningAmendmentDecision {
  const payload = normalizePayload({
    schemaVersion: 1,
    kind: 'planning-amendment-decision',
    reason: input.reason,
    executionImpact: input.executionImpact,
    rationale: input.rationale,
    amendsPlanningGeneration: input.amendsPlanningGeneration,
  });
  return Object.freeze({
    ...payload,
    decisionDigest: decisionDigest(payload),
  });
}

export function planningAmendmentDecisionDigest(
  decision: PlanningAmendmentDecision,
): string {
  return normalizeDecision(decision).decisionDigest;
}

export function renderPlanningAmendmentDecisionMarker(
  decision: PlanningAmendmentDecision,
): string {
  const normalized = normalizeDecision(decision);
  return `${MARKER_START}${canonicalJson(normalized)}${MARKER_END}`;
}

export function readPlanningAmendmentDecision(
  proposal: string,
): PlanningAmendmentDecision | null {
  return locateDecision(proposal)?.decision ?? null;
}

/**
 * Authoring helper for the reviewed proposal artifact. It replaces one exact
 * prior marker or appends the first marker; malformed or duplicate markers are
 * never repaired silently because doing so could hide competing decisions.
 */
export function replacePlanningAmendmentDecisionMarker(
  proposal: string,
  decision: PlanningAmendmentDecision,
): string {
  assertProposalText(proposal);
  const rendered = renderPlanningAmendmentDecisionMarker(decision);
  const located = locateDecision(proposal);
  if (located === null) {
    const base = proposal.trimEnd();
    return `${base}${base === '' ? '' : '\n\n'}${rendered}\n`;
  }
  return `${proposal.slice(0, located.start)}${rendered}${proposal.slice(
    located.end,
  )}`;
}

function locateDecision(proposal: string): {
  decision: PlanningAmendmentDecision;
  start: number;
  end: number;
} | null {
  assertProposalText(proposal);
  const starts: number[] = [];
  for (
    let offset = proposal.indexOf(MARKER_TOKEN);
    offset !== -1;
    offset = proposal.indexOf(MARKER_TOKEN, offset + MARKER_TOKEN.length)
  ) {
    starts.push(offset);
  }
  if (starts.length === 0) return null;
  if (starts.length !== 1) throw decisionInvalid('duplicate marker');
  const start = starts[0]!;
  if (!proposal.startsWith(MARKER_START, start)) {
    throw decisionInvalid('marker header');
  }
  const bodyStart = start + MARKER_START.length;
  const bodyEnd = proposal.indexOf(MARKER_END, bodyStart);
  if (bodyEnd === -1) throw decisionInvalid('marker terminator');
  const end = bodyEnd + MARKER_END.length;
  if (
    Buffer.byteLength(proposal.slice(start, end), 'utf8') > MAX_MARKER_BYTES
  ) {
    throw decisionInvalid('marker size');
  }
  const body = proposal.slice(bodyStart, bodyEnd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw decisionInvalid('marker JSON');
  }
  const decision = normalizeDecision(parsed);
  if (body !== canonicalJson(decision)) {
    throw decisionInvalid('marker canonicalization');
  }
  return { decision, start, end };
}

function normalizeDecision(value: unknown): PlanningAmendmentDecision {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...DECISION_KEYS].sort()) ||
    typeof value.decisionDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.decisionDigest)
  ) {
    throw decisionInvalid('decision shape');
  }
  const { decisionDigest: claimedDigest, ...rawPayload } = value;
  const payload = normalizePayload(rawPayload);
  const expectedDigest = decisionDigest(payload);
  if (claimedDigest !== expectedDigest)
    throw decisionInvalid('decision digest');
  return Object.freeze({ ...payload, decisionDigest: expectedDigest });
}

function normalizePayload(
  value: unknown,
): Omit<PlanningAmendmentDecision, 'decisionDigest'> {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(DECISION_KEYS.filter((key) => key !== 'decisionDigest')) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'planning-amendment-decision' ||
    typeof value.reason !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.reason) ||
    !['none', 'required'].includes(String(value.executionImpact)) ||
    typeof value.rationale !== 'string' ||
    value.rationale.trim() !== value.rationale ||
    value.rationale.length === 0 ||
    Buffer.byteLength(value.rationale, 'utf8') > MAX_RATIONALE_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value.rationale) ||
    typeof value.amendsPlanningGeneration !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.amendsPlanningGeneration)
  ) {
    throw decisionInvalid('decision payload');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'planning-amendment-decision' as const,
    reason: value.reason,
    executionImpact: value.executionImpact as 'none' | 'required',
    rationale: value.rationale,
    amendsPlanningGeneration: value.amendsPlanningGeneration,
  });
}

function decisionDigest(
  payload: Omit<PlanningAmendmentDecision, 'decisionDigest'>,
): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex');
}

function assertProposalText(proposal: string): void {
  if (typeof proposal !== 'string' || proposal.includes('\u0000')) {
    throw decisionInvalid('proposal bytes');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decisionInvalid(detail: string) {
  return workflowError(
    'AMENDMENT_DECISION_INVALID',
    'The reviewed amendment decision marker is malformed or non-canonical.',
    ExitCode.guard,
    { details: { detail } },
  );
}
