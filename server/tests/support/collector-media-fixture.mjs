import {createServer,request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';
import {createListingMediaStorage} from '../../listing-media-storage.mjs';

const env={LISTING_MEDIA_STORAGE:'cos',LISTING_COS_BUCKET:'fixture-1250000000',LISTING_COS_REGION:'ap-beijing',LISTING_COS_SECRET_ID:'fixture-id',LISTING_COS_SECRET_KEY:'fixture-key'};
const md5=bytes=>createHash('md5').update(bytes).digest('hex');
const mask=(1n<<64n)-1n,poly=0x42f0e1eba9ea3693n;
const table=Array.from({length:256},(_,i)=>{let value=BigInt(i)<<56n;for(let bit=0;bit<8;bit++)value=(value&1n<<63n)?value<<1n^poly:value<<1n;return value&mask;});
const crc64=bytes=>{let crc=0n;for(const byte of bytes)crc=((crc<<8n)&mask)^table[Number((crc>>56n)^BigInt(byte))];return String(crc);};

// A local HTTP COS boundary, with real SDK signatures, method/header checking,
// MD5 enforcement, immutable versions, ranges, and conditional server-side copy.
export async function collectorMediaFixture(t,{sources=new Map()}={}){
  const objects=new Map(),calls=[],errors=[];let losePutResponse=false;
  const find=(key,version)=>{const versions=objects.get(key)||[];return version?versions.find(v=>v.versionId===version):versions.at(-1);};
  const save=(key,bytes,contentType)=>{const value={key,bytes,contentType,size:bytes.length,etag:md5(bytes),crc64:crc64(bytes),versionId:randomUUID()};objects.set(key,[...(objects.get(key)||[]),value]);return value;};
  const headers=object=>({'Content-Type':object.contentType,'Content-Length':object.size,ETag:`"${object.etag}"`,'x-cos-version-id':object.versionId,'x-cos-hash-crc64ecma':object.crc64});
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://fixture'),key=decodeURIComponent(url.pathname).slice(1);
      calls.push({method:req.method,key,versionId:url.searchParams.get('versionId'),range:req.headers.range,copy:req.headers['x-cos-copy-source']});
      if(sources.has(key)){const bytes=sources.get(key);res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);return;}
      const reject=(status,code)=>{res.writeHead(status,{'Content-Type':'application/xml'});res.end(`<Error><Code>${code}</Code></Error>`);};
      const authorization=new URLSearchParams(req.headers.authorization||url.searchParams);
      const signature=authorization.get('q-signature');
      if(!signature)return reject(403,'AccessDenied');
      const queryNames=(authorization.get('q-url-param-list')||'').split(';').filter(Boolean),query={};
      for(const [name,value] of url.searchParams)if(queryNames.includes(name.toLowerCase()))query[name]=value;
      const signedHeaders={};for(const name of (authorization.get('q-header-list')||'').split(';').filter(Boolean))signedHeaders[name]=req.headers[name];
      const actual=new URLSearchParams(COS.getAuthorization({SecretId:env.LISTING_COS_SECRET_ID,SecretKey:env.LISTING_COS_SECRET_KEY,
        Method:req.method,Key:key,KeyTime:authorization.get('q-key-time'),Headers:signedHeaders,Query:query}));
      if(actual.get('q-signature')!==signature||Number(authorization.get('q-sign-time')?.split(';')[1])<Date.now()/1000)return reject(403,'SignatureDoesNotMatch');
      if(req.method==='PUT'&&req.headers['x-cos-copy-source']){
        const original=new URL('https://'+req.headers['x-cos-copy-source']);
        const object=find(decodeURIComponent(original.pathname).slice(1),original.searchParams.get('versionId'));
        if(!object)return reject(404,'NoSuchKey');
        if(req.headers['x-cos-copy-source-if-match']!==`"${object.etag}"`)return reject(412,'PreconditionFailed');
        const copied=save(key,object.bytes,req.headers['content-type']);
        const copiedHeaders={...headers(copied),'Content-Type':'application/xml'};delete copiedHeaders['Content-Length'];
        res.writeHead(200,copiedHeaders);
        res.end(`<CopyObjectResult><ETag>"${copied.etag}"</ETag><LastModified>2026-09-17T00:00:00.000Z</LastModified><CRC64>${copied.crc64}</CRC64></CopyObjectResult>`);return;
      }
      if(req.method==='PUT'){
        const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>20*1024**2)throw Error('fixture upload limit');chunks.push(chunk);}
        const bytes=Buffer.concat(chunks);
        if(Buffer.from(md5(bytes),'hex').toString('base64')!==req.headers['content-md5'])return reject(400,'BadDigest');
        const object=save(key,bytes,req.headers['content-type']);
        if(losePutResponse){losePutResponse=false;req.socket.destroy();return;}
        res.writeHead(200,{ETag:`"${object.etag}"`,'x-cos-version-id':object.versionId});res.end();return;
      }
      const object=find(key,url.searchParams.get('versionId'));if(!object)return reject(404,'NoSuchKey');
      if(req.method==='HEAD'){res.writeHead(200,headers(object));res.end();return;}
      if(req.method==='GET'){
        if(req.headers['if-match']&&req.headers['if-match']!==`"${object.etag}"`)return reject(412,'PreconditionFailed');
        const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
        if(range){const start=+range[1],end=+range[2],bytes=object.bytes.subarray(start,end+1);res.writeHead(206,{...headers(object),'Content-Length':bytes.length,'Content-Range':`bytes ${start}-${end}/${object.size}`});res.end(bytes);return;}
        res.writeHead(200,headers(object));res.end(object.bytes);return;
      }
      reject(403,'AccessDenied');
    }catch(error){errors.push(error.message);if(!res.headersSent){res.writeHead(500);res.end();}else res.destroy();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(errors.length)throw Error(errors.join('\n'));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const cosClient=new COS({SecretId:env.LISTING_COS_SECRET_ID,SecretKey:env.LISTING_COS_SECRET_KEY,Domain:`127.0.0.1:${server.address().port}`,
    Protocol:'http:',Timeout:3000,KeepAlive:false,ChunkRetryTimes:0});
  const request=(url,options,callback)=>httpRequest(new URL(url.pathname+url.search,base),{...options,lookup:undefined},callback);
  return {objects,calls,storage:createListingMediaStorage({env,cosClient}),request,find,save,base,losePutResponse:()=>{losePutResponse=true;}};
}
