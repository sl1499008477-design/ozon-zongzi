import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {gridLayout,prepareGrid,splitGrid} from '../ai-listing-grid.mjs';

test('production grid preserves source order, skips padding cells, and outputs strict 3:4',async()=>{
 const sources=await Promise.all(['#ff0000','#00ff00','#0000ff','#ffff00','#00ffff'].map(background=>sharp({create:{width:30,height:40,channels:3,background}}).png().toBuffer()));
 const prepared=await prepareGrid({sources,facts:['one','two'],prompt:'style instruction',language:'ru'});
 const tiles=await splitGrid(prepared.bytes,prepared.layout,sources.length);
 assert.equal(tiles.length,5);assert.match(prepared.prompt,/style instruction/);
 for(let i=0;i<tiles.length;i++){const {data,info}=await sharp(tiles[i]).raw().toBuffer({resolveWithObject:true});assert.equal(info.width*4,info.height*3);assert.equal(info.width,768);const source=await sharp(sources[i]).raw().toBuffer();assert.deepEqual([...data.subarray(100*info.width*3+100*3,100*info.width*3+100*3+3)],[...source.subarray(0,3)]);}
});
test('missing separators are rejected instead of cutting artwork',async()=>{
 const bytes=await sharp({create:{width:200,height:200,channels:3,background:'#fff'}}).png().toBuffer();
 await assert.rejects(()=>splitGrid(bytes,gridLayout(5),5),error=>{
  assert.equal(error.code,'AI_LISTING_GRID_GEOMETRY_INVALID');
  assert.deepEqual(error.diagnostic.actual,{width:200,height:200});
  assert.deepEqual(error.diagnostic.detected,{verticalBands:0,horizontalBands:0});
  assert.equal(error.diagnostic.expected.columns,3);assert.equal(error.diagnostic.expected.rows,2);
  assert.equal(error.diagnostic.expected.count,5);assert.equal(error.diagnostic.reason,'separator_count');
  return true;
 });
});

// Hand-measured fixture: retained inner gutters, changed row heights, no side frames.
// Fixed-position/equal cuts would lose the edge markers or include another cell.
async function frameDamagedGrid({missingInner=false,width=544}={}) {
 const layout={columns:4,rows:3,tw:96,th:128,width:544,height:512};
 const x=[[0,0],[120,152],[256,288],[392,424],[544,544]];
 const y=[[0,32],[165,197],[310,342],[480,512]];
 const colors=Array.from({length:12},(_,i)=>[30+i*12,120+i*5,210-i*10]);
 const layers=[];
 for(let i=0;i<12;i++){
  const col=i%4,row=Math.floor(i/4),left=x[col][1],top=y[row][1],w=x[col+1][0]-left,h=y[row+1][0]-top;
  const buffer=Buffer.alloc(w*h*3);
  for(let p=0;p<buffer.length;p+=3)for(let k=0;k<3;k++)buffer[p+k]=colors[i][k];
  // Mark both content edges so absent frames must not discard their pixels.
  for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++)if(xx<6||xx>=w-6)buffer.fill(0,(yy*w+xx)*3,(yy*w+xx)*3+3);
  layers.push({input:await sharp(buffer,{raw:{width:w,height:h,channels:3}}).png().toBuffer(),left,top});
 }
 if(missingInner)layers.push({input:await sharp({create:{width:32,height:512,channels:3,background:'#fff'}}).png().toBuffer(),left:256,top:0});
 const bytes=await sharp({create:{width:544,height:512,channels:3,background:'#f0f'}}).composite(layers).resize(width,512,{fit:'fill'}).png().toBuffer();
 return {bytes,layout,colors};
}

test('missing outer frames preserve measured cells, source order, and edge artwork',async()=>{
 const {bytes,layout,colors}=await frameDamagedGrid();
 const tiles=await splitGrid(bytes,layout,12);
 assert.equal(tiles.length,12);
 for(let i=0;i<tiles.length;i++){
  const {data,info}=await sharp(tiles[i]).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,96);assert.equal(info.height,128);
  const center=(64*96+48)*3;
  assert.deepEqual([...data.subarray(center,center+3)],colors[i]);
  const contentPixels=[];
  for(let x=0;x<96;x++){const p=(64*96+x)*3;if(data[p]===0&&data[p+1]===0&&data[p+2]===0)contentPixels.push(x);}
  assert.ok(contentPixels.some(x=>x<10)&&contentPixels.some(x=>x>85),`Cell ${i} keeps both edges`);
 }
});

