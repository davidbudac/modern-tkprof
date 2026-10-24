import type { MetadataBundle, MetadataObject } from './bundle.js';
export declare function findObjectInBundle(bundle: MetadataBundle, objectName: string | undefined): {
    key: string;
    object: MetadataObject;
} | null;
