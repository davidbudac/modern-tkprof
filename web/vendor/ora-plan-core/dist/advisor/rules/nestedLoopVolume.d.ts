import type { PlanNode } from '../../types.js';
import type { AdvisorThresholds } from '../config.js';
import type { AdvisorRule } from '../types.js';
interface NestedLoopVolume {
    probes: number;
    volume: number;
    critical: boolean;
}
/** Probe count and inner volume of a high-volume nested loop, or undefined when it is not one. */
export declare function nestedLoopVolume(node: PlanNode, thresholds: AdvisorThresholds): NestedLoopVolume | undefined;
export declare const nestedLoopVolumeRule: AdvisorRule;
export {};
