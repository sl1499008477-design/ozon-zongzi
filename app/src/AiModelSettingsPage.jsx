import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import {
  ApiOutlined,
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  ExportOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  createAiSettingsIntentStore,
  createLatestAiSettingsLoader,
  createGatewayConnection,
  createModelProfile,
  loadAiSettings,
  loadAiSettingsCatalog,
  publishModelProfile,
  requestModelSync,
  rollbackModelProfile,
  testModelProfile,
} from "./auto-listing-ai-settings-client.js";
import { aiSettingsModelOptions, aiSettingsPresentation } from "./auto-listing-ai-settings-view.js";
import "./auto-listing-ai-settings.css";

const DEFAULT_CONNECTION = Object.freeze({
  displayName: "本地 sub2API",
  baseUrl: "http://127.0.0.1:8080/v1",
});

const CONNECTION_STATUS = Object.freeze({
  PENDING: ["待验证", "processing"],
  VALIDATED: ["连接正常", "success"],
  ACTIVE: ["已启用", "success"],
  RETIRED: ["历史版本", "default"],
});

const SYNC_STATUS = Object.freeze({
  PENDING: ["等待同步", "processing"],
  LEASED: ["同步中", "processing"],
  SUCCEEDED: ["同步成功", "success"],
  FAILED: ["同步失败，可重试", "warning"],
  DEAD: ["同步失败", "error"],
});

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function settingsIdentity(overview) {
  if (!overview?.accountId) return "";
  return [
    overview.accountId,
    overview.activeConnection?.id || "",
    overview.activeConnection?.statusVersion || 0,
    overview.activeProfile?.id || "",
    overview.activeProfile?.configVersion || 0,
    ...(overview.connections || []).flatMap((row) => [row.id, row.version, row.statusVersion, row.status]),
    ...(overview.catalogs || []).flatMap((row) => [row.id, row.createdAt]),
    ...(overview.syncTasks || []).flatMap((row) => [row.id, row.statusVersion, row.status]),
    ...(overview.profiles || []).flatMap((row) => [row.id, row.configVersion, row.enabled,
      row.capabilityCheckedAt || "", row.activation?.kind || "", row.activation?.occurredAt || "",
      row.activation?.actorId || ""]),
    overview.pagination?.connections?.nextCursor || "",
    overview.pagination?.profiles?.nextCursor || "",
  ].join("|");
}

function dashboardUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || !url.host) return "";
    return `${url.protocol}//${url.host}/`;
  } catch {
    return "";
  }
}

function latestCatalogFor(overview, connection) {
  if (!connection) return null;
  const successfulTaskIds = new Set((overview?.syncTasks || [])
    .filter((task) => task.connectionId === connection.id
      && task.connectionVersion === connection.version
      && task.syncPurpose === "CATALOG_SYNC" && task.status === "SUCCEEDED")
    .map((task) => task.id));
  return [...(overview?.catalogs || [])]
    .filter((row) => row.connectionId === connection.id && row.connectionVersion === connection.version
      && successfulTaskIds.has(row.syncTaskId))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] || null;
}

function latestSyncFor(overview, connection) {
  if (!connection) return null;
  return [...(overview?.syncTasks || [])]
    .filter((row) => row.connectionId === connection.id && row.connectionVersion === connection.version
      && row.syncPurpose === "CATALOG_SYNC")
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] || null;
}

function latestSuccessfulSyncFor(overview, connection) {
  if (!connection) return null;
  return [...(overview?.syncTasks || [])]
    .filter((task) => task.connectionId === connection.id
      && task.connectionVersion === connection.version && task.syncPurpose === "CATALOG_SYNC"
      && task.status === "SUCCEEDED")
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))[0] || null;
}

function withActive(items, active) {
  const rows = Array.isArray(items) ? items : [];
  return active && !rows.some((row) => row.id === active.id) ? [active, ...rows] : rows;
}

function capabilityItems(profile) {
  const result = profile?.capabilityResult || {};
  const features = new Set(Array.isArray(result.features) ? result.features : []);
  const status = (feature) => result.outcome === "FAILED" ? "失败" : features.has(feature) ? "通过" : "待验证";
  return [
    ["文字结构化输出", status("STRUCTURED_TEXT")],
    ["图片生成", status("IMAGE_GENERATION")],
    ["图片可解码", result.outcome === "FAILED" ? "失败"
      : [...features].some((value) => value.startsWith("IMAGE_DECODE_")) ? "通过" : "待验证"],
  ];
}

function actionError(error, fallback) {
  if (["REQUEST_TIMEOUT", "AI_SETTINGS_CLIENT_POLL_TIMEOUT"].includes(error?.code)) {
    return "请求仍可能在后台处理中，请刷新后查看最新状态";
  }
  return error?.message || fallback;
}

function accountScopedSessionStorage(accountId) {
  const storage = globalThis.sessionStorage;
  const prefix = `ozon-ai-settings-account:${encodeURIComponent(accountId)}:`;
  return Object.freeze({
    getItem: (key) => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
    removeItem: (key) => storage.removeItem(`${prefix}${key}`),
  });
}

