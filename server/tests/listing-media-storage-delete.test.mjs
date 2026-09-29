import test from 'node:test';
import assert from 'node:assert/strict';
import {createListingMediaStorage} from '../listing-media-storage.mjs';
import {createServer} from 'node:http';
import COS from 'cos-nodejs-sdk-v5';
import {Readable} from 'node:stream';

const env={LISTING_MEDIA_STORAGE:'cos',LISTING_COS_BUCKET:'public-media-1250000000',LISTING_COS_REGION:'ap-shanghai',LISTING_COS_SECRET_ID:'fixture',LISTING_COS_SECRET_KEY:'fixture'};
const key=`listing-media/v1/prepared/${'a'.repeat(64)}.mp4`;
test('legacy versioned media is removed too; a failure remains retryable and adjacent keys survive',async()=>{
  const versions=new Set(['old-v1','old-v2','marker']);let fail=true;
  const cosClient={listObjectVersions:async()=>({statusCode:200,Versions:[],DeleteMarkers:[],IsTruncated:'false'})};
  const legacyClient={listObjects:(bucket,prefix,recursive,options)=>{
    assert.equal(prefix,key);assert.equal(options.IncludeVersion,true);
    return Readable.from([...versions].map(versionId=>({name:key,versionId})).concat({name:key+'.other',versionId:'neighbor'}));
  },removeObject:async(bucket,name,{versionId})=>{assert.equal(name,key);if(fail&&versionId==='old-v2')throw new Error('temporary MinIO error');versions.delete(versionId);}};
  const storage=createListingMediaStorage({env,cosClient,legacyClient});
  await assert.rejects(storage.deleteObjectVersions({key}),/temporary MinIO error/);
  assert.equal(versions.has('old-v1'),false);fail=false;
  assert.deepEqual(await storage.deleteObjectVersions({key}),{deletedVersions:2});
  assert.equal(versions.size,0);
  assert.deepEqual(await storage.deleteObjectVersions({key}),{deletedVersions:0});
});
test('COS permanent removal covers version pages and delete markers, never adjacent object keys',async()=>{
  const lists=[],deletes=[];let page=0;
  const storage=createListingMediaStorage({env,cosClient:{
    listObjectVersions:async input=>{lists.push(input);return [
      {statusCode:200,Versions:[{Key:key,VersionId:'v2'}],DeleteMarkers:[{Key:key,VersionId:'marker'}],IsTruncated:'true',NextKeyMarker:key,NextVersionIdMarker:'v2'},
      {statusCode:200,Versions:[{Key:key,VersionId:'null'},{Key:key+'.other',VersionId:'neighbor'}],DeleteMarkers:[],IsTruncated:'false'},
      {statusCode:200,Versions:[{Key:key+'.other',VersionId:'neighbor'}],DeleteMarkers:[],IsTruncated:'false'}][page++];},
    deleteMultipleObject:async input=>{deletes.push(input);return {statusCode:200,Deleted:input.Objects,Error:[]};}
  }});
  assert.deepEqual(await storage.deleteObjectVersions({key}),{deletedVersions:3});
  assert.equal(lists[1].KeyMarker,key);assert.equal(lists[1].VersionIdMarker,'v2');
  assert.deepEqual(deletes.flatMap(x=>x.Objects).map(x=>x.VersionId).sort(),['marker','null','v2']);
  assert.ok(deletes.every(x=>x.Objects.every(x=>x.Key===key)));assert.equal(deletes[0].Quiet,false);
});

