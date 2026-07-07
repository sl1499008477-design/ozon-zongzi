// 极掌采集器 — AutoScroller (P1)
//
// 用法:
//   const scroller = new window.JZAutoScroller({
//     queue: jzTaskQueue,                 // 必传, 用于联动节流
//     intervalMs: 3000,                   // 每 3 秒滚一次
//     emptyThreshold: 5,                  // 连续 N 次 scroll 没新卡片 → onEmpty
//     getCardCount: () => documentCardCount(),  // 必传, 返回当前页面已渲染的卡片数
//     onEmpty: () => { ... },             // 可选, 触发关键词跳下一个
//     onCongestionPause: () => { ... },   // 可选, 队列拥塞导致自动暂停时回调
//   });
//   scroller.start();   // 用户主动启动
//   scroller.stop();    // 用户主动停止 (彻底关掉, 也清掉空轮计数)
//
// 行为:
//   1. 每 intervalMs 调用 scrollTo(底部)
//   2. 订阅 queue.on('congestion'):
//        high → autoPause (不是 stop, 区别于用户 stop)
//        low  → 如果是 autoPause 进入的, 则 autoResume
//   3. 用户手动 stop 后, 即使 low 也不会自动复活
//   4. 每次 scroll 后等待 1.5s 检查 cardCount 是否增长; 不增长 emptyStreak++; 增长则清零
//   5. emptyStreak >= emptyThreshold → onEmpty (然后 stop)

(() => {
  if (window.JZAutoScroller) return;

  class JZAutoScroller {
    constructor(opts = {}) {
      if (!opts.queue) throw new Error('JZAutoScroller: queue required');
      if (typeof opts.getCardCount !== 'function') throw new Error('JZAutoScroller: getCardCount required');

      this.queue = opts.queue;
      this.intervalMs = opts.intervalMs ?? 3000;
      this.settleMs = opts.settleMs ?? 2500;
      this.scrollStepRatio = opts.scrollStepRatio ?? 0.75;
      this.minScrollStepPx = opts.minScrollStepPx ?? 480;
      this.emptyThreshold = opts.emptyThreshold ?? 5;
      this.getCardCount = opts.getCardCount;
      this.isReadyToScroll = opts.isReadyToScroll || (() => true);
      this.readinessPollMs = opts.readinessPollMs ?? 1000;
      this.maxReadinessWaitMs = opts.maxReadinessWaitMs ?? 0;
      this.onEmpty = opts.onEmpty || (() => {});
      this.onCongestionPause = opts.onCongestionPause || (() => {});

      this._timer = null;
      this._userActive = false;       // 用户意图：true=想跑
      this._autoPaused = false;       // 是否被节流自动暂停
      this._emptyStreak = 0;
      this._lastCardCount = 0;
      this._waitingReadySince = 0;
      this._unsubCongestion = null;
    }

    start() {
      if (this._userActive) return;
      this._userActive = true;
      this._autoPaused = false;
      this._emptyStreak = 0;
      this._waitingReadySince = 0;
      this._lastCardCount = this.getCardCount();
      this._unsubCongestion = this.queue.on('congestion', (e) => this._onCongestion(e));
      this._scheduleNext(0); // 立即滚一次
    }

    stop() {
      this._userActive = false;
      this._autoPaused = false;
      this._emptyStreak = 0;
      this._waitingReadySince = 0;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      if (this._unsubCongestion) { this._unsubCongestion(); this._unsubCongestion = null; }
    }

    isRunning() {
      return this._userActive && !this._autoPaused;
    }

    isUserActive() {
      return this._userActive;
    }

    isAutoPaused() {
      return this._autoPaused;
    }

    _onCongestion({ level }) {
      if (!this._userActive) return;
      if (level === 'high' && !this._autoPaused) {
        this._autoPaused = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        try { this.onCongestionPause('paused'); } catch {}
      } else if (level === 'low' && this._autoPaused) {
        this._autoPaused = false;
        try { this.onCongestionPause('resumed'); } catch {}
        this._scheduleNext(this.intervalMs);
      }
    }

    _scheduleNext(delay) {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this._tick(), delay);
    }

    async _tick() {
      this._timer = null;
      if (!this._userActive || this._autoPaused) return;

      let readyToScroll = true;
      try {
        readyToScroll = this.isReadyToScroll();
      } catch {
        readyToScroll = false;
      }
      if (!readyToScroll) {
        const now = Date.now();
        if (!this._waitingReadySince) this._waitingReadySince = now;
        if (!this.maxReadinessWaitMs || now - this._waitingReadySince < this.maxReadinessWaitMs) {
          this._scheduleNext(this.readinessPollMs);
          return;
        }
        this._waitingReadySince = 0;
      } else {
        this._waitingReadySince = 0;
      }

      const stats = typeof this.queue.stats === 'function' ? this.queue.stats() : null;
      if (stats && (stats.running > 0 || stats.pending > 0)) {
        this._scheduleNext(this.readinessPollMs);
        return;
      }

      const beforeCount = this._lastCardCount;
      // 滚到底部触发懒加载
      const scroller = document.scrollingElement || document.documentElement || document.body;
      const scrollStep = Math.max(this.minScrollStepPx, Math.floor((window.innerHeight || 800) * this.scrollStepRatio));
      try {
        window.scrollBy({ top: scrollStep, behavior: 'smooth' });
      } catch (e) {
        // some pages override scrollTo, fall back
        scroller.scrollTop += scrollStep;
      }

      // 等卡片渲染（1.5s）后再检查
      await new Promise((r) => setTimeout(r, this.settleMs));
      if (!this._userActive || this._autoPaused) return;

      const nowCount = this.getCardCount();
      const nearBottom = (scroller.scrollTop + window.innerHeight) >= (scroller.scrollHeight - 800);
      if (nowCount > beforeCount) {
        this._emptyStreak = 0;
        this._lastCardCount = nowCount;
      } else if (nearBottom) {
        this._emptyStreak++;
        if (this._emptyStreak >= this.emptyThreshold) {
          // 触发 onEmpty 然后停止
          const cb = this.onEmpty;
          this.stop();
          try { await cb(); } catch (e) { console.error('[JZAutoScroller] onEmpty error:', e); }
          return;
        }
      } else {
        this._emptyStreak = 0;
      }
      this._scheduleNext(this.intervalMs);
    }
  }

  window.JZAutoScroller = JZAutoScroller;
})();
