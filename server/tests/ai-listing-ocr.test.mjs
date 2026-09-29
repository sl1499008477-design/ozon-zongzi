import test from 'node:test';
import assert from 'node:assert/strict';
import {listingOcrCapability} from '../ai-listing-ocr.mjs';

test('Linux enables the production grid when Russian, English and Chinese OCR are installed',async()=>{
  const capability=await listingOcrCapability({platform:'linux',probe:async()=>({stdout:'List of available languages (3):\nchi_sim\neng\nrus\n'})});
  assert.equal(capability.available,true);
});

test('Linux reports missing OCR language data before a paid image request can start',async()=>{
  const capability=await listingOcrCapability({platform:'linux',probe:async()=>({stdout:'List of available languages (1):\neng\n'})});
  assert.equal(capability.available,false);
  assert.match(capability.reason,/rus/);
  assert.match(capability.reason,/chi_sim/);
});

test('missing Linux OCR executable is reported without leaking process output',async()=>{
  const capability=await listingOcrCapability({platform:'linux',probe:async()=>{throw new Error('internal process output');}});
  assert.equal(capability.available,false);
  assert.match(capability.reason,/Tesseract/);
  assert.doesNotMatch(capability.reason,/internal process output/);
});

test('Mac keeps using its installed Vision compiler',async()=>{
  assert.equal((await listingOcrCapability({platform:'darwin',probe:async()=>({stdout:'Swift installed'})})).available,true);
  assert.equal((await listingOcrCapability({platform:'darwin',probe:async()=>{throw new Error('missing');}})).available,false);
});
