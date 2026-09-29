import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:19126,strictPort:true}});
await server.listen();
console.log('Read review fixture: http://127.0.0.1:19126/tests/pipeline-read-review.fixture.html');
