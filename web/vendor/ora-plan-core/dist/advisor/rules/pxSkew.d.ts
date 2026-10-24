import type { AdvisorRule } from '../types.js';
/**
 * Per-PX-server skew, from the `<parallel_info>` sessions of a SQL Monitor XML report. Oracle does not
 * say which plan lines a server set runs, so the finding is plan-level (`nodeIds: []`).
 */
export declare const pxSkewRule: AdvisorRule;
