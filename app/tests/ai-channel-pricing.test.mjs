import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{middlewareMode:true}});
test.after(()=>vite.close());
const {channelWebsite,ChannelPrice,ChannelSpending}=await vite.ssrLoadModule('/src/AiChannelPricing.jsx');
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));

test('通道链接使用网站根地址，不包含API路径、查询参数或凭据',()=>{
  assert.equal(channelWebsite('https://www.aiartmirror.com/v1'),'https://www.aiartmirror.com/');
  assert.equal(channelWebsite('https://anyaigc.ai/v1?model=a'),'https://anyaigc.ai/');
  for(const value of ['javascript:alert(1)','https://private:secret@example.com/v1','not a url'])assert.equal(channelWebsite(value),null);
});
test('按次、按量价格明确单位，未配置价格不显示免费',()=>{
  assert.match(render(ChannelPrice,{pricing:{mode:'REQUEST',currency:'CNY',requestPrice:'0.2'}}),/0.2.*次请求/);
  const tokens=render(ChannelPrice,{pricing:{mode:'TOKEN',currency:'USD',inputPrice:'1.25',outputPrice:'10'}});
  for(const value of ['1M tokens','输入 1.25','补全 10'])assert.ok(tokens.includes(value));
  assert.match(render(ChannelPrice,{pricing:null}),/未配置/);
});
test('总花费分别标明币种与估算，保留微小金额和待核实覆盖率',()=>{
  const html=render(ChannelSpending,{spending:{totals:[{currency:'CNY',amount:'0.200000000000',requests:1},{currency:'USD',amount:'0.000000000001',requests:1}],requestCount:3,unpricedCount:1,pendingCount:0,failedCount:1}});
  for(const value of ['¥0.2','$0.000000000001','CNY','USD','估算','1 次费用待核实','2 / 3 次'])assert.ok(html.includes(value),value);
  assert.doesNotMatch(render(ChannelSpending,{spending:{totals:[],requestCount:1,unpricedCount:1,pendingCount:0,failedCount:0}}),/¥0|\$0/);
});
