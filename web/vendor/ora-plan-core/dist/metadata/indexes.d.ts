import type { MetadataBundle, IndexObject, MetadataObject } from './bundle.js';
import type { PlanNode } from '../types.js';
export interface ResolvedIndex {
    key: string;
    object: IndexObject;
}
export interface ResolvedIndexesForBlock {
    tableKey: string | null;
    indexes: ResolvedIndex[];
}
export declare function resolveIndexesForBlock(match: {
    key: string;
    object: MetadataObject;
}, bundle: MetadataBundle): ResolvedIndexesForBlock;
export declare function findUsedIndexKeys(bundle: MetadataBundle, nodes: PlanNode[]): Set<string>;
