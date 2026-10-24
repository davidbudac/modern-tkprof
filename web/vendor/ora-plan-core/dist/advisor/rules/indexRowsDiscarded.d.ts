import type { PlanNode } from '../../types.js';
import type { AdvisorThresholds } from '../config.js';
import type { AdvisorRule } from '../types.js';
export interface IndexDiscard {
    table: PlanNode;
    index: PlanNode;
    indexRows: number;
    tableRows: number;
    discarded: number;
}
/**
 * Table accesses by rowid that throw away most of what the index below them returned:
 * the index scan's A-Rows far exceed the table access's A-Rows and the table access
 * applies a filter. Both A-Rows are cumulative over all starts, so they compare directly.
 */
export declare function findIndexDiscards(nodes: PlanNode[], thresholds: AdvisorThresholds): IndexDiscard[];
export declare const indexRowsDiscardedRule: AdvisorRule;
