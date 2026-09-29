import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {App as AntApp} from 'antd';
import {createServer} from 'vite';

test('real components expose ordinary-user quality navigation, account-wide badge and settings without a bound store',async()=>{
 const vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,logLevel:'silent',cacheDir:'/private/tmp/ozon-order-inspection-84mmc_b3/ssr-cache',server:{middlewareMode:true,hmr:false,watch:null}});
 const previousWindow=globalThis.window,previousStorage=globalThis.localStorage;
 try{
  const {default:Page,QualityInspectionBell}=await vite.ssrLoadModule('/src/QualityInspectionPage.jsx');
  const reminders={summary:{unreadCount:2,total:3,latest:[],checkedAt:'2026-09-12T00:00:00Z'},refresh:async()=>{},markRead:async()=>true,loading:false,reading:false,error:''};
  const html=renderToStaticMarkup(React.createElement(AntApp,null,React.createElement(Page,{account:{id:'ordinary',role:'user'},reminders})));
  assert.match(html,/编号设置/);assert.match(html,/尚未绑定店铺，可以先设置质检编号/);assert.match(html,/当前账号全部店铺/);
  assert.doesNotMatch(html,/type="date"/);
  const bell=renderToStaticMarkup(React.createElement(QualityInspectionBell,{reminders,navigate(){}}));
  assert.match(bell,/质检提醒，2 条未读/);
  globalThis.window={location:{pathname:'/ozon/orders/quality',search:'',origin:'https://fixture.test'}};
  globalThis.localStorage={getItem(){return null;}};
  const {AppShell}=await vite.ssrLoadModule('/src/App.jsx');
  const shell=renderToStaticMarkup(React.createElement(AntApp,null,React.createElement(AppShell,{initialState:{route:'/ozon/orders/quality',authChecked:true,account:{id:'ordinary',role:'user'},localData:{stores:[],caches:{},jobs:{},summary:{}}}})));
  assert.match(shell,/订单管理/);assert.match(shell,/ant-menu-item-selected quality-menu-entry/);assert.match(shell,/质检单/);assert.match(shell,/编号设置/);
  assert.doesNotMatch(shell,/404: This page/);
 }finally{globalThis.window=previousWindow;globalThis.localStorage=previousStorage;await vite.close();}
});
