/**
 * Parse the DBMS_XPLAN "Note" section (dynamic sampling, adaptive plan,
 * SQL profile/baseline, etc.) from the tail of a plan listing.
 *
 * Looks for a line that is exactly "Note" (case-insensitive, trimmed),
 * skips the dashed underline that follows, then collects "- ..." lines
 * until the block ends.
 */
export function parseNoteSection(lines) {
    let noteLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^note$/i.test(lines[i].trim())) {
            noteLineIndex = i;
            break;
        }
    }
    if (noteLineIndex === -1) {
        return undefined;
    }
    let i = noteLineIndex + 1;
    // Skip the dashed underline line(s), if present.
    while (i < lines.length && /^\s*-+\s*$/.test(lines[i]))
        i++;
    const rawLines = [];
    for (; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^\s*-\s+(.*)$/);
        if (!match) {
            if (line.trim() === '')
                break;
            break;
        }
        rawLines.push(match[1].trim());
    }
    if (rawLines.length === 0) {
        return undefined;
    }
    const notes = { rawLines };
    for (const line of rawLines) {
        if (/dynamic (statistics|sampling) used/i.test(line)) {
            notes.dynamicSampling = true;
            const levelMatch = line.match(/level\s*=\s*(\d+)/i);
            if (levelMatch) {
                notes.dynamicSamplingLevel = parseInt(levelMatch[1], 10);
            }
        }
        if (/SQL plan directives? used/i.test(line)) {
            notes.planDirectives = true;
        }
        if (/cardinality feedback used/i.test(line)) {
            notes.cardinalityFeedback = true;
        }
        if (/statistics feedback used/i.test(line)) {
            notes.statisticsFeedback = true;
        }
        if (/this is an adaptive plan/i.test(line)) {
            notes.adaptivePlan = true;
        }
        const profileMatch = line.match(/SQL profile "([^"]+)"/i);
        if (profileMatch) {
            notes.sqlProfile = profileMatch[1];
        }
        const baselineMatch = line.match(/SQL plan baseline "([^"]+)"/i);
        if (baselineMatch) {
            notes.sqlPlanBaseline = baselineMatch[1];
        }
        const outlineMatch = line.match(/outline "([^"]+)"/i);
        if (outlineMatch) {
            notes.outline = outlineMatch[1];
        }
    }
    return notes;
}
