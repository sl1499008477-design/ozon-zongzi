import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderManagementService } from '../order-management-service.mjs';

test('pending order overview merges both processing groups before pagination and reports their combined total', async () => {
  const queries = [];
  const pool = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('SELECT s.id FROM stores')) return { rows: [{ id: 'owned-store' }] };
    if (sql.includes('GROUP BY effective_status')) return { rows: [
      { effective_status: 'awaiting_packaging', count: 2 }, { effective_status: 'acceptance_in_progress', count: 3 }, { effective_status: 'delivered', count: 8 },
    ] };
    return { rows: [] };
  } };
  const service = createOrderManagementService({ pool, clock: () => Date.parse('2026-09-27T06:00:00Z') });
  const result = await service.overview({ accountId: 'owner', storeId: 'owned-store' }, { status: 'pending', page: 2, pageSize: 2 });
  assert.equal(result.total, 5);
  assert.equal(result.statusCounts.pending, 5);
  assert.equal(result.statusCounts.all, 13);
  const selection = queries.find(query => query.sql.includes('LIMIT $7 OFFSET $8'));
  assert.match(selection.sql, /WHERE effective_status=ANY\(\$6::text\[\]\) ORDER BY[\s\S]*LIMIT/);
  assert.deepEqual(selection.values.slice(5), [
    ['awaiting_registration', 'awaiting_approve', 'awaiting_packaging', 'awaiting_deliver', 'acceptance_in_progress', 'not_accepted'], 2, 2,
  ]);
  assert.deepEqual(selection.values.slice(0, 2), ['owner', 'owned-store']);
});
