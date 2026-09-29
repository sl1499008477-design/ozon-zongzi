import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import http from 'node:http';
import https from 'node:https';
import { putObjectFromBuffer, putObjectFromFile, statObject } from "./object-storage.mjs";
import { listingMediaStorageConfig } from "./runtime-config.mjs";

const cacheControl = "public,max-age=31536000,immutable";
const storageError = (message, status = 400) => Object.assign(new Error(message), { status });
const deletableMediaKey = /^(?:listing-media\/v1\/(?:ai-image-listing\/[a-f0-9]{64}\.(?:jpg|png|webp)|prepared\/[a-f0-9]{64}\.(?:jpg|png|webp|mp4|mov))|staging\/collector\/[a-f0-9]{24}\/[a-f0-9-]{36})$/;

function checkDeleteKey(key) {
  if (!deletableMediaKey.test(key || '')) throw storageError('只允许清理已确认的商品媒体对象');
}

function checkSize(size, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw storageError("文件大小限制无效");
  if (size < 1) throw storageError("文件内容为空");
  if (size > maxBytes) throw storageError("文件超过公开素材上传大小限制", 413);
}

function metadataHeaders(metadata) {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [
    `x-cos-meta-${key.toLowerCase().replace(/^x-(?:amz|cos)-meta-/, "")}`, String(value),
  ]));
}

function confirmUpload(result) {
  if (!Number.isInteger(result?.statusCode) || result.statusCode < 200 || result.statusCode >= 300 || !result.ETag) {
    throw Object.assign(new Error("COS 未确认素材上传完成"), { code: "LISTING_COS_UPLOAD_UNCONFIRMED" });
  }
}

