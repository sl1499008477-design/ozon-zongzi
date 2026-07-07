// 极掌采集器 — KeywordPilot (P1)
//
// 关键词采集器：把一组关键词依次跳转 ozon 搜索页，采到指定数量后切下一个。
// 全程通过 IndexedDB sessions store 跨页恢复（不能用 chrome.storage.session — sw 会休眠）。
//
// 状态机：
//   IDLE      — 没在跑
//   NAVIGATING— pilot.start() 写完 session 后，正在 location.href 跳
//   COLLECTING— 当前页已加载，AutoScroller 启动中
//   DONE      — 全部关键词跑完
//
// 用法（content script init 中）:
//   const pilot = new window.JZKeywordPilot({
//     db: window.JZCollectorDB,
//     onStartCollecting: (kw) => { autoScroller.start(); panel.refresh(); },
//     onStopCollecting:  () => { autoScroller.stop(); panel.refresh(); },
//     onAllDone:         () => panel.toast('全部关键词已完成', 'success'),
//   });
//   await pilot.init();
//
//   // 用户操作：
//   await pilot.addKeywords(['коврик', 'лежак']);
//   await pilot.start({ maxCollectNumber: 200 });
//   pilot.notifyKeywordEmpty();   // AutoScroller 检测到底部 / 没新卡片
//   pilot.stop();                  // 用户主动中止

