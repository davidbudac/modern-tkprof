import type { PlanNode } from './types.js';
export type FlameMetric = 'actualTime' | 'cost' | 'actualRows' | 'rows';
export interface FlameRect {
    node: PlanNode;
    x0: number;
    x1: number;
    depth: number;
    value: number;
    selfValue: number;
}
export interface FlameLayoutOptions {
    width: number;
    minWidthPx?: number;
}
export declare function rollupMetric(root: PlanNode, metric: FlameMetric): Map<number, number>;
export declare function computeFlameLayout(root: PlanNode, metric: FlameMetric, opts: FlameLayoutOptions): FlameRect[];
export declare function getEffectiveFlameMetric(preferred: FlameMetric, hasActualStats: boolean): FlameMetric;
