const QUALIFIED_COLUMN = '(?:"[^"]+"\\.){0,2}"[^"]+"';
const INTERNAL_FUNCTION_RE = new RegExp(`INTERNAL_FUNCTION\\(\\s*(${QUALIFIED_COLUMN})\\s*\\)`, 'g');
const CONVERSION_FN_RE = new RegExp(`\\b(TO_NUMBER|TO_CHAR|TO_DATE)\\(\\s*(${QUALIFIED_COLUMN})\\s*[,)]`, 'g');
function stripQuotes(qualifiedColumn) {
    const parts = qualifiedColumn.split('.');
    const last = parts[parts.length - 1];
    if (last.startsWith('"') && last.endsWith('"'))
        return last.slice(1, -1);
    return last;
}
/** Blank out single-quoted literals so quotes/parens inside them can't confuse the context checks. */
function maskLiterals(predicate) {
    return predicate.replace(/'(?:[^']|'')*'/g, (lit) => ' '.repeat(lit.length));
}
/** True when `index` sits inside an analytic clause: OVER ( ... ). */
function insideOverClause(masked, index) {
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
        const ch = masked[i];
        if (ch === ')')
            depth++;
        else if (ch === '(') {
            if (depth > 0)
                depth--;
            else if (/\bOVER\s*$/i.test(masked.slice(0, i)))
                return true;
        }
    }
    return false;
}
const COMPARISON_BEFORE_RE = /(?:=|<|>|\bLIKE|\bBETWEEN)\s*$/i;
const COMPARISON_AFTER_RE = /^\s*(?:=|<|>|!=|\^=|(?:NOT\s+)?(?:LIKE|BETWEEN|IN)\b)/i;
const SORT_KEY_AFTER_RE = /^\s*(?:ASC|DESC)\b/i;
/**
 * Oracle prints INTERNAL_FUNCTION in places that are not conversions on a
 * compared column: DESC sort keys in analytic clauses, and a bare boolean term
 * (its IN-list representation). Only an operand of a comparison counts.
 */
function isConversionContext(masked, start, end) {
    if (SORT_KEY_AFTER_RE.test(masked.slice(end)))
        return false;
    if (insideOverClause(masked, start))
        return false;
    return COMPARISON_BEFORE_RE.test(masked.slice(0, start)) || COMPARISON_AFTER_RE.test(masked.slice(end));
}
function scan(predicate, source) {
    const hits = [];
    const masked = maskLiterals(predicate);
    for (const match of predicate.matchAll(INTERNAL_FUNCTION_RE)) {
        const start = match.index ?? 0;
        if (!isConversionContext(masked, start, start + match[0].length))
            continue;
        hits.push({
            fn: 'INTERNAL_FUNCTION',
            column: stripQuotes(match[1]),
            fragment: match[0],
            source,
        });
    }
    for (const match of predicate.matchAll(CONVERSION_FN_RE)) {
        const fn = match[1];
        hits.push({
            fn,
            column: stripQuotes(match[2]),
            fragment: match[0],
            source,
        });
    }
    return hits;
}
export function findImplicitConversions(access, filter) {
    const hits = [];
    if (access)
        hits.push(...scan(access, 'access'));
    if (filter)
        hits.push(...scan(filter, 'filter'));
    return hits;
}
function parseColumnRef(qualified) {
    const parts = qualified.split('.').map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
    const column = parts[parts.length - 1];
    const alias = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    return alias === undefined ? { column } : { alias, column };
}
/**
 * Columns referenced by predicates. Oracle prints every column reference quoted
 * ("E"."SAL"), while functions, keywords and bind variables are not, so quoted
 * identifier runs are columns. Literals are blanked first so quotes inside them
 * can't produce false hits. Results are de-duplicated by alias + column.
 */
export function extractQuotedColumns(...predicates) {
    const seen = new Set();
    const refs = [];
    for (const predicate of predicates) {
        if (!predicate)
            continue;
        for (const match of maskLiterals(predicate).matchAll(new RegExp(QUALIFIED_COLUMN, 'g'))) {
            const ref = parseColumnRef(match[0]);
            const key = `${ref.alias ?? ''}.${ref.column}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            refs.push(ref);
        }
    }
    return refs;
}
// Functions that hide a column from a plain B-tree index on it. The wrapped column
// has to be the first argument (NVL("COL", 0), SUBSTR("COL", 1, 3), TRUNC("D", 'MM')).
const WRAPPING_FUNCTIONS = [
    'UPPER', 'LOWER', 'INITCAP', 'TRUNC', 'ROUND', 'NVL', 'NVL2', 'COALESCE', 'SUBSTR', 'INSTR',
    'LENGTH', 'TRIM', 'LTRIM', 'RTRIM', 'REPLACE', 'LPAD', 'RPAD', 'TO_CHAR', 'TO_DATE', 'TO_NUMBER',
    'TO_TIMESTAMP', 'FLOOR', 'CEIL', 'DECODE', 'ADD_MONTHS',
];
const WRAPPING_FN_RE = new RegExp(`\\b(${WRAPPING_FUNCTIONS.join('|')})\\(\\s*(${QUALIFIED_COLUMN})\\s*[,)]`, 'g');
/** Columns that appear as the first argument of a function in a predicate (UPPER("E"."ENAME")='X'). */
export function findFunctionWrappedColumns(access, filter) {
    const hits = [];
    const scanOne = (predicate, source) => {
        if (!predicate)
            return;
        // Mask literals so a function-looking string inside a literal can't match; the column
        // regex only needs the quoted identifiers, which maskLiterals leaves intact.
        for (const match of maskLiterals(predicate).matchAll(WRAPPING_FN_RE)) {
            hits.push({ fn: match[1], ...parseColumnRef(match[2]), fragment: `${match[1]}(${match[2]}${match[0].endsWith(',') ? ', …' : ''})`, source });
        }
    };
    scanOne(access, 'access');
    scanOne(filter, 'filter');
    return hits;
}
