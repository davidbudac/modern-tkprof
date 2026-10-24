export interface ConversionHit {
    fn: 'INTERNAL_FUNCTION' | 'TO_NUMBER' | 'TO_CHAR' | 'TO_DATE';
    column: string;
    fragment: string;
    source: 'access' | 'filter';
}
export declare function findImplicitConversions(access?: string, filter?: string): ConversionHit[];
export interface ColumnRef {
    /** Table alias the column is qualified with ("E" in "E"."ENAME"), when present. */
    alias?: string;
    column: string;
}
/**
 * Columns referenced by predicates. Oracle prints every column reference quoted
 * ("E"."SAL"), while functions, keywords and bind variables are not, so quoted
 * identifier runs are columns. Literals are blanked first so quotes inside them
 * can't produce false hits. Results are de-duplicated by alias + column.
 */
export declare function extractQuotedColumns(...predicates: Array<string | undefined>): ColumnRef[];
export interface FunctionWrapHit extends ColumnRef {
    fn: string;
    fragment: string;
    source: 'access' | 'filter';
}
/** Columns that appear as the first argument of a function in a predicate (UPPER("E"."ENAME")='X'). */
export declare function findFunctionWrappedColumns(access?: string, filter?: string): FunctionWrapHit[];
