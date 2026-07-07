// 极掌采集器 — AntiBanGuard (P1)
//
// 监控 TaskQueue 任务失败率，超过阈值时探测当前页面是否被 ozon 风控（403）；
// 是的话 panel toast 提示用户 + 用 window.open 重新打开当前 URL（这是布丁猫的反爬绕过手段：
// 让 ozon 看到一次"真用户主动行为"，重新发会话/captcha）
//
// 用法:
//   const guard = new window.JZAntiBanGuard({
//     queue: jzTaskQueue,
//     onTrigger: (reason) => panel.toast('风控触发，' + reason, 'error', 5000),
//     onWindowOpen: () => {},
//   });
//   guard.start();
//   guard.probe();  // 手动触发一次探测

(() => {
  if (window.JZAntiBanGuard) return;

  class JZAntiBanGuard {
    constructor(opts = {}) {
      if (!opts.queue) throw new Error('JZAntiBanGuard: queue required');
      this.queue = opts.queue;
      this.windowSize = opts.windowSize ?? 20;
      this.failureRateThreshold = opts.failureRateThreshold ?? 0.5;
      this.cooldownMs = opts.cooldownMs ?? 60000;
      this.onTrigger = opts.onTrigger || (() => {});
      this.onWindowOpen = opts.onWindowOpen || (() => {});
      this.onProbeOk = opts.onProbeOk || (() => {});

      this._window = []; // 滑动窗口: [{ ok, ts }]
      this._lastProbeAt = 0;
      this._unsub = null;
      this._probing = false;
    }

    start() {
      if (this._unsub) return;
      this._unsub = this.queue.on('taskDone', ({ ok }) => this._record(ok));
    }

    stop() {
      if (this._unsub) { this._unsub(); this._unsub = null; }
      this._window = [];
    }

    _record(ok) {
      this._window.push({ ok, ts: Date.now() });
      if (this._window.length > this.windowSize) this._window.shift();
      if (this._window.length >= Math.max(5, Math.floor(this.windowSize / 2))) {
        const failed = this._window.filter((x) => !x.ok).length;
        const rate = failed / this._window.length;
        if (rate >= this.failureRateThreshold) {
          this.probe('failure-rate ' + (rate * 100).toFixed(0) + '%');
        }
      }
    }

    async probe(reason = 'manual') {
      const now = Date.now();
      if (this._probing) return;
      if (now - this._lastProbeAt < this.cooldownMs) return;
      this._probing = true;
      this._lastProbeAt = now;
      try {
        const res = await fetch(window.location.href, {
          credentials: 'include',
          method: 'GET',
          cache: 'no-cache',
          // 不要默认 referer 改写
        });
        if (res.status === 403) {
          try { this.onTrigger('页面被 ozon 风控（403），1 秒后用新窗口重试…'); } catch {}
          // 清窗口避免立刻再次触发
          this._window = [];
          setTimeout(() => {
            try {
              const w = window.open(window.location.href, '_blank');
              try { this.onWindowOpen(w); } catch {}
            } catch (e) {
              console.warn('[JZAntiBanGuard] window.open failed:', e);
            }
          }, 1000);
        } else {
          try { this.onProbeOk(res.status); } catch {}
        }
      } catch (err) {
        try { this.onProbeOk(-1); } catch {}
      } finally {
        this._probing = false;
      }
    }
  }

  window.JZAntiBanGuard = JZAntiBanGuard;
})();
