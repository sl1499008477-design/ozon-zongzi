import assert from 'node:assert/strict';

export async function runSelectionReview(page){
  const checks=[];
  const clickText=text=>page.click(`xpath=//button[translate(normalize-space(.)," ","")="${text.replaceAll(' ','')}"]`);
  const choose=id=>page.click(`loc=css:input[aria-label="选择任务 ${id}"]`);
  const dialogText=()=>page.evaluate(()=>[...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText||'');
  await page.goto('http://127.0.0.1:19128/tests/ai-listing-selection.fixture.html');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-active-0"]'));
  for(const [group,label,count] of [['active','执行中',2],['paused','已暂停',2],['failed','提交失败',2],['errors','错误',2],['cancelled','已取消',2],['deleted','已删除',52]]){
    await page.click(`loc=role:tab[name="${label} (${count})"]`);
    await page.waitForFunction(id=>document.querySelector(`[data-row-key="${id}"]`),`A-${group}-0`);
    const before=await page.evaluate(()=>({checked:document.querySelectorAll('[data-row-key] input[type="checkbox"]:checked').length,
      permanent:[...document.querySelectorAll('.ai-listing-batch-toolbar button')].filter(button=>button.textContent.includes('永久删除')).map(button=>({disabled:button.disabled})),
      rowCheckboxes:document.querySelectorAll('[data-row-key] input[type="checkbox"]').length}));
    assert.equal(before.checked,0);assert.equal(before.rowCheckboxes,group==='deleted'?5:2);
    assert.deepEqual(before.permanent,group==='deleted'?[{disabled:true}]:[]);
    await choose(`A-${group}-0`);
    assert.match(await page.evaluate(()=>document.querySelector('.ai-listing-batch-toolbar').textContent),/已选 1 项/);
  }
  checks.push('all six groups have checkboxes; changing groups clears selection; permanent deletion is deleted-only and requires selection');

  await page.click('loc=css:.ant-pagination li[title="2"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-deleted-5"]'));
  await choose('A-deleted-5');
  assert.match(await page.evaluate(()=>document.querySelector('.ai-listing-batch-toolbar').textContent),/已选 2 项/);
  await page.click('loc=css:.ant-pagination li[title="1"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-deleted-0"]'));
  assert.equal(await page.evaluate(()=>document.querySelector('input[aria-label="选择任务 A-deleted-0"]').checked),true);
  await clickText('永久删除 (2)');
  await page.waitForFunction(()=>document.querySelector('[role="dialog"]'));
  const confirmation=await dialogText();
  for(const text of ['批量永久删除','勾选的 2 个任务','不可恢复','COS 图片、视频','共享素材会保留'])assert(confirmation.includes(text),text);
  await clickText('返回');
  assert.equal(await page.evaluate(()=>window.batchSelection.requests.filter(row=>row.path.endsWith('/permanent-delete')).length),0);
  checks.push('cross-page selection survives pagination and cancelling its count-specific confirmation sends no deletion');

  await clickText('永久删除 (2)');await clickText('确认永久删除 2 项');
  await page.waitForFunction(()=>window.batchSelection.requests.filter(row=>row.path.endsWith('/permanent-delete')).length===2);
  await page.waitForFunction(()=>document.body.innerText.includes('已交给后台清理 2 项'));
  const accepted=await page.evaluate(()=>({writes:window.batchSelection.requests.filter(row=>row.path.endsWith('/permanent-delete')),
    checked:document.querySelectorAll('[data-row-key] input[type="checkbox"]:checked').length,
    present:!!document.querySelector('[data-row-key="A-deleted-0"]'),
    background:document.querySelector('[aria-label="后台清理状态"]')?.textContent}));
  assert.deepEqual(accepted.writes.map(row=>({path:row.path,body:row.body})),[
    {path:'/ai-listing/tasks/A-deleted-0/permanent-delete',body:{expectedVersion:7}},
    {path:'/ai-listing/tasks/A-deleted-5/permanent-delete',body:{expectedVersion:12}},
  ]);
  assert.equal(accepted.checked,0);assert.equal(accepted.present,false);assert.match(accepted.background,/后台清理 2 项/);
  checks.push('batch requests contain only two chosen IDs and versions; accepted tasks leave the list and are counted as background work');

  await page.click('loc=role:tab[name="执行中 (2)"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-active-1"]'));
  await choose('A-active-1');await clickText('暂停选中 (1)');
  await page.waitForFunction(()=>document.querySelector('[role="dialog"]'));
  assert.match(await dialogText(),/勾选的 1 个任务/);
  await clickText('确认暂停 1 项');
  await page.waitForFunction(()=>!document.querySelector('[data-row-key="A-active-1"]'));
  const ordinary=await page.evaluate(()=>({writes:window.batchSelection.requests.filter(row=>row.path==='/ai-listing/tasks/batch/apply'),
    previews:window.batchSelection.requests.filter(row=>row.path==='/ai-listing/tasks/batch/preview'),
    unselected:window.batchSelection.tasks.find(row=>row.id==='A-active-0')}));
  assert.deepEqual(ordinary.writes[0].body,{action:'pause',items:[{taskId:'A-active-1',expectedVersion:8}]});
  assert.equal(ordinary.previews.length,0);assert.equal(ordinary.unselected.group,'active');
  checks.push('ordinary batch action applies only checked rows and leaves the unselected task unchanged');

  await page.click('loc=role:tab[name="已删除 (50)"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-deleted-1"]'));
  await choose('A-deleted-1');await clickText('清空选择');
  assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-row-key] input[type="checkbox"]:checked').length),0);
  await choose('A-deleted-1');await clickText('切换验收账号');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="B-deleted-0"]'));
  const switched=await page.evaluate(()=>({old:document.querySelectorAll('[data-row-key^="A-"]').length,
    checked:document.querySelectorAll('[data-row-key] input[type="checkbox"]:checked').length,
    permanent:[...document.querySelectorAll('.ai-listing-batch-toolbar button')].find(button=>button.textContent.includes('永久删除')).disabled}));
  assert.deepEqual(switched,{old:0,checked:0,permanent:true});
  await page.click('loc=css:thead input[aria-label="Select all"]');
  assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-row-key] input[type="checkbox"]:checked').length),5);
  assert.match(await page.evaluate(()=>document.querySelector('.ai-listing-batch-toolbar').textContent),/已选 5 项/);
  await clickText('清空选择');
  checks.push('clear selection and account switch discard old choices; header checkbox selects only the current page');
  return {passed:checks.length,checks};
}

