import { sonliRequest } from './sonli-api.services.js';
import { getDesktopDeviceId } from './collector-backend.services.js';

export function claimCollectorProductGroup(runId, leaseToken, anchorSku, skus) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/product-groups/claim`,
        data: { deviceId: getDesktopDeviceId(), leaseToken, anchorSku, skus } });
}

export function saveCollectorGroupVariant(runId, leaseToken, groupId, anchorSku, variant) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/product-groups/${encodeURIComponent(groupId)}/variants`,
        data: { deviceId: getDesktopDeviceId(), leaseToken, anchorSku, variant } });
}

export function releaseCollectorProductGroup(runId, leaseToken, groupId, anchorSku) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/product-groups/${encodeURIComponent(groupId)}/release`,
        data: { deviceId: getDesktopDeviceId(), leaseToken, anchorSku } });
}
