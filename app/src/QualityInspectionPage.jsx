import React, { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Collapse, Empty, Form, Input, Modal, Popover, Select, Space, Spin, Tag } from 'antd';
import Table from "./PagedTable.jsx";
import { BellOutlined, MinusCircleOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, SyncOutlined } from '@ant-design/icons';
import { SourceSectionTitle } from './SourceTable.jsx';
import { OrderDetail, ProductIdentity } from './OrderManagementPage.jsx';
import { apiRequest } from './client-transport.js';
import { inspectionOrderKey, inspectionPrefixes } from './use-quality-inspection.js';
import './quality-inspection.css';

const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const syncNames = { IDLE: '尚未同步', QUEUED: '等待同步', RUNNING: '正在同步', COMPLETED: '本轮同步完成', FAILED: '同步未完成' };
const statusNames = { awaiting_packaging: '等待备货', awaiting_deliver: '等待发运', delivering: '运输中', disputed: '有争议', delivered: '已签收', cancelled: '已取消', other: '其他' };

export function QualityInspectionBell({ reminders, navigate }) {
  const [open, setOpen] = useState(false);
  const { summary, loading, reading, error } = reminders;
  async function openOrder(row) {
    if (!row.readAt && !await reminders.markRead([row])) return;
    setOpen(false);
    navigate(`/ozon/orders/quality?${new URLSearchParams({ q: row.orderNumber, storeId: row.storeId })}`);
  }
  const content = <div className="quality-reminder-popover">
    <div className="quality-reminder-heading"><strong>全店质检提醒</strong><span>{summary ? `${summary.unreadCount} 条未读` : '正在读取'}</span></div>
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => reminders.refresh()}>重试</Button>} />}
    {loading && !summary ? <Spin /> : summary && !summary.latest.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无质检提醒" /> : null}
    {(summary?.latest || []).slice(0, 5).map(row => <button key={inspectionOrderKey(row)} className="quality-reminder-item" type="button" disabled={reading} onClick={() => openOrder(row)}>
      <span><strong>{row.storeName || row.storeId}</strong>{!row.readAt && <Tag color="blue">未读</Tag>}</span>
      <span>订单 {row.orderNumber}</span><small>编号 {row.matchedPrefix} · {dateText(row.orderAt)}</small>
    </button>)}
    <Button type="link" onClick={() => { setOpen(false); navigate('/ozon/orders/quality'); }}>查看全部质检单</Button>
  </div>;
  return <Popover content={content} trigger="click" open={open} onOpenChange={value => { setOpen(value); if (value) void reminders.refresh(); }} placement="bottomRight" overlayClassName="prototype-overlay quality-reminder-overlay">
    <button className="qh-header-action quality-reminder-trigger" type="button" aria-label={`质检提醒，${summary ? `${summary.unreadCount} 条未读` : '正在读取'}`} title="当前账号全部店铺的质检提醒">
      <span><Badge count={summary?.unreadCount || 0} overflowCount={99}><BellOutlined /></Badge></span>
      <div><strong>质检提醒</strong><em>{error ? '读取失败' : '全部店铺'}</em></div>
    </button>
  </Popover>;
}

function InspectionSettings({ request, onClose, onSaved }) {
  const [form] = Form.useForm();
  const [settings, setSettings] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lifetime = useRef(null), saving = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    request('/ozon/order-inspection/settings', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setSettings(value); form.setFieldsValue({ prefixes: value.prefixes }); }
    }).catch(caught => { if (!controller.signal.aborted) setError(caught.message); });
    return () => controller.abort();
  }, [request, form]);
  async function save() {
    if (saving.current || !settings || lifetime.current?.signal.aborted) return;
    let prefixes;
    try { prefixes = inspectionPrefixes((await form.validateFields()).prefixes || []); }
    catch (caught) { if (!caught.errorFields) setError(caught.message); return; }
    saving.current = true; setBusy(true); setError('');
    const signal = lifetime.current.signal;
    try {
      await request('/ozon/order-inspection/settings', { method: 'PUT', body: { prefixes }, signal });
      if (!signal.aborted) onSaved();
    } catch (caught) { if (!signal.aborted) setError(caught.message); }
    finally { saving.current = false; if (!signal.aborted) setBusy(false); }
  }
  return <Modal open rootClassName="prototype-overlay" title="质检编号设置" onCancel={onClose} onOk={save} okText="保存规则" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !settings }}>
    <div className="quality-settings-body">
      <Alert type="info" showIcon message="按自定义编号规则识别" description="匹配订单号开头 5 位数字，保留开头的 0。规则适用于你的全部店铺；删除全部编号后不再匹配，已有已读记录保留。" />
      {error && <Alert type="error" showIcon message={error} />}
      {!settings ? !error && <Spin /> : <Form form={form} layout="vertical" disabled={busy}>
        <Form.List name="prefixes">{(fields, { add, remove }) => <>
          {fields.map(field => <div className="quality-prefix-row" key={field.key}>
            <Form.Item name={field.name} rules={[{ required: true, pattern: /^\d{5}$/, message: '请输入 5 位数字，保留开头的 0' }]}>
              <Input aria-label={`质检编号 ${field.name + 1}`} inputMode="numeric" maxLength={5} placeholder="例如 02131" />
            </Form.Item>
            <Button type="text" icon={<MinusCircleOutlined />} aria-label={`删除质检编号 ${field.name + 1}`} onClick={() => remove(field.name)} />
          </div>)}
          <Button type="dashed" icon={<PlusOutlined />} onClick={() => add('')}>添加编号</Button>
          {!fields.length && <p>当前规则为空，保存后不会自动恢复默认编号。</p>}
        </>}</Form.List>
      </Form>}
    </div>
  </Modal>;
}