function withSignal(intent, signal) {
  return Object.freeze({ ...intent, signal });
}

function GatewayConnectionSection({
  activeRequest, baseUrl, busy, canCreateConnection, displayName, gatewayKey,
  onBaseUrlChange, onDisplayNameChange, onGatewayKeyChange, onOpenDashboard,
  onSaveAndTest, selectedConnection,
}) {
  const connectionStatus = CONNECTION_STATUS[selectedConnection?.status] || ["未配置", "default"];
  return <Card title={<Space><ApiOutlined />sub2API 连接</Space>}>
    <div className="ai-model-settings-fields">
      <label>连接名称<Input value={displayName} disabled={busy} onChange={(event) => onDisplayNameChange(event.target.value)} /></label>
      <label>网关地址<Input value={baseUrl} disabled={busy} placeholder="http://127.0.0.1:8080/v1" onChange={(event) => onBaseUrlChange(event.target.value)} /></label>
      <label>新的网关 Key
        <Input type="password" autoComplete="new-password" value={gatewayKey} disabled={busy}
          placeholder={selectedConnection ? "已配置；更换时请输入新的 Key" : "只用于本次保存，之后不可回看"}
          onChange={(event) => onGatewayKeyChange(event.target.value)} />
      </label>
    </div>
    <Descriptions size="small" column={1} className="ai-model-settings-summary" items={[
      { key: "status", label: "运行状态", children: <Tag color={connectionStatus[1]}>{connectionStatus[0]}</Tag> },
      { key: "key", label: "网关 Key", children: selectedConnection ? `已配置 · ${selectedConnection.fingerprint || "安全保存"}` : "未配置" },
      { key: "version", label: "连接版本", children: selectedConnection ? `v${selectedConnection.version}` : "—" },
      { key: "checked", label: "最近连接检查", children: formatTime(selectedConnection?.validatedAt) },
    ]} />
    <Space wrap>
      <Button type="primary" icon={<SafetyCertificateOutlined />} disabled={busy || !canCreateConnection}
        loading={activeRequest === "测试连接"} onClick={onSaveAndTest}>测试连接</Button>
      <Button icon={<ExportOutlined />} disabled={busy || !dashboardUrl(baseUrl || selectedConnection?.baseUrl)}
        onClick={onOpenDashboard}>打开 sub2API 后台</Button>
    </Space>
    <p className="ai-model-settings-hint">完整 Key 只会提交给 ozon 粽子后端加密保存，页面和读取接口都不会再次回显。</p>
  </Card>;
}

function ModelSelectionSection({
  activeRequest, busy, catalogError, catalogLoading, connectionView, currentCatalog,
  imageModel, imageOptions,
  latestSuccessfulSync, latestSync, onConnectionChange, onImageModelChange,
  onConnectionPageNext, onConnectionPagePrevious, onProfileNameChange, onSaveSelection,
  onSync, onTextModelChange, overview, canSaveSelection, canShowPreviousConnectionPage,
  profileName, selectedConnectionId, selectionPresentation, textModel, textOptions,
}) {
  const syncStatus = SYNC_STATUS[latestSync?.status] || ["尚未同步", "default"];
  return <Card title={<Space><CloudSyncOutlined />模型同步与选择</Space>}>
    <div className="ai-model-settings-fields">
      <label>连接版本<Select value={selectedConnectionId || undefined} disabled={busy} placeholder="请选择连接"
        onChange={onConnectionChange} options={(overview?.connections || []).map((row) => ({
          value: row.id,
          label: `${row.displayName} · v${row.version} · ${CONNECTION_STATUS[row.status]?.[0] || row.status}`,
        }))} /></label>
    </div>
    <Space wrap className="ai-model-settings-pagination">
      <Button size="small" disabled={busy || !canShowPreviousConnectionPage}
        onClick={onConnectionPagePrevious}>上一页连接</Button>
      <Button size="small" disabled={busy || !overview?.pagination?.connections?.hasMore}
        onClick={onConnectionPageNext}>下一页连接</Button>
      <span>每页最多 {overview?.pagination?.connections?.pageSize || 10} 个连接</span>
    </Space>
    <Descriptions size="small" column={1} className="ai-model-settings-summary" items={[
      { key: "sync", label: "同步状态", children: <Tag color={syncStatus[1]}>{syncStatus[0]}</Tag> },
      { key: "time", label: "最近成功同步", children: formatTime(latestSuccessfulSync?.completedAt) },
      { key: "error", label: "同步说明", children: latestSync?.lastErrorSafe || latestSync?.lastErrorCode || "—" },
    ]} />
    <Button icon={<CloudSyncOutlined />} disabled={busy || !connectionView?.actions?.canSync}
      loading={activeRequest === "立即同步"} onClick={onSync}>立即同步</Button>
    {catalogLoading ? <Alert type="info" showIcon title="正在读取完整模型目录" /> : null}
    {catalogError ? <Alert type="error" showIcon title={catalogError} /> : null}
    {currentCatalog ? <p className="ai-model-settings-hint">
      当前目录共有 {currentCatalog.catalog.models.length} 个模型；推荐项排在前面，其他模型仍可搜索选择。
    </p> : null}
    {selectionPresentation.recommendations.warnings.length ? <Alert type="warning" showIcon
      title={selectionPresentation.recommendations.warnings.join("；")}
      description="系统推荐只依据模型目录元数据，发布前仍必须完成真实能力测试。" /> : null}
    <div className="ai-model-settings-fields ai-model-settings-fields--selection">
      <label>配置名称<Input value={profileName} disabled={busy} onChange={(event) => onProfileNameChange(event.target.value)} /></label>
      <label>文字模型<Select showSearch optionFilterProp="label" value={textModel || undefined}
        disabled={busy || catalogLoading || !textOptions.length}
        placeholder="同步后选择文字模型" onChange={onTextModelChange} options={textOptions.map((row) => ({
          value: row.value,
          label: `${row.recommended ? "系统推荐 · " : ""}${row.value}${row.reasons.length ? ` · 待验证 · ${row.reasons.join("、")}` : ""}`,
        }))} /></label>
      <label>图片模型<Select showSearch optionFilterProp="label" value={imageModel || undefined}
        disabled={busy || catalogLoading || !imageOptions.length}
        placeholder="同步后选择图片模型" onChange={onImageModelChange} options={imageOptions.map((row) => ({
          value: row.value,
          label: `${row.recommended ? "系统推荐 · " : ""}${row.value}${row.reasons.length ? ` · 待验证 · ${row.reasons.join("、")}` : ""}`,
        }))} /></label>
    </div>
    <Button type="primary" disabled={busy || !canSaveSelection}
      loading={activeRequest === "保存模型选择"} onClick={onSaveSelection}>保存模型选择</Button>
  </Card>;
}

