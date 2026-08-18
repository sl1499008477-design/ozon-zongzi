import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Progress,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  categoryStrategyErrorMessage,
  createCategoryStrategyIntentStore,
  createCategoryStrategyClient,
  loadCategoryStrategyThumbnail,
} from "./category-strategy-client.js";
import {
  findResumableCategoryStrategyDraftId,
  handoffCategoryStrategySampling,
  loadCategoryStrategyBootstrap,
  startCategoryStrategySampling,
} from "./category-strategy-bootstrap.js";
import { createCategoryStrategyExtensionBridge } from "./category-strategy-extension-bridge.js";
import {
  CATEGORY_STRATEGY_ROLES,
  categoryStrategyCountdown,
  categoryStrategyPageModel,
  clearStrategyResumeDraft,
  readStrategyResumeDraft,
  updateStrategyResumeState,
} from "./category-strategy-model.js";
import "./category-strategy.css";

const ROLE_LABELS = Object.freeze({
  MAIN: "主图", SELLING_POINT: "卖点图", DETAIL: "细节图", SCENE: "场景图",
  SPECIFICATION: "尺寸图", INFOGRAPHIC: "信息图",
});
const STATUS_LABELS = Object.freeze({
  NOT_CONFIGURED: "未配置", COLLECTING: "选样中", SAMPLES_READY: "样本已就绪",
  ANALYZING: "分析中", DRAFT_READY: "草稿待审核", PUBLISHED: "已发布", NEEDS_REVIEW: "需要人工检查",
});
const TEXT_DENSITY_LABELS = Object.freeze({ NONE: "无", LIGHT: "少量", MEDIUM: "适中", HEAVY: "较多" });

function queryDraftId(locationSearch = "") {
  const value = new URLSearchParams(locationSearch).get("draftId") || "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(value) ? value : "";
}

function queryAutoStartSampling(locationSearch = "") {
  return new URLSearchParams(locationSearch).get("from") === "auto-listing";
}

function currentCollectSourceVersion(localData, collectItemId) {
  const rows = localData?.caches?.collectBox || localData?.collectBox || [];
  const row = (Array.isArray(rows) ? rows : []).find((entry) => String(entry?.id || "") === collectItemId);
  const draftVersion = Number(row?.draftVersion);
  return Number.isSafeInteger(draftVersion) && draftVersion >= 1 ? `draft:${draftVersion}` : null;
}

function ProtectedThumbnail({ sample }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    setSrc("");
    setFailed(false);
    loadCategoryStrategyThumbnail(sample.thumbnailUrl, { signal: controller.signal }).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sample.thumbnailUrl]);
  if (src) return <img src={src} alt={`${sample.sku} 样本清晰预览`} />;
  return <span className="category-strategy-thumbnail-status" role="status">
    {failed ? "缩略图加载失败" : "缩略图加载中"}
  </span>;
}

function guidanceFormValues(analysis) {
  if (!analysis) return {};
  return {
    overallStyle: analysis.guidance.overallStyle,
    prohibitedPatterns: analysis.guidance.prohibitedPatterns.join("\n"),
    ...Object.fromEntries(CATEGORY_STRATEGY_ROLES.map((role) => [role, analysis.guidance.roles[role]])),
  };
}

function guidanceFromForm(values) {
  return {
    overallStyle: String(values.overallStyle || "").trim(),
    prohibitedPatterns: String(values.prohibitedPatterns || "").split("\n").map((entry) => entry.trim()).filter(Boolean),
    roles: Object.fromEntries(CATEGORY_STRATEGY_ROLES.map((role) => [role, {
      composition: String(values[role]?.composition || "").trim(),
      background: String(values[role]?.background || "").trim(),
      textDensity: values[role]?.textDensity,
      layout: String(values[role]?.layout || "").trim(),
    }])),
  };
}

