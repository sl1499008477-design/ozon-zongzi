import { listingWarehouseEligibility, assertListingWarehouseEligible } from './listing-warehouse-eligibility.mjs';

// Collection drafts use platform warehouse IDs; the verifier uses local record IDs.
export async function validateCollectListingWarehouses({warehouses=[], products=[], stocks=[], targetStoreId, accountId, verifyRfbsWarehouse}) {
  const ids = [...new Set(stocks.map(s => String(s.warehouse_id || s.warehouseId || '').trim()).filter(Boolean))];
  for (const id of ids) {
    const warehouse = warehouses.find(w => String(w.warehouse_id || w.warehouseId) === id
      && String(w.storeId || w.store_id) === String(targetStoreId));
    const input = {warehouse, products, targetStoreId, accountId};
    const eligibility = listingWarehouseEligibility(input);
    let validationEvidence;
    if (eligibility.code === 'RFBS_VALIDATION_REQUIRED') {
      validationEvidence = await verifyRfbsWarehouse({accountId, actorAccountId:accountId,
        targetStoreId, targetWarehouseId:warehouse.id, correlationId:'collect-listing'});
    }
    assertListingWarehouseEligible({...input, validationEvidence});
  }
}
