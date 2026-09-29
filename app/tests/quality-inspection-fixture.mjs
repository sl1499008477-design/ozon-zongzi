// Run with Node, then let Ego open the printed URL. All business API calls are fixture-only.
import {fileURLToPath} from 'node:url';
import {build,createServer} from 'vite';
const root=fileURLToPath(new URL('..',import.meta.url));
const fixture='/tests/quality-inspection.fixture.html';
if(process.argv.includes('--check')){
 await build({root,configFile:false,logLevel:'warn',build:{write:false,rollupOptions:{input:root+fixture}}});
 console.log('Quality inspection real-component fixture build passed');
}else{
 const vite=await createServer({root,configFile:false,logLevel:'warn',cacheDir:'/private/tmp/ozon-order-inspection-84mmc_b3/fixture-cache',server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{
  name:'quality-inspection-fixture-only',configureServer(server){server.middlewares.use((req,res,next)=>{
   const path=new URL(req.url,'http://fixture.test').pathname;
   if(path.startsWith('/api/')){res.statusCode=404;res.setHeader('content-type','application/json');res.end(JSON.stringify({message:'Fixture API is handled in the page; no production proxy'}));return;}
   if(path.startsWith('/ozon/'))req.url=fixture;
   next();
  });},
 }]});
 await vite.listen();console.log(`QUALITY_FIXTURE_URL=http://127.0.0.1:${vite.httpServer.address().port}/ozon/orders/quality`);
 const stop=async()=>{await vite.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
