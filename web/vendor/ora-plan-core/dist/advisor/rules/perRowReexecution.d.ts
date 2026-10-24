import type { AdvisorRule } from '../types.js';
/**
 * Work that is redone for every row of another row source: FILTER subqueries, scalar
 * subqueries in the select list, and remote operations driven per row. (Nested-loop
 * inner sides in general are covered by nested-loop-volume; this rule only adds the
 * remote case below them.)
 */
export declare const perRowReexecutionRule: AdvisorRule;
