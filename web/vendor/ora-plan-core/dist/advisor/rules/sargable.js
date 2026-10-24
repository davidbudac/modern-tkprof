const TOKEN_RE = /\s+|('(?:[^']|'')*')|("[^"]*")|(:\w+)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][\w$#]*)|(<=|>=|<>|!=|\^=|\|\||[=<>+\-*/])|([(),.])|(.)/gy;
function tokenize(text) {
    const toks = [];
    TOKEN_RE.lastIndex = 0;
    for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
        if (m[1] !== undefined)
            toks.push({ t: 'str', v: m[1] });
        else if (m[2] !== undefined)
            toks.push({ t: 'qid', v: m[2] });
        else if (m[3] !== undefined)
            toks.push({ t: 'bind', v: m[3] });
        else if (m[4] !== undefined)
            toks.push({ t: 'num', v: m[4] });
        else if (m[5] !== undefined)
            toks.push({ t: 'id', v: m[5] });
        else if (m[6] !== undefined)
            toks.push({ t: 'op', v: m[6] });
        else if (m[7] !== undefined)
            toks.push({ t: 'punct', v: m[7] });
        else if (m[8] !== undefined)
            toks.push({ t: 'op', v: m[8] });
    }
    return toks;
}
// Bare words that look like column references but are not.
const NOT_COLUMNS = new Set([
    'NULL', 'IS', 'NOT', 'AND', 'OR', 'IN', 'LIKE', 'BETWEEN', 'ESCAPE', 'EXISTS', 'ANY', 'ALL', 'SOME',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'DISTINCT', 'TRUE', 'FALSE',
    'DATE', 'TIMESTAMP', 'INTERVAL', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
    'SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'LOCALTIMESTAMP', 'ROWNUM', 'ROWID', 'USER', 'UID',
]);
function unquote(part) {
    return (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part).toUpperCase();
}
const isName = (t) => t !== undefined && (t.t === 'id' || t.t === 'qid');
const isWord = (t, word) => t !== undefined && t.t === 'id' && t.v.toUpperCase() === word;
const isPunct = (t, p) => t !== undefined && t.t === 'punct' && t.v === p;
/** Column references in a token run; function names and keywords are skipped. */
function columnRefs(toks) {
    const refs = [];
    for (let i = 0; i < toks.length; i++) {
        if (!isName(toks[i]))
            continue;
        const parts = [toks[i]];
        let j = i + 1;
        while (parts.length < 3 && isPunct(toks[j], '.') && isName(toks[j + 1])) {
            parts.push(toks[j + 1]);
            j += 2;
        }
        const isCall = isPunct(toks[j], '(');
        const last = parts[parts.length - 1];
        const keyword = last.t === 'id' && NOT_COLUMNS.has(last.v.toUpperCase());
        if (!isCall && !keyword) {
            refs.push({
                column: unquote(last.v),
                qualifier: parts.length >= 2 ? unquote(parts[parts.length - 2].v) : undefined,
            });
        }
        i = j - 1;
    }
    return refs;
}
const owns = (ref, alias) => ref.qualifier === undefined || (alias !== undefined && ref.qualifier === alias);
/** Strip parentheses that wrap the whole run, e.g. `(A=1 AND B=2)`. */
function unwrap(toks) {
    let cur = toks;
    while (cur.length >= 2 && isPunct(cur[0], '(') && isPunct(cur[cur.length - 1], ')')) {
        let depth = 0;
        let wrapsAll = true;
        for (let i = 0; i < cur.length; i++) {
            if (isPunct(cur[i], '('))
                depth++;
            else if (isPunct(cur[i], ')')) {
                depth--;
                if (depth === 0 && i < cur.length - 1) {
                    wrapsAll = false;
                    break;
                }
            }
        }
        if (!wrapsAll)
            break;
        cur = cur.slice(1, -1);
    }
    return cur;
}
/** Split at depth-0 occurrences of AND / OR (BETWEEN x AND y keeps its AND). */
function splitTop(toks, word) {
    const parts = [];
    let cur = [];
    let depth = 0;
    let betweenPending = 0;
    for (const tok of toks) {
        if (isPunct(tok, '('))
            depth++;
        else if (isPunct(tok, ')'))
            depth--;
        else if (depth === 0 && isWord(tok, 'BETWEEN'))
            betweenPending++;
        else if (depth === 0 && isWord(tok, 'AND') && betweenPending > 0) {
            betweenPending--;
            cur.push(tok);
            continue;
        }
        else if (depth === 0 && isWord(tok, word)) {
            parts.push(cur);
            cur = [];
            continue;
        }
        cur.push(tok);
    }
    parts.push(cur);
    return parts.filter((p) => p.length > 0);
}
const SARGABLE_CMP = new Set(['=', '<', '>', '<=', '>=']);
const NON_SARGABLE_CMP = new Set(['<>', '!=', '^=']);
function bareColumn(toks) {
    const inner = unwrap(toks);
    // A bare column is exactly one reference: name, or name . name [. name].
    const shaped = inner.length % 2 === 1 && inner.length <= 5
        && inner.every((t, i) => (i % 2 === 0 ? isName(t) : isPunct(t, '.')));
    if (!shaped)
        return undefined;
    const refs = columnRefs(inner);
    return refs.length === 1 ? refs[0] : undefined;
}
/** Classify one comparison / IS / IN / LIKE / BETWEEN term (no top-level AND/OR). */
function analyzeTerm(rawToks, alias) {
    const toks = unwrap(rawToks);
    const own = (run) => columnRefs(run).filter((r) => owns(r, alias));
    const unusable = () => own(toks).map((r) => ({ column: r.column, kind: 'unusable' }));
    if (isWord(toks[0], 'NOT'))
        return unusable();
    // Find the first depth-0 operator.
    let depth = 0;
    let opAt = -1;
    let kind = 'unusable';
    let comparison = false;
    let skip = 0;
    for (let i = 0; i < toks.length && opAt < 0; i++) {
        const tok = toks[i];
        if (isPunct(tok, '('))
            depth++;
        else if (isPunct(tok, ')'))
            depth--;
        else if (depth === 0) {
            if (tok.t === 'op' && SARGABLE_CMP.has(tok.v)) {
                opAt = i;
                kind = 'sargable';
                comparison = true;
                skip = 1;
            }
            else if (tok.t === 'op' && NON_SARGABLE_CMP.has(tok.v)) {
                opAt = i;
                kind = 'unusable';
                comparison = true;
                skip = 1;
            }
            else if (isWord(tok, 'IS')) {
                opAt = i;
                const negated = isWord(toks[i + 1], 'NOT');
                kind = negated ? 'sargable' : 'is-null';
                skip = negated ? 3 : 2;
            }
            else if (isWord(tok, 'IN')) {
                opAt = i;
                kind = 'sargable';
                skip = 1;
            }
            else if (isWord(tok, 'BETWEEN')) {
                opAt = i;
                kind = 'sargable';
                skip = 1;
            }
            else if (isWord(tok, 'LIKE')) {
                opAt = i;
                const pattern = toks[i + 1];
                kind = pattern?.t === 'str' && /^'[%_]/.test(pattern.v) ? 'unusable' : 'sargable';
                skip = 1;
            }
            else if (isWord(tok, 'NOT') && (isWord(toks[i + 1], 'IN') || isWord(toks[i + 1], 'LIKE') || isWord(toks[i + 1], 'BETWEEN'))) {
                opAt = i;
                kind = 'unusable';
                skip = 2;
            }
        }
    }
    if (opAt < 0)
        return unusable();
    const lhs = toks.slice(0, opAt);
    const rhs = toks.slice(opAt + skip);
    const lhsBare = bareColumn(lhs);
    const rhsBare = comparison ? bareColumn(rhs) : undefined;
    if (lhsBare && owns(lhsBare, alias) && own(rhs).length === 0)
        return [{ column: lhsBare.column, kind }];
    if (rhsBare && owns(rhsBare, alias) && own(lhs).length === 0)
        return [{ column: rhsBare.column, kind }];
    return unusable();
}
function analyzeExpr(rawToks, alias) {
    const toks = unwrap(rawToks);
    const ands = splitTop(toks, 'AND');
    if (ands.length > 1)
        return ands.flatMap((part) => analyzeExpr(part, alias));
    const ors = splitTop(toks, 'OR');
    if (ors.length > 1) {
        const branches = ors.map((part) => analyzeExpr(part, alias));
        const columns = new Set(branches.flatMap((b) => b.map((u) => u.column)));
        const everyBranchUsesOne = branches.every((b) => b.length > 0);
        if (columns.size === 1 && everyBranchUsesOne) {
            const [column] = columns;
            const all = branches.flat();
            const worst = all.some((u) => u.kind === 'unusable')
                ? 'unusable'
                : all.some((u) => u.kind === 'is-null') ? 'is-null' : 'sargable';
            return [{ column, kind: worst }];
        }
        // OR across different columns (or a branch that never touches this alias) defeats index access.
        return [...columns].map((column) => ({ column, kind: 'unusable' }));
    }
    return analyzeTerm(toks, alias);
}
/**
 * How each column of `alias` is used by the given predicates. A column can
 * appear more than once; a usable appearance wins over an unusable one.
 * Unqualified references count as the alias's own; qualified references to any
 * other alias (join keys, correlated subquery columns) are ignored.
 */
