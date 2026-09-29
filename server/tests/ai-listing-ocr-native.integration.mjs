import assert from 'node:assert/strict';
import sharp from 'sharp';
import {listingOcrCapability,recognizeListingText} from '../ai-listing-ocr.mjs';
import {readAiChannelTestSample,readAiChannelTestImage} from '../ai-channel-test-sample.mjs';
import {prepareGrid,splitGrid} from '../ai-listing-grid.mjs';

const started=Date.now();
const capability=await listingOcrCapability();
assert.equal(capability.available,true,capability.reason);
const descriptor=await readAiChannelTestSample();
const sources=await Promise.all(descriptor.sample.images.map(async image=>(await readAiChannelTestImage(image.url)).buffer));
const texts=await recognizeListingText(sources);
assert.equal(texts.length,6);
for(const text of texts)assert.doesNotMatch(text,/^(?:20|23)$/mu,'Rotated artwork must not introduce standalone numbers');
assert.match(texts[0],/2\s+штуки\s+в\s+наборе/iu);
assert.match(texts[1],/НЕ\s+ПУТАЮТСЯ/u);
assert.match(texts[1],/После/iu);
assert.match(texts[2],/зарядных\s+устройств/iu);
assert.match(texts[3],/Откидная\s+крышка/iu);
assert.match(texts[4],/сумку\s+или\s+рюкзак/iu);
for(const value of ['7,8','9,1','4,6'])assert.match(texts[5],new RegExp(value+'\\s*[сc][мm]','iu'));
const prepared=await prepareGrid({sources,facts:texts,prompt:descriptor.prompt.text,language:'ru'});
const images=await splitGrid(prepared.bytes,prepared.layout,6);
assert.equal(images.length,6);
for(const bytes of images){const {width,height}=await sharp(bytes).metadata();assert.equal(width,768);assert.equal(height,1024);}
// A blank picture must keep its own slot; OCR from the following picture cannot shift forward.
const blank=await sharp({create:{width:40,height:40,channels:3,background:'#fff'}}).png().toBuffer();
const blankTexts=await recognizeListingText([blank,sources[0],blank]);
assert.equal(blankTexts.length,3);assert.equal(blankTexts[0],'');assert.equal(blankTexts[2],'');
assert.match(blankTexts[1],/2\s+штуки\s+в\s+наборе/iu);
await assert.rejects(()=>recognizeListingText([Buffer.from('not an image')]),{code:'AI_LISTING_OCR_FAILED'});
console.log(JSON.stringify({platform:process.platform,arch:process.arch,sample:descriptor.sample.version,elapsedMs:Date.now()-started,checks:'source text, decimal dimensions, blank-page order, image decoding, six 768x1024 slices',texts},null,2));