function CapabilityPublishSection({
  activeRequest, busy, onCostConfirmationChange, onPublish, onProfileChange, onTest,
  overview, profileView, selectedProfile, selectedProfileId,
}) {
  const capability = selectedProfile?.capabilityResult || {};
  return <Card title={<Space><CheckCircleOutlined />能力测试与发布</Space>}>
    <Alert type="warning" showIcon title="能力测试可能产生费用"
      description="会真实调用一次文字模型和一张最低成本测试图。只有管理员明确确认后才执行；系统不会在后台同步时自动付费测试。" />
    <div className="ai-model-settings-fields">
      <label>待操作配置<Select value={selectedProfileId || undefined} disabled={busy} placeholder="请选择配置版本"
        onChange={onProfileChange} options={(overview?.profiles || []).map((row) => ({
          value: row.id,
          label: `${row.displayName} · v${row.configVersion}${row.enabled ? " · 当前正式版本" : ""}`,
        }))} /></label>
    </div>
    {selectedProfile ? <>
      <div className="ai-model-capability-grid">
        {capabilityItems(selectedProfile).map(([label, status]) => <div key={label} className={status === "通过" ? "is-passed" : ""}>
          <span>{label}</span><strong>{status}</strong>
        </div>)}
        <div><span>响应耗时</span><strong>{Number.isInteger(capability.latencyMs) ? `${capability.latencyMs} ms` : "—"}</strong></div>
      </div>
      {capability.errorCode ? <Alert type="error" showIcon title={`安全错误码：${capability.errorCode}`} /> : null}
      <p className="ai-model-settings-hint">测试时间：{formatTime(selectedProfile.capabilityCheckedAt)} · 当前状态：{profileView?.verificationLabel || "待刷新"}</p>
      <Checkbox checked={profileView?.paidTest.ready === true} disabled={busy}
        onChange={(event) => onCostConfirmationChange(event.target.checked)}>
        我已了解并确认本次真实能力测试可能产生少量费用
      </Checkbox>
      <Space wrap>
        <Button icon={<SafetyCertificateOutlined />} disabled={busy || !profileView?.actions?.canTest || !profileView?.paidTest.ready}
          loading={activeRequest === "能力测试"} onClick={onTest}>开始能力测试</Button>
        <Button type="primary" disabled={busy || !profileView?.actions?.canPublish}
          loading={activeRequest === "发布启用"} onClick={onPublish}>发布启用</Button>
      </Space>
    </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先保存模型选择" />}
  </Card>;
}

function ConfigurationHistorySection({
  activeRequest, busy, canShowPreviousProfilePage, onProfilePageNext,
  onProfilePagePrevious, onRollback, onRollbackConfirmationChange, overview,
  presentation, rollbackConfirmedProfileIds,
}) {
  const active = overview?.activeProfile || overview?.profiles?.find((row) => row.enabled) || null;
  const profilePresentation = (profileId) => presentation.profiles.find((item) => item.id === profileId);
  const activeActivation = active ? profilePresentation(active.id)?.activation : null;
  const columns = [
    { title: "版本", dataIndex: "configVersion", render: (value, row) => <Space><strong>v{value}</strong>{row.enabled ? <Tag color="success">当前正式版本</Tag> : null}</Space> },
    { title: "文字模型", dataIndex: "textModel", ellipsis: true },
    { title: "图片模型", dataIndex: "imageModel", ellipsis: true },
    { title: "验证状态", key: "capability", render: (_value, row) => profilePresentation(row.id)?.verificationLabel || "待刷新" },
    { title: "启用方式", key: "activation-kind", render: (_value, row) => profilePresentation(row.id)?.activation?.kindLabel || "—" },
    { title: "启用时间", key: "activation-time", render: (_value, row) => formatTime(profilePresentation(row.id)?.activation?.occurredAt) },
    { title: "操作管理员", key: "operator", render: (_value, row) => profilePresentation(row.id)?.activation?.actorId || "—" },
    { title: "操作", key: "action", render: (_value, row) => {
      const view = presentation.profiles.find((item) => item.id === row.id);
      if (!view?.actions?.canRollback) return "—";
      const confirmed = rollbackConfirmedProfileIds.includes(row.id);
      return <Space direction="vertical" size={4}>
        <Checkbox checked={confirmed} disabled={busy}
          onChange={(event) => onRollbackConfirmationChange(row.id, event.target.checked)}>
          确认重新验证，可能产生费用
        </Checkbox>
        <Button danger size="small" disabled={busy || !confirmed || !view.actions.canRollback}
          loading={activeRequest === "安全回退"} onClick={() => onRollback(row)}>安全回退</Button>
      </Space>;
    } },
  ];
  return <Card title="当前配置与历史版本">
    {active ? <Descriptions size="small" column={1} className="ai-model-settings-summary" items={[
      { key: "version", label: "当前正式版本", children: `v${active.configVersion}` },
      { key: "gateway", label: "网关地址", children: active.baseUrl },
      { key: "text", label: "文字模型", children: active.textModel },
      { key: "image", label: "图片模型", children: active.imageModel },
      { key: "kind", label: "启用方式", children: activeActivation?.kindLabel || "—" },
      { key: "time", label: "启用时间", children: formatTime(activeActivation?.occurredAt) },
      { key: "operator", label: "操作管理员", children: activeActivation?.actorId || "—" },
    ]} /> : <Alert type="info" showIcon title="尚未发布正式配置" description="请依次完成连接、同步、选择和真实能力测试。" />}
    <Table className="ai-model-settings-history" rowKey="id" size="small" pagination={false}
      scroll={{ x: 960 }} dataSource={overview?.profiles || []} columns={columns} locale={{ emptyText: "暂无历史版本" }} />
    <Space wrap className="ai-model-settings-pagination">
      <Button size="small" disabled={busy || !canShowPreviousProfilePage}
        onClick={onProfilePagePrevious}>上一页历史</Button>
      <Button size="small" disabled={busy || !overview?.pagination?.profiles?.hasMore}
        onClick={onProfilePageNext}>下一页历史</Button>
      <span>每页最多 {overview?.pagination?.profiles?.pageSize || 10} 个配置版本</span>
    </Space>
  </Card>;
}

export default function AiModelSettingsPage({ account = null, navigate = () => {} } = {}) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeRequest, setActiveRequest] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [displayName, setDisplayName] = useState(DEFAULT_CONNECTION.displayName);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CONNECTION.baseUrl);
  const [gatewayKey, setGatewayKey] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [profileName, setProfileName] = useState("自动上架 AI 模型");
  const [textModel, setTextModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [costConfirmedProfileIds, setCostConfirmedProfileIds] = useState([]);
  const [rollbackConfirmedProfileIds, setRollbackConfirmedProfileIds] = useState([]);
  const [catalogDetail, setCatalogDetail] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [connectionCursor, setConnectionCursor] = useState(null);
  const [profileCursor, setProfileCursor] = useState(null);
  const [connectionCursorStack, setConnectionCursorStack] = useState([]);
  const [profileCursorStack, setProfileCursorStack] = useState([]);
  const hydratedSettingsVersionRef = useRef("");
  const requestVersionRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const paginationInFlightRef = useRef(false);
  const activeActionControllerRef = useRef(null);
  const catalogControllerRef = useRef(null);
  const catalogLoaderRef = useRef(null);
  if (catalogLoaderRef.current === null) {
    catalogLoaderRef.current = createLatestAiSettingsLoader((catalogId, options) => (
      loadAiSettingsCatalog(catalogId, options)
    ));
  }
  const accountId = String(account?.id || "").trim();
  const intentStore = useMemo(() => createAiSettingsIntentStore(
    accountScopedSessionStorage(accountId),
  ), [accountId]);
  const busy = Boolean(activeRequest);

  const refreshOverview = useCallback(async ({
    silent = false,
    connectionCursor: nextConnectionCursor = connectionCursor,
    profileCursor: nextProfileCursor = profileCursor,
  } = {}) => {
    const requestVersion = ++requestVersionRef.current;
    if (!silent) setLoading(true);
    try {
      const result = await loadAiSettings({
        connectionCursor: nextConnectionCursor,
        profileCursor: nextProfileCursor,
      });
      if (requestVersion !== requestVersionRef.current) return null;
      setOverview(result);
      return result;
    } catch (caught) {
      if (requestVersion === requestVersionRef.current) {
        setError(actionError(caught, "AI 模型配置读取失败"));
      }
      return null;
    } finally {
      if (!silent && requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [connectionCursor, profileCursor]);

  useEffect(() => {
    activeActionControllerRef.current?.abort();
    activeActionControllerRef.current = null;
    catalogControllerRef.current?.abort();
    catalogControllerRef.current = null;
    catalogLoaderRef.current.invalidate();
    actionInFlightRef.current = false;
    paginationInFlightRef.current = false;
    hydratedSettingsVersionRef.current = "";
    setOverview(null);
    setActiveRequest("");
    setError("");
    setNotice("");
    setDisplayName(DEFAULT_CONNECTION.displayName);
    setBaseUrl(DEFAULT_CONNECTION.baseUrl);
    setGatewayKey("");
    setDraftDirty(false);
    setSelectedConnectionId("");
    setProfileName("自动上架 AI 模型");
    setTextModel("");
    setImageModel("");
    setSelectedProfileId("");
    setCostConfirmedProfileIds([]);
    setRollbackConfirmedProfileIds([]);
    setCatalogDetail(null);
    setCatalogLoading(false);
    setCatalogError("");
    setConnectionCursor(null);
    setProfileCursor(null);
    setConnectionCursorStack([]);
    setProfileCursorStack([]);
    if (account?.role !== "admin") {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    loadAiSettings({ signal: controller.signal, connectionCursor: null, profileCursor: null })
      .then((result) => {
        if (requestVersion === requestVersionRef.current) setOverview(result);
      })
      .catch((caught) => {
        if (requestVersion === requestVersionRef.current && caught?.code !== "REQUEST_ABORTED") {
          setError(actionError(caught, "AI 模型配置读取失败"));
        }
      })
      .finally(() => {
        if (requestVersion === requestVersionRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [accountId, account?.role]);

  useEffect(() => () => {
    requestVersionRef.current += 1;
    activeActionControllerRef.current?.abort();
    activeActionControllerRef.current = null;
    catalogControllerRef.current?.abort();
    catalogControllerRef.current = null;
    catalogLoaderRef.current.invalidate();
  }, []);

  const effectiveOverview = useMemo(() => overview ? {
    ...overview,
    connections: withActive(overview.connections, overview.activeConnection),
    profiles: withActive(overview.profiles, overview.activeProfile),
  } : null, [overview]);
  const presentation = useMemo(() => aiSettingsPresentation(effectiveOverview || {}, {
    costConfirmedProfileIds,
  }), [effectiveOverview, costConfirmedProfileIds]);
  const settingsVersion = useMemo(() => settingsIdentity(overview), [overview]);

  useEffect(() => {
    if (!overview || !settingsVersion) return;
    if (draftDirty || hydratedSettingsVersionRef.current === settingsVersion) return;
    const preferredConnection = overview.connections?.find((row) => row.id === selectedConnectionId)
      || overview.activeConnection || overview.connections?.[0] || null;
    setDisplayName(preferredConnection?.displayName || DEFAULT_CONNECTION.displayName);
    setBaseUrl(preferredConnection?.baseUrl || DEFAULT_CONNECTION.baseUrl);
    setSelectedConnectionId(preferredConnection?.id || "");
    setSelectedProfileId((current) => overview.profiles?.some((row) => row.id === current)
      ? current : overview.activeProfile?.id === current ? current
        : overview.activeProfile?.id || overview.profiles?.find((row) => row.enabled)?.id
          || overview.profiles?.[0]?.id || "");
    hydratedSettingsVersionRef.current = settingsVersion;
  }, [overview, settingsVersion, draftDirty, selectedConnectionId]);

  const selectedConnection = useMemo(() => (effectiveOverview?.connections || [])
    .find((row) => row.id === selectedConnectionId) || null, [effectiveOverview, selectedConnectionId]);
  const connectionView = useMemo(() => presentation.connections
    .find((row) => row.id === selectedConnectionId) || null, [presentation, selectedConnectionId]);
  const currentCatalogSummary = useMemo(() => latestCatalogFor(overview, selectedConnection), [overview, selectedConnection]);
  const currentCatalog = catalogDetail?.catalog?.id === currentCatalogSummary?.id
    ? catalogDetail.catalog : null;
  const latestSync = useMemo(() => latestSyncFor(overview, selectedConnection), [overview, selectedConnection]);
  const latestSuccessfulSync = useMemo(() => latestSuccessfulSyncFor(overview, selectedConnection), [overview, selectedConnection]);
  const selectionPresentation = useMemo(() => aiSettingsPresentation({
    ...(effectiveOverview || {}),
    catalogs: currentCatalog ? [currentCatalog] : [],
  }), [effectiveOverview, currentCatalog]);
  const textCandidates = selectionPresentation.recommendations.text;
  const imageCandidates = selectionPresentation.recommendations.image;
  const textOptions = useMemo(() => aiSettingsModelOptions(currentCatalog, textCandidates),
    [currentCatalog, textCandidates]);
  const imageOptions = useMemo(() => aiSettingsModelOptions(currentCatalog, imageCandidates),
    [currentCatalog, imageCandidates]);
  const canSaveSelection = Boolean(currentCatalog?.id)
    && currentCatalog.id === currentCatalogSummary?.id
    && presentation.profileCreatableCatalogIds.includes(currentCatalog?.id)
    && catalogDetail?.actions?.canCreateProfile === true
    && textOptions.some((row) => row.value === textModel)
    && imageOptions.some((row) => row.value === imageModel);

  useEffect(() => {
    catalogControllerRef.current?.abort();
    catalogControllerRef.current = null;
    catalogLoaderRef.current.invalidate();
    setCatalogDetail(null);
    setCatalogError("");
    if (!currentCatalogSummary?.id) {
      setCatalogLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    catalogControllerRef.current = controller;
    setCatalogLoading(true);
    catalogLoaderRef.current.run(currentCatalogSummary.id, { signal: controller.signal })
      .then((result) => {
        if (result.accepted && catalogControllerRef.current === controller) {
          setCatalogDetail(result.value);
        }
      })
      .catch((caught) => {
        if (catalogControllerRef.current === controller && caught?.code !== "REQUEST_ABORTED") {
          setCatalogError(actionError(caught, "完整模型目录读取失败"));
        }
      })
      .finally(() => {
        if (catalogControllerRef.current === controller) {
          catalogControllerRef.current = null;
          setCatalogLoading(false);
        }
      });
    return () => controller.abort();
  }, [currentCatalogSummary?.id]);

  useEffect(() => {
    if (draftDirty) return;
    setTextModel((current) => textOptions.some((row) => row.value === current)
      ? current : textOptions[0]?.value || "");
    setImageModel((current) => imageOptions.some((row) => row.value === current)
      ? current : imageOptions[0]?.value || "");
  }, [draftDirty, currentCatalog?.id, textOptions, imageOptions]);

  const selectedProfile = useMemo(() => (effectiveOverview?.profiles || [])
    .find((row) => row.id === selectedProfileId) || null, [effectiveOverview, selectedProfileId]);
  const profileView = useMemo(() => presentation.profiles
    .find((row) => row.id === selectedProfileId) || null, [presentation, selectedProfileId]);

  const showNextConnectionPage = async () => {
    const nextCursor = overview?.pagination?.connections?.nextCursor || null;
    if (!nextCursor || loading || busy || draftDirty || paginationInFlightRef.current) return;
    paginationInFlightRef.current = true;
    try {
      const result = await refreshOverview({ connectionCursor: nextCursor, profileCursor });
      if (!result) return;
      setConnectionCursorStack((current) => [...current, connectionCursor]);
      setConnectionCursor(nextCursor);
    } finally {
      paginationInFlightRef.current = false;
    }
  };

  const showPreviousConnectionPage = async () => {
    if (!connectionCursorStack.length || loading || busy || draftDirty || paginationInFlightRef.current) return;
    const previousCursor = connectionCursorStack.at(-1) ?? null;
    paginationInFlightRef.current = true;
    try {
      const result = await refreshOverview({ connectionCursor: previousCursor, profileCursor });
      if (!result) return;
      setConnectionCursorStack((current) => current.slice(0, -1));
      setConnectionCursor(previousCursor);
    } finally {
      paginationInFlightRef.current = false;
    }
  };

  const showNextProfilePage = async () => {
    const nextCursor = overview?.pagination?.profiles?.nextCursor || null;
    if (!nextCursor || loading || busy || paginationInFlightRef.current) return;
    paginationInFlightRef.current = true;
    try {
      const result = await refreshOverview({ connectionCursor, profileCursor: nextCursor });
      if (!result) return;
      setProfileCursorStack((current) => [...current, profileCursor]);
      setProfileCursor(nextCursor);
    } finally {
      paginationInFlightRef.current = false;
    }
  };

  const showPreviousProfilePage = async () => {
    if (!profileCursorStack.length || loading || busy || paginationInFlightRef.current) return;
    const previousCursor = profileCursorStack.at(-1) ?? null;
    paginationInFlightRef.current = true;
    try {
      const result = await refreshOverview({ connectionCursor, profileCursor: previousCursor });
      if (!result) return;
      setProfileCursorStack((current) => current.slice(0, -1));
      setProfileCursor(previousCursor);
    } finally {
      paginationInFlightRef.current = false;
    }
  };

  const runAction = async (name, operation, successMessage) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    const controller = new AbortController();
    activeActionControllerRef.current = controller;
    setActiveRequest(name);
    setError("");
    setNotice("");
    try {
      await operation(controller.signal);
      if (activeActionControllerRef.current === controller) setNotice(successMessage);
    } catch (caught) {
      if (activeActionControllerRef.current === controller && caught?.code !== "REQUEST_ABORTED") {
        setError(actionError(caught, `${name}失败`));
      }
    } finally {
      if (activeActionControllerRef.current !== controller) return;
      await refreshOverview({ silent: true });
      if (activeActionControllerRef.current !== controller) return;
      activeActionControllerRef.current = null;
      actionInFlightRef.current = false;
      setActiveRequest("");
    }
  };

  const saveAndTestConnection = () => runAction("测试连接", async (signal) => {
    const normalizedDisplayName = displayName.trim();
    const normalizedBaseUrl = baseUrl.trim();
    if (!normalizedDisplayName || !normalizedBaseUrl || !gatewayKey.trim()) {
      throw new Error("请完整填写连接名称、网关地址和新的网关 Key");
    }
    const gatewayKeyInput = { value: gatewayKey };
    const connectionIntent = intentStore.connectionIntent({
      displayName: normalizedDisplayName,
      baseUrl: normalizedBaseUrl,
    });
    const connection = await createGatewayConnection({
      displayName: normalizedDisplayName,
      baseUrl: normalizedBaseUrl,
      gatewayKey,
      gatewayKeyInput,
    }, withSignal(connectionIntent, signal));
    setGatewayKey("");
    setDraftDirty(false);
    setSelectedConnectionId(connection.id);
    const syncIntent = intentStore.commandIntent({ operation: "sync", targetId: connection.id });
    await requestModelSync({ connectionId: connection.id, connectionVersion: connection.version }, withSignal(syncIntent, signal));
  }, "连接已保存，验证与模型同步任务已提交");

  const syncModels = () => runAction("立即同步", async (signal) => {
    if (!selectedConnection || !connectionView?.actions?.canSync) throw new Error("当前连接暂不可同步");
    const intent = intentStore.commandIntent({ operation: "sync", targetId: selectedConnection.id });
    await requestModelSync({
      connectionId: selectedConnection.id,
      connectionVersion: selectedConnection.version,
    }, withSignal(intent, signal));
  }, "模型同步任务已提交");

  const saveSelection = () => runAction("保存模型选择", async (signal) => {
    if (!selectedConnection || !currentCatalog || !textModel || !imageModel || !profileName.trim()) {
      throw new Error("请先完成模型同步并选择文字模型和图片模型");
    }
    const intent = intentStore.commandIntent({ operation: "profile", targetId: currentCatalog.id });
    const profile = await createModelProfile({
      connectionId: selectedConnection.id,
      connectionVersion: selectedConnection.version,
      catalogId: currentCatalog.id,
      displayName: profileName.trim(),
      textModel,
      imageModel,
      textProtocol: "SUB2API_RESPONSES",
      imageProtocol: "SUB2API_OPENAI_IMAGES",
    }, withSignal(intent, signal));
    setSelectedProfileId(profile.id);
    setDraftDirty(false);
  }, "模型选择已保存为待验证配置");

  const testProfile = () => runAction("能力测试", async (signal) => {
    if (!selectedProfile || !profileView?.actions?.canTest || !profileView.paidTest.ready) {
      throw new Error("请先确认测试费用提示，并选择后端允许测试的配置");
    }
    const intent = intentStore.commandIntent({ operation: "test", targetId: selectedProfile.id });
    await testModelProfile({
      profileId: selectedProfile.id,
      configVersion: selectedProfile.configVersion,
      costConfirmed: true,
    }, withSignal(intent, signal));
    setCostConfirmedProfileIds((current) => current.filter((id) => id !== selectedProfile.id));
  }, "真实能力测试已完成");

  const publishProfile = () => runAction("发布启用", async (signal) => {
    if (!selectedProfile || !profileView?.actions?.canPublish) throw new Error("当前配置尚未达到发布条件");
    const intent = intentStore.commandIntent({ operation: "publish", targetId: selectedProfile.id });
    await publishModelProfile({
      profileId: selectedProfile.id,
      configVersion: selectedProfile.configVersion,
    }, withSignal(intent, signal));
  }, "AI 模型配置已发布，仅影响新建自动上架任务");

  const rollbackProfile = (profile) => runAction("安全回退", async (signal) => {
    const view = presentation.profiles.find((row) => row.id === profile.id);
    if (!view?.actions?.canRollback || !rollbackConfirmedProfileIds.includes(profile.id)) {
      throw new Error("请先确认回退将重新验证并可能产生少量费用");
    }
    const intent = intentStore.commandIntent({ operation: "rollback", targetId: profile.id });
    await rollbackModelProfile({
      profileId: profile.id,
      configVersion: profile.configVersion,
      costConfirmed: true,
    }, withSignal(intent, signal));
    setRollbackConfirmedProfileIds((current) => current.filter((id) => id !== profile.id));
  }, "历史配置已完成安全验证并回退");

  const openDashboard = () => {
    const target = dashboardUrl(baseUrl || selectedConnection?.baseUrl);
    if (!target) {
      setError("请先填写有效的 sub2API 网关地址");
      return;
    }
    window.open(target, "_blank", "noopener,noreferrer");
  };

  if (account?.role !== "admin") {
    return <div className="ai-model-settings-page">
      <Alert type="error" showIcon title="无权访问 AI 模型配置" description="请使用管理员账号进入此页面。后端仍会再次校验管理权限。" />
      <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/ozon/tools/auto-listing")}>返回自动上架</Button>
    </div>;
  }

  return <div className="ai-model-settings-page">
    <div className="ai-model-settings-page__header">
      <div>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/ozon/tools/auto-listing")}>返回自动上架</Button>
        <h1>AI 模型配置</h1>
        <p>统一连接 sub2API、同步可用模型，并由管理员确认文字模型与图片模型。</p>
      </div>
      <Button icon={<ReloadOutlined />} disabled={busy} loading={loading} onClick={() => refreshOverview()}>刷新</Button>
    </div>

    {notice ? <Alert type="success" showIcon title={notice} closable onClose={() => setNotice("")} /> : null}
    {error ? <Alert type="error" showIcon title={error} closable onClose={() => setError("")} /> : null}

    <Spin spinning={loading}>
      <div className="ai-model-settings-page__grid">
        <GatewayConnectionSection activeRequest={activeRequest} baseUrl={baseUrl} busy={busy}
          canCreateConnection={presentation.canCreateConnection} displayName={displayName} gatewayKey={gatewayKey}
          onBaseUrlChange={(value) => { setBaseUrl(value); setDraftDirty(true); }}
          onDisplayNameChange={(value) => { setDisplayName(value); setDraftDirty(true); }}
          onGatewayKeyChange={(value) => { setGatewayKey(value); setDraftDirty(true); }}
          onOpenDashboard={openDashboard} onSaveAndTest={saveAndTestConnection} selectedConnection={selectedConnection} />
        <ModelSelectionSection activeRequest={activeRequest} busy={busy || loading}
          canSaveSelection={canSaveSelection} canShowPreviousConnectionPage={connectionCursorStack.length > 0}
          catalogError={catalogError} catalogLoading={catalogLoading} connectionView={connectionView}
          currentCatalog={currentCatalog} imageModel={imageModel} imageOptions={imageOptions}
          latestSuccessfulSync={latestSuccessfulSync} latestSync={latestSync} overview={effectiveOverview}
          onConnectionChange={(value) => {
            const connection = effectiveOverview?.connections?.find((row) => row.id === value);
            setGatewayKey("");
            setSelectedConnectionId(value);
            setDisplayName(connection?.displayName || DEFAULT_CONNECTION.displayName);
            setBaseUrl(connection?.baseUrl || DEFAULT_CONNECTION.baseUrl);
            setDraftDirty(false);
          }}
          onConnectionPageNext={showNextConnectionPage}
          onConnectionPagePrevious={showPreviousConnectionPage}
          onImageModelChange={(value) => { setImageModel(value); setDraftDirty(true); }}
          onProfileNameChange={(value) => { setProfileName(value); setDraftDirty(true); }}
          onSaveSelection={saveSelection} onSync={syncModels}
          onTextModelChange={(value) => { setTextModel(value); setDraftDirty(true); }}
          profileName={profileName} selectedConnectionId={selectedConnectionId}
          selectionPresentation={selectionPresentation} textModel={textModel} textOptions={textOptions} />
        <CapabilityPublishSection activeRequest={activeRequest} busy={busy}
          onCostConfirmationChange={(checked) => setCostConfirmedProfileIds((current) => (
            checked ? [...new Set([...current, selectedProfile.id])] : current.filter((id) => id !== selectedProfile.id)
          ))}
          onProfileChange={setSelectedProfileId} onPublish={publishProfile} onTest={testProfile}
          overview={effectiveOverview} profileView={profileView} selectedProfile={selectedProfile} selectedProfileId={selectedProfileId} />
        <ConfigurationHistorySection activeRequest={activeRequest} busy={busy || loading}
          canShowPreviousProfilePage={profileCursorStack.length > 0}
          onProfilePageNext={showNextProfilePage} onProfilePagePrevious={showPreviousProfilePage}
          onRollback={rollbackProfile}
          onRollbackConfirmationChange={(profileId, checked) => setRollbackConfirmedProfileIds((current) => (
            checked ? [...new Set([...current, profileId])] : current.filter((id) => id !== profileId)
          ))}
          overview={overview} presentation={presentation} rollbackConfirmedProfileIds={rollbackConfirmedProfileIds} />
      </div>
    </Spin>
  </div>;
}
