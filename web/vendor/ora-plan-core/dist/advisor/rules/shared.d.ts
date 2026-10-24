import type { PlanNode } from '../../types.js';
/** Children of a node that belong to the executed plan (adaptive-plan rows that were not used are excluded). */
export declare function liveChildren(node: PlanNode): PlanNode[];
export declare const INDEX_SCAN_RE: RegExp;
export declare const FULL_SCAN_RE: RegExp;
export declare const TABLE_BY_ROWID_RE: RegExp;
export declare function isIndexScan(node: PlanNode): boolean;
export declare function isTableByRowid(node: PlanNode): boolean;
/**
 * Buffer gets this operation made itself. Buffers are cumulative (they include the children's),
 * so subtract them; the floor at 0 keeps sources whose per-line gets are already exclusive
 * from going negative (it can only under-report there, never over-report).
 */
export declare function selfBuffers(node: PlanNode): number | undefined;
/** Descendants of `node` (excluding it), skipping inactive adaptive-plan rows. */
export declare function liveDescendants(node: PlanNode): PlanNode[];
