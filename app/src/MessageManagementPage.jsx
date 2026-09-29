import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Space, Spin, Switch, Tabs, Tag } from 'antd';
import Table from "./PagedTable.jsx";
import { CopyOutlined, EditOutlined, MessageOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, SyncOutlined } from '@ant-design/icons';
import { SourceSectionTitle } from './SourceTable.jsx';
import './message-management.css';

const TRIGGERS = [
  { value: 'PICKUP', label: '待取货' }, { value: 'REVIEW', label: '签收后邀评' },
  { value: 'SHIPPING_READY', label: '待发货' }, { value: 'SHIPPED', label: '已发货' },
];
const STATUSES = { PENDING: ['待发送', 'blue'], SENDING: ['发送中', 'processing'], SENT: ['已发送', 'green'], SKIPPED: ['已跳过', 'default'], FAILED: ['发送失败', 'red'], UNCERTAIN: ['结果待核对', 'orange'], CANCELLED: ['已取消', 'default'] };
const POSTING_STATUSES = { awaiting_pickup: '待取货', awaiting_packaging: '待备货', awaiting_deliver: '待发货', delivering: '配送中', delivered: '已签收', cancelled: '已取消' };
const RUSSIAN_TEXT = {
  PICKUP: 'Здравствуйте! Ваш заказ ожидает в пункте выдачи. Пожалуйста, заберите его в указанный срок. Спасибо!',
  REVIEW: 'Здравствуйте! Спасибо за покупку. Будем рады вашему честному отзыву о товаре на Ozon.',
  SHIPPING_READY: 'Здравствуйте! Ваш заказ готовится к отправке. Спасибо за покупку!',
  SHIPPED: 'Здравствуйте! Ваш заказ отправлен. Статус доставки можно проверить в личном кабинете Ozon.',
};
const triggerLabel = value => TRIGGERS.find(item => item.value === value)?.label || value;
const templateBody = ({ id, name, trigger, delayHours, enabled, text, version }) => ({ id, name, trigger, delayHours, enabled, text, version });
const settingsBody = settings => ({ enabled: settings.enabled === true, displayName: settings.displayName || '', timeZone: settings.timeZone || 'Europe/Moscow', webhookBaseUrl: settings.webhookBaseUrl || '' });
const itemsFrom = (result, key) => Array.isArray(result) ? result : result?.[key] || result?.items || [];
const abortError = () => new DOMException('请求已取消', 'AbortError');
const reportError = (error, setter) => { if (error.name !== 'AbortError') setter(error.message || '请求失败，请重试'); };

export default function MessageManagementPage({ binding, localData, account, request }) {
  const storeId = binding?.id || localData?.currentStoreId;
  if (!storeId) return <div className="message-management-page">
    <SourceSectionTitle title="消息管理" subtitle="按订单状态自动发送，模板内容可预览" />
    <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择或绑定店铺，再管理买家消息" /></Card>
  </div>;
  return <StoreMessages key={`${account?.id || ''}:${storeId}`} storeId={storeId} request={request} />;
}

