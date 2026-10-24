const SQL_KEYWORDS = new Set([
    'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'BETWEEN', 'LIKE', 'EXISTS',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'ON', 'USING',
    'TRUE', 'FALSE', 'UPPER', 'LOWER', 'SUBSTR', 'TRIM', 'NVL', 'COALESCE',
    'TO_CHAR', 'TO_NUMBER', 'TO_DATE', 'TO_TIMESTAMP', 'CAST', 'DECODE',
    'ROUND', 'FLOOR', 'CEIL', 'ABS', 'MOD', 'LENGTH', 'INSTR',
    'SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIMESTAMP',
    'ROWNUM', 'ROWID',
]);
const IDENTIFIER_RUN = /(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$#]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$#]*)){0,2}/g;
function stripQuotes(part) {
    if (part.startsWith('"') && part.endsWith('"'))
        return part.slice(1, -1);
    return part;
}
export function extractPredicateColumns(...predicates) {
    const seen = new Set();
    for (const predicate of predicates) {
        if (!predicate)
            continue;
        const matches = predicate.match(IDENTIFIER_RUN) ?? [];
        for (const run of matches) {
            const parts = run.split('.').map(stripQuotes);
            const col = parts[parts.length - 1].toUpperCase();
            if (!col)
                continue;
            if (SQL_KEYWORDS.has(col))
                continue;
            if (/^[0-9]/.test(col))
                continue;
            seen.add(col);
        }
    }
    return [...seen];
}
