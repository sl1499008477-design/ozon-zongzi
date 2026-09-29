import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Empty, Form, Image, Input, InputNumber, Modal, Select, Space, Spin, Switch, Tabs, Tag } from 'antd';
import Table from "./PagedTable.jsx";
import { ClockCircleOutlined, DeleteOutlined, EditOutlined, EyeOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, SyncOutlined } from '@ant-design/icons';
import { SourceSectionTitle } from './SourceTable.jsx';
import { ozonPromotionTitle, ozonPromotionTypeLabel } from './ozon-promotion-labels.mjs';
import './promotion-management.css';

const TIME_ZONES = [{ value: 'Asia/Shanghai', label: '北京时间 · Asia/Shanghai' }, { value: 'Europe/Moscow', label: '莫斯科时间 · Europe/Moscow' }];
const PARTICIPATION_SCOPES = [{ value: 'ALL', label: '全部商品' }, { value: 'NONE', label: '未报名、未参加任何活动' }];
const SOURCES = { RULE: '定时报名', EXIT: '自动退出', FLOORS: '历史底价保护' };
const OPERATIONS = { JOIN: '报名活动', EXIT: '退出当前活动', CANCEL_FUTURE: '取消未来批次', SET_FLOOR: '设置平台底价保护', RENEW_FLOOR: '续期平台底价保护' };
const STATUSES = { PLANNED: ['待执行', 'blue'], SUBMITTED: ['已提交 / 处理中', 'processing'], SUCCEEDED: ['成功', 'green'], FAILED: ['失败', 'red'], UNCERTAIN: ['结果未知，待核对', 'orange'], CANCELLED: ['已取消 / 跳过', 'default'] };
const RUN_STATUSES = { PREVIEW: ['只读预览', 'blue'], QUEUED: ['已入队', 'processing'], RUNNING: ['执行中', 'processing'], COMPLETED: ['已完成', 'green'], PARTIAL: ['部分成功', 'orange'], FAILED: ['失败', 'red'], UNCERTAIN: ['结果未知，待核对', 'orange'], CANCELLED: ['已取消 / 跳过', 'default'] };
const EMPTY_OVERVIEW = { settings: null, state: {}, actions: [], products: [], memberships: [], rules: [], records: [] };
const pageSize = { showTotal: total => `共 ${total} 条` };
const idOf = value => String(value ?? '');
const empty = value => value === '' || value === undefined || value === null;
const money = (value, currency) => empty(value) ? '—' : `${value} ${currency || '（币种未确认）'}`;
const ceiling = item => item?.priceSemantics === 'CEILING';
const quantityApplies = (action, priceSemantics) => priceSemantics === 'CEILING' ? action?.isVoucher === true : action?.type === 'STOCK_DISCOUNT';
const abortError = () => new DOMException('请求已取消', 'AbortError');
const errorText = error => error?.message || '请求失败';
const isAborted = error => error?.name === 'AbortError' || error?.code === 'REQUEST_ABORTED';
const statusTag = value => <Tag color={STATUSES[value]?.[1]}>{STATUSES[value]?.[0] || value || '—'}</Tag>;
const runStatusTag = value => <Tag color={RUN_STATUSES[value]?.[1]}>{RUN_STATUSES[value]?.[0] || value || '—'}</Tag>;
const zoneLabel = zone => zone === 'Europe/Moscow' ? '莫斯科时间' : '北京时间';

function dateText(value, timeZone) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { timeZone, hour12: false });
}

function dateInput(value, timeZone) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function policySettings(settings = {}) {
  return { timeZone: settings.timeZone || 'Asia/Shanghai', exitEnabled: settings.exitEnabled === true && settings.exitMode !== 'BELOW_FLOOR', exitMode: 'ALL_AUTO', protectedActionIds: (settings.protectedActionIds || []).map(idOf), protectedProductIds: (settings.protectedProductIds || []).map(idOf) };
}

function selectionOptions(options, selected, noun) {
  const known = new Set(options.map(option => option.value));
  return [...options, ...(selected || []).map(idOf).filter(value => !known.has(value)).map(value => ({ value, label: `${noun} ID ${value}（当前快照未包含）` }))];
}

function ProductIdentity({ product }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const imageUrl = product?.imageUrl;
  const name = product?.name || '商品名称未提供';
  return <div className="promotion-product">
    <div className="promotion-product-thumbnail">
      {imageUrl && imageUrl !== failedUrl
        ? <Image src={imageUrl} alt={product?.name || '商品图片'} width={56} height={56} loading="lazy" onError={() => setFailedUrl(imageUrl)} />
        : <div className="promotion-product-no-image"><PictureOutlined /><span>暂无图片</span></div>}
    </div>
    <div className="promotion-identity"><strong className="promotion-product-name" title={name}>{name}</strong><span>SKU {product?.sku || '—'} · 货号 {product?.offerId || '—'}</span></div>
  </div>;
}

function ActionIdentity({ action, actionId }) {
  return <div className="promotion-identity"><strong>{actionId ? ozonPromotionTitle({ ...action, id: actionId }) : '历史底价保护'}</strong></div>;
}

function BatchTime({ value, timeZone }) {
  return value ? <div className="promotion-identity"><Tag color="purple">未来批次</Tag><span title={`平台 UTC：${value}`}>{dateText(value, timeZone)}</span></div> : <Tag color="blue">当前报名</Tag>;
}