function StoreMessages({ storeId, request }) {
  const [data, setData] = useState({ settings: null, templates: [], postings: [], records: [], variables: [] });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [tab, setTab] = useState('templates'), [editing, setEditing] = useState(null), [deleting, setDeleting] = useState(null);
  const [settingsDraft, setSettingsDraft] = useState(null), [settingsError, setSettingsError] = useState('');
  const [query, setQuery] = useState(''), [status, setStatus] = useState(), [trigger, setTrigger] = useState();
  const [list, setList] = useState({ items: [], loading: false, error: '' }), [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(5);
  useEffect(()=>setPage(1),[tab,query,status,trigger]);
  const listKey = JSON.stringify([tab, query, status, trigger, page, pageSize]);
  const lifetime = useRef(null), reloadSequence = useRef(0), mutationLock = useRef(false), refreshing = useRef(false);
  const call = useCallback(async (path, options = {}, params = {}) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) throw abortError();
    const search = new URLSearchParams({ storeId, ...params });
    const result = await request(`/ozon/messages${path}?${search}`, { ...options, signal });
    if (signal.aborted) throw abortError();
    return result;
  }, [request, storeId]);
  const reload = useCallback(async (sync = false, background = false) => {
    if (background && (refreshing.current || mutationLock.current)) return;
    const sequence = ++reloadSequence.current;
    refreshing.current = true;
    if (!background) { setLoading(true); setError(''); }
    try {
      const result = await call(sync ? '/sync' : '/overview', sync ? { method: 'POST', body: {} } : {},sync?{}:{summaryOnly:'1'});
      if (sequence === reloadSequence.current) { setData(result); setRevision(value => value + 1); }
    } catch (err) { if (sequence === reloadSequence.current) reportError(err, setError); }
    finally { if (sequence === reloadSequence.current) { refreshing.current = false; setLoading(false); } }
  }, [call]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void reload();
    const timer = setInterval(() => { void reload(false, true); }, 5000);
    return () => { clearInterval(timer); controller.abort(); reloadSequence.current += 1; };
  }, [reload]);
  useEffect(() => {
    if (tab === 'templates') return;
    let current = true;
    const records = tab === 'records';
    const params = records ? { ...(status ? { status } : {}), ...(trigger ? { trigger } : {}) } : { q: query, trigger: tab === 'review' ? 'REVIEW' : 'PICKUP' };
    params.page=String(page);params.pageSize=String(pageSize);
    setList(previous => ({ total:previous.total||0, key: listKey, items: previous.key === listKey ? previous.items : [], loading: true, error: '' }));
    call(records ? '/records' : '/postings', {}, params).then(result => {
      if (current) {const items=itemsFrom(result,records?'records':'postings'),total=result.total??items.length;setList({key:listKey,items,total,loading:false,error:''});if(page>Math.max(1,Math.ceil(total/pageSize)))setPage(Math.max(1,Math.ceil(total/pageSize)));}
    }).catch(err => { if (current && err.name !== 'AbortError') setList({ key: listKey, items: [], loading: false, error: err.message || '列表读取失败' }); });
    return () => { current = false; };
  }, [call, tab, query, status, trigger, revision, listKey, page, pageSize]);

  async function mutate(key, path, method, body, onSaved, onError = setError) {
    if (mutationLock.current) return;
    mutationLock.current = true; setBusy(key); setError('');
    try { await call(path, { method, ...(body === undefined ? {} : { body }) }); onSaved?.(); await reload(); }
    catch (err) { reportError(err, onError); }
    finally { mutationLock.current = false; setBusy(''); }
  }
  const settings = data.settings || {}, eligible = settings.subscriptionEligible === true;
  const locked = loading || !!busy || !data.settings;
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: settings.timeZone || 'Europe/Moscow', hour12: false }) : '—';
  const counts = settings.counts || {};
  const count = status => settings.counts ? counts[status] ?? 0 : '—';
  const selectedTrigger = tab === 'review' ? 'REVIEW' : 'PICKUP';
  const syncState = settings.syncing ? (settings.lastSyncAt ? '同步中' : '初次同步中') : (settings.syncProgress || (settings.chatScanComplete === false && settings.lastSyncAt) ? '部分同步' : settings.lastSyncAt && settings.chatScanComplete === true ? '已同步' : '尚未同步');
  const newTemplate = () => setEditing({ name: '', trigger: 'PICKUP', delayHours: 0, enabled: false, text: RUSSIAN_TEXT.PICKUP });
  const openSettings = () => { setSettingsDraft(settingsBody(settings)); setSettingsError(''); setCopied(false); };
  async function saveSettings() {
    if (settingsDraft.webhookBaseUrl) {
      try {
        const url = new URL(settingsDraft.webhookBaseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/', '/api', '/api/'].includes(url.pathname) || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname)) throw new Error();
      } catch { setSettingsError('请填写公网 HTTPS API 地址，仅可附带 /api 前缀；localhost 不能接收 Ozon 回调'); return; }
    }
    await mutate('settings', '/settings', 'PUT', settingsDraft, () => setSettingsDraft(null), setSettingsError);
  }
  async function copyCallback() {
    try { await navigator.clipboard.writeText(settings.webhookUrl); setCopied(true); }
    catch { setSettingsError('复制失败，请选中下方回调地址手动复制'); }
  }
  const orderColumn = { title: '订单 / 包裹', key: 'posting', width: 215, render: (_, item) => <div className="message-order"><strong>{item.orderNumber || '—'}</strong><span>{item.postingNumber || '—'}</span></div> };
  const recordColumns = [
    orderColumn,
    { title: '消息模板', dataIndex: 'templateName', width: 155, render: (value, item) => <div>{value || '已删除模板'}<div className="message-muted">{triggerLabel(item.trigger)}</div></div> },
    { title: '状态', dataIndex: 'status', width: 125, render: value => <Tag color={STATUSES[value]?.[1]}>{STATUSES[value]?.[0] || value}</Tag> },
    { title: '原因', dataIndex: 'reason', render: value => value || '—' },
    { title: '计划 / 发送时间', key: 'time', width: 175, render: (_, item) => <div className="message-order"><span>计划 {date(item.dueAt)}</span><span>发送 {date(item.sentAt)}</span></div> },
    { title: '操作', key: 'action', width: 85, render: (_, item) => item.status === 'UNCERTAIN' ? <Button size="small" disabled={locked} loading={busy === item.id} onClick={() => mutate(item.id, `/records/${encodeURIComponent(item.id)}/reconcile`, 'POST', {})}>核对</Button> : '—' },
  ];
  const postingColumns = [
    orderColumn,
    { title: '商品', dataIndex: 'products', render: products => (products || []).map((product, index) => <div key={product.sku || product.productId || index}>{product.name || product.offerId || product.sku || '—'} × {product.quantity ?? '—'}</div>) },
    { title: '履约方式', dataIndex: 'scheme', width: 100 },
    { title: '订单状态', dataIndex: 'status', width: 110, render: (value, item) => <span title={[value, item.substatus].filter(Boolean).join(' / ')}>{item.substatus === 'posting_in_pickup_point' ? '待取货' : POSTING_STATUSES[value] || value || '—'}</span> },
    { title: '触发时间 / 条件', key: 'eligibility', width: 210, render: (_, item) => <div>{date(item.events?.[selectedTrigger])}<div className="message-muted">{item.reason || '发送时复核条件'}</div></div> },
    { title: '操作', key: 'action', width: 125, render: (_, item) => <Button size="small" disabled={locked} onClick={() => setEditing({ ...(data.templates.find(template => template.trigger === selectedTrigger) || { name: '', trigger: selectedTrigger, text: RUSSIAN_TEXT[selectedTrigger], delayHours: 0, enabled: false }), previewPosting: item })}>预览消息</Button> },
  ];

  return <div className="message-management-page">
    <SourceSectionTitle title="消息管理" subtitle="按订单状态自动发送，模板内容可预览" actions={<>
      <Button icon={<ReloadOutlined />} loading={loading && !busy} disabled={!!busy} onClick={() => reload()}>刷新</Button>
      <Button icon={<SyncOutlined spin={settings.syncing === true} />} disabled={loading || !!busy || settings.syncing === true} onClick={() => reload(true)}>{settings.syncing ? syncState : '同步订单与聊天'}</Button>
      <Button type="primary" icon={<PlusOutlined />} disabled={locked} onClick={newTemplate}>新建消息模板</Button>
    </>} />
    {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
    <Card className="message-settings-card">
      <div className="message-settings-top">
        <div className="message-settings-heading"><MessageOutlined /><div><strong>店铺自动消息</strong><p>开启后，符合条件且已启用的模板将由后台自动发送</p></div></div>
        <Space><Switch aria-label="店铺自动发送" checked={settings.enabled === true} disabled={locked || (!eligible && !settings.enabled)} loading={busy === 'master'} onChange={enabled => mutate('master', '/settings', 'PUT', { enabled })} /><Button icon={<SettingOutlined />} disabled={loading || !!busy} onClick={openSettings}>店铺设置</Button></Space>
      </div>
      <div className="message-settings-meta">
        <span>买家看到的店铺名称：<strong>{settings.displayName || '未设置'}</strong></span><span>时区：{settings.timeZone || 'Europe/Moscow'}</span>
        <Tag color={eligible ? 'green' : 'orange'}>{({ PREMIUM_PLUS: 'Premium Plus', PREMIUM_PRO: 'Premium Pro', PREMIUM: 'Premium', PREMIUM_LITE: 'Premium Lite', UNSPECIFIED: '未订阅', UNKNOWN: '订阅未确认' })[settings.subscriptionType] || '订阅未确认'} · {eligible ? '具备发送资格' : '暂不能开启'}</Tag>
        <span>待发送 <strong>{count('PENDING')}</strong></span><span>已发送 <strong>{count('SENT')}</strong></span>
      </div>
      <div className="message-settings-meta"><Tag color={settings.syncing ? 'processing' : 'default'}>{syncState}</Tag><span>最近同步：{date(settings.lastSyncAt)}</span><span>最近收到事件：{date(settings.lastEventAt)}</span><span>聊天扫描：{settings.chatScanComplete === true ? '已完成' : '未完成'}</span></div>
      <div className="message-settings-meta"><span>已提前准备会话：{settings.chatPreparationCounts?.READY || 0}</span><span>会话结果待核对：{settings.chatPreparationCounts?.UNCERTAIN || 0}</span></div>
      {!!settings.chatPreparationCounts?.UNCERTAIN && <Alert type="warning" showIcon title="部分包裹创建聊天的结果不明，已暂停这些包裹的自动消息。系统会继续同步聊天，不会重复创建。" />}
      {settings.syncProgress && <p className="message-note" aria-live="polite">{settings.syncProgress}</p>}
      {settings.syncError && <Alert type="error" showIcon title={settings.syncError} />}
      <p className="message-note">发送需要 Premium Plus / Pro 订阅{!eligible ? '，请先确认订阅并同步资格' : ''}。FBO 仅可回复有效买家会话；FBS / rFBS 以平台允许建聊为准。同步仅读取订单和聊天。</p>
      <p className="message-note">开启店铺发送和催取模板后，后台会在 Ozon 允许时提前准备 FBS / rFBS 买家会话；准备会话不会发送消息正文。</p>
      <p className="message-note">到店、签收时间需接入真实事件回调；未收到真实时间时不会用同步时间代替。评价邀请最晚在签收后 72 小时内触达。</p>
    </Card>
    <Tabs activeKey={tab} onChange={value => { setTab(value); setQuery(''); }} items={[{ key: 'templates', label: '消息模板' }, { key: 'records', label: '发送记录' }, { key: 'review', label: '评价邀请' }, { key: 'pickup', label: '催取货' }]} />
    {tab === 'templates' ? <Spin spinning={loading}><div className="message-template-grid">
      {(data.templates || []).map(template => <Card key={template.id} className="message-template-card">
        <div className="message-card-heading"><div className="message-template-icon"><MessageOutlined /></div><div><h3>{template.name}</h3><Space wrap><Tag color="blue">{triggerLabel(template.trigger)}</Tag><span className="message-muted">{template.delayHours ? `延迟 ${template.delayHours} 小时` : '满足条件后发送'}</span></Space></div></div>
        <div className="message-template-text" lang="ru">{template.text}</div>
        <div className="message-card-footer"><span className="message-muted">已发送 <strong>{template.sentCount ?? '—'}</strong> 条</span><Space>
          <Button type="text" icon={<EditOutlined />} disabled={locked} onClick={() => setEditing(template)}>编辑</Button>
          <Switch size="small" aria-label={`启用模板 ${template.name}`} checked={template.enabled === true} disabled={locked || (!eligible && !template.enabled)} loading={busy === template.id} onChange={enabled => mutate(template.id, `/templates/${encodeURIComponent(template.id)}`, 'PUT', templateBody({ ...template, enabled }))} />
          <Dropdown trigger={['click']} menu={{ items: [{ key: 'delete', label: '删除模板', danger: true }], onClick: () => setDeleting(template) }}><Button type="text" aria-label={`更多操作 ${template.name}`} icon={<MoreOutlined />} disabled={locked} /></Dropdown>
        </Space></div>
      </Card>)}
      {!data.templates?.length && !loading && <Card className="message-empty"><Empty description="暂无消息模板，新建后可先预览内容"><Button type="primary" disabled={locked} onClick={newTemplate}>新建消息模板</Button></Empty></Card>}
    </div></Spin> : <Card className="message-list-card">
      <div className="message-list-toolbar"><Space wrap>
        {tab === 'records' ? <><Select aria-label="筛选发送状态" allowClear placeholder="全部发送状态" value={status} onChange={setStatus} options={Object.entries(STATUSES).map(([value, [label]]) => ({ value, label }))} /><Select aria-label="筛选触发条件" allowClear placeholder="全部触发条件" value={trigger} onChange={setTrigger} options={TRIGGERS} /></> : <Input.Search key={tab} aria-label="搜索订单或包裹" placeholder="搜索订单号或包裹号" allowClear onSearch={setQuery} />}
        {tab !== 'records' && <span className="message-muted">本店待发送 {count('PENDING')} · 已发送 {count('SENT')}</span>}
      </Space><span className="message-muted">按页加载 · 时间按店铺时区</span></div>
      {tab !== 'records' && <p className="message-note">{tab === 'review' ? '按签收条件筛选包裹，后台按订单去重并复核 72 小时触达窗口。' : '按待取货条件筛选包裹，延时从真实到店事件起算。'} 实际发送还需符合模板、订阅和会话条件。</p>}
      {list.error && <Alert type="error" showIcon title={list.error} />}
      <Table key={tab} rowKey={tab === 'records' ? 'id' : 'postingNumber'} loading={list.loading} columns={tab === 'records' ? recordColumns : postingColumns} dataSource={list.key === listKey ? list.items : []}  pagination={{current:page,pageSize,total:list.total||0,onChange:(next,size)=>{setPage(next);setPageSize(size);}}} scroll={{ x: 970 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的数据" /> }} expandable={tab === 'records' ? { expandedRowRender: item => <div className="message-preview-text" lang="ru">{item.text || '未生成消息内容'}</div>, rowExpandable: item => !!item.text } : undefined} />
    </Card>}
    {editing && <TemplateEditor template={editing} variables={data.variables || []} eligible={eligible} call={call} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
    <Modal centered className="message-management-modal" open={!!settingsDraft} title="店铺消息设置" onCancel={() => setSettingsDraft(null)} onOk={saveSettings} confirmLoading={busy === 'settings'} okButtonProps={{ disabled: !!busy }} cancelButtonProps={{ disabled: !!busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} okText="保存设置" cancelText="取消" width={600} destroyOnHidden>
      {settingsDraft && <Form layout="vertical">
        {settingsError && <Alert type="error" showIcon title={settingsError} />}
        <Form.Item label="面向买家的店铺名称"><Input value={settingsDraft.displayName} onChange={event => setSettingsDraft({ ...settingsDraft, displayName: event.target.value })} placeholder="用于模板中的店铺名称变量" /></Form.Item>
        <Form.Item label="店铺时区"><Select value={settingsDraft.timeZone} onChange={timeZone => setSettingsDraft({ ...settingsDraft, timeZone })} options={[{ value: 'Europe/Moscow', label: '莫斯科 · Europe/Moscow' }, { value: 'Asia/Shanghai', label: '北京时间 · Asia/Shanghai' }]} /></Form.Item>
        <Form.Item label="事件回调公网地址（HTTPS）" extra="填写公网 HTTPS API 地址，可带 /api 前缀。本机 localhost 无法接收 Ozon 推送。"><Input value={settingsDraft.webhookBaseUrl} onChange={event => setSettingsDraft({ ...settingsDraft, webhookBaseUrl: event.target.value.trim() })} placeholder="https://your-domain.example/api" /></Form.Item>
        <Form.Item label="已保存的完整回调 URL" extra="地址含店铺验证信息，仅复制到 Ozon 通知设置，请妥善保管。"><Space.Compact className="message-callback"><Input aria-label="完整回调 URL" readOnly value={settings.webhookUrl || ''} placeholder="保存公网地址后提供" /><Button icon={<CopyOutlined />} disabled={!settings.webhookUrl} onClick={copyCallback}>{copied ? '已复制' : '复制'}</Button></Space.Compact></Form.Item>
        <p className="message-note">状态通知用于获取准确到店和签收时间。若通知正在供其他系统使用，应先配置可靠转发，再调整 Ozon 的接收地址。</p>
        <p className="message-note">所需状态类型：TYPE_STATE_CHANGED、TYPE_FBO_POSTING_STATE_CHANGED。聊天信息也会通过定时查询同步。</p>
      </Form>}
    </Modal>
    <Modal centered className="message-management-modal" title="删除消息模板" open={!!deleting} onCancel={() => setDeleting(null)} onOk={() => mutate('delete', `/templates/${encodeURIComponent(deleting.id)}`, 'DELETE', undefined, () => setDeleting(null))} confirmLoading={busy === 'delete'} okButtonProps={{ danger: true, disabled: !!busy }} okText="删除模板" cancelText="取消">
      {error && <Alert type="error" showIcon title={error} />}
      删除“{deleting?.name}”后，已有发送记录和消息内容快照仍会保留。
    </Modal>
  </div>;
}

function TemplateEditor({ template, variables, eligible, call, onClose, onSaved }) {
  const [form] = Form.useForm();
  const [draft, setDraft] = useState(templateBody(template)), [posting, setPosting] = useState(template.previewPosting?.postingNumber);
  const [options, setOptions] = useState(template.previewPosting ? [template.previewPosting] : []), [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false), [preview, setPreview] = useState(null), [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const textarea = useRef(null), previewSequence = useRef(0), optionsSequence = useRef(0), savingLock = useRef(false);
  useEffect(() => () => { previewSequence.current += 1; }, []);
  useEffect(() => {
    const sequence = ++optionsSequence.current;
    const current = () => sequence === optionsSequence.current;
    setSearching(true); setOptions([]);
    const timer = setTimeout(() => {
      call('/postings', {}, { q: search, trigger: draft.trigger }).then(result => {
        if (current()) setOptions(itemsFrom(result, 'postings'));
      }).catch(err => { if (current()) reportError(err, setError); }).finally(() => { if (current()) setSearching(false); });
    }, search ? 250 : 0);
    return () => { optionsSequence.current += 1; clearTimeout(timer); };
  }, [call, search, draft.trigger]);
  function invalidate() { previewSequence.current += 1; setPreview(null); setPreviewing(false); setError(''); }
  function update(values) {
    if (values.trigger && values.trigger !== draft.trigger) {
      optionsSequence.current += 1; setPosting(undefined); setOptions([]); setSearch('');
    }
    if (values.trigger && !draft.id && draft.text === RUSSIAN_TEXT[draft.trigger]) { values = { ...values, text: RUSSIAN_TEXT[values.trigger] }; form.setFieldValue('text', values.text); }
    invalidate(); setDraft(previous => ({ ...previous, ...values }));
  }
  function insertVariable(key) {
    const element = textarea.current?.resizableTextArea?.textArea;
    const text = draft.text || '', start = element?.selectionStart ?? text.length, end = element?.selectionEnd ?? start;
    const token = `{{${key}}}`, next = text.slice(0, start) + token + text.slice(end);
    update({ text: next }); form.setFieldValue('text', next);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length); });
  }
  async function runPreview() {
    const sequence = ++previewSequence.current;
    setPreview(null); setPreviewing(true); setError('');
    try { const result = await call('/preview', { method: 'POST', body: { template: draft, postingNumber: posting } }); if (sequence === previewSequence.current) setPreview(result); }
    catch (err) { if (sequence === previewSequence.current) reportError(err, setError); }
    finally { if (sequence === previewSequence.current) setPreviewing(false); }
  }
  async function save() {
    if (savingLock.current) return;
    savingLock.current = true;
    try {
      const values = await form.validateFields(); setSaving(true); setError('');
      await call(`/templates${draft.id ? `/${encodeURIComponent(draft.id)}` : ''}`, { method: draft.id ? 'PUT' : 'POST', body: templateBody({ ...draft, ...values }) });
      await onSaved();
    } catch (err) { if (!err.errorFields) reportError(err, setError); }
    finally { savingLock.current = false; setSaving(false); }
  }
  const selectedOptions = options.some(item => item.postingNumber === posting) || !posting ? options : [{ postingNumber: posting }, ...options];
  return <Modal centered className="message-management-modal" title={draft.id ? '编辑消息模板' : '新建消息模板'} open width={780} onCancel={onClose} onOk={save} okText="保存模板" cancelText="取消" confirmLoading={saving} cancelButtonProps={{ disabled: saving }} closable={!saving} maskClosable={!saving} keyboard={!saving} destroyOnHidden>
    {error && <Alert type="error" showIcon title={error} />}
    <Form form={form} layout="vertical" initialValues={draft} onValuesChange={update} disabled={saving}>
      <Form.Item name="name" label="模板名称" rules={[{ required: true, whitespace: true, message: '请输入模板名称' }]}><Input placeholder="例如：到店取货提醒" maxLength={80} /></Form.Item>
      <div className="message-editor-grid">
        <Form.Item name="trigger" label="触发条件" rules={[{ required: true, message: '请选择触发条件' }]}><Select options={TRIGGERS} /></Form.Item>
        <Form.Item name="delayHours" label="延迟时间（小时）" rules={[{ required: true, message: '请输入延迟时间' }]}><InputNumber min={0} max={draft.trigger === 'REVIEW' ? 71.99 : 72} /></Form.Item>
        <Form.Item name="enabled" label="启用模板" valuePropName="checked"><Switch aria-label="编辑器启用模板" disabled={saving || (!eligible && !draft.enabled)} /></Form.Item>
      </div>
      {!eligible && <p className="message-note">当前店铺尚未确认 Premium Plus / Pro 发送资格，可保存停用模板并预览。</p>}
      <Form.Item name="text" label="消息内容（俄文）" rules={[{ required: true, whitespace: true, message: '请输入消息内容' }]}><Input.TextArea ref={textarea} rows={6} showCount count={{ strategy: value => Array.from(value).length }} /></Form.Item>
      <div className="message-variables"><span className="message-muted">在光标处插入变量：</span>{variables.map(variable => <Button key={variable.key} title={variable.description} size="small" disabled={saving} onMouseDown={event => event.preventDefault()} onClick={() => insertVariable(variable.key)}>{variable.label || variable.key}</Button>)}</div>
      <p className="message-note">最终消息最多 1000 字符，变量替换后以预览字数为准。{draft.trigger === 'REVIEW' ? '邀评须在真实签收后 72 小时内触达。' : ''}</p>
    </Form>
    <div className="message-preview-panel">
      <h3>实际包裹预览</h3><p className="message-note">仅显示当前店铺符合“{triggerLabel(draft.trigger)}”状态的包裹。预览仅生成内容，发送还需满足时间和会话条件。</p>
      <Space.Compact className="message-preview-select"><Select key={draft.trigger} aria-label="选择预览包裹" showSearch={{ onSearch: setSearch, filterOption: false }} allowClear placeholder="搜索并选择符合状态的订单 / 包裹" value={posting} loading={searching} notFoundContent={searching ? <Spin size="small" /> : `没有符合“${triggerLabel(draft.trigger)}”状态的包裹`} onChange={value => { invalidate(); setPosting(value); }} options={selectedOptions.map(item => ({ value: item.postingNumber, label: [item.orderNumber, item.postingNumber].filter(Boolean).join(' / ') }))} /><Button onClick={runPreview} loading={previewing} disabled={!posting || !draft.text?.trim() || saving}>生成预览</Button></Space.Compact>
      {preview && <div aria-live="polite"><div className="message-preview-text" lang="ru">{preview.text || '未生成内容'}</div>
        <Space wrap><Tag color={preview.valid ? 'green' : 'orange'}>{preview.valid ? '内容校验通过' : '暂不可发送'}</Tag><span>最终字数：{preview.characterCount ?? '—'} / 1000</span></Space>
        <p className="message-note">缺失字段：{preview.missing?.length ? preview.missing.map(value => variables.find(variable => variable.key === value)?.label || value).join('、') : '无'}</p>
        <p className="message-note">原因：{preview.reasons?.join('；') || preview.reason || '无阻断原因；发送时后台仍会复核条件'}</p>
      </div>}
    </div>
  </Modal>;
}
