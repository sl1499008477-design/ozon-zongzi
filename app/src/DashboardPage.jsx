import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Modal } from 'antd';
import {
  AppstoreOutlined, ArrowRightOutlined, BarChartOutlined, CheckCircleOutlined,
  ClockCircleOutlined, CloudUploadOutlined, FileTextOutlined, InboxOutlined,
  InfoCircleOutlined, PictureOutlined, ReloadOutlined, RightOutlined,
  ShopOutlined, ShoppingOutlined, SoundOutlined, TagOutlined, ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { apiRequest } from './client-transport.js';
import { dashboardCount, dashboardMoney, dashboardTodos } from './dashboard-model.js';
import './dashboard.css';

const SECTION_NAMES = { dailyListings: '今日上架', inspection: '质检提醒', orders: '订单', products: '商品库存', ai: 'AI 上架', wallet: '账户余额', promotions: '活动记录' };
const TODO_ICONS = { review: PictureOutlined, failed: WarningOutlined, inspection: FileTextOutlined, stock: InboxOutlined };
const SHORTCUTS = [
  { label: '采集箱', icon: InboxOutlined, path: '/ozon/products/collect' },
  { label: 'AI 上架', icon: ThunderboltOutlined, path: '/ozon/tools/ai-listing' },
  { label: '商品管理', icon: TagOutlined, path: '/ozon/products/list' },
  { label: '订单列表', icon: FileTextOutlined, path: '/ozon/orders' },
  { label: '活动管理', icon: SoundOutlined, path: '/ozon/promotions' },
];

function dateText(value, options = {}) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '尚未同步';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...options });
}

function HomeIcon({ icon: Icon, className = '' }) {
  return <span className={`dashboard-icon ${className}`} aria-hidden="true"><Icon /></span>;
}

function ShortcutLinks({ navigate, onClose }) {
  return <div className="dashboard-shortcuts">{SHORTCUTS.map(({ label, icon, path }) => <button key={path} type="button" onClick={() => { onClose?.(); navigate(path); }}>
    <HomeIcon icon={icon} /><span>{label}</span><RightOutlined aria-hidden="true" />
  </button>)}</div>;
}

