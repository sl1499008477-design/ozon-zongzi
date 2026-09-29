import assert from 'node:assert/strict';

// Run with the Ego page in the existing task space, while the fixture server runs.
export async function runReadReview(page){
  const checks=[];
  await page.goto('http://127.0.0.1:19128/tests/pipeline-read-review.fixture.html');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-0"]'));
  const initial=await page.evaluate(()=>({text:document.body.innerText,rows:document.querySelectorAll('[data-row-key]').length,requests:window.readReview.requests}));
  assert.equal(initial.rows,5);assert.match(initial.text,/555\.35 RUB/);assert.doesNotMatch(initial.text,/555\.35 CNY|untrusted backend copy/);
  for(const label of ['类目与包装已补全','Ozon 类目已失效，正在自动修复','无法确认商品类目，请人工选择','商品类目状态暂时无法确认，请联系管理员'])assert(initial.text.includes(label),label);
  assert(!initial.requests.some(row=>row.path.startsWith('/local/state')));
  checks.push('summary-only list preserves currency and safe category labels');

  await page.click('loc=css:button[aria-label="展开A 商品 0变体"]');
  await page.click('loc=css:input[aria-label="推送 SKU A-0-b"]');
  await page.click('loc=css:.ant-pagination li[title="2"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-5"]'));
  await page.click('loc=css:input[aria-label="Select row 1"]');
  await page.click('text="推送到 AI 上架"');
  const selected=new URL(await page.evaluate(()=>window.readReview.navigations.at(-1)),'http://fixture');
  assert.equal(selected.searchParams.get('ids'),'A-0,A-5');
  assert.deepEqual(JSON.parse(selected.searchParams.get('variants')),{'A-0':['A-0-b']});
  checks.push('cross-page group selection keeps the first page exact variant selection');
  await page.click('xpath=//tr[@data-row-key="A-5"]//button[.//span[text()="查看"]]');
  assert.equal(await page.evaluate(()=>window.readReview.navigations.at(-1)),'/ozon/products/collect/edit/?id=A-5');
  checks.push('summary row opens its exact collection detail');

  await page.click('text="切换账号并延迟响应"');
  await page.waitForFunction(()=>window.readReview.pending.length>0);
  const switched=await page.evaluate(()=>({old:document.querySelectorAll('[data-row-key^="A-"]').length,
    pushDisabled:[...document.querySelectorAll('button')].find(e=>e.textContent.includes('推送到 AI 上架')).disabled,
    path:window.readReview.requests.filter(row=>row.path.includes('/summary')).at(-1).path}));
  assert.equal(switched.old,0);assert.equal(switched.pushDisabled,true);assert.equal(new URL(switched.path,'http://fixture').searchParams.get('offset'),'0');
  await page.click('text="完成延迟读取"');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="B-0"]'));
  await page.click('loc=css:input[aria-label="Select row 1"]');await page.click('text="推送到 AI 上架"');
  const fresh=new URL(await page.evaluate(()=>window.readReview.navigations.at(-1)),'http://fixture');
  assert.equal(fresh.searchParams.get('ids'),'B-0');assert.deepEqual(JSON.parse(fresh.searchParams.get('variants')),{});
  checks.push('account change clears old rows, page, groups and variant selection before response');

  await page.click('text="切换测试页面"');await page.click('text="切换页面可见性"');
  await page.evaluate(()=>{window.readReview.timers=[];});
  await page.click('xpath=//tr[@data-row-key="detail"]//button');
  await page.waitForFunction(()=>window.readReview.timers.length>0);
  assert.equal(await page.evaluate(()=>window.readReview.timers.filter(ms=>[3000,30000,60000].includes(ms)).at(-1)),60000);
  const before=await page.evaluate(()=>window.readReview.requests.filter(row=>row.path==='/ai-listing/tasks/detail').length);
  await page.evaluate(()=>{window.readReview.hidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(count=>window.readReview.requests.filter(row=>row.path==='/ai-listing/tasks/detail').length>count,before);
  assert.equal(await page.evaluate(()=>window.readReview.timers.filter(ms=>[3000,30000,60000].includes(ms)).at(-1)),3000);
  await page.click('loc=css:button[aria-label="Close"]');
  await page.evaluate(()=>{window.readReview.taskStatus='COMPLETED';window.readReview.timers=[];});
  await page.click('xpath=//tr[@data-row-key="detail"]//button');
  await page.waitForFunction(()=>window.readReview.timers.length>0);
  assert.equal(await page.evaluate(()=>window.readReview.timers.filter(ms=>[3000,30000,60000].includes(ms)).at(-1)),30000);
  await page.click('loc=css:button[aria-label="Close"]');
  checks.push('detail polls hidden at 60s, resumes immediately at 3s, and slows completed to 30s');
  return {passed:checks.length,checks};
}

export async function runDeletedTaskReview(page){
  const checks=[];
  for(const batch of [false,true]){
    await page.goto('http://127.0.0.1:19128/tests/pipeline-read-review.fixture.html');
    await page.waitForFunction(()=>document.querySelector('[data-row-key="A-0"]'));
    await page.click('text="已删除任务验收"');
    await page.click('loc=role:tab[name="已删除 (1)"]');
    await page.waitForFunction(()=>document.querySelector('[data-row-key="deleted"]'));
    if(batch){
      await page.click('text="全部恢复"');
      await page.waitForFunction(()=>document.querySelector('[role="dialog"]'));
      assert.match(await page.evaluate(()=>document.querySelector('[role="dialog"]').innerText),/不会自动继续/);
      await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"确认恢复1项")])[last()]');
    }else{
      await page.click('xpath=//tr[@data-row-key="deleted"]//button[.//span[contains(text(),"查")]]');
      await page.waitForFunction(()=>window.readReview.requests.some(row=>row.path==='/ai-listing/tasks/deleted?includeDeleted=1'));
      const detail=await page.evaluate(()=>document.querySelector('[role="dialog"]').innerText);
      assert.match(detail,/已删除/);assert.doesNotMatch(detail,/修订资料并重试|重试任务/);
      await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"恢复任务")])[last()]');
      await page.waitForFunction(()=>document.querySelectorAll('[role="dialog"]').length===2);
      assert.match(await page.evaluate(()=>[...document.querySelectorAll('[role="dialog"]')].at(-1).innerText),/不会自动继续/);
      await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"确认恢复")])[last()]');
    }
    await page.waitForFunction(()=>window.readReview.deletedTask.deletedAt===null);
    await page.waitForFunction(()=>!document.querySelector('[data-row-key="deleted"]'));
    const state=await page.evaluate(()=>({task:window.readReview.deletedTask,requests:window.readReview.requests.filter(row=>row.method==='POST'),text:document.body.innerText}));
    assert.equal(state.task.status,'SUBMISSION_FAILED');assert.equal(state.task.submissionId,'original-submission');
    assert.equal(state.task.submissionResults[0].offerId,'original-offer');assert.equal(state.task.version,8);
    assert(state.text.includes('已删除 (0)'));assert(!state.requests.some(row=>/retry|from-collect|import|approve/.test(row.path)));
    if(batch){assert.equal(state.requests.find(row=>row.path.endsWith('/preview')).body.group,'deleted');assert.deepEqual(state.requests.find(row=>row.path.endsWith('/apply')).body.items,[{taskId:'deleted',expectedVersion:7}]);}
    else assert.equal(state.requests.find(row=>row.path.endsWith('/resume')).body.expectedVersion,7);
    checks.push(batch?'deleted batch restores confirmed version snapshot without automatic retry':'deleted detail is readable and restores in place without automatic retry');
  }
  return {passed:checks.length,checks};
}

