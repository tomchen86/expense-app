import crypto from 'node:crypto';
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { parseTasks, } from "../../consumer/expense-app/work-registry/contracts.js";
import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
import { commitFacts } from "../../../runtime/repository-transaction/git-transitions.js";
import { runGit, runGitBuffer, } from "../../../runtime/repository-transaction/git.js";
import { ManagedTrailerSyntaxError, parseManagedTrailers, } from "../../../modules/lifecycle/managed-trailers.js";
import { normalizeChangedPath } from "../../../runtime/session-workspace/paths.js";
/**
 * The single change whose authored plan predates investigation-first planning.
 * The migration is deliberately not a general capability: a legacy plan may be
 * carried onto the v2 schema exactly once, for the change that introduces the
 * schema, and the migrated artifact records `legacyMigration: true` so nothing
 * claims investigation preceded that plan's cognition.
 */
export const LEGACY_MIGRATION_CHANGE_ID = 'establish-investigation-first-planning';
/**
 * Legacy artifacts the migration regenerates in place. `.openspec.yaml` gains
 * the v2 schema selection, `design.md` gains the engine-owned investigation
 * ledger, and `guard.json` is normalized into the canonical v2 encoding. Every
 * other governed legacy artifact is preserved byte for byte.
 */
export const LEGACY_MIGRATION_REPLACED_ARTIFACTS = [
    '.openspec.yaml',
    'design.md',
    'guard.json',
];
export const LEGACY_MIGRATION_POLICY_DIGEST = sha256(canonicalJson({
    schema: 'workflow-legacy-plan-migration-policy.v1',
    changeId: LEGACY_MIGRATION_CHANGE_ID,
    legacySchemaName: 'expense-app',
    /**
     * The artifacts the migration may replace. Everything else in the governed
     * legacy tree is preserved byte for byte, which is what makes "preserved
     * checkbox projection" a structural property rather than a promise.
     */
    replacedArtifacts: LEGACY_MIGRATION_REPLACED_ARTIFACTS,
}));
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Artifacts the migration preserves exactly. `guard.json` is excluded because
 * the v2 grammar stores it canonically; its *semantic* content is pinned by
 * `guardDigest` instead.
 */
function preservedRelativePaths(repositoryRoot, commit, changePrefix) {
    const specs = listTreePaths(repositoryRoot, commit, `${changePrefix}/specs`)
        .map((treePath) => treePath.slice(`${changePrefix}/`.length))
        .sort();
    return ['proposal.md', 'tasks.md', ...specs];
}
/**
 * Resolve the exact pre-activation legacy generation this change may migrate.
 *
 * Eligibility is derived from managed Git history rather than from the working
 * tree: the change must currently declare the legacy schema, and an immutable
 * `Transition: plan` generation must be reachable from the pinned baseline.
 */
export function deriveLegacyPlanMigrationSubject(input) {
    const { repositoryRoot, changeRoot, changeId, baseline } = input;
    if (changeId !== LEGACY_MIGRATION_CHANGE_ID) {
        throw notEligible(`Only ${LEGACY_MIGRATION_CHANGE_ID} may migrate a legacy plan.`);
    }
    if (!COMMIT.test(baseline.head) || !COMMIT.test(baseline.tree)) {
        throw notEligible('Legacy migration requires an exact pinned baseline.');
    }
    const changePrefix = `${changeRoot}/${changeId}`;
    const metadata = readTextAtCommit(repositoryRoot, baseline.head, `${changePrefix}/.openspec.yaml`);
    if (metadata === null) {
        throw notEligible('Legacy migration requires a committed legacy change tree.');
    }
    const legacyMetadata = parseLegacyMetadata(metadata);
    const governingCommit = resolveGoverningLegacyGeneration(repositoryRoot, changeId, baseline.head);
    if (readTextAtCommit(repositoryRoot, governingCommit, `${changePrefix}/.openspec.yaml`) !== metadata) {
        throw notEligible('Legacy change metadata drifted from its governing generation.');
    }
    const tasksMarkdown = readTextAtCommit(repositoryRoot, baseline.head, `${changePrefix}/tasks.md`);
    const guardJson = readTextAtCommit(repositoryRoot, baseline.head, `${changePrefix}/guard.json`);
    if (tasksMarkdown === null || guardJson === null) {
        throw notEligible('Legacy migration requires committed legacy tasks and guard artifacts.');
    }
    const taskProjection = parseTasks(tasksMarkdown).map(({ id, completed }) => ({
        id,
        completed,
    }));
    if (taskProjection.length === 0) {
        throw notEligible('The legacy plan declares no tasks to preserve.');
    }
    let guard;
    try {
        guard = JSON.parse(guardJson);
    }
    catch {
        throw notEligible('The legacy guard artifact is not valid JSON.');
    }
    const digestAtBaseline = (relativePath) => {
        const content = readTextAtCommit(repositoryRoot, baseline.head, `${changePrefix}/${relativePath}`);
        if (content === null) {
            throw notEligible(`The governed legacy plan is missing ${relativePath}.`);
        }
        return [relativePath, sha256(content)];
    };
    const preservedArtifactDigests = Object.fromEntries(preservedRelativePaths(repositoryRoot, baseline.head, changePrefix).map(digestAtBaseline));
    const replacedArtifactDigests = Object.fromEntries(LEGACY_MIGRATION_REPLACED_ARTIFACTS.map(digestAtBaseline));
    return finalizeSubject({
        schemaVersion: 1,
        kind: 'legacy-plan-migration',
        changeId,
        legacySchemaName: 'expense-app',
        legacyCreated: legacyMetadata.created,
        governingCommit,
        baseline: { head: baseline.head, tree: baseline.tree },
        taskProjection,
        preservedArtifactDigests,
        replacedArtifactDigests,
        guardDigest: sha256(canonicalJson(guard)),
        policyDigest: LEGACY_MIGRATION_POLICY_DIGEST,
    });
}
/**
 * Validate a migration subject read back from durable authorization evidence.
 * The digest is recomputed, so a rewritten subject cannot widen what the
 * migration is allowed to replace.
 */
