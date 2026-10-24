import type { ParsedPlan } from '../types.js';
import type { DetectedFormat } from './types.js';
export declare function detectFormat(input: string): DetectedFormat;
/**
 * Build a plan straight from V$SQL_PLAN-style row objects (what the JSON parser reads), with the
 * same post-parse derivations as `parsePlan`. Unlike `parsePlan` it pulls in no text/XML parsers,
 * so bundlers can drop them.
 */
export declare function parsePlanRows(rows: Record<string, unknown>[]): ParsedPlan;
/**
 * Parse an execution plan from any supported format.
 * Automatically detects the format and uses the appropriate parser.
 *
 * @param input Raw plan text (DBMS_XPLAN output, SQL Monitor text, or SQL Monitor XML)
 * @returns Parsed plan structure with source metadata
 */
export declare function parsePlan(input: string): ParsedPlan;
/**
 * Split a paste holding several plans into one text per plan: CSV by SQL_ID / child number /
 * plan hash, everything else by DBMS_XPLAN "Plan hash value" blocks.
 */
export declare function splitPlanBatches(input: string): string[];
/** @deprecated Kept for existing imports; use `splitPlanBatches`. */
export declare const splitDbmsXplanPlanBatches: typeof splitPlanBatches;
export declare function parsePlans(input: string): ParsedPlan[];
/**
 * Check if the parsed plan has actual runtime statistics available.
 * @param plan Parsed plan
 * @returns true if actual statistics are present
 */
export declare function hasRuntimeStats(plan: ParsedPlan): boolean;
/**
 * Get display name for the plan source.
 * @param source Plan source type
 * @returns Human-readable source name
 */
export declare function getSourceDisplayName(source: ParsedPlan['source']): string;
export type { DetectedFormat, PlanParser } from './types.js';
export { dbmsXplanParser } from './dbmsXplanParser.js';
export { extractDbmsXplanSegments, parseDbmsXplanPlans } from './dbmsXplanParser.js';
export { sqlMonitorTextParser, sqlMonitorXmlParser } from './sqlMonitorParser.js';
export { jsonPlanParser } from './jsonPlanParser.js';
export { csvPlanParser, splitCsvPlanBatches } from './csvPlanParser.js';
export { xbiParser } from './xbiParser.js';
