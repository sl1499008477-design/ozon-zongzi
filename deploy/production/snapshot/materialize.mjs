import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
const [role,destination]=process.argv.slice(2);
if(!manifest.roles[role])throw Error('Usage: node deploy/production/snapshot/materialize.mjs <api|ai-worker|worker|web> [new-output-directory]');
const output=destination?resolve(destination):null;
if(output){try{await access(output);throw Error('Output directory must not already exist');}catch(error){if(error.code!=='ENOENT')throw error;}}
for(const [path,hash] of Object.entries(manifest.roles[role].files)){
 const override=resolve(root,'deploy/production/snapshot/overlays',role,path);
 let source=role==='web'?resolve(root,'app/production',path):resolve(root,path);
 if(role!=='web'){try{await access(override);source=override;}catch(error){if(error.code!=='ENOENT')throw error;}}
 const data=await readFile(source);
 if(createHash('sha256').update(data).digest('hex')!==hash)throw Error(`Deployed source hash changed: ${role}/${path}`);
 if(output){const target=resolve(output,path);if(relative(output,target).startsWith('..'))throw Error('Invalid snapshot path');await mkdir(dirname(target),{recursive:true});await writeFile(target,data);}
}
console.log(`${role}: ${Object.keys(manifest.roles[role].files).length} deployed files verified${output?' and copied to '+output:''}`);
