import type { ParsedPlan, PlanNode, SqlMonitorMetadata } from './types.js';
export type PartitionPruning = 'static' | 'runtime' | 'none';
/**
 * Assess partition pruning behavior for a node based on its Pstart/Pstop columns.
 * Returns undefined when the node has neither pstart nor pstop.
 */
export declare function assessPartitionPruning(node: PlanNode): PartitionPruning | undefined;
export interface ParallelSignal {
    nodeId: number;
    kind: 'broadcast-large' | 'serial-point';
    reason: string;
}
export declare const BROADCAST_LARGE_ROWS = 100000;
/**
 * Detect notable parallel-execution signals in a plan:
 *  - broadcast-large: a PX SEND BROADCAST redistributing a large row count
 *  - serial-point: a P->S transition that isn't the final send to the QC
 */
export declare function computeParallelSignals(plan: ParsedPlan): ParallelSignal[];
/**
 * Determine whether the requested degree of parallelism was downgraded at
 * runtime (fewer PX servers allocated than requested).
 */
export declare function getDopDowngrade(meta?: SqlMonitorMetadata): {
    requested: number;
    allocated: number;
} | null;
