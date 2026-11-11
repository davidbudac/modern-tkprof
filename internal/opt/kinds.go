package opt

// Node kinds of the outline, in the words of docs/mockups/10053-reader/tools/parse.mjs. A kind names the
// section the node covers; the one-line meaning is the trace's own structure (docs/trace-format-10053.md),
// not an interpretation.
const (
	KindDump        = "dump"         // the root: one dump with its view (lines ViewFrom..ViewTo)
	KindFileHeader  = "file-header"  // the file prologue before the first dump
	KindAfter       = "after"        // the lines after the END line up to the next dump (adaptive plan execution lines)
	KindPhaseEnv    = "phase-env"    // Environment: parser blocks, preamble, optimizer information, parameters
	KindPhaseTrans  = "phase-trans"  // Transformations: query transformations and the cost-based search
	KindPhaseCost   = "phase-cost"   // Costing: from "Final query after transformations" to the statement dump
	KindPhaseResult = "phase-result" // Result: the statement dump, plan, other_xml, state dump, registry, hints

	KindParserQBs   = "parser-qbs"      // the parser's "Registered qb: … (PARSER)" blocks with their signatures
	KindPreamble    = "preamble"        // SPM, optimizer mode choice, AUTODOP, first predicate move-around
	KindOptInfo     = "opt-info"        // "OPTIMIZER INFORMATION": statement, legend, parameters
	KindStatement   = "statement"       // "Current SQL Statement for this session" and the parser state
	KindLegend      = "legend"          // the trace's own abbreviation list
	KindParams      = "params"          // "PARAMETERS USED BY THE OPTIMIZER"
	KindParamsAlt   = "params-altered"  // "PARAMETERS WITH ALTERED VALUES" (and the altered fix controls)
	KindParamsDef   = "params-default"  // "PARAMETERS WITH DEFAULT VALUES" (about 610 lines, folded)
	KindParamsOptP  = "params-optparam" // "PARAMETERS IN OPT_PARAM HINT"
	KindColUsage    = "col-usage"       // "Column Usage Monitoring is ON"
	KindQT          = "qt"              // "Considering Query Transformations on query block X"
	KindCBQT        = "cbqt"            // "CBQT: Considering cost-based transformation on query block X"
	KindCBSec       = "cbsec"           // a cost-based transformation's banner section (Cost-Based …); its iterations are its children
	KindTSec        = "tsec"            // any other banner section between transformation steps (CSE, OBYE, JE …)
	KindRegistered  = "registered"      // a "Registered qb: X (derivation)" line a transformation created
	KindPeekedBinds = "peeked-binds"    // "Peeked values of the binds in SQL statement" with the Bind Info
	KindSPD         = "spd"             // SQL plan directives ("SPD: BEGIN context at statement level")
	KindIteration   = "iteration"       // one iteration of a cost-based search: "XXX: Starting iteration n" to its verdict
	KindRun         = "run"             // a costing run: "kkoqbc: optimizing query block" to "kkoqbc: finish optimizing"
	KindFinalQuery  = "final-query"     // "Final query after transformations" up to the first costing run
	KindRunHead     = "run-head"        // a run's header: query block text, signature, system statistics
	KindBaseStats   = "base-stats"      // "BASE STATISTICAL INFORMATION" of a run
	KindTable       = "table"           // "Access path analysis for T": the access paths of one table
	KindJoinSearch  = "join-search"     // "OPTIMIZER STATISTICS AND COMPUTATIONS": the join order search
	KindJoinOrder   = "join-order"      // "Join order[n]: T1 T2 …" up to the next one
	KindJoinStep    = "join-step"       // "Now joining: T" with the methods tried
	KindAPSearch    = "ap-search"       // adaptive plan: "Searching for inflection point (join #n)", re-costing of joins
	KindFinalCost   = "final-cost"      // "Final cost for query block X": the run's result
	KindStmtDump    = "stmt-dump"       // "Starting SQL statement dump": user, sql_id, statement
	KindPlan        = "plan"            // "----- Explain Plan Dump -----": plan table, query blocks, predicates
	KindPlanTable   = "plan-table"      // the "Plan Table" banner and the table
	KindPlanQBs     = "plan-qbs"        // "Query Block Name / Object Alias"
	KindPlanPreds   = "plan-preds"      // "Predicate Information:"
	KindOtherXML    = "other-xml"       // "Content of other_xml column": plan hash, peeked binds, outline data, hint report
	KindPeeked      = "peeked"          // other_xml's "Peeked Binds"
	KindOptMetrics  = "opt-metrics"     // other_xml's "Optimizer Metrics"
	KindQBRegXML    = "qbreg-xml"       // other_xml's "QUERY BLOCK REGISTRY" (one line of XML)
	KindOutlineData = "outline-data"    // other_xml's "Outline Data:" hint block
	KindHintReport  = "hint-report"     // other_xml's "Hint Report:"
	KindStateDump   = "state-dump"      // "Optimizer state dump:" (the parameters and fix controls again)
	KindStateParams = "state-params"    // the state dump's "Compilation Environment Dump"
	KindStateFix    = "state-fix"       // the state dump's "Bug Fix Control Environment"
	KindQBRegistry  = "qb-registry"     // "Query Block Registry:" tree, the final block marked [FINAL]
	KindHints       = "hints"           // "Dumping Hints": atom_hint lines with their flags
)

