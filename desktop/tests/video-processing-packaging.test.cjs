const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');

test('production package copies only the shared video processor beside app.asar',()=>{
  const config=require('../electron-builder.production.cjs');
  const entries=config.extraResources.filter(entry=>entry.to==='shared/ozon-video-processing.mjs');
  assert.equal(entries.length,1);
  assert.equal(entries[0].from,path.join(__dirname,'..','..','shared','ozon-video-processing.mjs'));
});
