import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import * as view from '../src/collect-enrichment-view.js';

test('list polls visible summaries and editor polls selected progress without the full refresh callback', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const polls = [...source.matchAll(/return startCollectEnrichmentPolling\(\{([\s\S]*?)\n\s*\}\);/g)];
  assert.equal(polls.length, 2);
  assert.match(polls[0][1], /document\.hidden.*loadPage\(\{signal\}\)/);
  assert.match(polls[1][1], /onCollectProgress/);
  for (const [, poll] of polls) {
    assert.doesNotMatch(poll, /onRefresh\(/);
  }
  assert.match(source, /onRefresh=\{refreshLocalState\}/, 'manual full refresh remains available');
});

test('only current active collection IDs are polled, including failed groups with active siblings', () => {
  assert.deepEqual(view.collectEnrichmentPollingIds([
    {id:'a', enrichment:{status:'NEEDS_ATTENTION',hasActiveJobs:true}},
    {id:'b', enrichment:{status:'COMPLETE'}},
    {id:'c', enrichment:{status:'NEEDS_ATTENTION',hasActiveJobs:false}},
    {id:'a', enrichment:{status:'PENDING_ENRICHMENT'}},
    {enrichment:{status:'PENDING_ENRICHMENT'}},
  ]), ['a']);
});

test('101 current items use two bounded reads and apply once, with no global or product read', async () => {
  const ids = Array.from({length:101}, (_, i) => `collect-${i}`);
  const requests = [], applied = [];
  const controller = new AbortController();
  const result = await view.refreshCollectEnrichmentProgress({
    ids, signal:controller.signal,
    request:async (path, options) => {
      const url = new URL(path, 'http://fixture.invalid');
      assert.equal(url.pathname, '/ozon/collect-box/progress');
      assert.equal(url.searchParams.has('accountId'), false);
      assert.equal(options.signal, controller.signal);
      const batch = url.searchParams.getAll('ids');
      requests.push(batch);
      return {data:batch.map(id => ({id, draftVersion:3, enrichment:{status:'COMPLETE'}}))};
    },
    apply:progress => applied.push(progress),
  });
  assert.deepEqual(requests.map(batch => batch.length), [100,1]);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].ids, ids);
  assert.equal(result.data.length, 101);
});

test('completion updates the full item needed for editing/listing while preserving other caches and items', () => {
  const running = {id:'a',draftVersion:1,enrichment:{status:'PENDING_ENRICHMENT'}};
  const untouched = {id:'b',listingDraft:{title:'saved manual value'}};
  const items = [running,untouched,{id:'deleted'}];
  const local = {currentStoreId:'store',caches:{collectBox:items,products:[{id:'product'}]},jobs:{keep:true}};
  const complete = {id:'a',draftVersion:2,enrichment:{status:'COMPLETE',completedSkus:43},
    listingDraft:{title:'saved title',logistics:{weightG:500},variants:[{sku:'successful-sku',images:['saved-image']}]},
    categoryResolution:{status:'ACTIVE',taxonomyScope:'OZON:DEFAULT'}};
  const merged = view.mergeCollectEnrichmentProgress(local, {ids:['a','deleted'],data:[complete,{id:'unrequested'}]}, items);
  assert.deepEqual(merged.caches.collectBox, [complete,untouched]);
  assert.equal(merged.caches.collectBox[1], untouched);
  assert.equal(merged.caches.products, local.caches.products);
  assert.equal(merged.jobs, local.jobs);
  assert.equal(view.collectEnrichmentView(merged.caches.collectBox[0].enrichment).listingBlocked, false);
  const current = {packageWeight:'901',packageLength:''};
  assert.equal(view.collectEditEnrichmentBackfill({current,item:complete,activeItemId:'a',generation:1,latestGeneration:1,dirtyFields:['packageWeight']}), current);
  const freshlyEdited = {...local,caches:{...local.caches,collectBox:[{...running,draftVersion:4},untouched]}};
  assert.equal(view.mergeCollectEnrichmentProgress(freshlyEdited, {ids:['a'],data:[complete]}, items), freshlyEdited,
    'an older polling response cannot overwrite a saved edit or a full refresh');
});

test('switching account/page or aborting an in-flight poll prevents its result from being applied', async () => {
  for (const reason of ['scope','abort']) {
    let current = true, applied = false, release;
    const controller = new AbortController();
    const pending = view.refreshCollectEnrichmentProgress({ids:['a'],signal:controller.signal,
      isCurrent:() => current, apply:() => {applied=true;},
      request:() => new Promise(resolve => {release=resolve;})});
    if (reason === 'scope') current = false;
    else controller.abort();
    release({data:[{id:'a'}]});
    await pending;
    assert.equal(applied, false, reason);
  }
});

test('read failure or malformed response preserves progress and remains eligible for the next tick', async () => {
  let applied = false;
  for (const request of [async () => {throw new Error('database unavailable');}, async () => ({ok:true})]) {
    await assert.rejects(view.refreshCollectEnrichmentProgress({ids:['a'],request,apply:()=>{applied=true;}}));
    assert.equal(applied, false);
  }
});

test('poll cleanup aborts the current read without introducing a timeout or changing the interval', async () => {
  let tick, signal;
  const stop = view.startCollectEnrichmentPolling({refresh:async options => {signal=options.signal;},
    setIntervalFn(fn, ms) {tick=fn;assert.equal(ms,5000);return 1;},clearIntervalFn() {}});
  await tick();
  assert.equal(signal.aborted,false);
  stop();
  assert.equal(signal.aborted,true);
});
