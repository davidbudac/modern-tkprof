/**
 * Parsers for the trailing sections of DBMS_XPLAN text output that attach data to plan
 * operations by Id: "Predicate Information" and "Query Block Name / Object Alias".
 * Shared by the DBMS_XPLAN and SQL Monitor text parsers.
 */
export interface NodePredicates {
    access?: string;
    filter?: string;
    /** Exadata smart-scan predicates, printed as `storage(...)`. */
    storage?: string;
}
export interface NodeQueryBlock {
    queryBlock?: string;
    objectAlias?: string;
}
/**
 * Parse the "Predicate Information" section into per-operation access / filter / storage
 * predicate text (outer `access(` … `)` stripped, wrapped lines joined with one space).
 *
 * - `<id> - access|filter|storage(` starts a predicate for that id;
 * - an Id-less line beginning with `access(`, `filter(` or `storage(` starts another
 *   predicate for the current id;
 * - any other non-empty line continues the open predicate;
 * - a predicate ends when its parentheses balance (quoted text excluded);
 * - the same type twice for one id is joined with ` AND `;
 * - the next section header ends the section.
 */
export declare function parsePredicateSection(lines: string[]): Map<number, NodePredicates>;
/**
 * Parse the "Query Block Name / Object Alias" section into per-operation query block and
 * object alias (`   2 - SET$1        / O@SEL$1`). Quotes around names are stripped so the
 * values agree with the SQL Monitor XML parser.
 */
export declare function parseQueryBlockSection(lines: string[]): Map<number, NodeQueryBlock>;
