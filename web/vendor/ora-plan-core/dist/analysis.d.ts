import type { ParsedPlan, PlanNode } from './types.js';
/** Depth-first walk over a plan tree (parent before children). */
export declare function walkPlanTree(root: PlanNode, visit: (node: PlanNode) => void): void;
/**
 * The children whose work a node really waits on: each active child as is, and for an
 * inactive child (an adaptive-plan row the optimizer did not use) the effective children
 * below it instead. Cumulative cost/time of an active node under an inactive one still
 * flows to the nearest active ancestor this way.
 */
export declare function effectiveChildren(node: PlanNode): PlanNode[];
/**
 * Derive per-operation self time from A-Time and normalize A-Time semantics
 * across sources. Runs once per parse, in place.
 *
 * Oracle reports A-Time cumulatively (a parent's time includes its children),
 * which makes "sort by A-Time" surface one hot leaf plus its entire ancestor
 * chain. Self time (own work only) is what hotspot ranking needs.
 *
 * - Cumulative sources (dbms_xplan, sql_monitor, json):
 *   selfTime = max(0, actualTime − Σ children.actualTime). The clamp absorbs
 *   parallel-execution and rounding artifacts where children exceed the parent.
 * - XBI: the parser stores SELF elapsed time in actualTime for every row
 *   EXCEPT the root, whose ">>> Plan totals >>>" row already carries the plan
 *   total (children's self times sum to it). Non-root actualTime is rolled up
 *   bottom-up to cumulative (matching the other sources), the root is derived
 *   like a cumulative source, and activityPercent is recomputed from self time.
 */
export declare function computeSelfTimes(plan: ParsedPlan): void;
/**
 * Derive `estimatedRowsTotal` — the optimizer's row estimate over ALL starts —
 * so it can be compared with A-Rows. Runs once per parse, in place.
 *
 * Oracle's E-Rows is the estimate PER EXECUTION while A-Rows is cumulative over
 * every start, so a naive A-Rows / E-Rows makes each nested-loop inner side
 * look like a huge underestimate. The total is E-Rows × the number of
 * executions, where the multiplier is found by walking up from a "base" node:
 * - never started (Starts = 0): no signal, left undefined;
 * - rowid-source shapes: with nested-loop batching (or a BATCHED rowid fetch)
 *   the table-by-rowid line's E-Rows is per OUTER ROW, i.e. per start of the
 *   index scan feeding the join, not per rowid start. The base is then that
 *   index line (the last child of the inner nested loop) instead of the node;
 * - a probe side (a child other than the first of a NESTED LOOPS / FILTER)
 *   re-executes: multiplier = the base's own Starts;
 * - under a partition iterator (the topmost op of a contiguous PARTITION run
 *   above the base, reached before any probe side) child Starts count
 *   partitions, not executions: multiplier = that iterator's Starts;
 * - inside a parallel slave set (tq / in-out set, or a `PX …` ancestor), E-Rows
 *   is already global and Starts counts slaves/granules, so a node that is not
 *   on a probe side gets multiplier 1 (Starts and A-Rows of a probe side are
 *   summed over slaves, so those still use E-Rows × Starts);
 * - below a COUNT STOPKEY where fewer rows than estimated were produced: early
 *   termination, not a misestimate, left undefined.
 * Values already set by a parser (e.g. XBI) are kept.
 */
export declare function computeEstimatedRowTotals(plan: ParsedPlan): void;
/**
 * The plan's total optimizer cost. Oracle cost is already cumulative, so the
 * root's cost is the total; falls back to the largest node cost when the root
 * has none, and 0 when no node has a cost.
 */
export declare function planRootCost(root: PlanNode | null, allNodes: PlanNode[]): number;
/**
 * Derive per-operation self cost: max(0, cost − Σ children cost), for nodes
 * with a defined cost. Runs once per parse, in place. Inactive adaptive-plan
 * rows get none, and their active descendants count as the children of the
 * nearest active ancestor (`effectiveChildren`).
 */
export declare function computeSelfCosts(plan: ParsedPlan): void;
/**
 * Whether time ranking should use ASH activity: SQL Monitor sources, where
 * A-Time active windows overlap so derived self time is meaningless, and at
 * least one non-root node has an ASH activity share.
 */
export declare function usesActivityRanking(plan: ParsedPlan): boolean;
/**
 * Non-root nodes ranked by time, hottest first. The measure is ASH
 * `activityPercent` for SQL Monitor sources that have it, else self time
 * (falling back to cumulative A-Time). Nodes with no measure are excluded.
 */
export declare function rankNodesByTime(plan: ParsedPlan): PlanNode[];
/**
 * The node deserving the "hotspot" ring, excluding root statement nodes.
 * SQL Monitor sources with ASH data use the highest `activityPercent`;
 * otherwise the highest self time (falling back to cumulative A-Time for
 * nodes without derived self time). Returns null when the plan has no actual
 * statistics.
 */
export declare function computeHottestNodeId(plan: ParsedPlan | null): number | null;
