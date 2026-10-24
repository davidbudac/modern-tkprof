function rawValue(node, metric) {
    // Adaptive-plan operations the optimizer did not use did no work: they carry no
    // value of their own, so only their active descendants roll up through them.
    if (node.inactive)
        return 0;
    switch (metric) {
        case 'actualTime':
            return node.actualTime ?? 0;
        case 'cost':
            return node.cost ?? 0;
        case 'actualRows':
            // Oracle's A-Rows is already cumulative over all starts, so it is used
            // as-is. Without it, fall back to the total estimate (E-Rows × starts).
            return node.actualRows ?? node.estimatedRowsTotal ?? node.rows ?? 0;
        case 'rows':
            // Total estimate over all starts (E-Rows × starts), comparable with the
            // cumulative A-Rows; per-start E-Rows is the fallback.
            return node.estimatedRowsTotal ?? node.rows ?? 0;
        default:
            return 0;
    }
}
export function rollupMetric(root, metric) {
    const values = new Map();
    function visit(node) {
        let childSum = 0;
        for (const child of node.children) {
            childSum += visit(child);
        }
        const value = Math.max(rawValue(node, metric), childSum);
        values.set(node.id, value);
        return value;
    }
    visit(root);
    return values;
}
/** Allocates child widths within [px0, px1], enforcing a per-child minimum where feasible. */
function allocateChildWidths(children, values, parentValue, px0, px1, minWidthPx) {
    const parentWidth = px1 - px0;
    const n = children.length;
    if (n === 0)
        return [];
    const idealWidths = children.map((child) => {
        const v = values.get(child.id) ?? 0;
        return parentValue === 0 ? parentWidth / n : (v / parentValue) * parentWidth;
    });
    if (parentWidth < n * minWidthPx) {
        // Not enough room to guarantee the minimum for every child; fall back to
        // pure proportional widths (hairlines are acceptable here).
        return idealWidths;
    }
    // Guarantee minWidthPx per child. Children below the minimum are pinned to
    // it; the deficit this creates (pinned width minus its ideal width) is
    // taken proportionally (by ideal width) from the still-unpinned children,
    // re-checking until stable. Unpinned children otherwise keep their ideal
    // width, so a parent's leftover self-space is preserved.
    const widths = idealWidths.slice();
    const pinned = new Set();
    let changed = true;
    while (changed) {
        changed = false;
        const unpinnedIndices = widths.map((_, i) => i).filter((i) => !pinned.has(i));
        if (unpinnedIndices.length === 0)
            break;
        const deficit = children.reduce((sum, _, i) => sum + (pinned.has(i) ? minWidthPx - idealWidths[i] : 0), 0);
        const unpinnedIdealTotal = unpinnedIndices.reduce((sum, i) => sum + idealWidths[i], 0);
        for (const i of unpinnedIndices) {
            const width = unpinnedIdealTotal === 0
                ? idealWidths[i] - deficit / unpinnedIndices.length
                : idealWidths[i] - (idealWidths[i] / unpinnedIdealTotal) * deficit;
            if (width < minWidthPx) {
                widths[i] = minWidthPx;
                pinned.add(i);
                changed = true;
            }
            else {
                widths[i] = width;
            }
        }
    }
    return widths;
}
function buildRects(node, depth, px0, px1, values, minWidthPx, out) {
    const value = values.get(node.id) ?? 0;
    let childrenValueSum = 0;
    for (const child of node.children) {
        childrenValueSum += values.get(child.id) ?? 0;
    }
    const selfValue = Math.max(0, value - childrenValueSum);
    out.push({ node, x0: px0, x1: px1, depth, value, selfValue });
    if (node.children.length === 0)
        return;
    const widths = allocateChildWidths(node.children, values, value, px0, px1, minWidthPx);
    let cursor = px0;
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        let childX0 = cursor;
        let childX1 = cursor + widths[i];
        // Clamp each child's span to the parent's span to guard floating point drift.
        childX0 = Math.min(Math.max(childX0, px0), px1);
        childX1 = Math.min(Math.max(childX1, px0), px1);
        if (childX1 < childX0)
            childX1 = childX0;
        buildRects(child, depth + 1, childX0, childX1, values, minWidthPx, out);
        cursor += widths[i];
    }
}
export function computeFlameLayout(root, metric, opts) {
    const { width } = opts;
    const minWidthPx = opts.minWidthPx ?? 2;
    const values = rollupMetric(root, metric);
    const out = [];
    buildRects(root, 0, 0, width, values, minWidthPx, out);
    return out;
}
export function getEffectiveFlameMetric(preferred, hasActualStats) {
    if (preferred !== 'cost' && !hasActualStats)
        return 'cost';
    return preferred;
}
