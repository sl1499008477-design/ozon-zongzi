/**
 * ozon-bestsellers-hook.js — Injected into seller.ozon.ru bestsellers page.
 *
 * 用途：用户在 Ozon 的「Bestsellers / What to Sell」页面操作"类目筛选"弹窗时，
 * 自动学习「一级类目中文名 → 该类目下所有 leaf categoryId 数组」映射。
 *
 * 工作原理：
 *   1. 在 page-context（注入到 MAIN world）hook window.fetch，监听 POST
 *      /api/site/seller-analytics/what_to_sell/data/v3 的 request body。
 *   2. 用户在筛选弹窗勾选某个一级类目（如"电子产品"）→ 点应用 → 该 fetch
 *      调用的 body.filter.categories 即该类目展开后的所有 leaf IDs。
 *   3. 同时在 popover DOM 中读取**已勾选**且**仅一个**一级类目 row 的中文名。
 *   4. 把 (name, leafIds) 通过 window.postMessage 转给 isolated world content
 *      script（jzc-bestsellers-relay），它再用 chrome.runtime.sendMessage 发到
 *      service worker 入库到极掌后端。
 *
 * 仅当 popover 当前**只有一个**一级类目处于选中状态时才上报，避免多选时无法
 * 反推哪些 leafId 属于哪个类目。
 */

(() => {
  const ROUTE_RE = /\/api\/site\/seller-analytics\/what_to_sell\/data\/v3$/;
  const POST = 'JZC_BESTSELLERS_REPORT';

  // ── 1) 读取当前 popover 中"已勾选的一级类目名" ──────────────
  // popover root 用 .s1c80-a 类（探测得知）。结构：
  //   <root> 滚动容器
  //     <row> ← 每行包含一个 input[type=checkbox] + label 文本
  // 一级类目 row 的特征：未缩进 / 父级；它的子叶子也会渲染但只在展开时出现。
  // 这里用启发式：当 popover 中**已勾选 input 的祖先 row 文本**只有一个独立中文名
  // 且该名字短（≤30 字）时，认为它就是用户勾的那个一级类目。
  const findCheckedRootCategoryName = () => {
    const popover = Array.from(document.querySelectorAll('div.s1c80-a'))
      .find((el) => el.offsetParent !== null);
    if (!popover) return null;
    const cbs = Array.from(popover.querySelectorAll('input[type="checkbox"]'));
    const checkedNames = new Set();
    for (const cb of cbs) {
      if (!cb.checked) continue;
      // 沿 parentElement 向上找最近"短文本 row"
      let row = cb;
      let txt = '';
      for (let i = 0; i < 8 && row; i++) {
        row = row.parentElement;
        if (!row) break;
        const t = (row.innerText || '').trim().split('\n')[0].trim();
        if (t && t.length > 1 && t.length < 30) {
          txt = t;
          break;
        }
      }
      if (txt) checkedNames.add(txt);
    }
    // 期望刚好一个独立勾选项（一级类目自动级联子项，但子项的 input 也算 checked）
    // 我们去重后取最短的（一级类目通常比子叶子名字短/抽象）。如果只有 1 个独立名字最理想。
    if (checkedNames.size === 0) return null;
    const arr = Array.from(checkedNames);
    if (arr.length === 1) return arr[0];
    // 多个：取最短的，假定是最高层级
    arr.sort((a, b) => a.length - b.length);
    return arr[0];
  };

  // ── 2) hook window.fetch ───────────────────────────────────────
  if (window.__jzcBestsellersHookInstalled) return;
  window.__jzcBestsellersHookInstalled = true;

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (init && init.body && ROUTE_RE.test(new URL(url, location.href).pathname)) {
        // 解析 body 并捕获 categories[]
        let body = init.body;
        if (typeof body === 'string' && body) {
          try {
            const parsed = JSON.parse(body);
            const cats = parsed?.filter?.categories;
            if (Array.isArray(cats) && cats.length > 0) {
              const name = findCheckedRootCategoryName();
              if (name) {
                const leafIds = cats.map(String);
                window.postMessage(
                  { __jzcReport: 1, type: POST, name, leafIds, source: 'hook-fetch' },
                  '*',
                );
              }
            }
          } catch {
            // body 解析失败，忽略
          }
        }
      }
    } catch {
      // 防御性，不要影响原 fetch
    }
    return origFetch.apply(this, arguments);
  };
})();