export function analyzeColumnUses(predicates, alias) {
    const rank = { unusable: 0, 'is-null': 1, sargable: 2 };
    const best = new Map();
    for (const predicate of predicates) {
        if (!predicate)
            continue;
        for (const use of analyzeExpr(tokenize(predicate), alias)) {
            const prev = best.get(use.column);
            if (prev === undefined || rank[use.kind] > rank[prev])
                best.set(use.column, use.kind);
        }
    }
    return [...best].map(([column, kind]) => ({ column, kind }));
}
/** Every column of `alias` referenced by the predicates, whatever the form. */
export function referencedColumns(predicates, alias) {
    const seen = new Set();
    for (const predicate of predicates) {
        if (!predicate)
            continue;
        for (const ref of columnRefs(tokenize(predicate)))
            if (owns(ref, alias))
                seen.add(ref.column);
    }
    return [...seen];
}
/** `E@SEL$1` or `"E"@"SEL$1"` -> `E`. */
export function aliasFromObjectAlias(objectAlias) {
    if (!objectAlias)
        return undefined;
    const text = objectAlias.trim();
    const quoted = /^"((?:[^"]|"")*)"/.exec(text);
    const raw = quoted ? quoted[1] : text.split('@')[0];
    return raw ? raw.toUpperCase() : undefined;
}
/** Table name without owner or quotes, upper-cased: `HR.EMPLOYEES` -> `EMPLOYEES`. */
export function tableNameOf(objectName) {
    if (!objectName)
        return undefined;
    const last = objectName.split('.').pop() ?? objectName;
    return unquote(last);
}
/**
 * The alias the operation scans its table under. Prefers the plan's object
 * alias; without one (no ALIAS section) it falls back to the table name when
 * predicates qualify by it, or to the only qualifier the predicates use.
 */
export function resolveNodeAlias(node, tableName) {
    const fromPlan = aliasFromObjectAlias(node.objectAlias);
    if (fromPlan)
        return fromPlan;
    const qualifiers = new Set();
    for (const predicate of [node.accessPredicates, node.filterPredicates]) {
        if (!predicate)
            continue;
        for (const ref of columnRefs(tokenize(predicate)))
            if (ref.qualifier)
                qualifiers.add(ref.qualifier);
    }
    if (tableName && qualifiers.has(tableName))
        return tableName;
    if (qualifiers.size === 1)
        return [...qualifiers][0];
    return undefined;
}
