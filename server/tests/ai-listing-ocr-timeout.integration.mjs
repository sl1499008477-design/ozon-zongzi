import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import sharp from 'sharp';

test('Linux OCR preserves original source slots at its time limit', {skip:process.platform!=='linux'}, async()=>{
const original=childProcess.execFile;
let respond;
const fake=()=>{};
fake[promisify.custom]=async(command,args)=>{
  assert.equal(command,'tesseract');
  if(args[0]==='--list-langs')return {stdout:'rus\neng\nchi_sim\n'};
  return respond((await readFile(args[0],'utf8')).split('\n').map(path=>basename(path)));
};
childProcess.execFile=fake;syncBuiltinESMExports();
const {recognizeListingText}=await import('../ai-listing-ocr.mjs');
const blank=await sharp({create:{width:40,height:40,channels:3,background:'#fff'}}).png().toBuffer();
const header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n';
const page=(n,text='')=>`1\t${n}\t0\t0\t0\t0\t0\t0\t40\t40\t-1\t\n`+(text?`5\t${n}\t1\t1\t1\t1\t0\t0\t30\t10\t95\t${text}\n`:'');
const timedOut=stdout=>Object.assign(new Error('Command timed out'),{code:null,signal:'SIGTERM',killed:true,stdout});
try {
  respond=async()=>{throw timedOut(header+page(1,'Крышка')+page(2)+page(3,'12 см'));};
  assert.deepEqual(await recognizeListingText([blank,blank,blank]),['Крышка','','12 см'],'Keep completed source text in the original slots when supplementary OCR times out');
  respond=async paths=>{
    assert.deepEqual(paths.slice(0,3),['0-0.png','1-0.png','2-0.png'],'Cover every upright source before supplementary views');
    throw timedOut('');
  };
  assert.deepEqual(await recognizeListingText([blank,blank,blank]),['','',''],'Valid source images remain usable without optional OCR text');
  respond=async()=>({stdout:header+page(1)});
  await assert.rejects(()=>recognizeListingText([blank]),{code:'AI_LISTING_OCR_FAILED'},'Unexpected truncated successful output is still an error');
  respond=async()=>{throw Object.assign(new Error('Tesseract failed'),{code:1,stdout:header+page(1)});};
  await assert.rejects(()=>recognizeListingText([blank]),{code:'AI_LISTING_OCR_FAILED'});
  respond=async()=>{throw Object.assign(timedOut(header+page(1)),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});};
  await assert.rejects(()=>recognizeListingText([blank]),{code:'AI_LISTING_OCR_FAILED'});
  await assert.rejects(()=>recognizeListingText([Buffer.from('not an image')]),{code:'AI_LISTING_OCR_FAILED'});
  console.log(JSON.stringify({passed:true,checks:['partial timeout preserves source order and blank slots','upright sources first','empty timeout uses original images','invalid completed output rejected','process errors rejected','output overflow rejected','invalid image rejected']}));
} finally {childProcess.execFile=original;syncBuiltinESMExports();}
});
