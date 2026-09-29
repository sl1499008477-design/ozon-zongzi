import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(realpathSync(path.resolve('app/node_modules/vite/package.json')));
const {build}=require('esbuild');
await build({entryPoints:['shared/sale-pricing.mjs'],bundle:true,format:'iife',globalName:'SalePricing',target:'chrome110',outfile:'extension/lib/sale-pricing.js',banner:{js:'// Generated from shared/sale-pricing.mjs; run scripts/build-sale-pricing-extension.mjs.'}});
