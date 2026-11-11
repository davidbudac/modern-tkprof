// ---- the guide: fixed text per kind of section and per kind of line, and the glossary --------------------------------------------------
// Rule agreed with the user: an entry exists only when a named source backs it. For the mock-up the sources are the trace's own Legend
// (read from the file by the build, see GLOSSARY below) and docs/trace-format-10053.md (cited by section). `source` is kept per entry for the
// implementation; the UI does not show it. Entries describe what a section is and how to read it; none says anything about this trace's
// decisions. A section kind or a line kind without an entry here shows "No guide text" in the panel.

const FMT = 'docs/trace-format-10053.md'

const GUIDE_SECTIONS = {
  'dump': { title: 'A dump', source: `${FMT} § What the trace is; § Where a dump starts and ends`,
    text: "The optimizer's log of one hard parse: one dump per optimized statement, written while the statement is compiled. It has no `tim=` values and no per-line timestamps; it is a record of decisions, not of time. A dump runs from the first `Registered qb: … (PARSER)` line to `END SQL Statement Dump`." },
  'file-header': { title: 'File header', source: `${FMT} § Where a dump starts and ends`,
    text: 'The file prologue and the `***` markers are those of a 10046 trace.' },
  'phase-env': { title: 'Environment', source: `${FMT} § Sections, in file order (1 to 3)`,
    text: 'Sections 1 to 3 of the format: the query blocks registered by the parser, the preamble lines, and `OPTIMIZER INFORMATION` (the statement, the legend, the parameters used by the optimizer).' },
  'phase-trans': { title: 'Transformations', source: `${FMT} § Sections, in file order (4 to 6)`,
    text: 'Sections 4 to 6 of the format: the query transformations, the binds and SQL plan directives, and the cost-based transformations, whose iterations hold costing runs.' },
  'phase-cost': { title: 'Costing', source: `${FMT} § 4 (headers of this phase), § 7, § 8`,
    text: 'From `Final query after transformations:` (the statement printed as one line) to `Starting SQL statement dump`: the costing runs that follow it and the adaptive plan lines (`AP:`).' },
  'phase-result': { title: 'Result', source: `${FMT} § 9`,
    text: '`Starting SQL statement dump`, the statement text again, the explain plan, the content of the other_xml column, the optimizer state dump and the hints.' },
  'parser-qbs': { title: 'Parser query blocks', source: `${FMT} § 1`,
    text: '`Registered qb: SEL$1 0x… (PARSER)` and its `QUERY BLOCK SIGNATURE`, one per query block of the statement as written. In `fro(n)` lines, `objn` is the object number (0 for an inline view or subquery).' },
  'preamble': { title: 'Preamble', source: `${FMT} § 2`,
    text: '`SPM: statement not found in SMB`, `SPM: capture of plan baseline is OFF`, `kkoctx(): choosing CBO …`, the `Automatic degree of parallelism (AUTODOP)` banner with its reason (`… is disabled: Parameter.`), a first `PM:` (predicate move-around) pass.' },
  'opt-info': { title: 'Optimizer information', source: `${FMT} § 3`,
    text: 'The statement as typed with the parser state, the trace\'s own legend of abbreviations, the parameters used by the optimizer, and the column usage monitoring line.' },
  'statement': { title: 'Current SQL statement', source: `${FMT} § 3; § Where a dump starts and ends`,
    text: '`----- Current SQL Statement for this session (sql_id=…) -----`, the statement text as typed, then `----- Parser State -----` (four lines). Nothing before the start of the dump names the statement; the sql_id comes here.' },
  'legend': { title: 'Legend', source: `${FMT} § 3`,
    text: 'The trace\'s own list of abbreviations (shown as tooltips on the terms in the text). Prefixes used in the trace but not in the legend: TE (table expansion), BJ (bushy join), PJE, OJE, CSE, GBP (group-by placement), SPD (SQL plan directives), CBRID.' },
  'params': { title: 'Parameters used by the optimizer', source: `${FMT} § 3`,
    text: '`PARAMETERS WITH ALTERED VALUES`, then `PARAMETERS WITH DEFAULT VALUES`, then `PARAMETERS IN OPT_PARAM HINT` (empty without such a hint).' },
  'params-altered': { title: 'Parameters with altered values', source: `${FMT} § 3`,
    text: '`Compilation Environment Dump` (`name = value` lines, empty when nothing is altered) and `Bug Fix Control Environment` (the altered fix controls).' },
  'params-default': { title: 'Parameters with default values', source: `${FMT} § 3`,
    text: '`Compilation Environment Dump`: about 570 lines such as `optimizer_features_enable = 19.1.0`, hidden parameters included. Folded by default.' },
  'params-optparam': { title: 'Parameters in OPT_PARAM hint', source: `${FMT} § 3`,
    text: 'The parameters set by an `OPT_PARAM` hint; empty without such a hint.' },
  'qt': { title: 'Query transformations', source: `${FMT} § 4`,
    text: 'One line per step: a prefix (the transformation; see the legend), a colon, free text. The wording of a refusal is not uniform (`Bypassed:`, `bypassed -`, `not valid since`, `Cannot …`, `invalid because …`). After a transformation the statement is printed again as one line after `******* UNPARSED QUERY IS *******`.' },
  'registered': { title: 'Registered query block', source: `${FMT} § 1`,
    text: 'The line that registers a query block, with its derivation in the parentheses. Seen: `PARSER`, `COPY`, `VIEW MERGE`, `SUBQUERY UNNEST`, `PLACE GROUP BY`, `QUERY BLOCK TABLES CHANGED`, `SPLIT/MERGE QUERY BLOCKS`, `ELIMINATION OF GROUP BY`.' },
  'peeked-binds': { title: 'Peeked values of the binds', source: `${FMT} § 5`,
    text: '`----- Bind Info (kkscoacd) -----`: the bind block has the shape of a 10046 `BINDS` block (`Bind#0`, `oacdty=`, `value=`; `No oacdef for this bind.`).' },
  'spd': { title: 'SQL plan directives', source: `${FMT} § 5`,
    text: '`SPD: BEGIN context at statement level` … `SPD: END context at statement level` lists the objects and their SQL plan directives (`dirid = …, state = 1, flags = 1, loc = 1, forDS = NO, forCG = YES {E(108611)[1]}`).' },
  'cbqt': { title: 'Cost-based transformations', source: `${FMT} § 6`,
    text: 'A state-space search: each iteration costs one variant of the statement and ends in a verdict (`Updated best state` or `Not update best state`, with the cost). Between iterations: `CBQT: Looking for cost annotations for query block …, key = …` and `CBQT: Saved costed qb# …`.' },
  'cbsec': { title: 'A cost-based transformation', source: `${FMT} § 6`,
    text: 'One transformation\'s state-space search, seen with the prefixes `GBP`, `CVM` and `JPPD`: `Starting iteration N, state space = …`, one or more costing runs, then the verdict with the cost.' },
  'iteration': { title: 'Iteration', source: `${FMT} § 6, § 7`,
    text: 'One variant of the statement: `… Starting iteration N, state space = …`, `… Costing transformed query.`, one or more costing runs, then the verdict (`Updated best state` or `Not update best state`, with the cost). The same query block is costed once per iteration that contains it.' },
  'run': { title: 'Costing run (kkoqbc)', source: `${FMT} § 7`,
    text: 'From `kkoqbc: optimizing query block …` to `kkoqbc: finish optimizing query block …`. Header (query block text, signature, system statistics), the base statistics per table, a single table access path per table, the join order search, and the final cost of the query block.' },
  'run-head': { title: 'Run header', source: `${FMT} § 7`,
    text: '`QUERY BLOCK TEXT` (the original statement again), `QUERY BLOCK SIGNATURE` (`signature (optimizer): …`), `SYSTEM STATISTICS INFORMATION` (CPUSPEEDNW, IOTFRSPEED, IOSEEKTIM, MBRC, each with its default).' },
  'base-stats': { title: 'Base statistical information', source: `${FMT} § 7`,
    text: 'Per table: `Table Stats::` (`#Rows`, `#Blks`, `AvgRowLen` …), its columns (`AvgLen`, `NDV`, `Nulls`, `Density`, `Min`, `Max`, a histogram line), then `Index Stats::` (`LVLS`, `#LB`, `#DK`, `LB/K`, `DB/K`, `CLUF`).' },
  'table': { title: 'Single table access path', source: `${FMT} § 7`,
    text: '`Access path analysis for …` / `SINGLE TABLE ACCESS PATH`, per table: the cardinality estimation from its predicates (`Estimated selectivity`, `Card: Original: …`), each access path costed (`Access Path: TableScan`; an index path after `****** Costing Index …`), then `Best:: AccessPath:` with Cost, Degree, Resp, Card and Bytes on the next line.' },
  'join-search': { title: 'Join order search', source: `${FMT} § 7`,
    text: '`OPTIMIZER STATISTICS AND COMPUTATIONS` / `GENERAL PLANS`. Each `Join order[N]` is a permutation; it ends in `Best so far:` lines (one per table) when it completes, or in `Join order aborted: cost > best plan cost`. The search ends with `(newjo-stop-1) …` and `Number of join permutations tried: N`; `(newjo-save) [3 0 1 2 ]` is the kept order as table numbers.' },
  'join-order': { title: 'Join order', source: `${FMT} § 7`,
    text: '`TABLE[ALIAS]#n`: n is the table\'s position in the query block\'s signature. A join order shares its prefix with the previous one, so its block starts at the first table that differs. It ends in `Best so far:` lines (one per table) when it completes, or in `Join order aborted: cost > best plan cost`.' },
  'join-step': { title: 'Now joining', source: `${FMT} § 7`,
    text: 'The next table of the order. `NL Join` (the inner table\'s access paths, each with `NL Join: Cost: …`, then `Best NL cost`), `Join Card`, `SM Join`, `HA Join`, then `Best:: JoinMethod:` with Cost, Degree, Resp, Card and Bytes. Variants seen: `SM Join (with index on outer)`, `HashSemi`, `SORT ressource` blocks.' },
  'final-cost': { title: 'Final cost', source: `${FMT} § 7`,
    text: 'End of the run: `Final cost for query block … - All Rows Plan:`, `Best join order: N`, then Cost, Degree, Card and Bytes, and the Resc and Resp figures with their io and cpu parts.' },
  'ap-search': { title: 'Adaptive plan', source: `${FMT} § 8`,
    text: '`AP: Costing Nested Loops Join for inflection point at card …` / `AP: Costing Hash Join for inflection point at card …`, repeated while the search narrows, each with a full costing of the join. Folded by default.' },
  'final-query': { title: 'Final query after transformations', source: `${FMT} § 4`,
    text: 'One of the headers after which the statement is printed again as one line: `Final query after transformations:******* UNPARSED QUERY IS *******`.' },
  'stmt-dump': { title: 'Statement dump', source: `${FMT} § 9`,
    text: '`user_id=… user_name=… module=… action=` and `sql_id=… plan_hash_value=…(…) problem_type=… command_type=…`, then the statement text twice more (`----- Current SQL Statement …`, `sql_text_length=…`, `sql=…`). This `plan_hash_value` is another hash than the `plan_hash` of other_xml.' },
  'plan': { title: 'Explain plan', source: `${FMT} § 9`,
    text: '`Plan Table`: Id | Operation | Name | Rows | Bytes | Cost | Time (abbreviations such as `96K`, `1149K`; inactive adaptive rows and `STATISTICS COLLECTOR` included), then `Query Block Name / Object Alias (identified by operation id):` and `Predicate Information:` in DBMS_XPLAN\'s wording, with the original bind names.' },
  'other-xml': { title: 'Content of other_xml column', source: `${FMT} § 9; § With event 10046 in the same file`,
    text: '`db_version`, `parse_schema`, `plan_hash_full`, `plan_hash`, `plan_hash_2`, `adaptive_plan`, `Peeked Binds`, `Optimizer Metrics`, `QUERY BLOCK REGISTRY` (one line of XML), `Outline Data:` (the hint block `/*+ BEGIN_OUTLINE_DATA … END_OUTLINE_DATA */`). `plan_hash` is the `plh` of the 10046 EXEC line of the same statement.' },
  'peeked': { title: 'Peeked binds', source: `${FMT} § 9`,
    text: 'Per bind: `position=`, `datatype(string)=` (e.g. `NUMBER`), `value=`.' },
  'outline-data': { title: 'Outline data', source: `${FMT} § 9`,
    text: 'The hint block `/*+ BEGIN_OUTLINE_DATA … END_OUTLINE_DATA */`.' },
  'state-dump': { title: 'Optimizer state dump', source: `${FMT} § 9`,
    text: '`Optimizer state dump:`: every parameter and fix control once more, then `Query Block Registry:` as an indented tree. Folded by default.' },
  'qb-registry': { title: 'Query block registry', source: `${FMT} § 9`,
    text: 'The query blocks as an indented tree, the final block marked `[FINAL]`. Blocks of rejected variants are in the tree with address `0x0`; `...` stands for a subtree already printed.' },
  'hints': { title: 'Dumping hints', source: `${FMT} § 9`,
    text: 'One `atom_hint=(@=… err=… resol=… used=… token=… org=… lvl=… txt=…)` line per hint. The section is empty for a statement without hints.' },
  'after': { title: 'After the dump', source: `${FMT} § Where a dump starts and ends`,
    text: 'A few `AP: qesdp…` lines of the adaptive plan follow `END SQL Statement Dump` at the first execution.' },
}
// the same text for parts of a section that have none of their own
GUIDE_SECTIONS['plan-table'] = GUIDE_SECTIONS['plan-qbs'] = GUIDE_SECTIONS['plan-preds'] = GUIDE_SECTIONS.plan
GUIDE_SECTIONS['state-params'] = GUIDE_SECTIONS['state-fix'] = GUIDE_SECTIONS['state-dump']

