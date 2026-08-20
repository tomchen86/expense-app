import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
/**
 * A deliberately small language for saying what a scan hit looks like.
 *
 * A class disposition claims that a group of hits are the same kind of thing,
 * and the engine has to be able to recheck that claim later. The check runs
 * over the window stored with each hit, so it must terminate in time
 * proportional to the window — no backtracking, no alternation, no repetition.
 * The predicate is author-supplied and therefore untrusted input entering a
 * replay path; a regular expression would open a denial-of-service surface for
 * the sake of expressiveness nobody has needed yet.
 *
 * Every operator here is one scan of a bounded buffer, and the shape itself is
 * bounded, so evaluation cost has a ceiling that can be stated rather than
 * measured.
 */
export const HIT_PREDICATE_LIMITS = Object.freeze({
    maxDepth: 8,
    maxNodes: 64,
    maxLiteralBytes: 128,
});
const LEAF_OPERATORS = [
    'contains',
    'containsToken',
    'beforeMatchContains',
    'afterMatchContains',
];
export function parseHitPredicate(value) {
    const budget = { nodes: 0 };
    return parseNode(value, 0, budget);
}
/**
 * Whether the hit is one of the kind the predicate describes.
 *
 * A hit with no stored window satisfies nothing, including negations: a
 * path-surface hit has no text to quote, and letting `not` succeed on absent
 * evidence would admit exactly the hits that cannot be checked. A truncated
 * window can confirm what it contains but never that something is missing,
 * because the missing text may be in the bytes that were dropped.
 */
export function evaluateHitPredicate(predicate, subject) {
    const text = subject.window?.utf8;
    if (subject.window === null || text === null || text === undefined) {
        return false;
    }
    return evaluate(predicate, text, subject);
}
function evaluate(predicate, text, subject) {
    switch (predicate.kind) {
        case 'contains':
            return text.includes(predicate.literal);
        case 'containsToken':
            return containsToken(text, predicate.literal);
        case 'beforeMatchContains':
            return sliceBeforeMatch(text, subject).includes(predicate.literal);
        case 'afterMatchContains':
            return sliceAfterMatch(text, subject).includes(predicate.literal);
        case 'all':
            return predicate.operands.every((operand) => evaluate(operand, text, subject));
        case 'any':
            return predicate.operands.some((operand) => evaluate(operand, text, subject));
        case 'not':
            // Absence is only provable over text that was stored whole.
            return (subject.window?.truncated === false &&
                !evaluate(predicate.operand, text, subject));
    }
}
/** True when the literal appears not surrounded by identifier characters. */
function containsToken(text, literal) {
    let from = 0;
    for (;;) {
        const index = text.indexOf(literal, from);
        if (index === -1)
            return false;
        const before = index === 0 ? '' : text[index - 1];
        const after = text[index + literal.length] ?? '';
        if (!isIdentifierChar(before) && !isIdentifierChar(after))
            return true;
        from = index + 1;
    }
}
function isIdentifierChar(character) {
    return character !== '' && /[A-Za-z0-9_$]/.test(character);
}
function sliceBeforeMatch(text, subject) {
    const offset = subject.matchOffset - (subject.window?.byteOffset ?? 0);
    return offset <= 0 ? '' : text.slice(0, offset);
}
function sliceAfterMatch(text, subject) {
    const offset = subject.matchOffset -
        (subject.window?.byteOffset ?? 0) +
        subject.matchLength;
    return offset >= text.length ? '' : text.slice(offset);
}
function parseNode(value, depth, budget) {
    budget.nodes += 1;
    if (depth > HIT_PREDICATE_LIMITS.maxDepth) {
        throw predicateInvalid('Predicate is nested deeper than the limit.');
    }
    if (budget.nodes > HIT_PREDICATE_LIMITS.maxNodes) {
        throw predicateInvalid('Predicate declares more nodes than the limit.');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw predicateInvalid('Predicate node must be an object.');
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
        throw predicateInvalid('Predicate node declares exactly one operator.');
    }
    const [operator] = keys;
    const operand = value[operator];
    if (LEAF_OPERATORS.includes(operator)) {
        return Object.freeze({
            kind: operator,
            literal: assertLiteral(operand),
        });
    }
    if (operator === 'all' || operator === 'any') {
        if (!Array.isArray(operand)) {
            throw predicateInvalid(`Operator ${operator} takes a list.`);
        }
        return Object.freeze({
            kind: operator,
            operands: Object.freeze(operand.map((entry) => parseNode(entry, depth + 1, budget))),
        });
    }
    if (operator === 'not') {
        return Object.freeze({
            kind: 'not',
            operand: parseNode(operand, depth + 1, budget),
        });
    }
    throw predicateInvalid(`Unknown predicate operator ${operator}.`);
}
function assertLiteral(value) {
    if (typeof value !== 'string' ||
        value === '' ||
        Buffer.byteLength(value, 'utf8') > HIT_PREDICATE_LIMITS.maxLiteralBytes) {
        throw predicateInvalid('Predicate literal is empty or over the limit.');
    }
    return value;
}
function predicateInvalid(message) {
    return workflowError('HIT_PREDICATE_INVALID', message, ExitCode.usage);
}