export default function DashboardPage({ binding, localData, navigate, request = apiRequest }) {
  const storeId = String(binding?.id || localData?.currentStoreId || '');
  const accountId = String(localData?.account?.id || '');
  const scope = JSON.stringify([accountId, storeId]);
  const [snapshot, setSnapshot] = useState({ scope, summary: null, loading: true, error: '' });
  const [activePanel, setActivePanel] = useState('todo');
  const [dialog, setDialog] = useState(null);
  const [compactPages, setCompactPages] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [listPage, setListPage] = useState(0);
  const mainRef = useRef(null);
  const refreshRef = useRef(() => {});
  const current = snapshot.scope === scope ? snapshot : { summary: null, loading: true, error: '' };
  const { summary, loading, error } = current;
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => setLayoutVersion(value => value + 1));
    observer.observe(mainRef.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { setCompactPages(false); }, [layoutVersion, activePanel, summary]);
  useLayoutEffect(() => {
    if (compactPages) return;
    const lists = mainRef.current.querySelectorAll('.dashboard-todo-list, .dashboard-progress-list');
    if ([...lists].some(list => list.getBoundingClientRect().height > 0 && list.scrollHeight > list.clientHeight + 1)) setCompactPages(true);
  }, [layoutVersion, activePanel, summary, compactPages]);

  useEffect(() => {
    let closed = false, busy = false, controller = null;
    setSnapshot({ scope, summary: null, loading: true, error: '' });
    setDialog(null);
    setListPage(0);
    async function refresh() {
      if (closed || busy) return;
      busy = true;
      controller = new AbortController();
      setSnapshot(previous => ({ ...(previous.scope === scope ? previous : { scope, summary: null }), loading: true }));
      try {
        const query = storeId ? `?${new URLSearchParams({ storeId })}` : '';
        const result = await request(`/ozon/dashboard/summary${query}`, { signal: controller.signal, timeoutMs: 25000 });
        if (!closed && !controller.signal.aborted) setSnapshot({ scope, summary: result, loading: false, error: '' });
      } catch (caught) {
        if (!closed && !controller.signal.aborted) setSnapshot(previous => ({ ...previous, loading: false, error: caught.message || '首页资料暂时无法读取' }));
      } finally { busy = false; }
    }
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { closed = true; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [scope, storeId, request]);

  const count = (section, field) => dashboardCount(summary, section, field);
  const todos = dashboardTodos(summary, Boolean(storeId));
  const sectionErrors = Object.entries(summary?.errors || {}).filter(([section, message]) => message && (storeId || !['orders', 'products', 'promotions'].includes(section)));
  const initialLoading = loading && !summary;
  const displayCount = value => value === null ? '—' : value.toLocaleString('zh-CN');
  const sectionState = section => !storeId && ['orders', 'products', 'promotions'].includes(section) ? '绑定店铺后查看' : initialLoading ? '读取中' : error && !summary || summary?.errors?.[section] ? '暂不可用' : null;
  const todoComplete = count('ai', 'review') !== null && count('ai', 'failed') !== null && count('inspection', 'unreadCount') !== null && (!storeId || count('products', 'attentionCount') !== null);
  const daily = summary?.dailyListings;
  const wallet = summary?.errors?.wallet ? null : summary?.wallet;
  const progress = [
    { key: 'waitingForEnrichment', title: '资料待补全', unit: '个任务', icon: FileTextOutlined, stage: 'enrichment' },
    { key: 'generating', title: '生图中', unit: '个任务', icon: PictureOutlined, stage: 'generating' },
    { key: 'review', title: '待人工审核', unit: '个任务', icon: ClockCircleOutlined, stage: 'review' },
    { key: 'submitting', title: '上架提交中', unit: '个任务', icon: CloudUploadOutlined, stage: 'submitting' },
  ];
  const metrics = [
    { id: 'dailyListings', label: '今日总上架 SKU 数', value: count('dailyListings', 'count'), unit: 'SKU', caption: '当前账号全部店铺 · 北京时间', icon: InboxOutlined, primary: true, action: () => setDialog('stores') },
    { id: 'inspection', label: '未读质检单', value: count('inspection', 'unreadCount'), unit: '单', caption: '全部店铺', icon: FileTextOutlined, action: () => navigate('/ozon/orders/quality?unread=1') },
    { id: 'orders', label: '待处理包裹', value: storeId ? count('orders', 'pendingCount') : null, unit: '个', caption: storeId ? '当前店铺 · 近 30 天已同步' : '绑定店铺后查看', icon: ShoppingOutlined, action: () => navigate(storeId ? '/ozon/orders?status=pending' : '/ozon/settings/stores') },
    { id: 'ai', label: '上架需处理', value: count('ai', 'attentionCount'), unit: '个任务', caption: '当前账号', icon: FileTextOutlined, action: () => navigate('/ozon/tools/ai-listing?tab=tasks&group=active&stage=attention') },
    { id: 'products', label: '库存关注', value: storeId ? count('products', 'attentionCount') : null, unit: 'SKU', caption: storeId ? '当前店铺 · 在售商品' : '绑定店铺后查看', icon: InboxOutlined, action: () => navigate(storeId ? '/ozon/products/list?stock=attention' : '/ozon/settings/stores') },
  ];
  const visibleRows = rows => compactPages ? rows.slice(Math.min(listPage, Math.max(0, rows.length - 1)), Math.min(listPage, Math.max(0, rows.length - 1)) + 1) : rows;
  const pagination = rows => compactPages && rows.length > 1 ? <div className="dashboard-list-pages" aria-label="工作事项分页">
    <button type="button" disabled={Math.min(listPage, rows.length - 1) === 0} onClick={() => setListPage(Math.max(0, Math.min(listPage, rows.length - 1) - 1))}>上一项</button>
    <span>{Math.min(listPage + 1, rows.length)} / {rows.length}</span>
    <button type="button" disabled={listPage >= rows.length - 1} onClick={() => setListPage(value => Math.min(rows.length - 1, value + 1))}>下一项</button>
  </div> : null;
  const compactStatus = error ? '更新失败 · 查看说明' : sectionErrors.length ? '部分数据不可用' : !storeId ? '尚未绑定店铺' : summary?.asOf ? `更新于 ${dateText(summary.asOf, { month: undefined, day: undefined })}` : '正在读取数据';

  return <main ref={mainRef} className="dashboard-page" aria-label="首页工作台" aria-busy={initialLoading}>
    <header className="dashboard-heading">
      <div><h1>待办优先工作台</h1><p>先处理重要事项，再继续今天的工作</p></div>
      <div className="dashboard-heading-meta">
        <span>{new Date(summary?.asOf || Date.now()).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' })}</span>
        <button type="button" className="dashboard-text-button" onClick={() => setDialog('status')}><InfoCircleOutlined /> 数据说明</button>
      </div>
    </header>

    <section className="dashboard-metrics" aria-label="业务概况">
      {metrics.map(metric => <div className={`dashboard-metric ${metric.primary ? 'dashboard-metric-primary' : ''}`} key={metric.id}>
        <button type="button" className="dashboard-metric-body" onClick={metric.action} aria-label={`${metric.label}：${metric.value === null ? sectionState(metric.id) || '暂无数据' : `${metric.value} ${metric.unit}`}，查看详情`}>
          <HomeIcon icon={metric.icon} />
          <span className="dashboard-metric-copy"><span className="dashboard-metric-label">{metric.label}</span>
            <span className={`dashboard-metric-number ${initialLoading ? 'dashboard-reading' : ''}`}>{displayCount(metric.value)}<small>{metric.unit}</small></span>
            <span className="dashboard-metric-caption">{sectionState(metric.id) || metric.caption}</span>
          </span>
        </button>
        {metric.primary && <button type="button" className="dashboard-store-link" onClick={metric.action}>按店铺查看<RightOutlined /></button>}
      </div>)}
    </section>

    <div className="dashboard-workspace">
      <div className="dashboard-panel-tabs" role="tablist" aria-label="首页工作区域">
        <button id="dashboard-todo-tab" type="button" role="tab" aria-selected={activePanel === 'todo'} aria-controls="dashboard-todo-panel" onClick={() => { setActivePanel('todo'); setListPage(0); }}><FileTextOutlined /> 优先处理{todos.length > 0 && <span>{todos.length} 项</span>}</button>
        <button id="dashboard-progress-tab" type="button" role="tab" aria-selected={activePanel === 'progress'} aria-controls="dashboard-progress-panel" onClick={() => { setActivePanel('progress'); setListPage(0); }}><BarChartOutlined /> 上架进度</button>
      </div>
      <div className="dashboard-panels">
        <section id="dashboard-todo-panel" className={`dashboard-panel dashboard-todo ${activePanel === 'todo' ? 'is-active' : ''}`} aria-labelledby="dashboard-todo-heading">
          <div className="dashboard-panel-heading"><HomeIcon icon={FileTextOutlined} /><h2 id="dashboard-todo-heading">优先处理</h2><span className="dashboard-badge">{initialLoading ? '读取中' : `${todos.length} 项`}</span></div>
          <div className="dashboard-todo-list">
            {visibleRows(todos).map((todo, index) => <button key={todo.id} type="button" className={`dashboard-todo-row ${index === 0 ? 'is-first' : ''}`} onClick={() => navigate(todo.path)}>
              <HomeIcon icon={TODO_ICONS[todo.id]} />
              <span className="dashboard-todo-copy"><strong>{todo.title}</strong><span>{todo.description}</span></span>
              <span className={`dashboard-todo-action ${index === 0 ? 'is-primary' : ''}`}>{todo.action}</span><RightOutlined className="dashboard-row-chevron" />
            </button>)}
            {!todos.length && <div className="dashboard-empty" role="status">
              <HomeIcon icon={initialLoading ? ClockCircleOutlined : todoComplete ? CheckCircleOutlined : InfoCircleOutlined} />
              <strong>{initialLoading ? '正在读取你的待办' : todoComplete ? '当前没有待处理事项' : '待办数据暂不可用'}</strong>
              <span>{initialLoading ? '正在汇总账号和当前店铺资料' : todoComplete ? '可以继续采集商品，或查看上架进度' : '已读取的其他模块仍可正常查看'}</span>
              {!initialLoading && !todoComplete && <Button onClick={() => refreshRef.current()} loading={loading}>重新读取</Button>}
            </div>}
          </div>
          {pagination(todos)}
        </section>

        <section id="dashboard-progress-panel" className={`dashboard-panel dashboard-progress ${activePanel === 'progress' ? 'is-active' : ''}`} aria-labelledby="dashboard-progress-heading">
          <div className="dashboard-panel-heading dashboard-progress-heading">
            <div className="dashboard-progress-title"><HomeIcon icon={BarChartOutlined} /><h2 id="dashboard-progress-heading">上架进度</h2><span className="dashboard-badge">当前账号</span></div>
            <div className="dashboard-wallet" aria-label="当前账号可用余额">
              <span>可用余额 <strong>{dashboardMoney(wallet?.availableCents, wallet?.currency)}</strong></span>
              <small>{sectionState('wallet') || `已预留 ${dashboardMoney(wallet?.reservedCents, wallet?.currency)}`}</small>
            </div>
          </div>
          <div className="dashboard-progress-list">{visibleRows(progress).map(item => <button key={item.key} type="button" className="dashboard-progress-row" onClick={() => navigate(`/ozon/tools/ai-listing?tab=tasks&group=active&stage=${item.stage}`)}>
            <HomeIcon icon={item.icon} /><span className="dashboard-progress-label">{item.title}</span>
            <span className="dashboard-progress-count"><strong>{displayCount(count('ai', item.key))}</strong><span>{item.unit}</span></span><RightOutlined className="dashboard-row-chevron" />
          </button>)}</div>
          {pagination(progress)}
          <button type="button" className="dashboard-center-link" onClick={() => navigate('/ozon/tools/ai-listing?tab=tasks')}>进入 AI 任务中心 <ArrowRightOutlined /></button>
        </section>
      </div>
    </div>

    <footer className="dashboard-footer">
      <div className="dashboard-shortcut-bar"><h2><HomeIcon icon={AppstoreOutlined} />常用入口</h2><ShortcutLinks navigate={navigate} /><button type="button" className="dashboard-shortcut-more dashboard-text-button" onClick={() => setDialog('shortcuts')}>打开常用入口 <RightOutlined /></button></div>
      <div className="dashboard-status-bar">
        <button type="button" className="dashboard-sync-note" onClick={() => setDialog('status')} title="查看全部数据来源与更新时间">
          {error || sectionErrors.length ? <InfoCircleOutlined /> : <ClockCircleOutlined />}
          <span className="dashboard-status-full">{error ? summary ? '更新失败 · 显示上次读取结果' : '首页资料读取失败' : sectionErrors.length ? '部分数据暂不可用 · 查看说明' : storeId ? `订单：近 30 天已同步数据 · ${summary?.orders?.lastSyncAt ? `更新于 ${dateText(summary.orders.lastSyncAt)}` : '尚未同步'}` : '尚未绑定店铺 · 账号数据正常展示'}</span><span className="dashboard-status-compact">{compactStatus}</span>
        </button>
        <div className="dashboard-status-actions">
          {count('promotions', 'uncertainCount') > 0 && <button type="button" className="dashboard-promotion-note" onClick={() => navigate('/ozon/promotions?tab=records&status=UNCERTAIN')}><InfoCircleOutlined /><span className="dashboard-status-full">活动有 {count('promotions', 'uncertainCount')} 项结果待核对</span><span className="dashboard-status-compact">活动待核对 {count('promotions', 'uncertainCount')}</span><span className="dashboard-record-action">查看记录 <RightOutlined /></span></button>}
          <button type="button" className="dashboard-refresh" aria-label="刷新首页数据" title="刷新首页数据" disabled={loading} onClick={() => refreshRef.current()}><ReloadOutlined spin={loading} /></button>
        </div>
      </div>
    </footer>

    <Modal title={dialog === 'stores' ? '今日上架 · 按店铺查看' : dialog === 'shortcuts' ? '常用入口' : '数据说明与更新时间'} open={Boolean(dialog)} onCancel={() => setDialog(null)} footer={null} rootClassName="prototype-overlay dashboard-dialog" destroyOnHidden>
      {dialog === 'stores' && <div className="dashboard-store-summary">
        <p>{daily?.date || '今日'} · 北京时间自然日 · 当前账号全部店铺</p>
        <p>同店铺成功上架的目标 SKU 去重统计，跨店铺分别计数。</p>
        {daily?.note && <p className="dashboard-dialog-note"><InfoCircleOutlined /> {daily.note}</p>}
        {sectionState('dailyListings') ? <p role="status">{sectionState('dailyListings')}<Button type="link" onClick={() => refreshRef.current()}>重新读取</Button></p> : daily?.byStore?.length ? <ul>{daily.byStore.map(store => <li key={store.storeId}><span><ShopOutlined /> {store.storeName || store.storeId}</span><strong>{displayCount(store.count)} SKU</strong></li>)}</ul> : <p>{daily?.count === 0 ? '今天还没有成功上架的 SKU' : '暂无可用的店铺统计'}</p>}
      </div>}
      {dialog === 'shortcuts' && <ShortcutLinks navigate={navigate} onClose={() => setDialog(null)} />}
      {dialog === 'status' && <div className="dashboard-data-notes">
        {error && <p role="alert">{error}{summary && '；当前展示上次成功读取的数据。'}</p>}
        {sectionErrors.map(([section, message]) => <p key={section} role="status"><strong>{SECTION_NAMES[section] || section}：</strong>{message}</p>)}
        <dl><div><dt>首页读取时间</dt><dd>{summary?.asOf ? `${dateText(summary.asOf)} · 北京时间` : '尚未成功读取'}</dd></div>
          <div><dt>今日总上架</dt><dd>当前账号全部店铺，北京时间自然日；同店目标 SKU 去重，跨店分别计数。{daily?.note}</dd></div>
          <div><dt>质检提醒</dt><dd>当前账号全部店铺的未读质检单。</dd></div>
          <div><dt>待处理包裹</dt><dd>当前店铺近 30 天已同步订单，等待备货或等待发运；同步时间：{dateText(summary?.orders?.lastSyncAt)}。</dd></div>
          <div><dt>库存关注</dt><dd>当前店铺在售商品的缺货与库存 1–10 件 SKU；同步时间：{dateText(summary?.products?.lastSyncAt)}。</dd></div>
          <div><dt>活动待核对</dt><dd>{count('promotions', 'uncertainCount') === null ? '暂不可用' : `${count('promotions', 'uncertainCount')} 个批次`}{count('promotions', 'uncertainCount') > 0 && <Button type="link" onClick={() => navigate('/ozon/promotions?tab=records&status=UNCERTAIN')}>查看记录</Button>}</dd></div>
          <div><dt>上架与余额</dt><dd>AI 任务和余额属于当前账号；可用余额已扣除预留金额。首页每 30 秒自动更新。</dd></div></dl>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => refreshRef.current()}>刷新数据</Button>
      </div>}
    </Modal>
  </main>;
}
