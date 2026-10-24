import type { ParsedPlan } from '../types.js';
import type { PlanParser } from './types.js';
/**
 * Parser for standard Oracle DBMS_XPLAN output.
 */
export declare const dbmsXplanParser: PlanParser;
export declare function extractDbmsXplanSegments(input: string): string[];
export declare function parseDbmsXplanPlans(input: string): ParsedPlan[];
