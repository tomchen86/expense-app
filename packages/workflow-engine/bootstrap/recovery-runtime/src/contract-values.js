export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isStringArray(value) {
    return (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}