// Landmark kinds and tones (Landmark.Kind, Landmark.Tone).
const (
	LMBestAP    = "best-ap"    // "Best:: AccessPath:" the access path kept for a table
	LMBestJM    = "best-jm"    // "Best:: JoinMethod:" the join method kept for a join step
	LMFinalCost = "final-cost" // "Final cost for query block" the end of a costing run
	LMAborted   = "aborted"    // "Join order aborted" a permutation dropped on cost
	LMVerdict   = "verdict"    // "Updated best state" / "Not update best state" / "Will not use|merge"
	LMRefused   = "refused"    // a transformation bypassed, not valid, cannot be done
	LMHintError = "hint-error" // a hint with err>0, "SOME HINTS HAVE ERRORS", "Syntax Error:"

	ToneKept     = "kept"
	ToneRejected = "rejected"
	ToneProblem  = "problem"
)

// Fold kinds (Fold.Kind).
const (
	FoldParams   = "params"     // parameters with default values
	FoldState    = "state"      // the optimizer state dump
	FoldFix      = "fix"        // fix controls, inside the state dump
	FoldAP       = "ap"         // adaptive plan re-costing
	FoldSameRun  = "same-run"   // a costing run whose text repeats an earlier one
	FoldStmtAgn  = "stmt-again" // the statement text repeated
	FoldSameSQL  = "same-sql"   // an UNPARSED statement equal to an earlier one
	foldFixLabel = "fix controls"
)

// kindMeaning gives the one-line meaning of each node kind, for tools that list them.
var kindMeaning = map[string]string{
	KindDump:        "one dump, from its first Registered qb line to the line before the next dump",
	KindFileHeader:  "the file prologue before the first dump",
	KindAfter:       "lines after the END line (adaptive plan execution)",
	KindPhaseEnv:    "environment: parser blocks, optimizer information, parameters",
	KindPhaseTrans:  "query transformations and the cost-based transformation search",
	KindPhaseCost:   "costing of the final query",
	KindPhaseResult: "the statement dump, plan, other_xml, state dump, registry, hints",
	KindParserQBs:   "query blocks as the parser registered them",
	KindPreamble:    "SPM, CBO choice, AUTODOP",
	KindOptInfo:     "optimizer information",
	KindStatement:   "the statement as typed",
	KindLegend:      "the trace's own abbreviation list",
	KindParams:      "parameters used by the optimizer",
	KindParamsAlt:   "parameters with altered values",
	KindParamsDef:   "parameters with default values",
	KindParamsOptP:  "parameters set by OPT_PARAM hints",
	KindColUsage:    "column usage monitoring",
	KindQT:          "query transformations on one query block",
	KindCBQT:        "cost-based transformations on one query block",
	KindCBSec:       "one cost-based transformation (its iterations)",
	KindTSec:        "a banner section between transformation steps",
	KindRegistered:  "a query block registered by a transformation",
	KindPeekedBinds: "peeked values of the binds (Bind Info)",
	KindSPD:         "SQL plan directives",
	KindIteration:   "one iteration of a cost-based search, ending in its verdict",
	KindRun:         "one costing run of a query block",
	KindFinalQuery:  "the final query after transformations",
	KindRunHead:     "a run's header: text, signature, system statistics",
	KindBaseStats:   "base statistics of the run's tables",
	KindTable:       "access paths of one table",
	KindJoinSearch:  "the join order search of a run",
	KindJoinOrder:   "one join order permutation",
	KindJoinStep:    "one table joined to the order so far, with its methods",
	KindAPSearch:    "adaptive plan inflection point search",
	KindFinalCost:   "final cost of a run",
	KindStmtDump:    "the statement dump",
	KindPlan:        "the explain plan dump",
	KindPlanTable:   "the plan table",
	KindPlanQBs:     "query block names and object aliases of the plan",
	KindPlanPreds:   "predicate information of the plan",
	KindOtherXML:    "content of the other_xml column",
	KindPeeked:      "peeked binds of the other_xml column",
	KindOptMetrics:  "optimizer metrics",
	KindQBRegXML:    "query block registry as XML",
	KindOutlineData: "outline data (the hint block)",
	KindHintReport:  "the hint report",
	KindStateDump:   "optimizer state dump",
	KindStateParams: "state dump parameters",
	KindStateFix:    "state dump fix controls",
	KindQBRegistry:  "query block registry tree",
	KindHints:       "dumped hints with their flags",
}

// KindMeaning returns the one-line meaning of a node kind ("" for an unknown kind).
func KindMeaning(kind string) string { return kindMeaning[kind] }