export default function CategoryStrategyPage({ account = null, localData = {}, locationSearch = "",
  navigate = () => {} } = {}) {
  const [form] = Form.useForm();
  const client = useMemo(() => createCategoryStrategyClient(), []);
  const extensionBridge = useMemo(() => createCategoryStrategyExtensionBridge(), []);
  const accountId = String(account?.id || "").trim();
  const [resumeRevision, setResumeRevision] = useState(0);
  const resume = useMemo(() => readStrategyResumeDraft(globalThis.sessionStorage, accountId, {
    sourceVersionOf: (collectItemId) => currentCollectSourceVersion(localData, collectItemId),
  }), [accountId, localData, resumeRevision]);
  const intents = useMemo(() => createCategoryStrategyIntentStore({
    storage: globalThis.sessionStorage, accountId,
  }), [accountId]);
  const routeDraftId = useMemo(() => queryDraftId(locationSearch), [locationSearch]);
  const autoStartSampling = useMemo(() => queryAutoStartSampling(locationSearch), [locationSearch]);
  const [strategies, setStrategies] = useState([]);
  const [detail, setDetail] = useState(null);
  const [samples, setSamples] = useState([]);
  const [session, setSession] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [guidanceLanguage, setGuidanceLanguage] = useState("ru");
  const [published, setPublished] = useState(null);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date().toISOString());
  const loadRequestRef = useRef(0);
  const currentAccountRef = useRef(accountId);
  currentAccountRef.current = accountId;
  const actionRequestRef = useRef(null);
  const [stateAccountId, setStateAccountId] = useState(accountId);

  const currentPublished = versions.find((version) => version.status === "PUBLISHED") || published;
  const view = detail ? categoryStrategyPageModel({ detail, session, analysis, published, now }) : null;
  const managementZh = analysis?.evidenceSummary?.managementZh || null;
  const visibleCommonPatterns = guidanceLanguage === "zh" && managementZh
    ? (analysis?.evidenceSummary?.commonPatterns || []).map((entry, index) => ({
      ...entry, pattern: managementZh.commonPatterns[index],
    })) : (analysis?.evidenceSummary?.commonPatterns || []);
  const visibleDifferences = guidanceLanguage === "zh" && managementZh
    ? (analysis?.evidenceSummary?.differences || []).map((entry, index) => ({
      ...entry, pattern: managementZh.differences[index],
    })) : (analysis?.evidenceSummary?.differences || []);
  const visibleCautions = guidanceLanguage === "zh" && managementZh
    ? managementZh.cautions : (analysis?.evidenceSummary?.cautions || []);

  const applyBundle = useCallback((bundle) => {
    setDetail(bundle.draft);
    setSession(bundle.session);
    setSamples(bundle.samples);
    setAnalysis(bundle.analysis);
    setPublished(bundle.published);
    setVersions(bundle.versions);
  }, []);

  const clearBundle = useCallback(() => {
    setDetail(null);
    setSession(null);
    setSamples([]);
    setAnalysis(null);
    setPublished(null);
    setVersions([]);
    form.resetFields();
  }, [form]);

  const load = useCallback(async (preferredDraftId = "") => {
    const requestId = ++loadRequestRef.current;
    actionRequestRef.current = null;
    setAction("");
    const draftId = preferredDraftId || routeDraftId || resume?.required?.draftId || "";
    setLoading(true);
    setError("");
    if (!draftId) clearBundle();
    try {
      const list = await client.list();
      if (requestId !== loadRequestRef.current) return;
      setStrategies(list);
      const resumableDraftId = draftId || findResumableCategoryStrategyDraftId({
        strategies: list,
        resume,
      });
      const bootstrap = await loadCategoryStrategyBootstrap({
        client,
        intents,
        extensionBridge,
        resume,
        routeDraftId: resumableDraftId,
        autoStartSampling,
        onDraftReady: ({ draftId: readyDraftId, bundle }) => {
          if (requestId !== loadRequestRef.current) return;
          applyBundle(bundle);
          if (autoStartSampling) {
            window.history.replaceState({}, "",
              `/ozon/tools/category-strategies/?draftId=${encodeURIComponent(readyDraftId)}`);
          }
        },
      });
      if (requestId !== loadRequestRef.current) return;
      if (bootstrap) {
        applyBundle({ ...bootstrap.bundle, session: bootstrap.session });
      }
    } catch (caught) {
      if (requestId === loadRequestRef.current) setError(categoryStrategyErrorMessage(caught));
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [applyBundle, autoStartSampling, clearBundle, client, extensionBridge, intents, resume, routeDraftId]);

  useEffect(() => {
    loadRequestRef.current += 1;
    setStrategies([]);
    clearBundle();
    setError("");
    setStateAccountId(accountId);
  }, [accountId, clearBundle]);
  useEffect(() => { load(routeDraftId); }, [load, routeDraftId]);
  useEffect(() => {
    if (!session) return undefined;
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 1_000);
    return () => window.clearInterval(timer);
  }, [session]);
  useEffect(() => {
    if (!analysis) return;
    form.setFieldsValue(guidanceFormValues(analysis));
    setGuidanceLanguage(analysis.evidenceSummary?.managementZh ? "zh" : "ru");
  }, [analysis, form]);

  const isCurrentAction = (context) => context.accountId === currentAccountRef.current
    && context.requestId === loadRequestRef.current;

  const runAction = async (name, operation) => {
    if (actionRequestRef.current) return;
    const token = {};
    const context = { accountId, requestId: ++loadRequestRef.current };
    actionRequestRef.current = token;
    setAction(name);
    setError("");
    try { await operation(context); } catch (caught) {
      if (actionRequestRef.current === token && isCurrentAction(context)) {
        setError(categoryStrategyErrorMessage(caught));
      }
    } finally {
      if (actionRequestRef.current === token) {
        actionRequestRef.current = null;
        setAction("");
      }
    }
  };

  const intentIdentity = (kind, fingerprint) => intents.identity(kind, fingerprint);
  const settleIntent = (kind, fingerprint) => intents.settle(kind, fingerprint);

  const beginSampling = () => runAction("sampling", async (context) => {
    const next = await startCategoryStrategySampling({ client, intents, extensionBridge, draft: detail });
    if (!isCurrentAction(context)) return;
    setSession(next);
  });

  const replaceSample = (sample) => runAction(`replace:${sample.sampleId}`, async (context) => {
    const removeFingerprint = { draftId: detail.draftId, sampleId: sample.sampleId,
      expectedDraftVersion: detail.draftVersion };
    const removeIdentity = await intentIdentity("category-sample-revision", removeFingerprint);
    const prepared = await client.removeSample(detail.draftId, sample.sampleId, {
      expectedDraftVersion: detail.draftVersion, ...removeIdentity,
    });
    const next = await handoffCategoryStrategySampling({
      client, extensionBridge, draft: detail, identity: prepared.samplingIdentity,
    });
    await settleIntent("category-sample-revision", removeFingerprint);
    if (!isCurrentAction(context)) return;
    setSession(next);
  });

  const reopenSampling = () => runAction("reopen", async () => {
    await extensionBridge.open(session.browserUrl);
  });

  const createNextDraft = () => runAction("new-draft", async (context) => {
    const fingerprint = { scope: detail.scope, sourceCollectItemId: detail.sourceCollectItemId,
      expectedSourceVersion: detail.expectedSourceVersion };
    const identity = await intentIdentity("category-draft", fingerprint);
    const created = await client.createDraft({ ...fingerprint, ...identity });
    await settleIntent("category-draft", fingerprint);
    if (!isCurrentAction(context)) return;
    const bundle = await client.getDraft(created.draftId);
    if (!isCurrentAction(context)) return;
    applyBundle(bundle);
    navigate(`/ozon/tools/category-strategies?draftId=${encodeURIComponent(created.draftId)}`);
  });

  const confirmAnalysis = () => Modal.confirm({
    title: "确认生成类目策略草稿",
    content: <div>
      <p>预计费用：调用当前账号已启用的文本分析模型 1 次，按模型实际计价。</p>
      <p>将分析 {detail.sampleCount} 个已确认样本；失败不会自动无限重试。</p>
    </div>,
    okText: "确认生成",
    cancelText: "取消",
    onOk: () => runAction("analysis", async (context) => {
      const fingerprint = { draftId: detail.draftId, draftVersion: detail.draftVersion,
        sampleCount: detail.sampleCount };
      const identity = await intentIdentity("category-analysis", fingerprint);
      await client.analyze(detail.draftId, {
        costConfirmed: true,
        ...identity,
      });
      await settleIntent("category-analysis", fingerprint);
      if (!isCurrentAction(context)) return;
      await load(detail.draftId);
    }),
  });

  const saveEdit = () => runAction("edit", async (context) => {
    const values = await form.validateFields();
    const patch = { guidance: guidanceFromForm(values), baseAnalysisAttemptId: analysis.attemptId };
    const fingerprint = { draftId: detail.draftId, expectedDraftVersion: detail.draftVersion, patch };
    const identity = await intentIdentity("category-edit", fingerprint);
    await client.edit(detail.draftId, {
      expectedDraftVersion: detail.draftVersion,
      patch,
      ...identity,
    });
    await settleIntent("category-edit", fingerprint);
    if (!isCurrentAction(context)) return;
    await load(detail.draftId);
  });

  const confirmPublish = () => Modal.confirm({
    title: "确认发布类目策略",
    content: "发布会生成新的账号级不可变版本，同账号内命中此精确类目的新任务将共用该版本。",
    okText: "确认发布",
    cancelText: "取消",
    onOk: () => runAction("publish", async (context) => {
      if (!currentPublished?.id) throw Object.assign(new Error("missing version"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_VERSION_CONFLICT", status: 409,
      });
      const fingerprint = { draftId: detail.draftId, expectedDraftVersion: detail.draftVersion,
        expectedPublishedStrategyVersionId: currentPublished.id };
      const identity = await intentIdentity("category-publish", fingerprint);
      await client.publish(detail.draftId, {
        expectedDraftVersion: detail.draftVersion,
        expectedPublishedStrategyVersionId: currentPublished.id,
        ...identity,
      });
      await settleIntent("category-publish", fingerprint);
      if (!isCurrentAction(context)) return;
      await load(detail.draftId);
    }),
  });

  const rollback = (target) => Modal.confirm({
    title: `创建回滚版本 v${target.version}`,
    content: "系统会复制该历史规则并发布为更高的新版本，不会修改原历史记录。",
    okText: "创建回滚版本",
    cancelText: "取消",
    onOk: () => runAction(`rollback:${target.id}`, async (context) => {
      const fingerprint = { draftId: detail.draftId, targetStrategyVersionId: target.id,
        expectedPublishedStrategyVersionId: currentPublished.id };
      const identity = await intentIdentity("category-rollback", fingerprint);
      await client.rollback(detail.draftId, {
        targetStrategyVersionId: target.id,
        expectedPublishedStrategyVersionId: currentPublished.id,
        ...identity,
      });
      await settleIntent("category-rollback", fingerprint);
      if (!isCurrentAction(context)) return;
      await load(detail.draftId);
    }),
  });

  const returnToStrategyList = () => {
    if (!clearStrategyResumeDraft(globalThis.sessionStorage, accountId)) {
      setError("无法清除自动恢复状态，请刷新页面后重试。");
      return;
    }
    loadRequestRef.current += 1;
    actionRequestRef.current = null;
    setAction("");
    setLoading(false);
    setError("");
    setResumeRevision((current) => current + 1);
    clearBundle();
    navigate("/ozon/tools/category-strategies");
  };

  const returnToCreate = () => {
    if (resume) updateStrategyResumeState(globalThis.sessionStorage, resume, "READY_TO_CONTINUE");
    navigate("/ozon/tools/auto-listing?strategy=ready");
  };

  if (account?.role !== "admin") return <Alert type="warning" showIcon
    title="没有类目策略管理权限" description="请请求账号管理员完成配置和发布。" />;
  if (stateAccountId !== accountId) return <Spin spinning><span className="category-strategy-account-loading"
    role="status">正在切换账号数据</span></Spin>;

  const columns = [
    { title: "精确类目", render: (_value, row) => `${row.scope.descriptionCategoryId} / 类型 ${row.scope.typeId}` },
    { title: "当前状态", dataIndex: "status", render: (value) => <Tag>{STATUS_LABELS[value] || value}</Tag> },
    { title: "样本数", dataIndex: "sampleCount" },
    { title: "操作", render: (_value, row) => <Button icon={<EyeOutlined />}
      onClick={() => navigate(`/ozon/tools/category-strategies?draftId=${encodeURIComponent(row.draftId)}`)}>查看</Button> },
  ];

  return <div className="category-strategy-page">
    <header className="category-strategy-header">
      <div><h1>类目图片策略</h1><p>查看证据、编辑规则并发布账号级精确类目策略。</p></div>
      <Space wrap>
        {detail ? <Button icon={<ArrowLeftOutlined />} onClick={returnToStrategyList}>返回策略列表</Button> : null}
        {resume ? <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/ozon/tools/auto-listing")}>返回自动上架</Button> : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(detail?.draftId)}>刷新</Button>
      </Space>
    </header>
    {error ? <Alert type="error" showIcon title="操作没有完成" description={error} closable onClose={() => setError("")} /> : null}
    <Spin spinning={loading}>
      {!detail ? <Card title="类目策略列表"><Table rowKey="draftId" columns={columns} dataSource={strategies}
        locale={{ emptyText: <Empty description="暂无类目策略" /> }} /></Card> : <>
        <Card title="精确类目与当前状态">
          <div className="category-strategy-facts">
            <div><span>类目体系</span><strong>{detail.scope.taxonomyScope}</strong></div>
            <div><span>类目编号</span><strong>{detail.scope.descriptionCategoryId}</strong></div>
            <div><span>商品类型</span><strong>{detail.scope.typeId}</strong></div>
            <div><span>当前状态</span><strong>{STATUS_LABELS[detail.status] || detail.status}</strong></div>
          </div>
        </Card>

        <Card title="样本库" extra={view?.canCreateDraft
          ? <Button type="primary" icon={<RocketOutlined />} loading={action === "new-draft"}
            onClick={createNextDraft}>创建新草稿</Button>
          : <Button icon={<RocketOutlined />} loading={action === "sampling"}
            disabled={!view?.canStartSampling} onClick={beginSampling}>继续选样</Button>}>
          {session ? <Alert type={view.countdown.expired ? "warning" : "info"} showIcon
            title={view.countdown.expired ? "选样会话已过期" : "扩展选样会话已开启"}
            description={<span role="status">会话剩余时间：{view.countdown.label}。如果页面没有自动打开，请使用右侧按钮。</span>}
            action={!view.countdown.expired ? <Button loading={action === "reopen"}
              onClick={reopenSampling}>打开 Ozon 选样页</Button> : null} /> : null}
          <p>已确认 {detail.sampleCount} 个商品；达到 5～20 个有效样本后才可分析。</p>
          {samples.length ? <div className="category-strategy-samples">{samples.map((sample) => <article key={sample.sampleId}>
            <ProtectedThumbnail sample={sample} />
            <strong>{sample.title || sample.sku}</strong>
            <div className="category-strategy-sample-image-facts">
              <Tag color="blue">共 {sample.imageCount} 张</Tag>
              <span>预览：{sample.previewRole === "MAIN" ? "主图" : "详情图"} {sample.previewWidth}×{sample.previewHeight}</span>
              <span>采集主图：{sample.mainImageWidth}×{sample.mainImageHeight}
                {Math.min(sample.mainImageWidth, sample.mainImageHeight) < 256 ? "（低清源图）" : ""}</span>
            </div>
            <label><input aria-label={`选择样本 ${sample.sku}`} type="checkbox" disabled /> SKU {sample.sku}</label>
            <Button size="small" danger icon={<DeleteOutlined />} disabled={!view?.canStartSampling || Boolean(action)}
              onClick={() => replaceSample(sample)}>替换此样本</Button>
          </article>)}</div> : <Empty description="样本缩略图由安全代理准备后显示" />}
        </Card>

        <Card title="生成类目策略草稿" extra={<Button type="primary" icon={<SafetyCertificateOutlined />}
          disabled={!view?.canAnalyze} loading={action === "analysis"} onClick={confirmAnalysis}>生成类目策略草稿</Button>}>
          <Alert type="info" showIcon title="预计费用"
            description="显式确认后调用当前启用的分析模型 1 次；确认采集本身不会调用 AI。" />
          {!view?.canAnalyze ? <p role="status">需要 5～20 个有效样本，当前 {detail.sampleCount} 个。</p> : null}
        </Card>

        <Card title="图片角色规则" extra={analysis && view?.analysisIsCurrent && managementZh
          ? <Segmented aria-label="策略说明语言" value={guidanceLanguage} onChange={setGuidanceLanguage}
            options={[{ label: "中文管理说明", value: "zh" }, { label: "俄文执行规则", value: "ru" }]} />
          : null}>
          {!analysis || !view?.analysisIsCurrent
            ? <Empty description={analysis ? "样本已变化，请重新生成策略草稿" : "生成草稿后可逐角色检查和编辑"} />
            : guidanceLanguage === "zh" && managementZh ? <div className="category-strategy-management-guidance">
              <Alert type={analysis.provenance === "MANUAL" ? "warning" : "info"} showIcon
                title="中文管理说明（只读）" description={analysis.provenance === "MANUAL"
                  ? "俄文执行规则已人工修改，中文仍是生成草稿时的说明，可能不再同步；发布以当前俄文为准。"
                  : "用于审核和维护；发布及后续图片生成始终使用同次分析产出的俄文执行规则。"} />
              <section><span>整体视觉风格</span><p>{managementZh.guidance.overallStyle}</p></section>
              <section><span>注意事项</span>
                <ul>{managementZh.guidance.prohibitedPatterns.map((entry) => <li key={entry}>{entry}</li>)}</ul>
              </section>
              <div className="category-strategy-role-grid">{CATEGORY_STRATEGY_ROLES.map((role) => {
                const rule = managementZh.guidance.roles[role];
                return <Card size="small" key={role} title={`${ROLE_LABELS[role]} · ${role}`}>
                  <dl>
                    <dt>构图</dt><dd>{rule.composition}</dd>
                    <dt>背景</dt><dd>{rule.background}</dd>
                    <dt>文字密度</dt><dd>{TEXT_DENSITY_LABELS[rule.textDensity] || rule.textDensity}</dd>
                    <dt>布局</dt><dd>{rule.layout}</dd>
                  </dl>
                  <p>证据与置信度：{analysis.evidenceSummary?.roleEvidence?.[role]?.evidenceIds?.length || 0} 条，
                    {Math.round((analysis.evidenceSummary?.roleEvidence?.[role]?.confidence || 0) * 100)}%</p>
                </Card>;
              })}</div>
            </div> : <Form form={form} layout="vertical">
            {!managementZh ? <Alert type="warning" showIcon title="旧草稿仅有俄文"
              description="该草稿生成于双语说明上线前；仍可正常审核、编辑和发布，无需迁移。" /> : <Alert type="info"
              showIcon title="俄文执行规则" description="此处内容会用于发布和后续图片生成，可进行人工编辑。" />}
            <Form.Item name="overallStyle" label="整体视觉风格" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item>
            <Form.Item name="prohibitedPatterns" label="注意事项（每行一条）" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
            <div className="category-strategy-role-grid">{CATEGORY_STRATEGY_ROLES.map((role) => <Card size="small" key={role}
              title={`${ROLE_LABELS[role]} · ${role}`}>
              <Form.Item name={[role, "composition"]} label="构图" rules={[{ required: true }]}><Input.TextArea /></Form.Item>
              <Form.Item name={[role, "background"]} label="背景" rules={[{ required: true }]}><Input.TextArea /></Form.Item>
              <Form.Item name={[role, "textDensity"]} label="文字密度" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name={[role, "layout"]} label="布局" rules={[{ required: true }]}><Input.TextArea /></Form.Item>
              <p>证据与置信度：{analysis.evidenceSummary?.roleEvidence?.[role]?.evidenceIds?.length || 0} 条，
                {Math.round((analysis.evidenceSummary?.roleEvidence?.[role]?.confidence || 0) * 100)}%</p>
            </Card>)}</div>
            <Button icon={<EditOutlined />} loading={action === "edit"} onClick={saveEdit}>保存人工编辑</Button>
            {analysis.editedAt ? <Tag icon={<CheckCircleOutlined />}>人工编辑 · {new Date(analysis.editedAt).toLocaleString()}</Tag> : null}
          </Form>}
        </Card>

        <div className="category-strategy-evidence-grid">
          <Card title="证据与置信度"><List dataSource={visibleCommonPatterns}
            locale={{ emptyText: "暂无共同规律" }} renderItem={(item) => <List.Item>
              <Space direction="vertical"><span>{item.pattern}</span><Progress percent={Math.round(item.confidence * 100)} size="small" /></Space>
            </List.Item>} /></Card>
          <Card title="样本差异"><List dataSource={visibleDifferences}
            locale={{ emptyText: "暂无样本差异" }} renderItem={(item) => <List.Item>{item.pattern}</List.Item>} /></Card>
          <Card title="注意事项"><List dataSource={visibleCautions}
            locale={{ emptyText: "暂无额外注意事项" }} renderItem={(item) => <List.Item>{item}</List.Item>} /></Card>
        </div>

        <Card title="影响预览" extra={<Button type="primary" icon={<SafetyCertificateOutlined />}
          disabled={!view?.canPublish || !currentPublished?.id} loading={action === "publish"} onClick={confirmPublish}>发布策略</Button>}>
          <Alert type="warning" showIcon title="同账号共享" description={view.impactText} />
          <p>策略只规定图片表现方式，不会改变自动上架页面配置的图片数量、店铺、仓库、币种或库存。</p>
        </Card>

        <Card title="版本历史" extra={<HistoryOutlined />}>
          <Table rowKey="id" pagination={false} dataSource={versions} columns={[
            { title: "版本", dataIndex: "version", render: (value) => `v${value}` },
            { title: "状态", dataIndex: "status" },
            { title: "操作", render: (_value, row) => row.id !== currentPublished?.id
              ? <Button size="small" disabled={Boolean(action)} onClick={() => rollback(row)}>创建回滚版本</Button> : "当前版本" },
          ]} />
        </Card>

        {published && detail.status === "PUBLISHED" ? <Card className="category-strategy-published" title="策略已发布">
          <Alert type="success" showIcon title={`已发布 v${published.version}`}
            description="系统没有自动创建任务。返回后请检查原配置，再点击继续创建。" />
          <Button type="primary" size="large" onClick={returnToCreate}>返回并继续创建</Button>
        </Card> : null}
      </>}
    </Spin>
  </div>;
}