export default function QualityInspectionPage({ account, locationSearch = '', reminders, request = apiRequest }) {
  const initial = new URLSearchParams(locationSearch);
  const [search, setSearch] = useState(initial.get('q') || ''), [q, setQ] = useState(initial.get('q') || '');
  const [storeId, setStoreId] = useState(initial.get('storeId') || ''), [readStatus, setReadStatus] = useState(initial.get('unread') === '1' ? 'unread' : 'all');
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(5), [nonce, setNonce] = useState(0);
  const [result, setResult] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false), [detail, setDetail] = useState(null), [syncBusy, setSyncBusy] = useState(false);
  const lifetime = useRef(null), syncing = useRef(false);
  const query = new URLSearchParams({ q, readStatus, storeId, page: String(page), pageSize: String(pageSize) }).toString();
  const data = result?.query === query ? result.data : null;
  useEffect(() => {
    const next = new URLSearchParams(locationSearch);
    setSearch(next.get('q') || ''); setQ(next.get('q') || ''); setStoreId(next.get('storeId') || ''); setReadStatus(next.get('unread') === '1' ? 'unread' : 'all'); setPage(1); setDetail(null);
  }, [locationSearch]);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    request(`/ozon/order-inspection/overview?${query}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setResult({ query, data: value });
      if (page > 1 && !value.items.length) setPage(1);
    }).catch(caught => { if (!controller.signal.aborted) setError(caught.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [account?.id, request, query, nonce, reminders.summary]);
  const stores = data?.stores || [];
  const unreadRows = (data?.items || []).filter(row => !row.readAt);
  const refresh = () => { setNonce(value => value + 1); void reminders.refresh(); };
  async function sync() {
    if (syncing.current || lifetime.current?.signal.aborted) return;
    syncing.current = true; setSyncBusy(true); setError('');
    const signal = lifetime.current.signal;
    try { await request('/ozon/order-inspection/sync', { method: 'POST', body: {}, signal }); if (!signal.aborted) refresh(); }
    catch (caught) { if (!signal.aborted) setError(caught.message); }
    finally { syncing.current = false; if (!signal.aborted) setSyncBusy(false); }
  }
  const columns = [
    { title: '订单编号', width: 205, render: (_, row) => <div className="quality-order-identity"><strong>{row.orderNumber}</strong><Tag color="purple">质检单 · {row.matchedPrefix}</Tag>{!row.readAt && <Tag color="blue">未读</Tag>}</div> },
    { title: '店铺', dataIndex: 'storeName', width: 135, render: (name, row) => name || row.storeId },
    { title: '商品', width: 285, render: (_, row) => <div className="quality-order-products">{row.postings.flatMap(posting => posting.products).slice(0, 2).map((product, index) => <ProductIdentity key={`${product.sku}:${index}`} product={product} />)}</div> },
    { title: '包裹 / 履约状态', width: 230, render: (_, row) => <div className="quality-order-postings">{row.postings.map(posting => <div key={JSON.stringify([posting.scheme, posting.postingNumber])}>
      <Button type="link" onClick={() => setDetail({ ...posting, storeId: row.storeId })} aria-label={`查看包裹 ${posting.postingNumber}`}>{posting.postingNumber}</Button>
      <span>{posting.scheme} · {statusNames[posting.statusGroup] || posting.status || '未提供'}</span>
    </div>)}</div> },
    { title: '订单时间 · 北京', width: 170, render: (_, row) => dateText(row.orderAt) },
    { title: '提醒', width: 110, fixed: 'right', render: (_, row) => row.readAt ? <span>已读</span> : <Button type="link" disabled={loading || reminders.reading} onClick={() => reminders.markRead([row])}>标为已读</Button> },
  ];
  return <div className="source-page quality-inspection-page">
    <SourceSectionTitle title="质检单" subtitle="按自定义编号规则识别 · 当前账号全部店铺" actions={[
      <Button key="settings" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>编号设置</Button>,
      <Button key="refresh" icon={<ReloadOutlined />} onClick={refresh} loading={loading}>刷新</Button>,
      <Button key="sync" type="primary" icon={<SyncOutlined />} onClick={sync} loading={syncBusy} disabled={!stores.length}>同步全店订单</Button>,
    ]} />
    {(error || reminders.error) && <Alert type="error" showIcon message={error || reminders.error} />}
    <div className="quality-summary"><Card><span>全店未读提醒</span><strong>{reminders.summary?.unreadCount ?? data?.unreadCount ?? '—'}</strong></Card>
      <Card><span>当前筛选质检单</span><strong>{data?.total ?? '—'}</strong></Card>
      <Card><span>店铺同步覆盖</span><strong>{stores.length ? `${stores.filter(store => store.status === 'COMPLETED').length} / ${stores.length}` : loading ? '—' : '未绑定店铺'}</strong><small>本轮完成 / 全部店铺</small></Card></div>
    <Alert type={stores.some(store => store.status === 'FAILED') ? 'warning' : 'info'} showIcon message={stores.some(store => store.status === 'FAILED') ? '部分店铺同步未完成，请查看店铺覆盖情况' : '自动检查全部店铺订单'} description="首次同步从各店铺绑定前 15 天开始，后台持续检查新增订单；数据库已有的更早订单同样参与识别，包含全部履约状态。" />
    {!!stores.length && <Collapse items={[{ key: 'coverage', label: '店铺覆盖情况', children: <div className="quality-coverage">{stores.map(store => <div key={store.storeId}>
      <strong>{store.storeName || store.storeId} · {syncNames[store.status] || '尚未同步'}</strong>
      <span>已覆盖：{dateText(store.since)} 至 {dateText(store.to)}</span><span>本轮目标：{dateText(store.targetTo)} · 最近同步：{dateText(store.lastSyncedAt)}</span>
      {store.lastError && <span className="quality-coverage-error">{store.lastError}</span>}
    </div>)}</div> }]} />}
    <Card><div className="quality-filters"><Space wrap>
      <Select aria-label="质检店铺" value={storeId} style={{ minWidth: 160 }} options={[{ value: '', label: '全部店铺' }, ...stores.map(store => ({ value: store.storeId, label: store.storeName || store.storeId }))]} onChange={value => { setStoreId(value); setPage(1); }} />
      <Select aria-label="质检已读状态" value={readStatus} options={[{ value: 'all', label: '全部提醒' }, { value: 'unread', label: '未读' }, { value: 'read', label: '已读' }]} onChange={value => { setReadStatus(value); setPage(1); }} />
      <Button disabled={loading || reminders.reading || !unreadRows.length} onClick={() => reminders.markRead(unreadRows)}>本页标为已读</Button>
    </Space><Input.Search aria-label="搜索质检订单" placeholder="订单号 / 包裹号 / 店铺" allowClear value={search} onChange={event => { setSearch(event.target.value); if (!event.target.value) { setQ(''); setPage(1); } }} onSearch={value => { setQ(value.trim()); setPage(1); }} /></div>
      <Table rowKey={inspectionOrderKey} dataSource={data?.items || []} columns={columns} loading={loading} scroll={{ x: 1135 }} pagination={{ current: page, pageSize, total: data?.total || 0, onChange: (next, size) => { setPage(size === pageSize ? next : 1); setPageSize(size); }, showTotal: total => `共 ${total} 个订单` }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={stores.length ? '暂无符合条件的质检单' : '尚未绑定店铺，可以先设置质检编号'} /> }} />
    </Card>
    {settingsOpen && <InspectionSettings request={request} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); refresh(); }} />}
    {detail && <OrderDetail key={JSON.stringify([account?.id, detail.storeId, detail.scheme, detail.postingNumber])} identity={detail} storeId={detail.storeId} request={request} onClose={() => setDetail(null)} />}
  </div>;
}
