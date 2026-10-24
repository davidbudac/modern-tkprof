import { findObjectInBundle } from "./lookup.js";
export function resolveIndexesForBlock(match, bundle) {
    if (match.object.type === 'TABLE') {
        const table = match.object;
        const indexes = [];
        for (const indexKey of table.indexes) {
            const obj = bundle.objects[indexKey];
            if (obj && obj.type === 'INDEX') {
                indexes.push({ key: indexKey, object: obj });
            }
        }
        return { tableKey: match.key, indexes };
    }
    const tableKey = match.object.table;
    const tableObj = bundle.objects[tableKey];
    if (!tableObj || tableObj.type !== 'TABLE') {
        return { tableKey: null, indexes: [] };
    }
    const indexes = [];
    for (const indexKey of tableObj.indexes) {
        if (indexKey === match.key)
            continue;
        const obj = bundle.objects[indexKey];
        if (obj && obj.type === 'INDEX') {
            indexes.push({ key: indexKey, object: obj });
        }
    }
    return { tableKey, indexes };
}
export function findUsedIndexKeys(bundle, nodes) {
    const used = new Set();
    for (const node of nodes) {
        if (!node.objectName)
            continue;
        const hit = findObjectInBundle(bundle, node.objectName);
        if (hit && hit.object.type === 'INDEX') {
            used.add(hit.key);
        }
    }
    return used;
}