export async function runPermanentDeleteReview(page){
  const checks=[];
  await page.goto('http://127.0.0.1:19128/tests/pipeline-read-review.fixture.html');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-0"]'));
  await page.click('text="已删除任务验收"');
  await page.click('loc=role:tab[name="已删除 (1)"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="deleted"]'));
  const initial=await page.evaluate(()=>document.body.innerText);
  assert.match(initial,/已删除任务保留 15 天/);assert.match(initial,/共享素材会保留/);assert.doesNotMatch(initial,/全部永久删除/);

  await page.click('loc=css:button[aria-label="操作任务 9024"]');
  await page.click('text="永久删除任务"');
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.innerText.includes('永久删除任务')));
  const confirmation=await page.evaluate(()=>[...document.querySelectorAll('[role="dialog"]')].at(-1).innerText);
  for(const text of ['对应采集商品','没有其他 SKU 或任务继续使用时','COS 图片、视频和衍生资料','不可恢复','共享素材会保留'])assert.match(confirmation,new RegExp(text));
  await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"返回")])[last()]');
  assert.equal(await page.evaluate(()=>window.readReview.requests.filter(row=>row.path.endsWith('/permanent-delete')&&row.method==='POST').length),0);
  checks.push('deleted group explains retention and cancelling permanent deletion sends no request');

  await page.click('xpath=//tr[@data-row-key="deleted"]//button[contains(translate(normalize-space(.)," ",""),"查看")]');
  await page.waitForFunction(()=>window.readReview.requests.some(row=>row.path==='/ai-listing/tasks/deleted?includeDeleted=1'));
  await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"永久删除任务")])[last()]');
  await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"确认永久删除")])[last()]');
  await page.waitForFunction(()=>window.readReview.requests.some(row=>row.path.endsWith('/permanent-delete')&&row.method==='POST'));
  await page.waitForFunction(()=>!document.querySelector('[data-row-key="deleted"]'));
  await page.waitForFunction(()=>![...document.querySelectorAll('[role="dialog"]')].some(d=>d.innerText.includes('任务详情')));
  const accepted=await page.evaluate(()=>({task:window.readReview.deletedTask,
    request:window.readReview.requests.find(row=>row.path.endsWith('/permanent-delete')&&row.method==='POST'),
    details:[...document.querySelectorAll('[role="dialog"]')].filter(d=>d.innerText.includes('任务详情')).length,
    background:document.querySelector('[aria-label="后台清理状态"]')?.textContent}));
  assert.equal(accepted.request.body.expectedVersion,7);assert.equal(accepted.task.purge.state,'PENDING');assert.equal(accepted.details,0);
  assert.match(accepted.background,/后台清理 1 项/);
  checks.push('accepted cleanup closes its detail and leaves the table while durable work is still PENDING');

  await page.click('text="切换测试页面"');await page.click('text="已删除任务验收"');
  await page.click('loc=role:tab[name="已删除 (0)"]');
  await page.waitForFunction(()=>document.querySelector('[aria-label="后台清理状态"]'));
  assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-row-key="deleted"]').length),0);
  checks.push('leaving and reopening the task view restores background count from the server without restoring queued rows');

  await page.evaluate(()=>{window.readReview.deletedTask={...window.readReview.deletedTask,version:9,
    purge:{state:'FAILED',requestedAt:'2026-09-18T02:00:00.000Z',errorMessage:'COS 清理失败'},taskActions:{permanentDelete:true}};});
  await page.click('xpath=//button[contains(translate(normalize-space(.)," ",""),"刷新任务")]');
  await page.waitForFunction(()=>document.body.innerText.includes('清理失败'));
  await page.click('loc=css:button[aria-label="操作任务 9024"]');
  const failedActions=await page.evaluate(()=>[...document.querySelectorAll('.ant-dropdown-menu-item')].filter(item=>item.offsetParent!==null).map(item=>item.innerText));
  assert.deepEqual(failedActions,['永久删除任务']);
  await page.click('loc=css:button[aria-label="操作任务 9024"]');
  await page.click('xpath=//tr[@data-row-key="deleted"]//button[contains(translate(normalize-space(.)," ",""),"查看")]');
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.innerText.includes('清理失败')));
  await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"永久删除任务")])[last()]');
  await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"确认永久删除")])[last()]');
  await page.waitForFunction(()=>window.readReview.requests.filter(row=>row.path.endsWith('/permanent-delete')&&row.method==='POST').length===2);
  assert.equal(await page.evaluate(()=>window.readReview.requests.filter(row=>row.path.endsWith('/permanent-delete')&&row.method==='POST').at(-1).body.expectedVersion),9);
  await page.waitForFunction(()=>!document.querySelector('[data-row-key="deleted"]'));
  await page.waitForFunction(()=>![...document.querySelectorAll('[role="dialog"]')].some(d=>d.innerText.includes('任务详情')));
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[role="dialog"]')].filter(d=>d.innerText.includes('任务详情')).length),0);
  checks.push('failed cleanup returns visibly with its error and exact-version retry goes back to background');

  await page.evaluate(()=>{window.readReview.deletedTask=null;});
  await page.click('xpath=//button[contains(translate(normalize-space(.)," ",""),"刷新任务")]');
  await page.waitForFunction(()=>!document.querySelector('[aria-label="后台清理状态"]'));
  checks.push('the background count clears only after the server reports no pending cleanup');

  await page.goto('http://127.0.0.1:19128/tests/pipeline-read-review.fixture.html');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-0"]'));
  await page.click('text="已删除任务验收"');await page.click('loc=role:tab[name="已删除 (1)"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="deleted"]'));
  await page.click('xpath=//tr[@data-row-key="deleted"]//button[contains(translate(normalize-space(.)," ",""),"查看")]');
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.innerText.includes('已删除')));
  const ordinaryBefore=await page.evaluate(()=>window.readReview.requests.filter(row=>row.path==='/ai-listing/tasks/deleted?includeDeleted=1').length);
  await page.evaluate(()=>{window.readReview.detailFailure={status:404,message:'普通详情暂时不存在'};document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(count=>window.readReview.requests.filter(row=>row.path==='/ai-listing/tasks/deleted?includeDeleted=1').length>count,ordinaryBefore);
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.innerText.includes('普通详情暂时不存在')));
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.innerText.includes('任务详情'))),true);

  const runningBefore=await page.evaluate(()=>window.readReview.requests.filter(row=>row.path==='/ai-listing/tasks/deleted?includeDeleted=1').length);
  await page.evaluate(()=>{window.readReview.detailFailure=null;window.readReview.deletedTask={...window.readReview.deletedTask,version:8,
    purge:{state:'RUNNING',requestedAt:'2026-09-03T02:00:00.000Z'},taskActions:{}};document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(count=>window.readReview.requests.filter(row=>row.path==='/ai-listing/tasks/deleted?includeDeleted=1').length>count,runningBefore);
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.innerText.includes('正在清理')));
  await page.evaluate(()=>{window.readReview.deletedTask=null;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>![...document.querySelectorAll('[role="dialog"]')].some(dialog=>dialog.innerText.includes('任务详情')));
  checks.push('ordinary 404 stays visible, while a scoped versioned RUNNING detail makes the next confirmed 404 close the detail');
  return {passed:checks.length,checks};
}