test('outer-frame recovery cannot invent a missing internal separator',async()=>{
 const {bytes,layout}=await frameDamagedGrid({missingInner:true});
 await assert.rejects(splitGrid(bytes,layout,12),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
});

test('outer-frame recovery requires the frozen canvas dimensions',async()=>{
 const {bytes,layout}=await frameDamagedGrid({width:548});
 await assert.rejects(splitGrid(bytes,layout,12),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
});

test('unrelated magenta bands cannot replace the frozen internal layout',async()=>{
 const {bytes,layout}=await frameDamagedGrid();
 const paint=background=>sharp({create:{width:32,height:512,channels:3,background}}).png().toBuffer();
 const damaged=await sharp(bytes).composite([{input:await paint('#fff'),left:120,top:0},{input:await paint('#f0f'),left:64,top:0}]).png().toBuffer();
 await assert.rejects(splitGrid(damaged,layout,12),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
});

test('a partial inner gutter cannot be accepted by lowering the global threshold',async()=>{
 const source=await sharp({create:{width:30,height:40,channels:3,background:'#bbb'}}).png().toBuffer();
 const prepared=await prepareGrid({sources:Array(9).fill(source),facts:[],prompt:'design',language:'ru'});
 // First internal divider loses half of the first row; other rows are intact.
 const patch=await sharp({create:{width:32,height:512,channels:3,background:'#bbb'}}).png().toBuffer();
 const damaged=await sharp(prepared.bytes).composite([{input:patch,left:800,top:32}]).png().toBuffer();
 await assert.rejects(splitGrid(damaged,prepared.layout,9),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
});

async function pinkNineGrid({missingInner=false}={}) {
 const colors=['#226677','#337788','#448899','#5599aa','#66aabb','#77bbcc','#88ccdd','#99ddee','#aaeeff'];
 const sources=await Promise.all(colors.map(background=>sharp({create:{width:30,height:40,channels:3,background}}).png().toBuffer()));
 const prepared=await prepareGrid({sources,facts:[],prompt:'design',language:'ru'});
 const {data,info}=await sharp(prepared.bytes).raw().toBuffer({resolveWithObject:true});
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
  const p=(y*info.width+x)*info.channels;
  if(data[p]===255&&data[p+1]===0&&data[p+2]===255){data[p]=253;data[p+1]=90+Math.floor(y/info.height*40);data[p+2]=253;}
  if(missingInner&&x>=800&&x<832&&y>=32&&y<544){data[p]=200;data[p+1]=200;data[p+2]=200;}
 }
 return {bytes:await sharp(data,{raw:info}).png().toBuffer(),layout:prepared.layout,colors};
}

test('nine-cell pink separators retain full-length geometry and original source order',async()=>{
 const {bytes,layout,colors}=await pinkNineGrid();
 const tiles=await splitGrid(bytes,layout,9);
 assert.equal(tiles.length,9);
 for(let i=0;i<9;i++){
  const {data,info}=await sharp(tiles[i]).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,768);assert.equal(info.height,1024);
  const expected=Buffer.from(colors[i].slice(1),'hex');
  const at=(512*768+384)*3;
  assert.deepEqual([...data.subarray(at,at+3)],[...expected]);
  // A pink gutter must not leak into the extracted artwork.
  for(let p=0;p<data.length;p+=3)assert.ok(!(data[p]>190&&data[p+2]>190&&data[p]-data[p+1]>90&&data[p+2]-data[p+1]>90));
 }
});

test('pink color recovery still rejects a partially missing inner divider',async()=>{
 const {bytes,layout}=await pinkNineGrid({missingInner:true});
 await assert.rejects(splitGrid(bytes,layout,9),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
});

test('a decorative pink strip away from the frozen divider cannot become a crop boundary',async()=>{
 const {bytes,layout}=await pinkNineGrid();
 const paint=(width,background)=>sharp({create:{width,height:3200,channels:3,background}}).png().toBuffer();
 const damaged=await sharp(bytes).composite([{input:await paint(32,'#bbb'),left:800,top:0},{input:await paint(32,'#fd6efd'),left:550,top:0}]).png().toBuffer();
 await assert.rejects(splitGrid(damaged,layout,9),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
});

test('a broad pink product background cannot be mistaken for a narrow gutter',async()=>{
 const {bytes,layout}=await pinkNineGrid();
 const background=await sharp({create:{width:120,height:3200,channels:3,background:'#fd6efd'}}).png().toBuffer();
 const damaged=await sharp(bytes).composite([{input:background,left:750,top:0}]).png().toBuffer();
 await assert.rejects(splitGrid(damaged,layout,9),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
});
test('dense layouts remain at most 1K and within actual canvas constraints',()=>{
 for(let n=1;n<=12;n++){const l=gridLayout(n);assert.ok(l.width<=3840&&l.height<=3840&&l.width*l.height<=8294400);assert.equal(l.tw*4,l.th*3);assert.ok(l.tw<=768&&l.th<=1024);}
 assert.throws(()=>gridLayout(13));
});

test('an undersized native tile reports actual crop dimensions without relaxing publication limits',async()=>{
 const source=await sharp({create:{width:30,height:40,channels:3,background:'#aaa'}}).png().toBuffer();
 const prepared=await prepareGrid({sources:[source],facts:[],prompt:'design',language:'ru'});
 await assert.rejects(splitGrid(prepared.bytes,prepared.layout,1,{minWidth:900,minHeight:1200,maxWidth:4320,maxHeight:7680}),error=>{
  assert.equal(error.code,'AI_LISTING_IMAGE_DIMENSIONS_UNSUPPORTED');
  assert.deepEqual(error.diagnostic.tile,{index:0,width:768,height:1024});
  assert.deepEqual(error.diagnostic.detected,{verticalBands:2,horizontalBands:2});
  assert.equal(error.diagnostic.reason,'tile_dimensions');return true;
 });
});

test('group runtime performs OCR before channel and stores all slices after releasing channel',async()=>{
 const {createAiListingGridPort}=await import('../ai-listing-runtime.mjs');
 const source=await sharp({create:{width:30,height:40,channels:3,background:'#fff'}}).png().toBuffer();
 const events=[],stored=[];
 const port=createAiListingGridPort({downloadImage:async()=>({buffer:source}),recognizeText:async b=>{events.push('ocr');return b.map(()=> 'FACT\nTelegram: @sample_shop');},runChannel:async(input,generate)=>{
 events.push('channel');const result=await generate({profile:{id:'channel',imageModel:'gpt-image-2',secret:'PRIVATE'},gateway:{generateImage:async request=>{assert.equal(request.sourceImages.length,1);assert.ok(!JSON.stringify(request).includes('PRIVATE'));const facts=request.prompt.split('OCR source text (may contain recognition errors; omit unclear text):\n')[1].split('Possible watermarks / promotional signatures')[0];assert.match(facts,/FACT/);assert.doesNotMatch(facts,/@sample_shop/);return {bytes:request.sourceImages[0].bytes,contentType:'image/png'};}}});events.push('released');return result;
 },putObject:async o=>{events.push('store');stored.push(o);},publication:{prefix:'images',baseUrl:'https://media.test/'}});
 const result=await port({accountId:'a',taskId:'t',sku:'sku',sources:[{index:0,sourceUrl:'https://source.test/1'},{index:1,sourceUrl:'https://source.test/2'}],prompt:'design',image:{language:'ru',quality:'high'},requestKey:'r'});
 assert.deepEqual(events,['ocr','channel','released','store','store','store','store']);
 assert.deepEqual(result.images.map(i=>[i.sku,i.index]),[['sku',0],['sku',1]]);
 assert.deepEqual(stored.map(item=>item.contentType),['image/png','image/webp','image/png','image/webp']);
 assert.ok(result.images.every((image,index)=>image.generatedUrl.endsWith('.png')&&image.previewUrl.endsWith('.webp')&&image.index===index));
});


test('grid separates promotional OCR from product facts without dropping brands, models or decimals',async()=>{
 const source=await sharp({create:{width:30,height:40,channels:3,background:'#fff'}}).png().toBuffer();
 const original='ACME\nACME\nМодель: TG-220\nIP65 / 220V\n7,8 см | 9,1 см | 4,6 см\n2 штуки в наборе\n7,8 см | Telegram: @sample_shop\nWeChat Smart Watch\n微信：sample_shop\n店铺：示例家居\nМагазин: Example Shop\nwww.example-shop.test\nsales@example-shop.test\nПодпишитесь на наш магазин!\nFOLLOW OUR SHOP\n电话：+86 12345678901';
 const userPrompt='保留产品本体上的文字、Logo和型号。';
 const prepared=await prepareGrid({sources:[source,source],facts:[original,'Watermark: DEMO SHOP'],prompt:userPrompt,language:'ru'});
 const sourceSection=prepared.prompt.split('OCR source text (may contain recognition errors; omit unclear text):\n')[1].split('Possible watermarks / promotional signatures')[0];
 for(const value of ['@sample_shop','微信：sample_shop','示例家居','Example Shop','www.example-shop.test','sales@example-shop.test','Подпишитесь','FOLLOW OUR SHOP','12345678901','DEMO SHOP'])assert.ok(!sourceSection.includes(value),`Promotional text must not be treated as product facts: ${value}`);
 for(const value of ['ACME','Модель: TG-220','IP65 / 220V','7,8 см','9,1 см','4,6 см','2 штуки в наборе','WeChat Smart Watch'])assert.ok(sourceSection.includes(value),`Product evidence must remain: ${value}`);
 assert.match(prepared.prompt,/Possible watermarks \/ promotional signatures/);
 assert.ok(prepared.prompt.includes('@sample_shop'),'Keep excluded OCR available for visual disambiguation');
 assert.ok(prepared.prompt.includes(userPrompt),'Keep the saved design prompt verbatim');
 assert.match(prepared.prompt,/printed or engraved on the physical product or its packaging/);
 assert.match(prepared.prompt,/repetition, corner position or rotation alone/i);
 assert.equal(original.includes('微信：sample_shop'),true);
 const tiles=await splitGrid(prepared.bytes,prepared.layout,2);
 assert.equal(tiles.length,2,'A source with only a watermark must keep its original image slot');
});