export function assertLegacyPlanMigrationSubject(value) {
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'legacy-plan-migration' ||
        value.changeId !== LEGACY_MIGRATION_CHANGE_ID ||
        value.legacySchemaName !== 'expense-app' ||
        typeof value.legacyCreated !== 'string' ||
        !CANONICAL_DATE.test(value.legacyCreated) ||
        typeof value.governingCommit !== 'string' ||
        !COMMIT.test(value.governingCommit) ||
        !isRecord(value.baseline) ||
        typeof value.baseline.head !== 'string' ||
        !COMMIT.test(value.baseline.head) ||
        typeof value.baseline.tree !== 'string' ||
        !COMMIT.test(value.baseline.tree) ||
        !Array.isArray(value.taskProjection) ||
        value.taskProjection.length === 0 ||
        !value.taskProjection.every((task) => isRecord(task) &&
            typeof task.id === 'string' &&
            task.id.length > 0 &&
            typeof task.completed === 'boolean') ||
        !isDigestRecord(value.preservedArtifactDigests) ||
        !isDigestRecord(value.replacedArtifactDigests) ||
        LEGACY_MIGRATION_REPLACED_ARTIFACTS.some((relativePath) => !Object.hasOwn(value.replacedArtifactDigests, relativePath)) ||
        typeof value.guardDigest !== 'string' ||
        !DIGEST.test(value.guardDigest) ||
        value.policyDigest !== LEGACY_MIGRATION_POLICY_DIGEST ||
        typeof value.subjectDigest !== 'string') {
        throw subjectInvalid();
    }
    const candidate = value;
    const expected = finalizeSubject({
        schemaVersion: 1,
        kind: 'legacy-plan-migration',
        changeId: candidate.changeId,
        legacySchemaName: 'expense-app',
        legacyCreated: candidate.legacyCreated,
        governingCommit: candidate.governingCommit,
        baseline: candidate.baseline,
        taskProjection: candidate.taskProjection.map(({ id, completed }) => ({
            id,
            completed,
        })),
        preservedArtifactDigests: candidate.preservedArtifactDigests,
        replacedArtifactDigests: candidate.replacedArtifactDigests,
        guardDigest: candidate.guardDigest,
        policyDigest: candidate.policyDigest,
    });
    if (canonicalJson(expected) !== canonicalJson(candidate)) {
        throw subjectInvalid();
    }
    return expected;
}
/**
 * The metadata bytes the migration materializes: the v2 schema selection with
 * the legacy creation date preserved, because the change was not created today.
 */
export function legacyMigrationMetadataBytes(subject) {
    return `schema: expense-app-v2\ncreated: ${subject.legacyCreated}\n`;
}
/**
 * True when `existing` are the exact governed legacy bytes this migration is
 * authorized to regenerate. Anything else — an unmanaged edit, a different
 * artifact, a partially applied projection — is not replaceable and the
 * migration fails closed rather than overwriting it.
 */
