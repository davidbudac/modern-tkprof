import type { ParsedPlan } from '../types.js';
export interface BindVariable {
    name: string;
    type?: string;
    value: string | null;
    position?: number;
}
/**
 * Interface for plan parsers.
 * Each parser handles a specific input format.
 */
export interface PlanParser {
    /**
     * Check if this parser can handle the given input.
     * @param input Raw input string
     * @returns true if this parser can parse the input
     */
    canParse(input: string): boolean;
    /**
     * Parse the input into a ParsedPlan.
     * @param input Raw input string
     * @returns Parsed plan structure
     */
    parse(input: string): ParsedPlan;
}
/**
 * Detected format of the input.
 */
export type DetectedFormat = 'dbms_xplan' | 'sql_monitor_text' | 'sql_monitor_xml' | 'json' | 'csv' | 'xbi' | 'unknown';