// Only public listing assets use this selector. Private data and the historical
// API image route retain object-storage.mjs and its original MinIO credentials.
export function createListingMediaStorage({ env = process.env, cosClient, legacyClient, fetchObject = fetch } = {}) {
  const config = listingMediaStorageConfig(env);
  let legacyClientPromise;
  const legacyEnabled = legacyClient || ['MINIO_ENDPOINT','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','MINIO_BUCKET'].every(name => env[name]);
  const legacy = () => legacyClientPromise ||= legacyClient ? Promise.resolve(legacyClient) : import('minio').then(({Client}) => {
    const useSSL=['true','1'].includes(String(env.MINIO_USE_SSL || 'false').toLowerCase());
    const value = new Client({endPoint:env.MINIO_ENDPOINT,port:Number(env.MINIO_PORT || 9000),
      useSSL,accessKey:env.MINIO_ACCESS_KEY,secretKey:env.MINIO_SECRET_KEY,
      transport:{request(options,callback){
        const request=(useSSL?https:http).request(options,callback);
        request.setTimeout(30_000,()=>request.destroy(storageError('历史素材存储请求超时',504)));
        return request;
      }}});
    return value;
  });
  async function deleteLegacyVersions({key}) {
    checkDeleteKey(key);
    if (!legacyEnabled) {
      if (config.provider === 'minio') throw storageError('历史素材存储未配置',503);
      return {deletedVersions:0};
    }
    const minio=await legacy(),bucket=env.MINIO_BUCKET || 'sonli-local-files',versions=[];
    for await (const item of minio.listObjects(bucket,key,true,{IncludeVersion:true})) if(item.name===key) {
      if (typeof item.versionId !== 'string' || !item.versionId) throw storageError('历史素材版本未确认',502);
      versions.push(item.versionId);
    }
    for (const versionId of versions) await minio.removeObject(bucket,key,{versionId});
    if (versions.length) for await (const item of minio.listObjects(bucket,key,true,{IncludeVersion:true})) {
      if (item.name===key) throw storageError('历史素材永久删除尚未完成',502);
    }
    return {deletedVersions:versions.length};
  }
  if (config.provider === "minio") return { putObjectFromBuffer, putObjectFromFile, statObject,deleteObjectVersions:deleteLegacyVersions };
  let clientPromise;
  const client = () => clientPromise ||= cosClient ? Promise.resolve(cosClient) : import("cos-nodejs-sdk-v5").then(({ default: COS }) => new COS({
    SecretId: config.secretId, SecretKey: config.secretKey, Protocol: "https:",
    UploadCheckContentMd5: true,
  }));
  let deletionClientPromise;
  // Cleanup requests carry no large upload body and must not outlive shutdown indefinitely.
  const deletionClient = () => deletionClientPromise ||= cosClient ? Promise.resolve(cosClient) : import("cos-nodejs-sdk-v5").then(({ default: COS }) => new COS({
    SecretId: config.secretId, SecretKey: config.secretKey, Protocol: "https:", Timeout: 30_000, ChunkRetryTimes: 0,
  }));
  const address = key => ({ Bucket: config.bucket, Region: config.region, Key: key });
  const receipt = (key, contentType, size, sha256) => ({ key, bucket: config.bucket, contentType, size, ...(sha256 ? { sha256 } : {}) });
  const staging = key => {
    if (!/^staging\/collector\/[a-zA-Z0-9/-]+$/.test(key || '')) throw storageError('素材必须使用服务端 staging key');
  };
  const objectHead = async (key, versionId) => {
    const result = await (await client()).headObject({ ...address(key), ...(versionId ? { VersionId: versionId } : {}) });
    const headers = result.headers || {};
    return { ...receipt(key, headers['content-type'], Number(headers['content-length'])),
      etag: String(result.ETag || headers.etag || '').replace(/^"|"$/g, ''),
      versionId: result.VersionId || headers['x-cos-version-id'], crc64: headers['x-cos-hash-crc64ecma'] };
  };
  const signedUrl = async params => new Promise((resolve, reject) => {
    client().then(cos => cos.getObjectUrl(params, (error, result) => error ? reject(error) : resolve(result.Url)), reject);
  });
  return {
    async deleteObjectVersions({ key }) {
      checkDeleteKey(key);
      const cos = await deletionClient();
      const unconfirmed = () => Object.assign(new Error('COS 未确认素材永久删除完成'), { code: 'LISTING_COS_DELETE_UNCONFIRMED' });
      const versions = [];
      let marker;
      const seen = new Set();
      do {
        const result = await cos.listObjectVersions({ Bucket: config.bucket, Region: config.region, Prefix: key, MaxKeys: '1000', ...marker });
        if (result.statusCode !== 200 || !Array.isArray(result.Versions) || !Array.isArray(result.DeleteMarkers)
          || !['true','false',true,false].includes(result.IsTruncated)) throw unconfirmed();
        for (const item of [...result.Versions, ...result.DeleteMarkers]) if (item.Key === key) {
          if (typeof item.VersionId !== 'string' || !item.VersionId) throw unconfirmed();
          versions.push({ Key: key, VersionId: item.VersionId });
        }
        marker = null;
        if (result.IsTruncated === true || result.IsTruncated === 'true') {
          if (!result.NextKeyMarker || typeof result.NextVersionIdMarker !== 'string') throw unconfirmed();
          marker = { KeyMarker: result.NextKeyMarker, VersionIdMarker: result.NextVersionIdMarker };
          const identity = JSON.stringify(marker);
          if (seen.has(identity)) throw unconfirmed();
          seen.add(identity);
        }
      } while (marker);
      for (let offset = 0; offset < versions.length; offset += 1000) {
        const Objects = versions.slice(offset, offset + 1000);
        const result = await cos.deleteMultipleObject({ Bucket: config.bucket, Region: config.region, Objects, Quiet: false });
        if (result.statusCode !== 200 || result.Error?.length || !Array.isArray(result.Deleted)
          || Objects.some(object => !result.Deleted.some(item => item.Key === object.Key && item.VersionId === object.VersionId))) throw unconfirmed();
      }
      if (versions.length) {
        const result = await cos.listObjectVersions({ Bucket: config.bucket, Region: config.region, Prefix: key, MaxKeys: '1000' });
        if (result.statusCode !== 200 || !Array.isArray(result.Versions) || !Array.isArray(result.DeleteMarkers)
          || [...result.Versions, ...result.DeleteMarkers].some(item => item.Key === key)) throw unconfirmed();
      }
      const historical = await deleteLegacyVersions({key});
      return { deletedVersions: versions.length + historical.deletedVersions };
    },
    async signCollectorPut({ key, contentType, md5, expires = 600 }) {
      staging(key);
      const headers = { 'Content-Type': contentType, 'Content-MD5': md5 };
      const url = await signedUrl({ ...address(key), Method: 'PUT', Headers: headers, Expires: Math.min(600, expires) });
      return { url, headers };
    },
    async headCollectorObject({ key, versionId }) {
      staging(key);
      return objectHead(key, versionId);
    },
    async readCollectorRange({ key, versionId, etag, size, start, end, signal }) {
      staging(key);
      if (!versionId || versionId === 'null' || !etag || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end >= size || end - start >= 10 * 1024 ** 2) throw storageError('素材版本或读取范围无效');
      const headers = { Range: `bytes=${start}-${end}`, 'If-Match': `"${etag}"` };
      const url = await signedUrl({ ...address(key), Method: 'GET', Headers: headers, Query: { versionId }, Expires: 60 });
      const response = await fetchObject(url, { headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`
        || response.headers.get('x-cos-version-id') !== versionId) {
        await response.body?.cancel(); throw storageError('COS 素材版本或范围响应不匹配', 422);
      }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > end - start + 1) throw storageError('COS 素材范围超过限制', 413);
        chunks.push(chunk);
      }
      if (length !== end - start + 1) throw storageError('COS 素材范围读取不完整', 422);
      return Buffer.concat(chunks);
    },
    async copyVerifiedObject({ source, key }) {
      staging(source.key);
      if (!source.versionId || source.versionId === 'null' || !source.etag || !source.crc64
        || !/^listing-media\/v1\/prepared\/[a-zA-Z0-9.-]+$/.test(key)) throw storageError('素材发布版本或对象键无效');
      const CopySource = `${config.bucket}.cos.${config.region}.myqcloud.com/${source.key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(source.versionId)}`;
      const result = await (await client()).putObjectCopy({ ...address(key), CopySource, CopySourceIfMatch: `"${source.etag}"`,
        MetadataDirective: 'Replaced', ContentType: source.contentType, CacheControl: cacheControl,
        Headers: { 'x-cos-meta-collector-version': source.versionId } });
      confirmUpload(result);
      const copied = await objectHead(key);
      if (copied.size !== source.size || copied.crc64 !== source.crc64 || copied.etag !== source.etag
        || copied.contentType !== source.contentType) throw storageError('COS 发布副本校验失败', 422);
      return copied;
    },
    async putObjectFromBuffer({ key, buffer, contentType = "application/octet-stream", metadata = {},
      maxBytes = Number(env.LOCAL_FILE_MAX_BYTES || 50 * 1024 ** 2) }) {
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
      checkSize(bytes.length, maxBytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const result = await (await client()).putObject({ ...address(key), Body: bytes, ContentLength: bytes.length,
        ContentType: contentType, CacheControl: cacheControl,
        Headers: { ...metadataHeaders(metadata), "x-cos-meta-content-sha256": sha256 } });
      confirmUpload(result);
      return receipt(key, contentType, bytes.length, sha256);
    },
    async putObjectFromFile({ key, path, contentType = "application/octet-stream", metadata = {}, maxBytes = 2 * 1024 ** 3 }) {
      const info = await stat(path);
      if (!info.isFile()) throw storageError("待保存素材不是文件");
      checkSize(info.size, maxBytes);
      const headers = metadataHeaders(metadata);
      // The SDK streams small files and uses checksummed multipart uploads for
      // larger ones. Never materialize a video as a single in-memory Buffer.
      const result = await (await client()).uploadFile({ ...address(key), FilePath: path,
        ContentType: contentType, CacheControl: cacheControl, Headers: headers });
      confirmUpload(result);
      return receipt(key, contentType, info.size, headers["x-cos-meta-content-sha256"]);
    },
    async statObject(key) {
      // Preserve SDK errors, including 401/403 and transport failures. Only a
      // real 404 may tell the preparation flow to upload a missing object.
      const result = await (await client()).headObject(address(key));
      const headers = result.headers || {};
      const metaData = Object.fromEntries(Object.entries(headers)
        .filter(([name]) => name.startsWith("x-cos-meta-") || name === "content-type" || name === "cache-control")
        .map(([name, value]) => [name.replace(/^x-cos-meta-/, ""), value]));
      return { ...receipt(key, headers["content-type"], Number(headers["content-length"]), headers["x-cos-meta-content-sha256"]),
        etag: String(result.ETag || "").replace(/^"|"$/g, ""), versionId: result.VersionId || headers['x-cos-version-id'],
        crc64: headers['x-cos-hash-crc64ecma'], metaData };
    },
  };
}
