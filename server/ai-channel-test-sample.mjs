import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AI_LISTING_DEFAULT_PROMPT} from './ai-listing-service.mjs';

const directory=new URL('../app/public/ai-channel-samples/v1/',import.meta.url);
const prefix='/ai-channel-samples/v1/';
let loaded;
async function sampleFiles() {
  return loaded ||= (async()=>{
    const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
    const files=new Map();
    for(const image of manifest.images)files.set(prefix+image.file,await readFile(new URL(image.file,directory)));
    return {manifest,files};
  })().catch(error=>{loaded=null;throw error;});
}

export async function readAiChannelTestSample() {
  const {manifest}=await sampleFiles();
  return {available:true,sample:{version:manifest.version,name:manifest.name,referenceNotes:manifest.referenceNotes,
    images:manifest.images.map(({file,...image})=>({...image,url:prefix+file}))},
    prompt:{version:'formal-grid-v1-'+createHash('sha256').update(AI_LISTING_DEFAULT_PROMPT).digest('hex').slice(0,12),text:AI_LISTING_DEFAULT_PROMPT},
    image:{ratio:'3:4',language:'ru',quality:'high'},expected:{count:6,width:768,height:1024}};
}

export async function readAiChannelTestImage(url) {
  const {files}=await sampleFiles();
  const buffer=files.get(url);
  if(!buffer)throw Object.assign(new Error('内置测试图片不存在'),{code:'CHANNEL_TEST_SAMPLE_UNAVAILABLE'});
  return {buffer};
}
