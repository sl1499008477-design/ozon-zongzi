import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './client-transport.js';

export const inspectionOrderKey = row => JSON.stringify([row.storeId, row.orderNumber]);
export function inspectionPrefixes(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !/^\d{5}$/.test(value.trim()))) {
    throw new Error('每个编号必须是 5 位数字，保留开头的 0');
  }
  return [...new Set(values.map(value => value.trim()))];
}

// One account owns this read loop. An ACK aborts the older GET before applying its summary.
export function startInspectionReminders({ request, onChange, document: doc = globalThis.document,
  intervalMs = 30_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let stopped = false, timer, poll, acknowledgement;
  let view = { summary: null, error: '', loading: true, reading: false };
  const publish = patch => { if (!stopped) { view = { ...view, ...patch }; onChange(view); } };
  const clearTimer = () => { clearTimeoutFn(timer); timer = undefined; };
  const schedule = () => { clearTimer(); if (!stopped && !doc?.hidden) timer = setTimeoutFn(refresh, intervalMs); };
  async function refresh() {
    if (stopped || view.reading || doc?.hidden) return false;
    clearTimer(); poll?.abort();
    const controller = new AbortController(); poll = controller;
    publish({ loading: !view.summary });
    try {
      const summary = await request('/ozon/order-inspection/summary', { signal: controller.signal });
      if (!stopped && !controller.signal.aborted) publish({ summary, error: '', loading: false });
    } catch (error) {
      if (!stopped && !controller.signal.aborted) {
        publish({ error: error.message || '质检提醒读取失败', loading: false, ...(error.status === 401 ? { summary: null } : {}) });
        if (error.status === 401) stop();
      }
    } finally {
      if (poll === controller) { poll = null; schedule(); }
    }
  }
  async function markRead(rows) {
    if (stopped || view.reading) return false;
    if (!rows.length) return true;
    clearTimer(); poll?.abort(); poll = null;
    const controller = new AbortController(); acknowledgement = controller;
    publish({ reading: true, error: '' });
    try {
      const summary = await request('/ozon/order-inspection/read', {
        method: 'POST', signal: controller.signal,
        body: { items: rows.map(({ storeId, orderNumber }) => ({ storeId, orderNumber })) },
      });
      if (stopped || controller.signal.aborted) return false;
      publish({ summary, error: '', loading: false });
      return true;
    } catch (error) {
      if (!stopped && !controller.signal.aborted) {
        publish({ error: error.message || '已读状态保存失败', ...(error.status === 401 ? { summary: null, reading: false } : {}) });
        if (error.status === 401) stop();
      }
      return false;
    } finally {
      acknowledgement = null;
      if (!stopped) { publish({ reading: false }); schedule(); }
    }
  }
  function visibilityChanged() {
    if (doc.hidden) { clearTimer(); poll?.abort(); poll = null; }
    else void refresh();
  }
  function stop() {
    stopped = true; clearTimer(); poll?.abort(); acknowledgement?.abort();
    doc?.removeEventListener('visibilitychange', visibilityChanged);
  }
  doc?.addEventListener('visibilitychange', visibilityChanged);
  void refresh();
  return { refresh, markRead, stop };
}

export function useQualityInspection({ accountId, request = apiRequest }) {
  const [state, setState] = useState(null);
  const current = useRef(null);
  useEffect(() => {
    if (!accountId) { current.current = null; setState(null); return; }
    const feed = startInspectionReminders({ request, onChange: view => setState({ accountId, ...view }) });
    current.current = { accountId, feed };
    return () => { feed.stop(); if (current.current?.feed === feed) current.current = null; };
  }, [accountId, request]);
  const refresh = useCallback(() => current.current?.accountId === accountId ? current.current.feed.refresh() : Promise.resolve(false), [accountId]);
  const markRead = useCallback(rows => current.current?.accountId === accountId ? current.current.feed.markRead(rows) : Promise.resolve(false), [accountId]);
  const view = accountId && state?.accountId === accountId ? state : { summary: null, error: '', loading: Boolean(accountId), reading: false };
  return { ...view, refresh, markRead };
}
