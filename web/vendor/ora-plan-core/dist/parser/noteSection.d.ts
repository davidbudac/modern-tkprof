export interface PlanNotes {
    rawLines: string[];
    dynamicSampling?: boolean;
    dynamicSamplingLevel?: number;
    planDirectives?: boolean;
    cardinalityFeedback?: boolean;
    statisticsFeedback?: boolean;
    adaptivePlan?: boolean;
    sqlProfile?: string;
    sqlPlanBaseline?: string;
    outline?: string;
}
/**
 * Parse the DBMS_XPLAN "Note" section (dynamic sampling, adaptive plan,
 * SQL profile/baseline, etc.) from the tail of a plan listing.
 *
 * Looks for a line that is exactly "Note" (case-insensitive, trimmed),
 * skips the dashed underline that follows, then collects "- ..." lines
 * until the block ends.
 */
export declare function parseNoteSection(lines: string[]): PlanNotes | undefined;