test('COS permission, partial-delete and incomplete-version-list failures cannot acknowledge success',async()=>{
  const denied=Object.assign(new Error('denied'),{code:'AccessDenied',statusCode:403});
  await assert.rejects(createListingMediaStorage({env,cosClient:{listObjectVersions:async()=>{throw denied;}}}).deleteObjectVersions({key}),error=>error===denied);
  const versions={statusCode:200,Versions:[{Key:key,VersionId:'v'}],DeleteMarkers:[],IsTruncated:'false'};
  for(const result of [{statusCode:200,Deleted:[],Error:[{Key:key,Code:'AccessDenied'}]},{statusCode:200,Deleted:[],Error:[]}]){
    const storage=createListingMediaStorage({env,cosClient:{listObjectVersions:async()=>versions,deleteMultipleObject:async()=>result}});
    await assert.rejects(storage.deleteObjectVersions({key}),{code:'LISTING_COS_DELETE_UNCONFIRMED'});
  }
  const truncated=createListingMediaStorage({env,cosClient:{listObjectVersions:async()=>({...versions,IsTruncated:'true'})}});
  await assert.rejects(truncated.deleteObjectVersions({key}),{code:'LISTING_COS_DELETE_UNCONFIRMED'});
});

test('COS permanent removal is idempotent and rejects bucket roots, backups and arbitrary paths',async()=>{
  let calls=0;const storage=createListingMediaStorage({env,cosClient:{listObjectVersions:async()=>{calls++;return {statusCode:200,Versions:[],DeleteMarkers:[],IsTruncated:'false'};}}});
  assert.deepEqual(await storage.deleteObjectVersions({key}),{deletedVersions:0});
  const before=calls;
  for(const key of ['','listing-media/v1','backups/private.sql','downloads/app.zip','staging/collector/other/1','listing-media/v1/prepared/../any.jpg'])await assert.rejects(storage.deleteObjectVersions({key}));
  assert.equal(calls,before);
});

test('real COS SDK sends exact version pagination and versioned deletes over HTTP',async t=>{
  const requests=[],failures=[];const versions=new Set(['v2','v1','marker']);
  const xmlItem=(tag,id)=>`<${tag}><Key>${key}</Key><VersionId>${id}</VersionId><IsLatest>false</IsLatest></${tag}>`;
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://fixture.invalid');requests.push({method:req.method,query:Object.fromEntries(url.searchParams)});
      let content='';for await(const chunk of req)content+=chunk;
      res.setHeader('Content-Type','application/xml');
      if(req.method==='GET'&&url.searchParams.has('versions')){
        assert.equal(url.searchParams.get('prefix'),key);
        if(!versions.size)return res.end('<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>');
        if(url.searchParams.has('key-marker')){
          assert.equal(url.searchParams.get('key-marker'),key);assert.equal(url.searchParams.get('version-id-marker'),'v2');
          return res.end(`<ListVersionsResult>${xmlItem('Version','v1')}<IsTruncated>false</IsTruncated></ListVersionsResult>`);
        }
        return res.end(`<ListVersionsResult>${xmlItem('Version','v2')}${xmlItem('DeleteMarker','marker')}<IsTruncated>true</IsTruncated><NextKeyMarker>${key}</NextKeyMarker><NextVersionIdMarker>v2</NextVersionIdMarker></ListVersionsResult>`);
      }
      assert.equal(req.method,'POST');assert(url.searchParams.has('delete'));
      const ids=[...content.matchAll(/<VersionId>([^<]+)<\/VersionId>/g)].map(m=>m[1]);
      assert.deepEqual(ids.sort(),['marker','v1','v2']);
      for(const id of ids)versions.delete(id);
      res.end(`<DeleteResult>${ids.map(id=>xmlItem('Deleted',id)).join('')}</DeleteResult>`);
    }catch(e){failures.push(e.message);res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.deepEqual(failures,[]);});
  const cosClient=new COS({SecretId:'fixture-id',SecretKey:'fixture-key',Domain:`127.0.0.1:${server.address().port}`,Protocol:'http:',Timeout:2000,KeepAlive:false,ChunkRetryTimes:0});
  const storage=createListingMediaStorage({env,cosClient});
  assert.deepEqual(await storage.deleteObjectVersions({key}),{deletedVersions:3});
  assert.equal(versions.size,0);assert.equal(requests.filter(r=>r.method==='GET').length,3);
});
