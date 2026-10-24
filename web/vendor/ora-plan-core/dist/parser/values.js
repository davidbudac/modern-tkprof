/**
 * Small pure value parsers shared by the DBMS_XPLAN and SQL Monitor text parsers.
 *
 * Oracle abbreviates large numbers in plan tables with a letter suffix. Counts
 * (Rows, Starts, Buffers, Cost…) use 1000-based suffixes; sizes (memory, temp)
 * use 1024-based ones.
 */
const SUFFIX_POWER = 'KMGTPE';
/** Line endings to `\n` (CRLF and lone CR) so files saved on Windows/old Mac parse like LF ones. */
export function normalizeNewlines(input) {
    return input.replace(/\r\n?/g, '\n');
}
/** Expand tabs to spaces on 8-column tab stops. */
export function expandTabs(line, tabSize = 8) {
    if (!line.includes('\t'))
        return line;
    let out = '';
    for (const ch of line) {
        if (ch === '\t') {
            out += ' '.repeat(tabSize - (out.length % tabSize));
        }
        else {
            out += ch;
        }
    }
    return out;
}
/**
 * Expand tabs in plan-table lines (those starting with `|`) so column slicing and
 * indentation depth see real columns. Other lines (SQL text, predicates) are untouched.
 */
export function expandTableTabs(lines) {
    return lines.map((line) => (line.startsWith('|') ? expandTabs(line) : line));
}
function scaled(num, suffix, base) {
    const value = parseFloat(num);
    if (!Number.isFinite(value))
        return null;
    const power = suffix ? SUFFIX_POWER.indexOf(suffix.toUpperCase()) + 1 : 0;
    return Math.round(value * Math.pow(base, power));
}
/** Count with 1000-based K/M/G/T/P/E suffixes; commas allowed ("1,234", "4823K"). */
export function parseCount(str) {
    const cleaned = str.replace(/,/g, '').trim();
    if (!cleaned)
        return null;
    const match = cleaned.match(/^([\d.]+)\s*([KMGTPE])?$/i);
    if (match)
        return scaled(match[1], match[2], 1000);
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? null : num;
}
/** Byte size with 1024-based K/M/G/T/P/E suffixes and an optional trailing B ("2048K", "10M", "512B"). */
export function parseByteSize(str) {
    const cleaned = str.replace(/,/g, '').trim();
    if (!cleaned)
        return null;
    const match = cleaned.match(/^([\d.]+)\s*([KMGTPE])?B?$/i);
    if (!match)
        return null;
    return scaled(match[1], match[2], 1024);
}
/** "123 (5)", "4823K (1)", "13M  (2)" → cost (1000-based suffix) and the %CPU in parentheses. */
export function parseCostCell(str) {
    const match = str.replace(/,/g, '').trim().match(/^([\d.]+)\s*([KMGTPE])?\s*(?:\((\d+)\))?/i);
    if (!match)
        return null;
    const cost = scaled(match[1], match[2], 1000);
    if (cost === null)
        return null;
    return match[3] !== undefined ? { cost, cpuPercent: parseInt(match[3], 10) } : { cost };
}
/**
 * ALLSTATS Used-Mem: memory used by the last execution plus, in parentheses, how
 * many passes the work area needed (0 optimal, 1 one-pass, n > 1 multipass).
 * "1385K (0)" → { bytes: 1418240, passes: 0 }.
 */
export function parseUsedMem(str) {
    const match = str.trim().match(/^(\S+?)\s*(?:\((\d+)\))?$/);
    if (!match)
        return null;
    const bytes = parseByteSize(match[1]);
    if (bytes === null)
        return null;
    return match[2] !== undefined ? { bytes, passes: parseInt(match[2], 10) } : { bytes };
}
/** ALLSTATS (without LAST) O/1/M column: executions that ran optimal / one-pass / multipass ("1/0/0"). */
export function parseWorkareaExecutions(str) {
    const match = str.trim().match(/^(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)$/);
    if (!match)
        return null;
    return {
        optimal: parseInt(match[1], 10),
        onePass: parseInt(match[2], 10),
        multipass: parseInt(match[3], 10),
    };
}
/** A-Time ("00:00:00.06", "01:02:03", or plain seconds) → milliseconds. */
export function parseTimeToMs(timeStr) {
    if (!timeStr)
        return null;
    // Format: HH:MM:SS.ss or SS.ss or similar
    const hhmmssMatch = timeStr.match(/(\d+):(\d+):(\d+)(?:\.(\d+))?/);
    if (hhmmssMatch) {
        const hours = parseInt(hhmmssMatch[1], 10);
        const minutes = parseInt(hhmmssMatch[2], 10);
        const seconds = parseInt(hhmmssMatch[3], 10);
        const fraction = hhmmssMatch[4] ? parseInt(hhmmssMatch[4], 10) / Math.pow(10, hhmmssMatch[4].length) : 0;
        return (hours * 3600 + minutes * 60 + seconds + fraction) * 1000;
    }
    // Just seconds
    const secMatch = timeStr.match(/([\d.]+)\s*(?:s|sec)?/i);
    if (secMatch) {
        return parseFloat(secMatch[1]) * 1000;
    }
    return null;
}
