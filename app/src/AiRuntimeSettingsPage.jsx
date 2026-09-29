import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, InputNumber, Space, Spin, Switch, Tag } from "antd";
import { apiRequest } from "./client-transport.js";
import "./ai-runtime-settings.css";

const POLL_INTERVAL_MS = 5_000;

const settingFields = [
  {
    key: "productConcurrency",
    label: "商品任务并发",
    min: 1,
    max: 20,
    description: "全站同时领取的独立商品任务数量。多变体商品仍按一个任务成组处理，任务内 SKU 保持顺序。",
  },
  {
    key: "requestConcurrency",
    label: "付费请求并发",
    min: 1,
    max: 20,
    description: "限制所有用户合计的实际 AI 请求，通道能力测试也计入；结果待确认的请求仍可能占用名额。",
  },
  {
    key: "localConcurrency",
    label: "本地处理并发",
    min: 1,
    max: 2,
    description: "限制 OCR、拼图和切片等本机 CPU 工作。当前只支持 1 或 2，远端 AI 等待不占此名额。",
  },
  {
    key: "billingConcurrency",
    label: "同计费账号并发",
    min: 1,
    max: 20,
    description: "相同 API 地址和网关计费账号共享此上限。提高数值只允许更多任务同时处理，不代表网关一定能同时处理相同数量的请求。",
  },
];

const hasValue = (value) => value !== null && value !== undefined;
const metric = (value, suffix = "") => hasValue(value) ? `${value}${suffix}` : "未取得";

function formatBytes(value) {
  if (!hasValue(value)) return "未取得";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未取得";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function formatDate(value) {
  if (!value) return "未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未取得" : date.toLocaleString();
}

function WorkerState({ snapshot, statusUnknown, now }) {
  const worker = snapshot?.worker || {};
  const seenAt = Date.parse(worker.seenAt || "");
  const current = statusUnknown !== true
    && worker.online === true
    && Number.isFinite(seenAt)
    && now - seenAt <= 20_000;
  const applied = current && hasValue(worker.appliedRevision);
  const caughtUp = applied && worker.appliedRevision === snapshot.revision;
  const resources = current ? worker.resources : null;
  const local = current ? worker.local : null;
  const memoryScope = resources?.memoryScope === "container"
    ? "当前后台容器"
    : resources?.memoryScope === "host" ? "当前后台主机" : "未取得";

  return <>
    <Card className="runtime-settings-card runtime-worker-card" title="后台应用状态">
      <div className="runtime-status-line">
        <div>
          <span className="runtime-status-label">运行状态</span>
          <strong>{current ? "后台在线" : "后台离线或状态已过期"}</strong>
        </div>
        <Tag color={!current ? "default" : caughtUp ? "success" : "processing"}>
          {!current ? "状态不可用" : caughtUp ? "后台已应用" : "等待后台应用"}
        </Tag>
      </div>
      <div className="runtime-revision-row">
        <span>保存版本 {metric(snapshot?.revision)}</span>
        <span>后台应用版本 {applied ? worker.appliedRevision : "未取得"}</span>
        <span>最近心跳 {current ? formatDate(worker.seenAt) : "未取得"}</span>
      </div>
      {!current ? <Alert
        type="warning"
        showIcon
        title="后台状态未取得"
        description="离线或过期的心跳不能代表当前占用；页面不会把旧计数显示成实时状态。"
      /> : <div className="runtime-metric-grid">
        <div><span>有效商品并发</span>{" "}<strong>{metric(worker.effectiveProductConcurrency)}</strong></div>
        <div><span>商品占用</span><strong>{metric(worker.activeProducts)}</strong></div>
        <div><span>AI 请求占用</span><strong>{metric(worker.activeRequests)}</strong></div>
        <div><span>本地处理占用</span><strong>{metric(local?.active)}</strong></div>
        <div><span>本地等待</span><strong>{metric(local?.pending)}</strong></div>
        <div><span>本地有效并发</span><strong>{metric(local?.concurrency)}</strong></div>
      </div>}
      {current ? <p className="runtime-worker-note">
        自动调节当前{worker.adaptiveEnabled === true ? "开启" : worker.adaptiveEnabled === false ? "关闭" : "状态未取得"}。
        下调不会取消正在处理的商品、请求或本地工作，后台会等占用下降后再领取新任务。
      </p> : null}
    </Card>

    <Card className="runtime-settings-card" title="资源采样与范围">
      <div className="runtime-resource-grid">
        <div><span>采样范围</span><strong>{current ? memoryScope : "未取得"}</strong></div>
        <div><span>内存已用</span><strong>{current ? formatBytes(resources?.memoryUsedBytes) : "未取得"}</strong></div>
        <div><span>内存限额</span><strong>{current ? formatBytes(resources?.memoryLimitBytes) : "未取得"}</strong></div>
        <div><span>CPU 核数</span><strong>{current ? metric(resources?.cpuCores) : "未取得"}</strong></div>
        <div><span>CPU 负载参考</span><strong>{current && hasValue(resources?.cpuRatio) ? `${(resources.cpuRatio * 100).toFixed(0)}%` : "未取得"}</strong></div>
        <div><span>事件循环延迟</span><strong>{current ? metric(resources?.eventLoopDelayMs, " ms") : "未取得"}</strong></div>
      </div>
      <Alert
        className="runtime-capacity-note"
        type="info"
        showIcon
        title="内存限额是只读信息"
        description="主机扩容和容器内存限额需要在部署环境调整。提高页面中的并发只会允许更多任务同时处理，不等于已经证明当前资源能够稳定承载该并发。"
      />
    </Card>
  </>;
}