(() => {
  if (window.JZKeywordPilot) return;

  // 用 location.origin 自动适配当前域名 (www.ozon.ru / ozon.kz),不写死。
  function buildSearchUrl(keyword) {
    const cur = new URL(window.location.href);
    if (cur.pathname.includes('/category/') || cur.pathname.includes('/highlight/')) {
      cur.searchParams.set('text', keyword);
      return cur.toString();
    }
    return `${location.origin}/search/?from_global=true&text=${encodeURIComponent(keyword)}`;
  }

  function getCurrentTextParam() {
    return new URLSearchParams(window.location.search).get('text') || '';
  }

  class JZKeywordPilot {
    constructor(opts = {}) {
      if (!opts.db) throw new Error('JZKeywordPilot: db required');
      this.db = opts.db;
      this.onStartCollecting = opts.onStartCollecting || (() => {});
      this.onStopCollecting = opts.onStopCollecting || (() => {});
      this.onAllDone = opts.onAllDone || (() => {});
      this.defaultMaxCollectNumber = opts.defaultMaxCollectNumber ?? 200;

      this.mode = 'IDLE';
      this.currentKeyword = null;       // { id, text, maxCollectNumber }
      this.startSalesCount = 0;
      this.collectorStartedByKeywordPilot = true;
      this._monitorTimer = null;
      this._listeners = new Map();
    }

    on(event, cb) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(cb);
      return () => this._listeners.get(event)?.delete(cb);
    }
    _emit(event, payload) {
      const set = this._listeners.get(event);
      if (!set) return;
      for (const cb of set) try { cb(payload); } catch (e) { console.error('[JZKeywordPilot]', event, e); }
    }

    async init() {
      // 跨页复活：检查 session.current
      const session = await this.db.getSession();
      if (!session || !session.currentKeywordId) {
        this.mode = 'IDLE';
        return;
      }
      const all = await this.db.getKeywords();
      const kw = all.find((k) => k.id === session.currentKeywordId);
      if (!kw || kw.status === 'done' || kw.status === 'failed') {
        await this.db.clearSession();
        this.mode = 'IDLE';
        return;
      }
      // 校验当前 URL 的 text 参数与目标关键词匹配
      const urlText = getCurrentTextParam();
      if (!urlText || urlText !== kw.text) {
        // URL 不匹配 — 可能用户中途换页了；保留 session 等下次匹配后再激活
        this.mode = 'IDLE';
        return;
      }
      // 命中：进入 COLLECTING
      this.currentKeyword = kw;
      this.startSalesCount = (typeof session.startSalesCount === 'number')
        ? session.startSalesCount
        : await this.db.countSales();
      this.collectorStartedByKeywordPilot = session.collectorStartedByKeywordPilot !== false;
      this.mode = 'COLLECTING';
      this._startMonitor();
      try { this.onStartCollecting(kw, session); } catch (e) { console.error('[JZKeywordPilot] onStartCollecting:', e); }
      this._emit('stateChange', this.getState());
    }

    async addKeywords(texts) {
      const n = await this.db.addKeywords(texts);
      this._emit('stateChange', this.getState());
      return n;
    }

    async listKeywords() {
      return this.db.getKeywords();
    }

    async clearAllKeywords() {
      await this.db.clearKeywords();
      this._emit('stateChange', this.getState());
    }

    async start(opts = {}) {
      if (this.mode === 'COLLECTING' || this.mode === 'NAVIGATING') return;
      const kw = await this.db.getNextPendingKeyword();
      if (!kw) {
        this.mode = 'DONE';
        try { this.onAllDone(); } catch (e) { console.error('[JZKeywordPilot] onAllDone:', e); }
        this._emit('stateChange', this.getState());
        return;
      }
      const maxCollectNumber = opts.maxCollectNumber ?? this.defaultMaxCollectNumber;
      const collectorStartedByKeywordPilot = Object.prototype.hasOwnProperty.call(opts, 'collectorStartedByKeywordPilot')
        ? opts.collectorStartedByKeywordPilot !== false
        : this.collectorStartedByKeywordPilot !== false;
      this.collectorStartedByKeywordPilot = collectorStartedByKeywordPilot;
      // 标 keyword running
      await this.db.updateKeyword(kw.id, { status: 'running', maxCollectNumber });
      // 写 session
      const startSalesCount = await this.db.countSales();
      await this.db.setSession({
        currentKeywordId: kw.id,
        mode: 'NAVIGATING',
        startSalesCount,
        collectorStartedByKeywordPilot,
      });
      this.mode = 'NAVIGATING';
      this.currentKeyword = { ...kw, maxCollectNumber };
      this.startSalesCount = startSalesCount;
      this._emit('stateChange', this.getState());
      // 跳转 — content script 会被销毁，新页面 init() 接管
      const url = buildSearchUrl(kw.text);
      window.location.href = url;
    }

    async stop({ markCurrentDone = false, markCurrentFailed = false } = {}) {
      this._stopMonitor();
      const kw = this.currentKeyword;
      if (kw) {
        if (markCurrentDone) {
          const collected = (await this.db.countSales()) - this.startSalesCount;
          await this.db.updateKeyword(kw.id, { status: 'done', collectedCount: Math.max(0, collected) });
        } else if (markCurrentFailed) {
          await this.db.updateKeyword(kw.id, { status: 'failed' });
        } else {
          // 用户主动中止：把状态恢复为 pending（下次还能继续）
          await this.db.updateKeyword(kw.id, { status: 'pending' });
        }
      }
      await this.db.clearSession();
      this.mode = 'IDLE';
      const oldKw = this.currentKeyword;
      this.currentKeyword = null;
      try { this.onStopCollecting(oldKw); } catch (e) { console.error('[JZKeywordPilot] onStopCollecting:', e); }
      this._emit('stateChange', this.getState());
    }

    // AutoScroller 检测到无新卡片或队列 drained 时调用
    async notifyKeywordEmpty() {
      if (this.mode !== 'COLLECTING') return;
      await this._completeCurrentAndAdvance();
    }

    // 监控当前关键词是否已采到上限
    _startMonitor() {
      this._stopMonitor();
      if (!this.currentKeyword || !this.currentKeyword.maxCollectNumber) return;
      this._monitorTimer = setInterval(async () => {
        if (this.mode !== 'COLLECTING' || !this.currentKeyword) return;
        const count = await this.db.countSales();
        const got = count - this.startSalesCount;
        if (got >= this.currentKeyword.maxCollectNumber) {
          await this._completeCurrentAndAdvance();
        }
      }, 5000);
    }
    _stopMonitor() {
      if (this._monitorTimer) { clearInterval(this._monitorTimer); this._monitorTimer = null; }
    }

    async _completeCurrentAndAdvance() {
      this._stopMonitor();
      const kw = this.currentKeyword;
      if (kw) {
        const collected = (await this.db.countSales()) - this.startSalesCount;
        await this.db.updateKeyword(kw.id, { status: 'done', collectedCount: Math.max(0, collected) });
      }
      try { this.onStopCollecting(kw); } catch (e) { console.error('[JZKeywordPilot] onStopCollecting:', e); }
      await this.db.clearSession();
      this.currentKeyword = null;
      this.mode = 'IDLE';
      // 立刻取下一个
      await this.start();
    }

    getState() {
      return {
        mode: this.mode,
        currentKeyword: this.currentKeyword,
        startSalesCount: this.startSalesCount,
      };
    }
  }

  window.JZKeywordPilot = JZKeywordPilot;
})();
