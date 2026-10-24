export function findObjectInBundle(bundle, objectName) {
    if (!objectName)
        return null;
    const direct = bundle.objects[objectName];
    if (direct)
        return { key: objectName, object: direct };
    const suffix = `.${objectName}`;
    for (const key of Object.keys(bundle.objects)) {
        if (key.endsWith(suffix)) {
            return { key, object: bundle.objects[key] };
        }
    }
    return null;
}
