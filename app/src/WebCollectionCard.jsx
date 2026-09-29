import React, { useRef, useState } from 'react';
import { App, Button, Card, Input, Radio } from 'antd';
import { InboxOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { apiRequest } from './client-transport.js';
import { collectAddReadiness } from './collect-box-target-store.js';
import { webCollectionIntent } from './web-collection-jobs.js';

export default function WebCollectionCard({ onRefresh, navigate }) {
  const { message } = App.useApp();
  const [input, setInput] = useState('');
  const [scope, setScope] = useState('ALL');
  const [submitting, setSubmitting] = useState(false);
  const intent = useRef(null);
  const sending = useRef(false);
  const submit = async () => {
    if (sending.current) return;
    const ready = collectAddReadiness({ value: input, token: localStorage.getItem('token') });
    if (!ready.ok) { message.warning(ready.message); return; }
    sending.current = true;
    setSubmitting(true);
    intent.current = webCollectionIntent(intent.current, { sku: ready.sku, scope });
    try {
      await apiRequest('/ozon/collect-box/web-jobs', { method: 'POST', body: intent.current, timeoutMs: 15000 });
      setInput('');
      intent.current = null;
      await Promise.resolve(onRefresh?.()).catch(() => message.warning("任务已保存，列表刷新失败，请点击下方刷新"));
      message.success('采集任务已保存，等待已登录的扩展领取');
    } catch (failure) { message.error(`提交失败：${failure.message}。可以重试，相同请求不会重复创建任务`); }
    finally { sending.current = false; setSubmitting(false); }
  };
  return <Card className="collect-add-card web-collection-card">
    <div className="collect-add-head">
      <div className="collect-title-icon"><InboxOutlined /></div>
      <div className="collect-title-copy"><div className="collect-title-row">添加采集商品</div>
        <span className="collect-subtitle">粘贴 Ozon 商品链接或 SKU，由浏览器扩展采集并回传</span></div>
    </div>
    <div className="collect-input-row">
      <div className="collect-input-wrap"><Input size="large" prefix={<LinkOutlined />} value={input}
        disabled={submitting} onChange={event => setInput(event.target.value)}
        placeholder="https://www.ozon.ru/product/... 或直接输入 SKU" onPressEnter={submit} aria-label="Ozon 商品链接或 SKU" /></div>
      <Button type="primary" size="large" icon={<PlusOutlined />} loading={submitting} onClick={submit}>添加采集</Button>
    </div>
    <div className="web-collection-options">
      <Radio.Group value={scope} onChange={event => setScope(event.target.value)} disabled={submitting} aria-label="采集范围">
        <Radio value="ALL">整组变体</Radio><Radio value="CURRENT">仅当前 SKU</Radio>
      </Radio.Group>
      <Button type="link" onClick={() => navigate('/ozon/downloads/')}>下载浏览器扩展</Button>
    </div>
    <p className="web-collection-help">请保持电脑和浏览器运行，并在最新版扩展中登录当前粽子账号。整组变体会采集各 SKU 的图片、价格和属性；登录或验证提示需要你在商品页处理。</p>
  </Card>;
}
