// Keep the real Collection and preparation algorithm; replace only local I/O
// ports so the PostgreSQL fixture never contacts source sites or real COS.
export async function resolve(specifier,context,nextResolve){
  if(specifier.endsWith('/media-preparer.services.js')){
    const actual=new URL('../../dist-electron/services/collection/media-preparer.services.js?fixture-real',import.meta.url).href;
    return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
      import {prepareCollectorMedia as prepare} from ${JSON.stringify(actual)};
      export * from ${JSON.stringify(actual)};
      export const prepareCollectorMedia=(item,options)=>prepare(item,{...options,...globalThis.__COLLECTOR_MEDIA_IO__});
    `)};
  }
  return nextResolve(specifier,context);
}
