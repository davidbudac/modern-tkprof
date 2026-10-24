/** Children of a node that belong to the executed plan (adaptive-plan rows that were not used are excluded). */
export function liveChildren(node) {
    return node.children.filter((c) => !c.inactive);
}
export const INDEX_SCAN_RE = /^INDEX\b.*\bSCAN\b/;
export const FULL_SCAN_RE = /TABLE ACCESS (STORAGE )?FULL/;
export const TABLE_BY_ROWID_RE = /^TABLE ACCESS BY (?:(?:LOCAL|GLOBAL) )?INDEX ROWID/;
export function isIndexScan(node) {
    return INDEX_SCAN_RE.test(node.operation.toUpperCase());
}
export function isTableByRowid(node) {
    return TABLE_BY_ROWID_RE.test(node.operation.toUpperCase());
}
/**
 * Buffer gets this operation made itself. Buffers are cumulative (they include the children's),
 * so subtract them; the floor at 0 keeps sources whose per-line gets are already exclusive
 * from going negative (it can only under-report there, never over-report).
 */
export function selfBuffers(node) {
    if (node.logicalReads === undefined)
        return undefined;
    const childGets = liveChildren(node).reduce((sum, c) => sum + (c.logicalReads ?? 0), 0);
    return Math.max(0, node.logicalReads - childGets);
}
/** Descendants of `node` (excluding it), skipping inactive adaptive-plan rows. */
export function liveDescendants(node) {
    const out = [];
    const walk = (n) => {
        for (const c of liveChildren(n)) {
            out.push(c);
            walk(c);
        }
    };
    walk(node);
    return out;
}