function MembershipTable({ rows, products, actions, timeZone, loading = false }) {
  return <Table className="promotion-table" rowKey={(item, index) => `${item.actionId}:${item.productId}:${item.batchAt}:${index}`} loading={loading} dataSource={rows} pagination={pageSize} scroll={{ x: 1150 }} columns={[
    { title: '商品 / SKU', key: 'product', width: 270, render: (_, item) => <ProductIdentity product={products.get(idOf(item.productId))} /> },
    { title: '活动', key: 'action', width: 235, render: (_, item) => <ActionIdentity action={actions.get(idOf(item.actionId))} actionId={item.actionId} /> },
    { title: `批次 · ${zoneLabel(timeZone)}`, dataIndex: 'batchAt', width: 190, render: value => <BatchTime value={value} timeZone={timeZone} /> },
    { title: '报名来源', dataIndex: 'mode', width: 140, render: value => <Tag color={value === 'AUTO' ? 'orange' : value === 'MANUAL' ? 'blue' : 'default'}>{value === 'AUTO' ? 'AUTO · 平台自动' : value === 'MANUAL' ? 'MANUAL · 手动' : 'UNKNOWN · 未知'}</Tag> },
    { title: '活动金额 / 币种', key: 'price', width: 230, render: (_, item) => ceiling(item) ? <div className="promotion-identity"><strong>{item.batchAt ? '计划限价' : '活动限价'}：{money(item.price, item.currency)}</strong><span>卖家价：{money(item.currentSellerPrice, item.sellerPriceCurrency)}</span>{!empty(item.maxPrice) && <span>平台活动阈值：{money(item.maxPrice, item.maxPriceCurrency)}</span>}</div> : money(item.price, item.currency) },
    { title: '每个 SKU 参活件数', dataIndex: 'quantity', width: 140, render: (value, item) => {
      const action = actions.get(idOf(item.actionId));
      return action ? quantityApplies(action, item.priceSemantics) ? value ?? '—' : '不适用' : value ?? '—';
    } },
  ]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合筛选条件的报名记录" /> }} />;
}

function RunItems({ record, products, actions, timeZone }) {
  const rows = [...(record.items || []).map((item, index) => ({ ...item, rowId: `item:${index}` })), ...(record.skipped || []).map((item, index) => ({ ...item, rowId: `skipped:${index}`, skipped: true }))];
  return <Table className="promotion-table" rowKey="rowId" dataSource={rows} pagination={pageSize} scroll={{ x: 1430 }} columns={[
    { title: '对象 / SKU', key: 'product', width: 240, render: (_, item) => { const product = products.get(idOf(item.productId)); return <ProductIdentity product={{ ...product, name: item.name || product?.name, offerId: item.offerId || product?.offerId }} />; } },
    { title: '活动', key: 'action', width: 220, render: (_, item) => <ActionIdentity action={{ ...actions.get(idOf(item.actionId)), title: item.actionTitle || actions.get(idOf(item.actionId))?.title }} actionId={item.actionId} /> },
    { title: '执行内容 / 批次', key: 'operation', width: 200, render: (_, item) => <div className="promotion-identity"><strong>{OPERATIONS[item.operation] || item.operation || SOURCES[record.source] || '—'}</strong>{item.batchAt ? <span title={`平台 UTC：${item.batchAt}`}>{dateText(item.batchAt, timeZone)}</span> : item.actionId ? <span>当前活动</span> : null}</div> },
    { title: '每个 SKU 参活件数', dataIndex: 'quantity', width: 140, render: (value, item) => {
      const action = actions.get(idOf(item.actionId));
      const recordedAction = { type: item.actionType ?? action?.type, isVoucher: item.isVoucher ?? action?.isVoucher };
      const knownType = !!action || item.actionType != null || typeof item.isVoucher === 'boolean';
      if (item.operation === 'JOIN' && knownType && !quantityApplies(recordedAction, item.priceSemantics)) return '不适用';
      return !empty(value) ? value : item.operation === 'JOIN' && knownType ? '未设置' : '—';
    } },
    { title: '价格 / 限价与降幅', key: 'price', width: 235, render: (_, item) => item.operation === 'JOIN' ? <div className="promotion-identity">
      <span>基准价：{money(item.basePrice, item.currency)}</span>
      <strong>{ceiling(item) ? '提交限价' : '活动价'}：{money(item.price, item.currency)}</strong>
      {!empty(item.targetDiscountPercent) && <span>报名降价比例：{item.targetDiscountPercent}%</span>}
      <span>{empty(item.discountPercent) ? `${ceiling(item) ? '限价降幅' : '实际降幅'}：未记录基准价` : `${ceiling(item) ? '限价降幅' : '实际降幅'}：${item.discountPercent}%`}</span>
      {!empty(item.maxDiscountPercent) && <span>规则降幅上限：{item.maxDiscountPercent}%</span>}
      {ceiling(item) && <span>最高限价，非报名后实价；可能影响商品卡价格</span>}
    </div> : item.operation === 'EXIT' && ceiling(item) && item.exitByPrice === true && !empty(item.price) ? <div className="promotion-identity">{!empty(item.previousPrice) && <span>原限价：{money(item.previousPrice, item.currency)}</span>}<strong>退出后限价：{money(item.price, item.currency)}</strong><span>恢复非活动基准价；可能影响商品卡价格</span></div> : money(item.price, item.currency) },
    { title: '逐商品状态', key: 'status', width: 165, render: (_, item) => item.skipped ? <Tag>跳过</Tag> : statusTag(item.status) },
    { title: '执行 / 跳过原因及错误', key: 'reason', width: 265, render: (_, item) => <div className="promotion-identity"><span>{item.reason || '—'}</span>{item.error && <span className="promotion-error">{typeof item.error === 'string' ? item.error : item.error.message || item.error.code || '平台执行失败'}</span>}{Array.isArray(item.warnings) && item.warnings.map((warning, index) => <span key={index} className="promotion-muted">平台提示：{warning}</span>)}</div> },
  ]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次没有可执行商品或跳过明细" /> }} />;
}

export default function PromotionManagementPage({ binding, localData, account, request, locationSearch = '' }) {
  const storeId = binding?.id || localData?.currentStoreId;
  if (!storeId) return <div className="promotion-management-page"><SourceSectionTitle title="活动管理" subtitle="活动与商品、定时报名、自动退出" /><Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择或绑定店铺，再管理活动" /></Card></div>;
  return <StorePromotions key={`${account?.id || ''}:${storeId}`} storeId={storeId} storeName={binding?.label || binding?.displayName || binding?.name || binding?.storeName || storeId} request={request} locationSearch={locationSearch} />;
}

function StorePromotions({ storeId, storeName, request, locationSearch }) {
  const initialQuery = new URLSearchParams(locationSearch);
  const [data, setData] = useState(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [tab, setTab] = useState(initialQuery.get('tab') === 'records' ? 'records' : 'activities'), [query, setQuery] = useState(''), [batch, setBatch] = useState('all'), [mode, setMode] = useState(), [actionFilter, setActionFilter] = useState();
  const [actionDetail, setActionDetail] = useState(null), [editing, setEditing] = useState(null), [deleting, setDeleting] = useState(null), [enableConfirmation, setEnableConfirmation] = useState(false);
  const [policyDraft, setPolicyDraft] = useState(null);
  const [runView, setRunView] = useState(null), [runError, setRunError] = useState(''), [attemptedRuns, setAttemptedRuns] = useState(() => new Set()), [recordStatus, setRecordStatus] = useState(Object.hasOwn(RUN_STATUSES, initialQuery.get('status')) ? initialQuery.get('status') : undefined);
  useEffect(() => {
    const next = new URLSearchParams(locationSearch);
    setTab(next.get('tab') === 'records' ? 'records' : 'activities');
    setRecordStatus(Object.hasOwn(RUN_STATUSES, next.get('status')) ? next.get('status') : undefined);
    setRunView(null); setRunError('');
  }, [locationSearch]);
  const lifetime = useRef(null), sequence = useRef(0), refreshing = useRef(false), mutationLock = useRef(false), executeLock = useRef(new Set());

  const call = useCallback(async (path, options = {}) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) throw abortError();
    try {
      const result = await request(`/ozon/promotions${path}?${new URLSearchParams({ storeId })}`, { ...options, signal });
      if (signal.aborted) throw abortError();
      return result;
    } catch (err) { if (signal.aborted) throw abortError(); throw err; }
  }, [request, storeId]);

  const reload = useCallback(async (background = false) => {
    if (refreshing.current || mutationLock.current) return;
    const current = ++sequence.current;
    refreshing.current = true;
    if (!background) setLoading(true);
    try {
      const result = await call('/overview');
      if (current === sequence.current) { setData(result); setError(''); }
    } catch (err) { if (current === sequence.current && !isAborted(err)) setError(errorText(err)); }
    finally {
      refreshing.current = false;
      if (current === sequence.current) setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    // Each account/store mount owns its requests; a late response cannot enter the next store.
    refreshing.current = false;
    void reload();
    const timer = setInterval(() => { void reload(true); }, 5000);
    return () => { clearInterval(timer); controller.abort(); sequence.current += 1; };
  }, [reload]);

  async function mutate(key, path, method, body, onSaved, onError = setError) {
    if (mutationLock.current) return false;
    mutationLock.current = true; sequence.current += 1; setBusy(key); setError('');
    try {
      const result = await call(path, { method, ...(body === undefined ? {} : { body }), ...(path === '/preview' ? { timeoutMs: 60000 } : {}) });
      if (result?.settings) setData(result);
      await onSaved?.(result);
      return true;
    } catch (err) { if (!isAborted(err)) onError(errorText(err)); return false; }
    finally { mutationLock.current = false; if (!lifetime.current?.signal.aborted) { setBusy(''); setLoading(false); } }
  }

  function rememberRecord(record) {
    setData(previous => ({ ...previous, records: [record, ...(previous.records || []).filter(item => item.id !== record.id)] }));
    setRunView(previous => ({ ...previous, id: record.id, record }));
  }

  async function preview(source, rule) {
    if (mutationLock.current) return;
    setRunError('');
    setRunView({ title: rule ? `${rule.name} · 报名预览` : `${SOURCES[source]}预览`, source, record: null });
    await mutate(`preview:${source}:${rule?.id || ''}`, '/preview', 'POST', { source, ...(rule ? { ruleId: rule.id } : {}) }, async record => {
      // Preview refreshes the server snapshot, including newly discovered product identities.
      const overview = await call('/overview');
      setData(overview); rememberRecord(record);
    }, setRunError);
  }

  async function execute(record) {
    if (mutationLock.current || executeLock.current.has(record.id)) return;
    executeLock.current.add(record.id);
    setAttemptedRuns(previous => new Set(previous).add(record.id));
    setRunError('');
    await mutate(`execute:${record.id}`, `/runs/${encodeURIComponent(record.id)}/execute`, 'POST', {}, rememberRecord, message => setRunError(`${message}。本次提交结果尚未确认，请只读核对，勿重复执行。`));
  }

  function reconcile(record) {
    setRunError('');
    return mutate(`reconcile:${record.id}`, `/runs/${encodeURIComponent(record.id)}/reconcile`, 'POST', {}, rememberRecord, setRunError);
  }

  const settings = data.settings || {}, state = data.state || {};
  const priceSemantics = data.priceSemantics === 'CEILING' ? 'CEILING' : 'FIXED';
  const timeZone = settings.timeZone || 'Asia/Shanghai';
  const locked = loading || !!busy || !data.settings;
  const policy = policyDraft || policySettings(settings);
  const products = useMemo(() => new Map((data.products || []).map(item => [idOf(item.productId), item])), [data.products]);
  const actions = useMemo(() => new Map((data.actions || []).map(item => [idOf(item.id), item])), [data.actions]);
  const productOptions = useMemo(() => (data.products || []).map(item => ({ value: idOf(item.productId), label: `${item.name || '商品'} · SKU ${item.sku || '—'} · ${item.offerId || item.productId}` })), [data.products]);
  const actionOptions = useMemo(() => (data.actions || []).map(item => ({ value: idOf(item.id), label: ozonPromotionTitle(item) })), [data.actions]);
  const categoryOptions = useMemo(() => [...new Set((data.products || []).map(item => idOf(item.categoryId)).filter(Boolean))].map(value => ({ value, label: `类目 ID ${value}` })), [data.products]);
  const memberships = data.memberships || [], rules = data.rules || [], records = data.records || [];
  const currentCount = memberships.filter(item => !item.batchAt).length, futureCount = memberships.length - currentCount;
  const matchesProduct = (product, productId, text) => [product?.name, product?.sku, product?.offerId, productId].some(value => String(value ?? '').toLowerCase().includes(text.trim().toLowerCase()));
  const filteredMemberships = memberships.filter(item => (batch === 'all' || (batch === 'future' ? !!item.batchAt : !item.batchAt)) && (!mode || item.mode === mode) && (!actionFilter || idOf(item.actionId) === actionFilter) && matchesProduct(products.get(idOf(item.productId)), item.productId, query));
  const detail = actions.get(idOf(actionDetail));
  const selectedRecord = runView?.id ? records.find(item => item.id === runView.id) || runView.record : null;
  const attempted = selectedRecord && attemptedRuns.has(selectedRecord.id);
  const uncertain = selectedRecord && (selectedRecord.status === 'UNCERTAIN' || (selectedRecord.items || []).some(item => item.status === 'UNCERTAIN'));
  const executable = selectedRecord?.source !== 'FLOORS' && selectedRecord?.status === 'PREVIEW' && (selectedRecord.items || []).some(item => item.status === 'PLANNED') && !(selectedRecord.items || []).some(item => ['SUBMITTED', 'UNCERTAIN'].includes(item.status)) && !attempted;
  const previewBusy = busy.startsWith('preview:');
  const editPolicy = values => setPolicyDraft(previous => ({ ...(previous || policySettings(settings)), ...values }));
  const selectionText = (ids, map, key) => ids?.length ? ids.map(id => key === 'title' ? ozonPromotionTitle({ ...map.get(idOf(id)), id }) : map.get(idOf(id))?.[key] || `ID ${id}`).join('、') : '全部';

  return <div className="promotion-management-page">
    <SourceSectionTitle title="活动管理" subtitle="按店铺管理活动报名、未来批次与自动退出" actions={<>
      <Button icon={<ReloadOutlined />} loading={loading} disabled={!!busy} onClick={() => reload()}>刷新</Button>
      <Button icon={<SyncOutlined spin={state.syncing === true} />} loading={busy === 'sync'} disabled={locked || state.syncing === true} onClick={() => mutate('sync', '/sync', 'POST', {})}>{state.syncing ? '平台同步中' : '同步平台数据'}</Button>
      {tab === 'rules' && <Button type="primary" icon={<PlusOutlined />} disabled={locked} onClick={() => setEditing({})}>新建报名规则</Button>}
    </>} />
    {error && <Alert type="error" showIcon title={error} description="未取得新数据时保留上次快照；可刷新读取最新状态。" />}
    <Card className="promotion-status-card">
      <div className="promotion-toolbar"><div className="promotion-heading"><SafetyCertificateOutlined /><div><strong>店铺自动执行</strong><p>{storeName} · {settings.enabled === true ? '后台按已启用规则运行' : '总开关已关闭，保存规则不会自动开启'}</p></div></div>
        <Space><Tag color={settings.enabled === true ? 'green' : 'default'}>{settings.enabled === true ? '已开启' : '已关闭'}</Tag><Switch aria-label="店铺自动执行总开关" checked={settings.enabled === true} loading={busy === 'master'} disabled={locked} onChange={enabled => enabled ? setEnableConfirmation(true) : mutate('master', '/settings', 'PUT', { enabled: false })} /></Space>
      </div>
      <div className="promotion-meta"><span>上次同步：{dateText(state.lastSyncAt, timeZone)}</span><span>下次同步：{dateText(state.nextSyncAt, timeZone)}</span><span>最近执行：{dateText(state.lastRunAt, timeZone)}</span><span>币种：{state.currency || '待平台确认'}</span><span>{zoneLabel(timeZone)} · {timeZone}</span></div>
      {state.lastError && <Alert showIcon type="warning" title={typeof state.lastError === 'string' ? state.lastError : state.lastError.message || '平台同步或执行异常'} />}
      <p className="promotion-note">页面每 5 秒更新状态，编辑内容保留。手动执行需先查看预览；总开关关闭时仍可明确执行单次预览。后台需保持在线。</p>
    </Card>
    <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'activities', label: '活动与商品' }, { key: 'rules', label: '定时报名规则' }, { key: 'protection', label: '自动退出' }, { key: 'records', label: '执行记录' }]} />

    {tab === 'activities' && <>
      <div className="promotion-metrics">{[['活动', data.actions?.length || 0], ['当前报名记录', currentCount], ['未来报名记录', futureCount], ['快照商品', data.products?.length || 0]].map(([label, count]) => <Card key={label}><span>{label}</span><strong>{count}</strong></Card>)}</div>
      <Card><div className="promotion-toolbar"><h3>活动列表</h3><span className="promotion-muted">平台时间按{zoneLabel(timeZone)}显示；报名记录按商品 × 活动 × 批次统计</span></div>
        <Table className="promotion-table" rowKey="id" loading={loading} dataSource={data.actions || []} pagination={pageSize} scroll={{ x: 1200 }} columns={[
          { title: '活动 / 类型', key: 'name', width: 280, render: (_, item) => <div className="promotion-identity"><strong>{ozonPromotionTitle(item)}</strong><span>{ozonPromotionTypeLabel(item.type)}</span></div> },
          { title: '活动周期', key: 'period', width: 200, render: (_, item) => <div className="promotion-identity"><span>开始 {dateText(item.startAt, timeZone)}</span><span>结束 {dateText(item.endAt, timeZone)}</span></div> },
          { title: '冻结时间', dataIndex: 'freezeAt', width: 180, render: value => value ? dateText(value, timeZone) : '未提供' },
          { title: '自动加入批次', dataIndex: 'autoAddDates', width: 205, render: dates => dates?.length ? dates.map(value => <div key={value} title={`平台 UTC：${value}`}>{dateText(value, timeZone)}</div>) : '无待生效批次' },
          { title: '当前 / 未来报名', key: 'memberships', width: 150, render: (_, item) => { const rows = memberships.filter(row => idOf(row.actionId) === idOf(item.id)); return `${rows.filter(row => !row.batchAt).length} / ${rows.filter(row => row.batchAt).length}`; } },
          { title: '操作', key: 'actions', width: 120, render: (_, item) => <Button icon={<EyeOutlined />} onClick={() => setActionDetail(item.id)}>详情</Button> },
        ]} />
      </Card>
      <Card><div className="promotion-toolbar"><h3>商品报名与未来批次</h3><Space wrap>
        <Select aria-label="筛选报名批次" value={batch} onChange={setBatch} options={[{ value: 'all', label: '全部批次' }, { value: 'current', label: '当前报名' }, { value: 'future', label: '未来批次' }]} />
        <Select aria-label="筛选报名来源" allowClear placeholder="全部来源" value={mode} onChange={setMode} options={[{ value: 'AUTO', label: 'AUTO · 自动' }, { value: 'MANUAL', label: 'MANUAL · 手动' }, { value: 'UNKNOWN', label: 'UNKNOWN · 未知' }]} />
        <Select className="promotion-action-filter" aria-label="筛选活动" showSearch optionFilterProp="label" allowClear placeholder="全部活动" value={actionFilter} onChange={setActionFilter} options={actionOptions} />
        <Input.Search aria-label="搜索报名商品" placeholder="商品名 / SKU / 货号" allowClear value={query} onChange={event => setQuery(event.target.value)} />
      </Space></div><p className="promotion-note">活动数量不等于仓库可用库存。AUTO、MANUAL 与 UNKNOWN 按平台返回值显示；自动退出只处理明确的 AUTO。</p>
        <MembershipTable rows={filteredMemberships} products={products} actions={actions} timeZone={timeZone} loading={loading} />
      </Card>
    </>}

    {tab === 'rules' && <Card><div className="promotion-toolbar"><h3>定时报名规则</h3><span className="promotion-muted">单次或每日执行 · 报名降价比例可选</span></div>
      <p className="promotion-note">可按非活动基准价设定报名降价比例，留空使用平台允许的金额。{priceSemantics === 'CEILING' ? '新动态活动仅提供最高限价，提交限价与当前价都不是报名后实价；限价可能影响商品卡价格。最大降幅保护保留，无法确认实际卖家价满足保护时跳过。保存后请预览基准价、提交限价及限价降幅。' : '保存后可预览基准价、活动价及实际降幅。'}设定比例不满足平台要求时跳过，不自动加大降幅。</p>
      <Table className="promotion-table" rowKey="id" loading={loading} dataSource={rules} pagination={pageSize} scroll={{ x: 1320 }} columns={[
        { title: '规则 / 状态', key: 'name', width: 210, render: (_, rule) => <div className="promotion-identity"><strong>{rule.name}</strong><span><Tag color={rule.enabled ? 'blue' : 'default'}>{rule.enabled ? '规则已启用' : '规则已停用'}</Tag></span>{rule.enabled && settings.enabled !== true && <span>总开关关闭，自动执行待命</span>}</div> },
        { title: '执行时间', key: 'schedule', width: 235, render: (_, rule) => <div className="promotion-identity"><strong>{rule.schedule?.mode === 'DAILY' ? `每日 ${rule.schedule.time || '—'}` : `单次 ${dateText(rule.schedule?.at, rule.schedule?.timeZone || timeZone)}`}</strong><span>{rule.schedule?.timeZone || timeZone}</span><span>下次 {dateText(rule.nextRunAt, rule.schedule?.timeZone || timeZone)}</span><span>最近 {dateText(rule.lastRunAt, rule.schedule?.timeZone || timeZone)}</span></div> },
        { title: '活动 / 商品 / 类目', key: 'scope', width: 310, render: (_, rule) => <div className="promotion-identity"><span>活动：{selectionText(rule.actionIds, actions, 'title')}</span><span>参与范围：{(PARTICIPATION_SCOPES.find(item => item.value === rule.participationScope) || PARTICIPATION_SCOPES[0]).label}</span><span>商品：{selectionText(rule.productIds, products, 'name')}</span><span>类目：{rule.categoryIds?.length ? rule.categoryIds.join('、') : '全部'}</span></div> },
        { title: '条件 / 参活件数', key: 'condition', width: 260, render: (_, rule) => <div className="promotion-identity"><span>最低库存 {empty(rule.minStock) ? '按平台要求' : rule.minStock}</span><span>{priceSemantics === 'CEILING' ? '促销码参活件数' : '库存折扣参活件数'}：{rule.quantity === 0 || rule.quantity === '0' ? '旧值0需修改' : empty(rule.quantity) ? '未设置' : rule.quantity}</span><span>报名降价比例：{empty(rule.targetDiscountPercent) ? '未设置，使用平台允许金额' : `${rule.targetDiscountPercent}%`}</span><span>最大降价幅度：{empty(rule.maxDiscountPercent) ? '不限' : `${rule.maxDiscountPercent}%`}</span></div> },
        { title: '操作', key: 'action', width: 310, render: (_, rule) => <Space wrap><Button icon={<EyeOutlined />} disabled={locked} loading={busy === `preview:RULE:${rule.id}`} onClick={() => preview('RULE', rule)}>只读预览</Button><Button icon={<EditOutlined />} disabled={locked} onClick={() => setEditing(rule)}>编辑</Button><Button danger type="text" icon={<DeleteOutlined />} disabled={locked} onClick={() => { setError(''); setDeleting(rule); }}>删除</Button></Space> },
      ]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无报名规则"><Button type="primary" disabled={locked} onClick={() => setEditing({})}>新建报名规则</Button></Empty> }} />
    </Card>}

    {tab === 'protection' && <>
      <Card><div className="promotion-toolbar"><h3>自动退出设置</h3><Space><Button disabled={locked || !policyDraft} onClick={() => setPolicyDraft(null)}>放弃修改</Button><Button type="primary" disabled={locked || !policyDraft} loading={busy === 'policy'} onClick={() => mutate('policy', '/settings', 'PUT', policyDraft, () => setPolicyDraft(null))}>保存设置</Button></Space></div>
        <Form layout="vertical" disabled={locked} className="promotion-policy-form">
          <div className="promotion-form-grid">
            <Form.Item label="自动退出开关"><Switch aria-label="自动退出开关" checked={policy.exitEnabled} onChange={exitEnabled => editPolicy({ exitEnabled })} /></Form.Item>
            <Form.Item label="显示及店铺调度时区"><Select value={policy.timeZone} onChange={timeZone => editPolicy({ timeZone })} options={TIME_ZONES} /></Form.Item>
          </div>
          <div className="promotion-form-grid promotion-form-grid-two">
            <Form.Item label="保留的活动（自动退出例外）"><Select aria-label="自动退出活动例外" mode="multiple" showSearch optionFilterProp="label" placeholder="无例外" value={policy.protectedActionIds} onChange={protectedActionIds => editPolicy({ protectedActionIds })} options={selectionOptions(actionOptions, policy.protectedActionIds, '活动')} /></Form.Item>
            <Form.Item label="保留的商品 / SKU（自动退出例外）"><Select aria-label="自动退出商品例外" mode="multiple" showSearch optionFilterProp="label" placeholder="无例外" value={policy.protectedProductIds} onChange={protectedProductIds => editPolicy({ protectedProductIds })} options={selectionOptions(productOptions, policy.protectedProductIds, '商品')} /></Form.Item>
          </div>
        </Form>
        <p className="promotion-note">开启后尝试退出当前与未来的 AUTO 报名；MANUAL、未知来源及例外范围不自动退出。{priceSemantics === 'CEILING' && ' 新动态活动按恢复非活动基准价计算退出后限价；价仍不足以退出时跳过，限价变更可能影响商品卡价格。'}</p>
        <p className="promotion-note">{settings.enabled === true ? '总开关已开启：保存后，后台会按已开启的自动退出设置执行。' : '保存设置不打开总开关。可在总开关关闭时生成预览，再明确执行一次。'}{policyDraft ? ' 当前有未保存设置，请先保存再预览。' : ''}</p>
        <div className="promotion-preview-actions"><Button icon={<EyeOutlined />} disabled={locked || !!policyDraft} loading={busy === 'preview:EXIT:'} onClick={() => preview('EXIT')}>只读预览退出</Button></div>
      </Card>
    </>}

    {tab === 'records' && <Card><div className="promotion-toolbar"><h3>执行记录</h3><Select aria-label="筛选执行状态" placeholder="全部状态" value={recordStatus} allowClear onChange={setRecordStatus} options={Object.entries(RUN_STATUSES).map(([value, [label]]) => ({ value, label }))} /></div><p className="promotion-note">预览不向平台写入。显示最近 100 个批次及全部排队、执行中、待核对批次。排队批次也可能包含待核对商品，请以逐商品结果为准；结果未知的商品仅只读核对。</p>
      <Table className="promotion-table" rowKey="id" loading={loading} dataSource={records.filter(record => !recordStatus || record.status === recordStatus)} pagination={pageSize} scroll={{ x: 1080 }} columns={[
        { title: '来源 / 批次', key: 'source', width: 260, render: (_, record) => <div className="promotion-identity"><strong>{SOURCES[record.source] || record.source}</strong><span>{record.id}</span></div> },
        { title: '状态', dataIndex: 'status', width: 170, render: runStatusTag },
        { title: '逐商品汇总', key: 'summary', width: 220, render: (_, record) => <RunSummary record={record} /> },
        { title: '创建 / 更新时间', key: 'time', width: 200, render: (_, record) => <div className="promotion-identity"><span>{dateText(record.createdAt, timeZone)}</span><span>{dateText(record.updatedAt, timeZone)}</span>{record.retryAt && <span>下次读取重试：{dateText(record.retryAt, timeZone)}</span>}</div> },
        { title: '操作', key: 'action', width: 220, render: (_, record) => <Button icon={<EyeOutlined />} disabled={!!busy} onClick={() => { setRunError(''); setRunView({ id: record.id, record, title: `${SOURCES[record.source] || '活动'} · 批次详情` }); }}>{record.status === 'UNCERTAIN' ? '查看并只读核对' : '查看逐商品详情'}</Button> },
      ]} />
    </Card>}

    <Modal centered className="promotion-management-modal" open={!!actionDetail} title={detail ? ozonPromotionTitle(detail) : '活动详情'} width={1280} onCancel={() => setActionDetail(null)} footer={<Button onClick={() => setActionDetail(null)}>关闭</Button>} destroyOnHidden>
      {detail && <><Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[{ key: 'id', label: '活动 ID / 类型', children: `${detail.id} / ${ozonPromotionTypeLabel(detail.type)}` }, { key: 'candidates', label: '候选商品', children: `${detail.candidates?.length || 0} 个` }, { key: 'start', label: '开始时间', children: dateText(detail.startAt, timeZone) }, { key: 'end', label: '结束时间', children: dateText(detail.endAt, timeZone) }, { key: 'freeze', label: '冻结时间', children: dateText(detail.freezeAt, timeZone) }, { key: 'zone', label: '显示时区', children: timeZone }]} /><h3>当前报名与未来批次</h3><MembershipTable rows={memberships.filter(item => idOf(item.actionId) === idOf(detail.id))} products={products} actions={actions} timeZone={timeZone} /><h3>平台候选商品</h3><Table className="promotion-table" rowKey="productId" dataSource={detail.candidates || []} pagination={pageSize} scroll={{ x: 720 }} columns={[{ title: '商品 / SKU', key: 'product', width: 320, render: (_, item) => <ProductIdentity product={products.get(idOf(item.productId))} /> }, { title: priceSemantics === 'CEILING' ? '平台活动阈值' : '最高允许活动价', key: 'price', width: 210, render: (_, item) => money(item.maxPrice, item.currency ?? (data.priceSemantics == null ? products.get(idOf(item.productId))?.currency : null)) }, { title: '最低活动数量', dataIndex: 'minQuantity', width: 150, render: value => value ?? '—' }]} /></>}
    </Modal>

    {editing && <RuleEditor key={editing.id || 'new'} rule={editing} timeZone={timeZone} priceSemantics={priceSemantics} productOptions={productOptions} actions={data.actions || []} actionOptions={actionOptions} categoryOptions={categoryOptions} masterEnabled={settings.enabled === true} busy={!!busy} onClose={() => setEditing(null)} onSave={(body, onError) => mutate('rule', `/rules${editing.id ? `/${encodeURIComponent(editing.id)}` : ''}`, editing.id ? 'PUT' : 'POST', body, () => setEditing(null), onError)} />}

    <Modal centered className="promotion-management-modal" open={!!deleting} title="删除报名规则" onCancel={() => setDeleting(null)} onOk={() => mutate('delete', `/rules/${encodeURIComponent(deleting.id)}`, 'DELETE', undefined, () => setDeleting(null))} confirmLoading={busy === 'delete'} okText="停用并删除" cancelText="取消" okButtonProps={{ danger: true, disabled: !!busy }} cancelButtonProps={{ disabled: !!busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
      {error && <Alert type="error" title={error} showIcon />}<p>停用并删除“{deleting?.name}”。已有预览和执行记录继续保留。</p>
    </Modal>

    <Modal centered className="promotion-management-modal" open={enableConfirmation} title="开启店铺自动执行" onCancel={() => setEnableConfirmation(false)} onOk={() => mutate('master', '/settings', 'PUT', { enabled: true }, () => setEnableConfirmation(false))} confirmLoading={busy === 'master'} okText="开启自动执行" cancelText="取消" okButtonProps={{ disabled: !!busy }} cancelButtonProps={{ disabled: !!busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
      {error && <Alert type="error" title={error} showIcon />}<Alert type="warning" showIcon title="开启后，后台将按已保存且启用的规则向 Ozon 报名或退出活动。" description={priceSemantics === 'CEILING' ? '新动态活动仅提供最高限价，不能由当前价或限价推断报名后实价；限价可能影响商品卡价格。最大降幅保护保留，无法确认实际卖家价符合上限时跳过。请先核对规则及只读预览。' : undefined} />
      <Descriptions column={1} size="small" items={[{ key: 'store', label: '当前店铺', children: storeName }, { key: 'rules', label: '已启用报名规则', children: rules.filter(rule => rule.enabled).map(rule => rule.name).join('、') || '无' }, { key: 'exit', label: '自动退出', children: settings.exitEnabled ? priceSemantics === 'CEILING' ? '尝试退出 AUTO 报名；动态活动须满足价格退出条件' : '退出全部 AUTO 报名' : '关闭' }, { key: 'exceptions', label: '退出例外', children: `${settings.protectedActionIds?.length || 0} 个活动 / ${settings.protectedProductIds?.length || 0} 个商品` }]} /><p className="promotion-note">请以已保存规则及只读预览核对范围。未保存的页面编辑不会生效。</p>
    </Modal>

    <Modal centered className="promotion-management-modal" open={!!runView} title={runView?.title || '执行批次'} width={1440} onCancel={() => setRunView(null)} closable={!busy} maskClosable={!busy} keyboard={!busy} footer={<Space wrap><Button disabled={!!busy} onClick={() => setRunView(null)}>关闭</Button>{selectedRecord && <Button loading={busy === `reconcile:${selectedRecord.id}`} disabled={locked} icon={<ReloadOutlined />} onClick={() => reconcile(selectedRecord)}>只读核对平台结果</Button>}{executable && <Button type="primary" loading={busy === `execute:${selectedRecord.id}`} disabled={locked} onClick={() => execute(selectedRecord)}>执行本次预览</Button>}</Space>} destroyOnHidden>
      {runError && <Alert type="error" showIcon title={runError} />}
      {previewBusy && <div className="promotion-preview-loading"><Spin /><p>正在同步平台数据并生成只读预览，可能需要约 30 秒，请稍候。</p></div>}
      {selectedRecord && <><div className="promotion-toolbar"><Space wrap>{runStatusTag(selectedRecord.status)}<span className="promotion-muted">批次 {selectedRecord.id} · {dateText(selectedRecord.createdAt, timeZone)}</span></Space><RunSummary record={selectedRecord} /></div>
        {selectedRecord.retryAt && <p className="promotion-note">下次读取重试：{dateText(selectedRecord.retryAt, timeZone)}（{zoneLabel(timeZone)}）。读取失败后延迟重试，同批次尚未提交项将继续处理。</p>}
        {uncertain || (attempted && selectedRecord.status === 'PREVIEW') ? <Alert type="warning" showIcon title="结果未知的商品只读核对，不重复提交；同批次待执行项按后台状态处理。" /> : executable ? <Alert type="info" showIcon title="请核对下方对象、SKU、活动、执行内容、数量、金额币种及跳过原因。" description="“执行本次预览”会向 Ozon 提交真实报名、退出或取消未来批次操作。执行前会重读条件，条件变化时跳过；总开关关闭也可执行这一次。" /> : <Alert type="info" showIcon title={selectedRecord.status === 'PREVIEW' ? selectedRecord.source === 'FLOORS' ? '底价保护功能已移除，历史预览仅供查看。' : '本次没有可执行商品，请查看跳过原因。' : '批次状态每 5 秒更新，平台逐商品处理结果以下方明细为准。'} />}
        <RunItems record={selectedRecord} products={products} actions={actions} timeZone={timeZone} />
      </>}
    </Modal>
  </div>;
}

function RunSummary({ record }) {
  const items = record.items || [];
  const summary = record.summary || {};
  return <div className="promotion-identity"><span>执行项 {summary.total ?? items.length} · 待执行 {summary.planned ?? items.filter(item => item.status === 'PLANNED').length} · 跳过 {summary.skipped ?? record.skipped?.length ?? 0}</span><span>成功 {summary.succeeded ?? items.filter(item => item.status === 'SUCCEEDED').length} · 失败 {summary.failed ?? items.filter(item => item.status === 'FAILED').length} · 待核对 {summary.uncertain ?? items.filter(item => ['UNCERTAIN', 'SUBMITTED'].includes(item.status)).length} · 取消 {summary.cancelled ?? items.filter(item => item.status === 'CANCELLED').length}</span></div>;
}

function RuleEditor({ rule, timeZone, priceSemantics, productOptions, actions, actionOptions, categoryOptions, masterEnabled, busy, onClose, onSave }) {
  const [form] = Form.useForm();
  const [error, setError] = useState('');
  const saving = useRef(false);
  const zone = rule.schedule?.timeZone || timeZone;
  const [initial] = useState(() => ({ name: rule.name || '', enabled: rule.enabled === true, actionIds: (rule.actionIds || []).map(idOf), participationScope: rule.participationScope || 'ALL', productIds: (rule.productIds || []).map(idOf), categoryIds: (rule.categoryIds || []).map(idOf), minStock: rule.minStock ?? null, targetDiscountPercent: rule.targetDiscountPercent ?? null, maxDiscountPercent: rule.maxDiscountPercent ?? null, quantity: rule.id ? rule.quantity ?? null : 1, scheduleMode: rule.schedule?.mode || 'ONCE', at: dateInput(rule.schedule?.at, zone), time: rule.schedule?.time || '09:00', timeZone: zone }));
  const scheduleMode = Form.useWatch('scheduleMode', form) || initial.scheduleMode;
  const selectedActionIds = Form.useWatch('actionIds', form) ?? initial.actionIds;
  const quantityRequired = actions.some(action => quantityApplies(action, priceSemantics) && (!selectedActionIds.length || selectedActionIds.includes(idOf(action.id))));

  async function save() {
    if (saving.current || busy) return;
    saving.current = true;
    setError('');
    try {
      const values = await form.validateFields();
      // Only the two contract time zones are allowed; neither uses DST for these schedules.
      const at = values.scheduleMode === 'ONCE' ? new Date(`${values.at}${values.timeZone === 'Europe/Moscow' ? '+03:00' : '+08:00'}`).toISOString() : '';
      await onSave({ name: values.name.trim(), enabled: values.enabled === true, ...(rule.version !== undefined ? { version: rule.version } : {}), actionIds: values.actionIds || [], participationScope: values.participationScope || 'ALL', productIds: values.productIds || [], categoryIds: values.categoryIds || [], minStock: values.minStock ?? null, targetDiscountPercent: values.targetDiscountPercent ?? null, maxDiscountPercent: values.maxDiscountPercent ?? null, quantity: quantityRequired ? values.quantity : rule.id ? values.quantity ?? rule.quantity ?? null : null, schedule: { mode: values.scheduleMode, at, time: values.scheduleMode === 'DAILY' ? values.time : '', timeZone: values.timeZone } }, setError);
    } catch (err) { if (!err.errorFields) setError(errorText(err)); }
    finally { saving.current = false; }
  }

  return <Modal centered className="promotion-management-modal" open title={rule.id ? '编辑报名规则' : '新建报名规则'} width={900} onCancel={onClose} onOk={save} okText="保存规则" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: busy }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} destroyOnHidden>
    {error && <Alert type="error" showIcon title={error} />}
    <Form form={form} layout="vertical" initialValues={initial} disabled={busy}>
      <div className="promotion-form-grid promotion-rule-heading"><Form.Item name="name" label="规则名称" rules={[{ required: true, whitespace: true, message: '请输入规则名称' }]}><Input maxLength={80} placeholder="例如：主推商品每日活动报名" /></Form.Item><Form.Item name="enabled" label="自动运行此规则" valuePropName="checked"><Switch aria-label="自动运行报名规则" /></Form.Item></div>
      <Form.Item name="actionIds" label="活动范围" extra="留空表示全部活动；按活动 ID 保存所选范围。"><Select aria-label="报名活动范围" mode="multiple" showSearch optionFilterProp="label" placeholder="全部活动" options={selectionOptions(actionOptions, initial.actionIds, '活动')} /></Form.Item>
      <Form.Item name="participationScope" label="活动参与范围" extra="未报名范围每次执行按全部活动复核，排除已有当前或未来报名的商品，并与商品、类目条件同时满足。已全部退出的商品也可入选，不按上架天数筛选。"><Select aria-label="活动参与范围" options={PARTICIPATION_SCOPES} /></Form.Item>
      <Form.Item name="productIds" label="商品 / SKU 范围" extra="可按商品名、SKU 或货号搜索并选择；留空表示全部商品。"><Select aria-label="报名商品范围" mode="multiple" showSearch optionFilterProp="label" placeholder="全部商品" options={selectionOptions(productOptions, initial.productIds, '商品')} /></Form.Item>
      <Form.Item name="categoryIds" label="类目范围" extra="与所选商品范围同时满足；留空表示全部类目。"><Select aria-label="报名类目范围" mode="multiple" showSearch optionFilterProp="label" placeholder="全部类目" options={selectionOptions(categoryOptions, initial.categoryIds, '类目')} /></Form.Item>
      <div className="promotion-form-grid">
        <Form.Item name="minStock" label="最低可用库存（可选）" extra="留空不增加额外门槛，仍须有库存且满足平台要求。"><InputNumber min={1} max={10000000} precision={0} placeholder="按平台要求" /></Form.Item>
        <Form.Item name="targetDiscountPercent" label="报名降价比例（可选）" extra={priceSemantics === 'CEILING' ? '相对非活动基准价计算提交限价；它不是报名后实价。留空使用平台允许的限价，要求更大降幅时跳过。' : '相对非活动基准价降价，如填 30 表示降价 30%。留空使用平台最高允许活动价；平台要求更大降幅时跳过。'}><InputNumber min={0} max={99.99} step={0.01} precision={2} suffix="%" placeholder="留空按平台最高允许价" /></Form.Item>
        <Form.Item name="maxDiscountPercent" label="最大降价幅度（可选）" extra={priceSemantics === 'CEILING' ? '沿用相对非活动基准价的最大降幅保护。新动态活动只有最高限价；无法确认报名后实际卖家价符合上限时跳过。' : '填写 50% 表示相对非活动基准价最多降价 50%，不代表统一五折。报名降价比例不得超过此上限；比例留空时使用平台最高允许活动价。'}><InputNumber min={0} max={100} step={0.1} precision={2} suffix="%" placeholder="不限" /></Form.Item>
        {quantityRequired && <Form.Item name="quantity" preserve label="每个 SKU 参活件数" extra={`例如填3，表示每个 SKU 报名3件；库存还须满足平台要求。${priceSemantics === 'CEILING' ? '新机制仅用于促销码活动。' : '旧机制仅用于库存折扣活动。'}`} rules={[{ required: true, message: '请输入每个 SKU 参活件数' }, { type: 'integer', min: 1, max: 10000000, message: '参活件数须为 1 至 10000000 的整数，旧值 0 需修改' }]}><InputNumber step={1} changeOnBlur={false} /></Form.Item>}
      </div>
      {!quantityRequired && <p className="promotion-note">当前所选活动无需填写参活件数；{priceSemantics === 'CEILING' ? '新机制仅促销码活动使用此值。' : '旧机制仅库存折扣活动使用此值。'}已有规则的件数会保留。</p>}
      <div className="promotion-form-grid">
        <Form.Item name="scheduleMode" label="执行周期"><Select options={[{ value: 'ONCE', label: 'ONCE · 单次执行' }, { value: 'DAILY', label: 'DAILY · 每日执行' }]} /></Form.Item>
        {scheduleMode === 'DAILY' ? <Form.Item name="time" label="每日执行时间" rules={[{ required: true, message: '请选择执行时间' }]}><Input type="time" step={60} /></Form.Item> : <Form.Item name="at" label="单次执行日期时间" rules={[{ required: true, message: '请选择执行日期时间' }]}><Input type="datetime-local" step={60} /></Form.Item>}
        <Form.Item name="timeZone" label="规则执行时区"><Select options={TIME_ZONES} /></Form.Item>
      </div>
      <p className="promotion-note"><ClockCircleOutlined /> 日期与时间按所选规则时区填写，保存后按该时区调度。修改店铺显示时区不会改写已有规则时区。</p>
      <Alert type="info" showIcon title={priceSemantics === 'CEILING' ? '按设定比例计算提交限价；比例留空时取平台允许的限价。' : '按设定比例计算活动价；比例留空时取平台最高允许价。仍须满足降幅上限、数量与库存条件。'} description={`${masterEnabled ? '店铺总开关已开启：保存已启用规则后将按计划自动运行。' : '保存不会开启店铺总开关。'} 平台要求更大降幅时跳过，不自动加大降幅。${priceSemantics === 'CEILING' ? '新动态活动只有最高限价，当前价或提交限价都不能代表报名后实价；最大降幅保护保留，无法确认实际卖家价符合上限时跳过。限价可能影响商品卡价格，可先预览金额和跳过原因。' : '保存不会重新定价已报名商品；可先预览基准价、活动价、实际降幅和跳过原因。'}`} />
    </Form>
  </Modal>;
}