export function isReplaceableLegacyArtifact(subject, relativePath, existing) {
    const digest = subject.replacedArtifactDigests[relativePath];
    return digest !== undefined && sha256(existing) === digest;
}
/**
 * Reject any planning contribution that would re-author governed legacy bytes
 * or move a checkbox. A legacy migration is a schema transition, not an
 * opportunity to rewrite the plan or to record task completion.
 */
export function assertPreservedLegacyProjection(input) {
    const { subject, tasks, guard, entries } = input;
    if (canonicalJson(tasks.map(({ id, completed }) => ({ id, completed }))) !==
        canonicalJson(subject.taskProjection)) {
        throw projectionInvalid('A legacy migration must preserve the exact committed checkbox projection.');
    }
    if (sha256(canonicalJson(guard)) !== subject.guardDigest) {
        throw projectionInvalid('A legacy migration must preserve the governed task guard.');
    }
    for (const [relativePath, expectedDigest] of Object.entries(subject.preservedArtifactDigests)) {
        const content = entries.get(relativePath);
        if (content === undefined || sha256(content) !== expectedDigest) {
            throw projectionInvalid(`A legacy migration must preserve ${relativePath} exactly.`);
        }
    }
    for (const relativePath of entries.keys()) {
        if (relativePath.startsWith('specs/') &&
            !Object.hasOwn(subject.preservedArtifactDigests, relativePath)) {
            throw projectionInvalid(`A legacy migration must not add ${relativePath} to the governed plan.`);
        }
    }
}
function resolveGoverningLegacyGeneration(repositoryRoot, changeId, head) {
    const commits = runGit(repositoryRoot, ['rev-list', head])
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    for (const commit of commits) {
        let trailers;
        try {
            trailers = parseManagedTrailers(commitFacts(repositoryRoot, commit).message);
        }
        catch (error) {
            if (error instanceof ManagedTrailerSyntaxError) {
                continue;
            }
            throw error;
        }
        if (trailers?.kind === 'plan' &&
            trailers.changeId === changeId &&
            trailers.transition === 'plan') {
            return commit;
        }
    }
    throw workflowError('LEGACY_MIGRATION_GENERATION_MISSING', 'No immutable governing legacy plan generation is reachable from the baseline.', ExitCode.guard);
}
function parseLegacyMetadata(text) {
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
    const fields = new Map();
    for (const line of lines) {
        const match = /^([a-z][a-z0-9-]*): ([^\s].*)$/.exec(line);
        if (!match || fields.has(match[1])) {
            throw notEligible('The legacy change metadata is not canonical.');
        }
        fields.set(match[1], match[2]);
    }
    const created = fields.get('created') ?? '';
    if (fields.size !== 2 ||
        fields.get('schema') !== 'expense-app' ||
        !CANONICAL_DATE.test(created)) {
        throw notEligible('Legacy migration requires a change that currently declares expense-app.');
    }
    return { created };
}
function listTreePaths(repositoryRoot, commit, prefix) {
    return runGit(repositoryRoot, [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        commit,
        '--',
        `:(literal)${prefix}`,
    ])
        .split('\0')
        .filter(Boolean)
        .map(normalizeChangedPath);
}
function readTextAtCommit(repositoryRoot, commit, filePath) {
    const entry = runGit(repositoryRoot, ['ls-tree', '-z', commit, '--', `:(literal)${filePath}`], true);
    if (!entry.trim()) {
        return null;
    }
    const content = runGitBuffer(repositoryRoot, [
        'show',
        `${commit}:${filePath}`,
    ]);
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    }
    catch {
        throw notEligible('Governed legacy planning artifacts must be UTF-8 text.');
    }
    return text;
}
function finalizeSubject(subject) {
    return { ...subject, subjectDigest: sha256(canonicalJson(subject)) };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isDigestRecord(value) {
    return (isRecord(value) &&
        Object.keys(value).length > 0 &&
        Object.values(value).every((digest) => typeof digest === 'string' && DIGEST.test(digest)));
}
function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function notEligible(message) {
    return workflowError('LEGACY_MIGRATION_NOT_ELIGIBLE', message, ExitCode.guard);
}
function subjectInvalid() {
    return workflowError('LEGACY_MIGRATION_SUBJECT_INVALID', 'The durable legacy migration subject is not the exact authorized subject.', ExitCode.staleState);
}
function projectionInvalid(message) {
    return workflowError('LEGACY_MIGRATION_PROJECTION_INVALID', message, ExitCode.guard);
}
