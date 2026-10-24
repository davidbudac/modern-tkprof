import type { ParallelServer } from '../types.js';
import type { PlanNotes } from './noteSection.js';
/**
 * Extras from the real Oracle SQL Monitor XML: adaptive-plan flags, quoted aliases, plan
 * `<info>` entries, outline hints and per-session parallel stats. Pure functions over the
 * parsed `Document` / `Element`s.
 */
/**
 * `"O"@"SEL$1"` -> `O@SEL$1`, the spelling DBMS_XPLAN's text Query Block / Alias section uses.
 * Doubled quotes inside a quoted identifier are not unescaped (Oracle aliases essentially never
 * contain them).
 */
export declare function normalizeObjectAlias(alias: string | null | undefined): string | undefined;
/** `<operation skp="1">`: the operation was skipped (not chosen) by an adaptive plan. */
export declare function isSkippedOperation(op: Element): boolean;
/**
 * Collect every `<info type="...">value</info>` under the `<plan>` element (Oracle puts them in
 * the first operation's `<other_xml>`). A type that repeats keeps each distinct value, joined
 * with ", " (e.g. `nodeid/pflags`). Order follows the document.
 */
export declare function parsePlanInfo(doc: Document): Record<string, string> | undefined;
/**
 * Fill the same `PlanNotes` fields the DBMS_XPLAN "Note" section would from the `<info>`
 * entries that map onto it, and synthesise the corresponding Note lines (worded as DBMS_XPLAN
 * words them, so line-based consumers such as the advisor's plan-notes rule keep working).
 * Returns undefined when nothing maps.
 *
 * Mapped types: dynamic_sampling (value = level), adaptive_plan, cardinality_feedback,
 * statistics_feedback, sql_profile, sql_patch, baseline (SQL plan baseline), outline, and
 * dop + dop_reason ("Degree of Parallelism is N because of ...").
 *
 * Only `dynamic_sampling`, `dop`, `dop_reason` and the raw `has_user_tab`/`db_version`/... types
 * appear in the bundled captures; the others follow Oracle's documented/known shape and are
 * matched defensively.
 */
export declare function planNotesFromInfo(info: Record<string, string> | undefined): PlanNotes | undefined;
/** `<outline_data><hint>…</hint></outline_data>` hints in document order, one per entry. */
export declare function parseOutlineHints(doc: Document): string[] | undefined;
export interface ParallelInfo {
    servers: ParallelServer[];
    /** `dop` attribute of `<parallel_info>`. */
    dop?: number;
    serverSets?: number;
    serverGroups?: number;
    /** `<target><servers_requested>` / `<servers_allocated>` (elements in real reports). */
    serversRequested?: number;
    serversAllocated?: number;
}
/**
 * Parse `<parallel_info>`: one `<session>` per PX server (plus the coordinator), each with
 * `<stats type="monitor">` in microseconds. A session carries `server_group` / `server_set` /
 * `server_num` for PX servers; the coordinator (`process_name="PX Coordinator"`) has none.
 * Absent stats stay undefined. Returns undefined when the report has no `<parallel_info>`.
 */
export declare function parseParallelInfo(doc: Document): ParallelInfo | undefined;
export interface SkewMetric {
    max: number;
    avg: number;
    /** max / avg; undefined when avg is 0. 1 = perfectly even. */
    ratio?: number;
}
export interface PxSetSkew {
    set: number;
    serverCount: number;
    elapsed?: SkewMetric;
    bufferGets?: SkewMetric;
}
/**
 * Per server set (the coordinator is excluded), the max-to-average ratio of elapsed time and
 * buffer gets across that set's servers. Oracle omits zero-valued stats, so a server without
 * the stat counts as 0 once at least one server in its set reported it; a set where no server
 * reported a metric has no entry for it. Sets are returned in ascending order.
 */
export declare function pxSkew(servers: ParallelServer[] | undefined): PxSetSkew[];
