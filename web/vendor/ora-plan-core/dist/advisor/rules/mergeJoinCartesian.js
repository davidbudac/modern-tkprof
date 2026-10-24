/**
 * Rows a row source delivers per start. A-Rows is cumulative over all starts, so divide by Starts.
 * The BUFFER SORT under a MERGE JOIN CARTESIAN is started once per outer row and replays the
 * buffered set each time (A-Rows = outer rows x buffered rows, Starts = outer rows); the buffered
 * set itself is what its child produced on its single start.
 */
function rowsPerStart(node) {
    if (node.operation.toUpperCase().includes('BUFFER SORT') && node.children.length === 1 && node.children[0].actualRows !== undefined) {
        return rowsPerStart(node.children[0]);
    }
    if (node.actualRows !== undefined) {
        return node.starts !== undefined && node.starts > 1 ? node.actualRows / node.starts : node.actualRows;
    }
    return node.rows;
}
export const mergeJoinCartesianRule = {
    id: 'merge-join-cartesian',
    evaluate(ctx) {
        const findings = [];
        const { cartesianMinSideRows, cartesianCriticalProduct, maxFindingsPerRule } = ctx.thresholds;
        for (const node of ctx.plan.allNodes) {
            if (!node.operation.toUpperCase().includes('MERGE JOIN CARTESIAN'))
                continue;
            if (node.children.length !== 2)
                continue;
            const leftRows = rowsPerStart(node.children[0]);
            const rightRows = rowsPerStart(node.children[1]);
            if (leftRows === undefined || rightRows === undefined)
                continue;
            if (leftRows <= cartesianMinSideRows || rightRows <= cartesianMinSideRows)
                continue;
            // The join's own A-Rows is the real product; otherwise multiply the two sides.
            const actualProduct = node.actualRows !== undefined
                ? node.actualRows / (node.starts !== undefined && node.starts > 1 ? node.starts : 1)
                : undefined;
            const product = actualProduct ?? leftRows * rightRows;
            const isCritical = product > cartesianCriticalProduct;
            findings.push({
                ruleId: 'merge-join-cartesian',
                severity: isCritical ? 'critical' : 'warning',
                nodeIds: [node.id],
                title: `Cartesian product on ${node.operation}`,
                explanation: `A Cartesian join combines ${leftRows.toLocaleString()} rows with ${rightRows.toLocaleString()} rows, producing ${actualProduct !== undefined ? '' : 'up to '}${Math.round(product).toLocaleString()} rows with no join condition linking the two sides.`,
                suggestion: 'Check for a missing join predicate between these two row sources, or confirm the Cartesian product is intentional.',
            });
            if (findings.length >= maxFindingsPerRule)
                break;
        }
        return findings;
    },
};
