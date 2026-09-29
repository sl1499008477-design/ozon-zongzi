import assert from 'node:assert/strict';
export async function runTablePagination(page){
 const checks=[];
 await page.goto('http://127.0.0.1:19128/tests/table-pagination.fixture.html');
 const count=()=>page.evaluate(()=>document.querySelectorAll('tbody tr[data-row-key]').length);
 const chooseSize=async size=>{await page.click('loc=css:input[aria-label="每页显示条数"]');await page.click(`loc=css:.ant-select-item-option[title="${size} 条/页"]`);await page.waitForFunction(n=>document.querySelectorAll('tbody tr[data-row-key]').length===n,size);};
 for(const view of ['local','products','history','webjobs','orders','messages']){
  await page.click(`loc=role:button[name="${view}"]`);
  if(view==='messages')await page.click('loc=role:tab[name="发送记录"]');
  await page.waitForFunction(()=>document.querySelectorAll('tbody tr[data-row-key]').length===5);
  assert.equal(await count(),5,`${view} default5`);
  const pos=await page.evaluate(()=>({size:document.querySelector('.ant-pagination-options').getBoundingClientRect().x,prev:document.querySelector('.ant-pagination-prev').getBoundingClientRect().x}));assert(pos.size<pos.prev,`${view} selector is leftmost`);
  await page.click('loc=css:.ant-pagination li[title="2"]');
  await page.waitForFunction(()=>document.querySelector('.ant-pagination-item-active')?.title==='2');
  for(const size of [10,20,50,5]){
   await chooseSize(size);
   assert.equal(await page.evaluate(()=>document.querySelector('.ant-pagination-item-active')?.title),'1',`${view} size change resets page`);
  }
  if(view!=='local'){
   const paths=await page.evaluate(()=>window.pageQA.requests.map(row=>row.path));
   const prefix={products:'/ozon/products/cache?',history:'/ai-listing/tasks?',webjobs:'/ozon/collect-box/web-jobs?',orders:'/ozon/order-management/overview?',messages:'/ozon/messages/records?'}[view];
   const requests=paths.filter(path=>path.startsWith(prefix)).map(path=>new URL(path,'http://fixture').searchParams);
   for(const size of [5,10,20,50])assert(requests.some(params=>Number(params.get(view==='history'?'limit':'pageSize'))===size),`${view} real requested size ${size}`);
  }
  console.log(`Verified ${view}`);
  checks.push(`${view}: default5, current-page render, 5/10/20/50, reset to first page, selector left of page buttons`);
 }
 await page.click('loc=role:button[name="empty"]');
 await page.waitForFunction(()=>document.querySelector('.empty-table-pager .ant-pagination-options'));
 assert.equal(await count(),0);assert.equal(await page.evaluate(()=>document.querySelector('.ant-pagination-options').textContent.trim()),'5 条/页');
 checks.push('empty list retains a real zero-total size selector');
 await page.click('loc=role:button[name="products"]');await page.waitForFunction(()=>document.querySelector('[data-row-key="item-0"]'));
 await page.click('loc=css:tr[data-row-key="item-0"] input[type="checkbox"]');await page.click('loc=css:.ant-pagination li[title="2"]');await page.waitForFunction(()=>document.querySelector('[data-row-key="item-5"]'));
 await page.click('loc=css:tr[data-row-key="item-5"] input[type="checkbox"]');await chooseSize(10);
 assert.equal(await page.evaluate(()=>document.querySelectorAll('tr[data-row-key] input[type="checkbox"]:checked').length),2);
 await page.fill('loc=css:input[placeholder="搜索商品名称 / SKU / 货号"]','test-62');await page.waitForFunction(()=>document.querySelectorAll('tbody tr[data-row-key]').length===1&&document.querySelector('[data-row-key="item-62"]'));
 assert.equal(await page.evaluate(()=>document.querySelectorAll('tr[data-row-key] input[type="checkbox"]:checked').length),0);
 checks.push('product cross-page selection survives size changes; search fetches matching page and clears old selection');
 return {passed:checks.length,checks};
}

export async function runPricingPageIdentity(page){
 await page.goto('http://127.0.0.1:19128/tests/table-pagination.fixture.html');await page.click('loc=role:button[name="pricing"]');await page.waitForFunction(()=>document.body.innerText.includes('物流规则'));
 const checks=[];
 for(const [label,key,field,before,changed] of [['物流规则','logisticsRules','provider','P0','TARGET'],['佣金规则','commissionRules','ruleName','规则 0','目标规则']]){
  await page.click(`text="${label}"`);await page.click('loc=css:.ant-pagination li[title="2"]');await page.waitForFunction(()=>document.querySelector('[data-row-key="item-5"]'));
  await page.fill('loc=css:tr[data-row-key="item-5"] td:first-child input',changed);await page.click('loc=role:button[name="保存草稿"]');
  const saved=await page.evaluate(()=>window.pageQA.savedPricing);assert.equal(saved[key][0][field],before);assert.equal(saved[key][5][field],changed);
  await page.waitForFunction(()=>document.querySelector('[data-row-key="item-0"]'));await page.click('loc=css:.ant-pagination li[title="2"]');await page.waitForFunction(()=>document.querySelector('[data-row-key="item-6"]'));
  await page.click('loc=css:tr[data-row-key="item-6"] td:last-child button');await page.click('loc=role:button[name="保存草稿"]');
  const deleted=await page.evaluate(()=>window.pageQA.savedPricing);assert.equal(deleted[key].some(row=>row.id==='item-6'),false);assert.equal(deleted[key][0].id,'item-0');
  checks.push(`${label}: editing/deleting page2 targets its exact rule, keeps page1 unchanged`);
 }
 return {passed:checks.length,checks};
}
