import type { PlanNode } from '../../types.js';
/**
 * Predicate analysis shared by the index / partition rules: which columns of a
 * given table alias appear in a DBMS_XPLAN predicate, and in which of those
 * appearances an index (or partition pruning) can actually use the column.
 */
export type ColumnUseKind = 'sargable' | 'is-null' | 'unusable';
export interface ColumnUse {
    /** Upper-cased column name. */
    column: string;
    kind: ColumnUseKind;
}
/**
 * How each column of `alias` is used by the given predicates. A column can
 * appear more than once; a usable appearance wins over an unusable one.
 * Unqualified references count as the alias's own; qualified references to any
 * other alias (join keys, correlated subquery columns) are ignored.
 */
export declare function analyzeColumnUses(predicates: Array<string | undefined>, alias: string | undefined): ColumnUse[];
/** Every column of `alias` referenced by the predicates, whatever the form. */
export declare function referencedColumns(predicates: Array<string | undefined>, alias: string | undefined): string[];
/** `E@SEL$1` or `"E"@"SEL$1"` -> `E`. */
export declare function aliasFromObjectAlias(objectAlias: string | undefined): string | undefined;
/** Table name without owner or quotes, upper-cased: `HR.EMPLOYEES` -> `EMPLOYEES`. */
export declare function tableNameOf(objectName: string | undefined): string | undefined;
/**
 * The alias the operation scans its table under. Prefers the plan's object
 * alias; without one (no ALIAS section) it falls back to the table name when
 * predicates qualify by it, or to the only qualifier the predicates use.
 */
export declare function resolveNodeAlias(node: PlanNode, tableName?: string): string | undefined;
