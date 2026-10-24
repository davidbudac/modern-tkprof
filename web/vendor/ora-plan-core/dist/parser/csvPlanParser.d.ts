import type { PlanParser } from './types.js';
export declare const csvPlanParser: PlanParser;
/**
 * Split a CSV holding several plans (SQL_ID / CHILD_NUMBER / PLAN_HASH_VALUE) into one text per
 * plan, each with the original header. Returns `[input]` when there is a single plan (or no
 * column to tell plans apart) and `[]` when the input is not a plan CSV.
 */
export declare function splitCsvPlanBatches(input: string): string[];