export async function runSingleSelectedPurgeReview(page){
  await page.goto('http://127.0.0.1:19128/tests/ai-listing-selection.fixture.html?single-selected=1');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-active-0"]'));
  await page.click('loc=role:tab[name="已删除 (52)"]');
  await page.waitForFunction(()=>document.querySelector('[data-row-key="A-deleted-0"]'));
  await page.click('loc=css:input[aria-label="选择任务 A-deleted-0"]');
  await page.click('loc=css:input[aria-label="选择任务 A-deleted-1"]');
  await page.click('loc=css:button[aria-label="操作任务 A-deleted-0"]');
  await page.click('text="永久删除任务"');
  await page.click('xpath=(//div[@role="dialog"]//button[contains(translate(normalize-space(.)," ",""),"确认永久删除")])[last()]');
  await page.waitForFunction(()=>!document.querySelector('[data-row-key="A-deleted-0"]'));
  const state=await page.evaluate(()=>({toolbar:document.querySelector('.ai-listing-batch-toolbar').textContent,
    retained:document.querySelector('input[aria-label="选择任务 A-deleted-1"]').checked}));
  assert.match(state.toolbar,/已选 1 项/);assert.equal(state.retained,true);
  return {passed:1,checks:['single accepted deletion prunes only its selected ID and keeps the other selected task']};
}
