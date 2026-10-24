import type { ParsedPlan, PlanSource } from '../types.js';
import type { PlanParser } from './types.js';
/**
 * Parser for Oracle execution plans in JSON format.
 * Handles JSON extracted from V$SQL_PLAN_STATISTICS_ALL via JSON_ARRAYAGG/JSON_OBJECT,
 * as used by tools like Datadog's explain plan visualizer and Tanel Poder's xdd.sql scripts.
 *
 * Expected input: a JSON array of objects, each representing a plan operation.
 * Keys are flexible (snake_case or camelCase variants supported).
 */
export declare const jsonPlanParser: PlanParser;
/**
 * Build a plan from V$SQL_PLAN-style rows (one object per operation, keys flexibly named).
 * Shared by the JSON and CSV parsers.
 */
export declare function buildPlanFromRows(rows: Record<string, unknown>[], source: PlanSource): ParsedPlan;