export default function AiRuntimeSettingsPage({ account, request = apiRequest }) {
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState(null);
  const [editRevision, setEditRevision] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pollError, setPollError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [statusUnknown, setStatusUnknown] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mountedRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const readingRef = useRef(false);
  const requestSequenceRef = useRef(0);

  const applySnapshot = useCallback((result, { replaceDraft = false } = {}) => {
    setSnapshot(result);
    if (replaceDraft || !dirtyRef.current) {
      setDraft(result.settings);
      setEditRevision(result.revision);
      dirtyRef.current = false;
      setDirty(false);
    }
  }, []);

  const load = useCallback(async ({ poll = false, replaceDraft = false } = {}) => {
    if (account?.role !== "admin") return;
    if (savingRef.current) return;
    if (readingRef.current) return;
    readingRef.current = true;
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    if (!poll) setRefreshing(true);
    try {
      const result = await request("/admin/ai-runtime-settings");
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      applySnapshot(result, { replaceDraft });
      setNow(Date.now());
      setStatusUnknown(false);
      setLoadError("");
      setPollError("");
      if (replaceDraft) {
        setSaveError("");
        setConflict(false);
      }
    } catch (error) {
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      setStatusUnknown(true);
      if (poll) setPollError("运行状态刷新失败，未保存草稿仍保留。");
      else setLoadError(error?.message || "AI 并发设置读取失败");
    } finally {
      readingRef.current = false;
      if (mountedRef.current && !poll) setRefreshing(false);
      if (mountedRef.current && sequence === requestSequenceRef.current) {
        setLoading(false);
      }
    }
  }, [account?.role, applySnapshot, request]);

  useEffect(() => {
    mountedRef.current = true;
    if (account?.role !== "admin") {
      setLoading(false);
      return () => { mountedRef.current = false; };
    }
    void load({ replaceDraft: true });
    const timer = window.setInterval(() => {
      if (!savingRef.current) void load({ poll: true });
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [account?.id, account?.role, load]);

  useEffect(() => {
    const seenAt = Date.parse(snapshot?.worker?.seenAt || "");
    if (snapshot?.worker?.online !== true || !Number.isFinite(seenAt)) return undefined;
    const delay = Math.max(0, Math.min(20_050, seenAt + 20_050 - Date.now()));
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [snapshot?.worker?.online, snapshot?.worker?.seenAt]);

  const changeSetting = (key, value) => {
    dirtyRef.current = true;
    setDirty(true);
    setSaveError("");
    setConflict(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const draftValid = useMemo(() => Boolean(draft) && settingFields.every((field) => (
    Number.isInteger(draft[field.key])
      && draft[field.key] >= field.min
      && draft[field.key] <= field.max
  )) && typeof draft.adaptiveEnabled === "boolean", [draft]);

  const save = async () => {
    if (!draftValid || savingRef.current) return;
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    setConflict(false);
    try {
      const result = await request("/admin/ai-runtime-settings", {
        method: "PUT",
        body: { revision: editRevision, settings: draft },
      });
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      applySnapshot(result, { replaceDraft: true });
      setNow(Date.now());
      setStatusUnknown(false);
      setPollError("");
    } catch (error) {
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      if (error?.status === 409) {
        setConflict(true);
        setSaveError("配置已被其他管理员更新，请重新载入后再保存。");
      } else {
        setSaveError(error?.message || "保存失败，请重试");
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current && sequence === requestSequenceRef.current) setSaving(false);
    }
  };

  if (account?.role !== "admin") {
    return <div className="source-page runtime-settings-page">
      <Alert type="error" showIcon title="仅管理员可查看和修改 AI 并发设置" />
    </div>;
  }

  return <div className="source-page runtime-settings-page">
    <div className="ai-listing-page-head">
      <div>
        <span className="workspace-eyebrow">OZON SELLER WORKSPACE</span>
        <h1>AI 并发设置</h1>
        <p>调整当前实例中所有用户共用的 AI 任务、付费请求与本地处理上限，无需重启后台。</p>
      </div>
      <Button disabled={saving} loading={refreshing} onClick={() => void load()}>刷新运行状态</Button>
    </div>

    {loadError ? <Alert
      type="error"
      showIcon
      title="设置读取失败"
      description={loadError}
      action={<Button onClick={() => void load({ replaceDraft: true })}>重试</Button>}
    /> : null}
    {pollError ? <Alert type="warning" showIcon title={pollError} /> : null}
    {saveError ? <Alert
      type="error"
      showIcon
      title={saveError}
      action={conflict ? <Button onClick={() => void load({ replaceDraft: true })}>重新载入已保存配置</Button> : null}
    /> : null}

    {loading && !draft ? <div className="runtime-loading" role="status"><Spin /> 正在读取 AI 并发设置…</div> : null}
    {draft ? <div className="runtime-settings-layout">
      <Card
        className="runtime-settings-card runtime-editor-card"
        title="全站并发上限"
        extra={<Tag color={dirty ? "warning" : "default"}>{dirty ? "有未保存修改" : "已与保存值一致"}</Tag>}
      >
        <div className="runtime-setting-fields">
          {settingFields.map((field) => <label className="runtime-setting-field" key={field.key}>
            <span className="runtime-setting-label">{field.label}</span>
            <InputNumber
              aria-label={field.label}
              min={field.min}
              max={field.max}
              precision={0}
              disabled={saving}
              value={draft[field.key]}
              onChange={(value) => changeSetting(field.key, value)}
            />
            <small>{field.description}</small>
            <em>可设置范围：{field.min}–{field.max}</em>
          </label>)}
        </div>
        <div className="runtime-adaptive-row">
          <div>
            <strong>自动调节</strong>
            <p>开启后，后台可在已保存上限内根据压力暂时降低同时处理数量，并在健康后逐步恢复；关闭后按保存上限工作。</p>
            <small>首次保存前沿用当前平台或环境默认：macOS 默认关闭，Linux 默认开启，也可能由既有部署配置覆盖。当前开关按后台返回值原样显示。</small>
          </div>
          <Switch
            aria-label="自动调节"
            checked={draft.adaptiveEnabled}
            disabled={saving}
            onChange={(checked) => changeSetting("adaptiveEnabled", checked)}
          />
        </div>
        <div className="runtime-save-row">
          <div>
            <span>{snapshot?.source === "saved" ? "当前来源：已保存配置" : "当前来源：平台或环境默认"}</span>
            <small>最近保存：{formatDate(snapshot?.updatedAt)}</small>
          </div>
          <Space>
            <Button disabled={!dirty || saving} onClick={() => void load({ replaceDraft: true })}>放弃修改并重新载入</Button>
            <Button type="primary" loading={saving} disabled={!draftValid || !dirty} onClick={save}>保存设置</Button>
          </Space>
        </div>
      </Card>

      {snapshot ? <WorkerState snapshot={snapshot} statusUnknown={statusUnknown} now={now} /> : null}
    </div> : null}
  </div>;
}
