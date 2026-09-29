import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm,access,mkdir,rename} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
const exec=promisify(execFile);
let compiled;
const LANGUAGES = ['rus','eng','chi_sim'];
export async function listingOcrCapability({platform=process.platform,probe=exec}={}) {
  if(platform==='linux') {
    try {
      const {stdout}=await probe('tesseract',['--list-langs'],{timeout:10_000,maxBuffer:64*1024});
      const installed=new Set(String(stdout||'').split(/\r?\n/).map(line=>line.trim()));
      const missing=LANGUAGES.filter(language=>!installed.has(language));
      return missing.length ? {available:false,reason:`服务器文字识别缺少语言包：${missing.join('、')}`} : {available:true};
    } catch {return {available:false,reason:'服务器 Tesseract 文字识别不可用，请检查安装或选择逐张生图'};}
  }
  if(platform!=='darwin')return {available:false,reason:'智能拼图切片需要 Linux 或 macOS 文字识别环境；当前环境可使用逐张生图'};
  try {await probe('/usr/bin/swiftc',['--version'],{timeout:10_000,maxBuffer:64*1024});return {available:true};}
  catch {return {available:false,reason:'本机 Swift 文字识别工具尚不可用，请安装 Command Line Tools 或选择逐张生图'};}
}
async function binary() {
  if(process.platform!=='darwin')throw new Error('macOS Vision required');
  const source=fileURLToPath(new URL('./ai-listing-ocr.swift',import.meta.url));
  const hash=createHash('sha256').update(await readFile(source)).digest('hex').slice(0,16);
  const cache=join(homedir(),'Library','Caches','ozon 粽子');
  await mkdir(cache,{recursive:true});
  const path=join(cache,`vision-${process.arch}-${hash}`);
  try {await access(path);return path;}catch{}
  const temp=`${path}-${process.pid}`;
  await exec('/usr/bin/swiftc',[source,'-o',temp],{timeout:120_000,maxBuffer:1024*1024});
  await rename(temp,path);return path;
}
// Confidence belongs to OCR output, not the original image. Keep original inputs for generation.
function tesseractText(tsv,views,count,partial=false) {
  const lines=new Map(),pages=new Set();
  for(const row of tsv.split(/\r?\n/).slice(1)) {
    const fields=row.split('\t'),page=Number(fields[1]);
    if(fields[0]==='1')pages.add(page);
    if(fields[0]!=='5'||!fields[11]?.trim())continue;
    const key=fields.slice(1,5).join(':');
    const line=lines.get(key)||{page,words:[],score:0,length:0};
    const word=fields.slice(11).join('\t').trim();
    line.words.push(word);line.score+=Number(fields[10])*word.length;line.length+=word.length;
    lines.set(key,line);
  }
  if(!partial&&pages.size!==views.length)throw new Error('OCR page count mismatch');
  const result=Array.from({length:count},()=>new Set());
  for(const line of lines.values()) {
    const view=views[line.page-1],text=line.words.join(' ');
    if(!view||line.score/line.length<75||(text.match(/[\p{L}\p{N}]/gu)||[]).length<2)continue;
    // Supplement vertical measurements with units, excluding isolated marks in sideways artwork.
    if(view.rotated&&!/^\d[\d.,]*\s*[\p{L}%°]{1,8}$/u.test(text))continue;
    result[view.index].add(text);
  }
  return result.map(lines=>[...lines].join('\n'));
}

async function recognizeLinuxText(buffers,dir) {
  const views=[];
  for(let index=0;index<buffers.length;index++) {
    const source=sharp(buffers[index]).rotate();
    // Bound OCR work for large source photos; generation still receives the original bytes.
    const full=await source.clone().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
      .grayscale().normalize().threshold(180).png().toBuffer();
    const small=await source.clone().resize({width:800,height:800,fit:'inside',withoutEnlargement:true})
      .grayscale().normalize().threshold(180).png().toBuffer();
    const images=[full,small,await sharp(small).rotate(90).png().toBuffer(),await sharp(small).rotate(270).png().toBuffer()];
    for(let variant=0;variant<images.length;variant++) {
      const path=join(dir,`${index}-${variant}.png`);await writeFile(path,images[variant]);
      views.push({path,index,variant,rotated:variant>=2});
    }
  }
  // Cover every upright source before spending time on smaller/rotated supplements.
  views.sort((a,b)=>a.variant-b.variant);
  const list=join(dir,'images.txt');await writeFile(list,views.map(view=>view.path).join('\n'));
  let stdout,partial=false;
  try {
    ({stdout}=await exec('tesseract',[list,'stdout','-l',LANGUAGES.join('+'),'--psm','11','tsv'],{
      timeout:120_000,maxBuffer:8*1024*1024,env:{...process.env,OMP_THREAD_LIMIT:'1'},
    }));
  } catch(error) {
    if(!error.killed||error.signal!=='SIGTERM'||error.code!==null)throw error;
    // OCR only supplements the original images. A time limit must not discard valid sources.
    stdout=String(error.stdout||'');stdout=stdout.slice(0,stdout.lastIndexOf('\n')+1);partial=true;
    console.warn('[ai-listing] OCR time limit reached; using available text and original images',{sources:buffers.length});
  }
  return tesseractText(stdout,views,buffers.length,partial);
}

export async function recognizeListingText(buffers) {
  if(!buffers.length)return [];
  let executable;
  try {
    if(process.platform==='linux') {
      const capability=await listingOcrCapability();if(!capability.available)throw new Error('OCR unavailable');
    } else {compiled??=binary().catch(e=>{compiled=null;throw e;});executable=await compiled;}
  } catch {throw Object.assign(new Error('文字识别不可用'),{code:'AI_LISTING_OCR_UNAVAILABLE'});}
  const dir=await mkdtemp(join(tmpdir(),'ai-listing-ocr-'));
  try {
    if(process.platform==='linux')return await recognizeLinuxText(buffers,dir);
    const paths=[];
    for(let i=0;i<buffers.length;i++){const path=join(dir,`${i}.image`);await writeFile(path,buffers[i]);paths.push(path);}
    const {stdout}=await exec(executable,paths,{timeout:120_000,maxBuffer:2*1024*1024});
    return JSON.parse(stdout).pages.map(page=>page.lines.map(line=>line.text).join('\n'));
  } catch {throw Object.assign(new Error('原图文字识别失败'),{code:'AI_LISTING_OCR_FAILED'});}
  finally {await rm(dir,{recursive:true,force:true});}
}
