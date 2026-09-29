import assert from 'node:assert/strict';
import test from 'node:test';
import { aiListingHomeFilter, aiListingTaskListPath } from '../src/ai-listing-home-filter.js';

test('home failure and attention links span failed and active task groups', () => {
  assert.deepEqual(aiListingHomeFilter('?tab=tasks&group=active&stage=attention'), { group: 'all', stage: 'attention' });
  assert.deepEqual(aiListingHomeFilter('?tab=tasks&group=failed&stage=failed'), { group: 'all', stage: 'failed' });
});

test('home progress stages scope active tasks; invalid URL filters keep normal active view', () => {
  for (const stage of ['review', 'enrichment', 'generating', 'submitting']) {
    assert.deepEqual(aiListingHomeFilter(`?group=all&stage=${stage}`), { group: 'active', stage });
  }
  assert.deepEqual(aiListingHomeFilter('?group=all&stage=unknown'), { group: 'active', stage: '' });
  assert.deepEqual(aiListingHomeFilter('?group=failed'), { group: 'failed', stage: '' });
  assert.deepEqual(aiListingHomeFilter(''), { group: 'active', stage: '' });
});

test('task list requests preserve server-side stage and pagination instead of filtering current page', () => {
  const path = aiListingTaskListPath({ group: 'all', stage: 'failed', page: 3, pageSize: 5 });
  assert.equal(path, '/ai-listing/tasks?view=tasks&group=all&stage=failed&limit=5&offset=10');
  assert.equal(aiListingTaskListPath({ group: 'active', stage: '', page: 1, pageSize: 5 }), '/ai-listing/tasks?view=tasks&group=active&limit=5&offset=0');
});