// line kinds: the first match wins
const GUIDE_LINES = [
  { re: /^Registered qb: /, title: 'Registered qb', source: `${FMT} § 1`,
    text: 'Registers a query block: its name, address and, in parentheses, how it came to be (`PARSER` for a block of the statement as written; `COPY`, `VIEW MERGE`, `SUBQUERY UNNEST` … for a block a transformation creates).' },
  { re: /fro\(\d+\):.*objn=/, title: 'fro(n)', source: `${FMT} § 1`, text: '`objn` is the object number (0 for an inline view or subquery).' },
  { re: /^----- Current SQL Statement for this session/, title: 'sql_id', source: `${FMT} § Where a dump starts and ends`,
    text: 'Nothing before the start of the dump names the statement; the `sql_id` comes on this line.' },
  { re: /UNPARSED QUERY IS/, title: 'UNPARSED QUERY IS', source: `${FMT} § 4`,
    text: 'After a transformation the statement is printed again as one line (up to 1,111 characters in the probe). Headers seen: `SQL:`, `Stmt:`, `BEFORE REDUCTION` / `AFTER REDUCTION`, `Final query after transformations:`.' },
  { re: /^\w+: Starting iteration \d+, state space/, title: 'Starting iteration', source: `${FMT} § 6`,
    text: 'An iteration of the state-space search starts: it costs one variant of the statement and ends in a verdict.' },
  { re: /^\w+: (Updated best state|Not update best state), Cost =/, title: 'Verdict', source: `${FMT} § 6`,
    text: 'The end of an iteration: `Updated best state` or `Not update best state`, with the cost.' },
  { re: /^JPPD: Will not use JPPD/, title: 'Will not use JPPD', source: `${FMT} § 6`, text: 'Seen with JPPD: `JPPD: Will not use JPPD from query block SEL$1 (#1)`.' },
  { re: /^CBQT: (Looking for cost annotations|Saved costed qb#)/, title: 'Cost annotations', source: `${FMT} § 6`,
    text: 'Between iterations: `CBQT: Looking for cost annotations for query block …, key = …` and `CBQT: Saved costed qb# …`.' },
  { re: /^kkoqbc: (optimizing|finish optimizing) query block/, title: 'kkoqbc', source: `${FMT} § 7`,
    text: 'A costing run runs from `kkoqbc: optimizing query block …` to `kkoqbc: finish optimizing query block …`. The same query block is costed once per iteration that contains it.' },
  { re: /Card: Original:/, title: 'Card: Original', source: `${FMT} § 7`, text: '`Original:` and `rsel` run together without a space.' },
  { re: /ix_sel/, title: 'ix_sel', source: `${FMT} § 7`, text: 'Selectivities switch to exponent notation when small.' },
  { re: /^\s*Best:: AccessPath:/, title: 'Best:: AccessPath', source: `${FMT} § 7`,
    text: 'Ends a single table access path: the access path named after `Best::`, with Cost, Degree, Resp, Card and Bytes on the next line.' },
  { re: /^\s*Best:: JoinMethod:/, title: 'Best:: JoinMethod', source: `${FMT} § 7`,
    text: 'Ends a join step, after `NL Join`, `SM Join` and `HA Join`: the method named after `Best::`, with Cost, Degree, Resp, Card and Bytes on the next line.' },
  { re: /^Join order\[\d+\]:/, title: 'Join order', source: `${FMT} § 7`,
    text: '`TABLE[ALIAS]#n`: n is the table\'s position in the query block\'s signature. A join order shares its prefix with the previous one, so its block starts at the first table that differs.' },
  { re: /^Now joining: /, title: 'Now joining', source: `${FMT} § 7`, text: '`TABLE[ALIAS]#n`: n is the table\'s position in the query block\'s signature.' },
  { re: /^(Best so far:|\s+Table#:\s*\d+\s+cost:)/, title: 'Best so far', source: `${FMT} § 7`,
    text: 'A permutation that completes ends in `Best so far:` lines, one per table.' },
  { re: /^Join order aborted/, title: 'Join order aborted', source: `${FMT} § 7`,
    text: 'A permutation ends in `Best so far:` lines when it completes, or in `Join order aborted: cost > best plan cost`.' },
  { re: /^\(newjo-save\)/, title: '(newjo-save)', source: `${FMT} § 7`, text: '`(newjo-save)` is the kept order as table numbers.' },
  { re: /^(\(newjo-stop|Number of join permutations tried)/, title: 'End of the search', source: `${FMT} § 7`,
    text: 'The join order search ends with `(newjo-stop-1) k:…, spcnt:…, perm:…, maxperm:…` and `Number of join permutations tried: N`.' },
  { re: /^(Final cost for query block|\s*Best join order:)/, title: 'Final cost', source: `${FMT} § 7`,
    text: 'End of the run: the best join order\'s number, then Cost, Degree, Card, Bytes, and Resc and Resp with their io and cpu parts.' },
  { re: /^AP: Costing .* for inflection point/, title: 'AP: Costing', source: `${FMT} § 8`,
    text: 'Repeated while the search for the inflection point narrows, each with a full costing of the join.' },
  { re: /^AP: qesdp/, title: 'AP: qesdp', source: `${FMT} § Where a dump starts and ends`, text: 'Adaptive plan lines written at the first execution, after the end of the dump.' },
  { re: /^\s*plan_hash\s*:/, title: 'plan_hash', source: `${FMT} § With event 10046 in the same file`,
    text: '`plan_hash` is the `plh` of the 10046 EXEC line of the same statement (checked on two statements).' },
  { re: /plan_hash_value=/, title: 'plan_hash_value', source: `${FMT} § With event 10046 in the same file`,
    text: 'The `plan_hash_value=…(…)` of this line is another hash than the `plan_hash` of other_xml.' },
  { re: /^\s*atom_hint=/, title: 'atom_hint', source: `${FMT} § 9`,
    text: 'One hint: `@=` an address, then `err`, `resol`, `used`, `token`, `org`, `lvl` and the hint text after `txt=`.' },
  { re: /dirid = \d+, state = /, title: 'SQL plan directive', source: `${FMT} § 5`,
    text: 'A directive of the object: `dirid = …, state = 1, flags = 1, loc = 1, forDS = NO, forCG = YES {E(108611)[1]}`.' },
  { re: /^\s*(Bind#\d+|oacdty=|oacflg=|kxsbbbfp=|value=|No oacdef)/, title: 'Bind', source: `${FMT} § 5`, text: 'The bind block has the shape of a 10046 `BINDS` block.' },
  { re: /^Automatic degree of parallelism is/, title: 'AUTODOP', source: `${FMT} § 2`, text: 'The `Automatic degree of parallelism (AUTODOP)` banner with its reason.' },
  { re: /END SQL Statement Dump/, title: 'End of the dump', source: `${FMT} § Where a dump starts and ends`,
    text: 'A few `AP: qesdp…` lines of the adaptive plan follow it at the first execution.' },
  { re: /\bbypassed\b|not valid since|\bCannot\b|invalid because/i, title: 'Refused transformation', source: `${FMT} § 4`,
    text: 'A refusal; its wording is not uniform (`Bypassed:`, `bypassed -`, `not valid since`, `Cannot …`, `invalid because …`).' },
]

// the glossary: the trace's Legend (read by the build from the file, line numbers kept as the source) plus the terms the format reference
// names that the legend leaves out
function buildGlossary(model) {
  const g = new Map()
  const lg = model.legend
  for (const e of lg) {
    let text = e.text
    if (e.codes.length) text += ': ' + e.codes.map(([c, t]) => `${c} ${t}`).join('; ')
    g.set(e.term, { term: e.term, text, source: `trace Legend, ${model.file.name} line ${e.line}` })
  }
  const extra = [
    ['TE', 'table expansion'], ['BJ', 'bushy join'], ['GBP', 'group-by placement'], ['SPD', 'SQL plan directives'],
  ]
  for (const [t, x] of extra) if (!g.has(t)) g.set(t, { term: t, text: x, source: `${FMT} § 3 (prefixes used but not in the legend)` })
  g.set('objn', { term: 'objn', text: 'the object number (0 for an inline view or subquery)', source: `${FMT} § 1` })
  return g
}
