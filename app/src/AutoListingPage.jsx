import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Upload,
} from "antd";
import {
  CloudUploadOutlined,
  EyeOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  amountToMinorUnits,
  autoListingCurrencyPresentation,
  autoListingTaskErrorMessage,
  autoListingWarehouseOptions,
  autoListingExcelSerializedBodyLimit,
  deriveAutoListingConfig,
  kopecksToRubles,
  readExcelFileAsBase64,
  shouldResetAutoListingAdjustment,
} from "./auto-listing-config.js";
import {
  autoListingImportProgress,
  autoListingImportRowPresentation,
  autoListingItemPresentation,
  autoListingTaskRows,
  autoListingCreatedAtLabel,
} from "./auto-listing-view.js";
import { apiRequest } from "./client-transport.js";
import "./auto-listing-page.css";

const ROLE_FIELDS = Object.freeze([
  ["main", "主图", 1, 1],
  ["sellingPoint", "卖点图", 2, 5],
  ["detail", "细节图", 1, 2],
  ["scene", "场景图", 1, 2],
  ["specification", "尺寸图", 0, 1],
  ["infographic", "信息图", 1, 2],
]);

const DEFAULT_FORM = Object.freeze({
  targetStoreId: "",
  targetWarehouseId: "",
  stock: 5,
  priceAdjustmentAmount: "0",
  ratio: "3:4",
  resolution: "1K",
  quality: "Medium",
  language: "ru",
  roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 },
});

const DEFAULT_EXCEL_LIMITS = Object.freeze({ maxBytes: 2_097_152, maxRows: 1_000 });

function byteLimitLabel(bytes) {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function requestId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function storeCurrency(store) {
  return store?.currencyCode || store?.currency_code || store?.currency || store?.companyCurrency || "";
}

function safeCurrencyPresentation(value) {
  try { return autoListingCurrencyPresentation(value); } catch { return null; }
}

function collectIdsFromLocation() {
  if (typeof window === "undefined") return [];
  const query = new URLSearchParams(window.location.search);
  if (query.get("source") !== "collect") return [];
  return [...new Set(String(query.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 100);
}

function visibleCollectIds(localData, requested) {
  const rows = localData?.caches?.collectBox || localData?.collectBox || [];
  const visible = new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.id || "")));
  return requested.filter((id) => visible.has(id));
}

function safeStoreLabel(store) {
  for (const value of [store?.label, store?.companyName]) {
    if (typeof value !== "string") continue;
    const clean = value.trim();
    if (clean && clean.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(clean)) return clean;
  }
  return "未命名店铺";
}

export default function AutoListingPage({ localData = {}, onRefresh, account = null, navigate = () => {} } = {}) {
  const [form] = Form.useForm();
  const [source, setSource] = useState("collect");
  const [collectIds] = useState(() => visibleCollectIds(localData, collectIdsFromLocation()));
  const [workbook, setWorkbook] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [imports, setImports] = useState([]);
  const [excelLimits, setExcelLimits] = useState(DEFAULT_EXCEL_LIMITS);
  const [preferenceVersion, setPreferenceVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [actionItemId, setActionItemId] = useState("");
  const [importDetail, setImportDetail] = useState(null);
  const [importDetailOpen, setImportDetailOpen] = useState(false);
  const [importDetailLoading, setImportDetailLoading] = useState(false);
  const [importActionId, setImportActionId] = useState("");
  const loadRequestRef = useRef(0);
  const reviewRequestRef = useRef(0);
  const importDetailRequestRef = useRef(0);
  const hydratedAccountRef = useRef("");
  const selectedCurrencyRef = useRef(null);
  const createIntentRef = useRef(null);
  const createInFlightRef = useRef(false);

  const stores = useMemo(() => (localData?.stores || []).filter((store) => !store?.disabled), [localData]);
  const accountId = String(account?.id || "").trim();
  const defaultStoreId = stores[0]?.id || "";
  const warehouses = localData?.caches?.warehouses || localData?.warehouses || [];
  const selectedStoreId = Form.useWatch("targetStoreId", form) || "";
  const selectedWarehouseId = Form.useWatch("targetWarehouseId", form) || "";
  const roles = Form.useWatch("roles", form) || DEFAULT_FORM.roles;
  const imageTotal = Object.values(roles).reduce((sum, count) => sum + (Number(count) || 0), 0);
  const selectedStore = useMemo(
    () => stores.find((store) => String(store?.id || "") === selectedStoreId) || null,
    [selectedStoreId, stores],
  );
  const currencyPresentation = useMemo(
    () => safeCurrencyPresentation(storeCurrency(selectedStore)),
    [selectedStore],
  );
  const storeLabels = useMemo(() => new Map(stores.map((store) => [
    String(store?.id || ""), safeStoreLabel(store),
  ])), [stores]);
  const warehouseChoice = useMemo(() => autoListingWarehouseOptions({
    warehouses,
    targetStoreId: selectedStoreId,
    selectedWarehouseId,
  }), [warehouses, selectedStoreId, selectedWarehouseId]);

  useEffect(() => {
    if (selectedWarehouseId && !warehouseChoice.selectedWarehouseId) {
      form.setFieldValue("targetWarehouseId", "");
    }
  }, [form, selectedWarehouseId, warehouseChoice.selectedWarehouseId]);

  useEffect(() => { selectedCurrencyRef.current = null; }, [accountId]);
  useEffect(() => {
    if (!selectedStoreId || !currencyPresentation) return;
    const previous = selectedCurrencyRef.current;
    if (previous?.accountId === accountId
      && shouldResetAutoListingAdjustment(previous.currency, currencyPresentation.currency)) {
      form.setFieldValue("priceAdjustmentAmount", "0");
      setNotice("切换了店铺币种，售价加减已重置为 0");
      createIntentRef.current = null;
    }
    selectedCurrencyRef.current = { accountId, currency: currencyPresentation.currency };
  }, [accountId, currencyPresentation, form, selectedStoreId]);

  const loadData = useCallback(async () => {
    const requestVersion = ++loadRequestRef.current;
    setLoading(true);
    setError("");
    try {
      const [preferenceResult, jobResult] = await Promise.all([
        apiRequest("/auto-listing/preferences"),
        apiRequest("/auto-listing/jobs?limit=50"),
      ]);
      if (requestVersion !== loadRequestRef.current) return false;
      const preference = preferenceResult?.data || {};
      setPreferenceVersion(Number.isInteger(preference.configVersion) ? preference.configVersion : 0);
      if (hydratedAccountRef.current !== accountId) {
        form.setFieldsValue({
          ...DEFAULT_FORM,
          targetStoreId: preference.targetStoreId || defaultStoreId,
          targetWarehouseId: preference.targetWarehouseId || "",
          stock: preference.stock || DEFAULT_FORM.stock,
          priceAdjustmentAmount: kopecksToRubles(preference.priceAdjustmentKopecks || "0"),
          ratio: preference.image?.ratio || DEFAULT_FORM.ratio,
          resolution: preference.image?.resolution || DEFAULT_FORM.resolution,
          quality: preference.image?.quality || DEFAULT_FORM.quality,
          language: "ru",
          roles: { ...DEFAULT_FORM.roles, ...(preference.image?.roles || {}) },
        });
        hydratedAccountRef.current = accountId;
      }
      setJobs(Array.isArray(jobResult?.data) ? jobResult.data : []);
      setImports(Array.isArray(preferenceResult?.imports) ? preferenceResult.imports : []);
      const nextLimits = preferenceResult?.limits;
      if (!Number.isSafeInteger(nextLimits?.maxBytes) || nextLimits.maxBytes < 1
        || !Number.isSafeInteger(nextLimits?.maxRows) || nextLimits.maxRows < 1) {
        throw new Error("Excel 导入限制加载失败");
      }
      setExcelLimits({ maxBytes: nextLimits.maxBytes, maxRows: nextLimits.maxRows });
      return true;
    } catch (caught) {
      if (requestVersion !== loadRequestRef.current) return false;
      setError(caught?.message || "自动上架数据加载失败");
      if (hydratedAccountRef.current !== accountId) {
        form.setFieldsValue({ ...DEFAULT_FORM, targetStoreId: defaultStoreId });
        hydratedAccountRef.current = accountId;
      }
      return false;
    } finally {
      if (requestVersion === loadRequestRef.current) setLoading(false);
    }
  }, [accountId, defaultStoreId, form]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => () => { importDetailRequestRef.current += 1; }, []);

  const normalizedConfig = useCallback((values) => deriveAutoListingConfig({
    targetStoreId: values.targetStoreId,
    targetWarehouseId: values.targetWarehouseId,
    stock: values.stock,
    priceAdjustmentKopecks: amountToMinorUnits(values.priceAdjustmentAmount),
    image: {
      ratio: values.ratio,
      resolution: values.resolution,
      quality: values.quality,
      language: "ru",
      roles: values.roles,
    },
  }), []);

  const createTask = async () => {
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    setError("");
    setNotice("");
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      if (!currencyPresentation) throw new Error("当前店铺币种不支持自动上架，请检查店铺设置");
      const config = normalizedConfig(values);
      if (source === "collect" && !collectIds.length) throw new Error("请先从采集箱选择商品");
      if (source === "excel" && !workbook) throw new Error("请选择包含商品 SKU 的 Excel 文件");
      const excelFile = source === "excel"
        ? await readExcelFileAsBase64(workbook, { maxBytes: excelLimits.maxBytes }) : null;
      const fingerprint = JSON.stringify({
        accountId, source, collectIds, config,
        workbook: excelFile ? { name: excelFile.name, contentSha256: excelFile.contentSha256 } : null,
      });
      if (!createIntentRef.current || createIntentRef.current.fingerprint !== fingerprint) {
        createIntentRef.current = {
          fingerprint,
          correlationId: requestId("auto-listing"),
          idempotencyKey: requestId(source),
          preferenceIdempotencyKey: requestId("preferences"),
          expectedPreferenceVersion: preferenceVersion,
        };
      }
      const intent = createIntentRef.current;
      const savedPreference = await apiRequest("/auto-listing/preferences", {
        method: "PUT",
        body: {
          config,
          expectedVersion: intent.expectedPreferenceVersion,
          idempotencyKey: intent.preferenceIdempotencyKey,
          correlationId: intent.correlationId,
        },
      });
      if (!Number.isInteger(savedPreference?.data?.configVersion)) {
        throw new Error("上架配置保存结果无效，请刷新后重试");
      }
      setPreferenceVersion(savedPreference?.data?.configVersion);
      if (source === "collect") {
        await apiRequest("/auto-listing/jobs/from-collect-box", {
          method: "POST",
          body: {
            collectItemIds: collectIds, idempotencyKey: intent.idempotencyKey,
            config, correlationId: intent.correlationId,
          },
        });
      } else {
        const { contentSha256, ...uploadFile } = excelFile;
        await apiRequest("/auto-listing/imports/excel", {
          method: "POST",
          serializedBody: JSON.stringify({
            ...uploadFile, config, idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId,
          }),
          maxSerializedBodyBytes: autoListingExcelSerializedBodyLimit(excelLimits.maxBytes),
          timeoutMs: 60_000,
        });
        setWorkbook(null);
      }
      createIntentRef.current = null;
      setNotice("任务已创建");
      let refreshed = await loadData();
      try {
        await onRefresh?.();
      } catch {
        refreshed = false;
      }
      if (!refreshed) setError("任务已创建，但列表刷新失败，请手动刷新");
    } catch (caught) {
      setError(autoListingTaskErrorMessage(caught));
    } finally {
      createInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const openImportDetail = async (item) => {
    const requestVersion = ++importDetailRequestRef.current;
    setImportDetailOpen(true);
    setImportDetail(null);
    setImportDetailLoading(true);
    try {
      const result = await apiRequest(`/auto-listing/imports/${encodeURIComponent(item.id)}`);
      if (requestVersion !== importDetailRequestRef.current) return;
      setImportDetail(result?.data || null);
    } catch (caught) {
      if (requestVersion !== importDetailRequestRef.current) return;
      setImportDetail({ error: caught?.message || "导入详情加载失败" });
    } finally {
      if (requestVersion === importDetailRequestRef.current) setImportDetailLoading(false);
    }
  };

  const closeImportDetail = () => {
    importDetailRequestRef.current += 1;
    setImportDetailOpen(false);
    setImportDetailLoading(false);
    setImportDetail(null);
  };

  const retryFailedImportRows = async () => {
    if (!importDetail?.id || importActionId) return;
    setImportActionId(importDetail.id);
    setError("");
    try {
      await apiRequest(`/auto-listing/imports/${encodeURIComponent(importDetail.id)}/retry`, {
        method: "POST",
        body: {
          expectedStatusVersion: importDetail.statusVersion,
          idempotencyKey: requestId("import-retry"),
          correlationId: requestId("import-retry-correlation"),
        },
      });
      closeImportDetail();
      await loadData();
    } catch (caught) {
      if (caught?.status === 409) {
        closeImportDetail();
        await loadData();
        setError("导入状态已变化，请查看刷新后的导入进度");
      } else {
        setError(caught?.message || "失败行重试提交失败");
      }
    } finally {
      setImportActionId("");
    }
  };

  const openReview = async (itemId) => {
    const requestVersion = ++reviewRequestRef.current;
    setReviewOpen(true);
    setReview(null);
    setReviewLoading(true);
    try {
      const result = await apiRequest(`/auto-listing/items/${encodeURIComponent(itemId)}/review`);
      if (requestVersion !== reviewRequestRef.current) return;
      setReview(result?.data || null);
    } catch (caught) {
      if (requestVersion !== reviewRequestRef.current) return;
      setReview({ error: caught?.message || "审核内容加载失败" });
    } finally {
      if (requestVersion === reviewRequestRef.current) setReviewLoading(false);
    }
  };

  const closeReview = () => {
    reviewRequestRef.current += 1;
    setReviewOpen(false);
    setReviewLoading(false);
    setReview(null);
  };

  const performAction = async (row, action) => {
    if (actionItemId && actionItemId !== row.itemId) return;
    setError("");
    setActionItemId(row.itemId);
    try {
      await apiRequest(`/auto-listing/items/${encodeURIComponent(row.itemId)}/${action}`, {
        method: "POST",
        body: {
          jobId: row.jobId,
          expectedStatusVersion: row.statusVersion,
          idempotencyKey: requestId(action),
          correlationId: requestId("action"),
        },
      });
      await loadData();
    } catch (caught) {
      if (caught?.status === 409) {
        await loadData();
        setError("商品状态已变化，请查看刷新后的任务状态");
      } else {
        setError(caught?.message || "操作失败");
      }
    } finally {
      setActionItemId("");
    }
  };

  const confirmApprove = async (row) => {
    if (actionItemId) return;
    setError("");
    setActionItemId(row.itemId);
    try {
      const result = await apiRequest(`/auto-listing/items/${encodeURIComponent(row.itemId)}/review`);
      const evidence = result?.data;
      if (!evidence?.target || !evidence?.price || !Array.isArray(evidence.images)) {
        throw new Error("审核摘要读取失败，请刷新后重试");
      }
      const reviewCurrency = autoListingCurrencyPresentation(evidence.price.currency);
      const reviewAmount = kopecksToRubles(evidence.price.finalPriceKopecks);
      const reviewPriceText = reviewCurrency.currency === "CNY"
        ? `${reviewCurrency.symbol}${reviewAmount}` : `${reviewAmount} ${reviewCurrency.symbol}`;
      Modal.confirm({
        title: "确认上传到 Ozon",
        content: <Space direction="vertical" size={4}>
          <span>店铺：{storeLabels.get(String(evidence.target.storeId || "")) || "—"}</span>
          <span>仓库：{evidence.target.warehouseLabel || evidence.target.warehouseId}</span>
          <span>库存：{evidence.target.stock}</span>
          <span>上架价格：{reviewPriceText}</span>
          <span>商品变体：{evidence.target.variantCount} 个</span>
          <span>新图片：{evidence.images.length} 张</span>
          <span>确认后只替换商品图片和富文本，并使用以上冻结配置提交。</span>
        </Space>,
        okText: "确认上传",
        cancelText: "取消",
        onOk: () => performAction(row, "approve"),
        onCancel: () => setActionItemId(""),
      });
    } catch (caught) {
      setActionItemId("");
      setError(caught?.message || "审核摘要读取失败");
    }
  };

  const taskRows = autoListingTaskRows(jobs);
  const taskColumns = [
    { title: "商品", dataIndex: "sourceRecordId", render: (value, row) => row.title || row.sku || value || row.itemId },
    { title: "任务进度", dataIndex: "status", render: (_value, row) => {
      const item = autoListingItemPresentation(row);
      return <Space direction="vertical" size={2}><Tag>{item.statusLabel}</Tag>{item.failureLabel ? <span>{item.failureLabel}</span> : null}</Space>;
    } },
    { title: "上架店铺", dataIndex: "targetStoreId", render: (value) => storeLabels.get(String(value || "")) || "—" },
    { title: "创建时间", dataIndex: "jobCreatedAt", render: (value) => autoListingCreatedAtLabel(value) },
    { title: "操作", key: "actions", render: (_value, row) => {
      const item = autoListingItemPresentation(row);
      return <Space wrap>
        {item.actions.review ? <Button size="small" disabled={Boolean(actionItemId) || reviewLoading} icon={<EyeOutlined />} onClick={() => openReview(row.itemId)}>查看</Button> : null}
        {item.actions.approve ? <Button type="primary" size="small" loading={actionItemId === row.itemId} disabled={Boolean(actionItemId)} icon={<CloudUploadOutlined />} onClick={() => confirmApprove(row)}>审核通过并上架</Button> : null}
        {item.actions.regenerate ? <Button size="small" loading={actionItemId === row.itemId} disabled={Boolean(actionItemId)} icon={<ReloadOutlined />} onClick={() => performAction(row, "regenerate")}>重新生成</Button> : null}
        {item.actions.retry ? <Button size="small" loading={actionItemId === row.itemId} disabled={Boolean(actionItemId)} icon={<ReloadOutlined />} onClick={() => performAction(row, "retry")}>重试</Button> : null}
        {item.actions.cancel ? <Button size="small" danger loading={actionItemId === row.itemId} disabled={Boolean(actionItemId)} icon={<StopOutlined />} onClick={() => performAction(row, "cancel")}>取消任务</Button> : null}
      </Space>;
    } },
  ];

  return <div className="auto-listing-page">
    <div className="auto-listing-page__header">
      <div><h1>自动上架</h1><p>生成全新的商品图片和富文本；类目、属性、SKU、重量、尺寸等商品底稿保持不变。</p></div>
      <Space wrap>
        <Tag color="blue">按当前上传策略处理</Tag>
        {account?.role === "admin" ? <Button icon={<SettingOutlined />}
          onClick={() => navigate("/ozon/tools/auto-listing/ai-settings")}>AI 模型配置</Button> : null}
      </Space>
    </div>
    {notice ? <Alert type="success" showIcon title={notice} closable onClose={() => setNotice("")} /> : null}
    {error ? <Alert type="error" showIcon title={error} closable onClose={() => setError("")} /> : null}
    <Spin spinning={loading}>
      <Card title="1. 选择商品来源">
        <Tabs activeKey={source} onChange={setSource} items={[
          { key: "collect", label: "采集箱推送", children: collectIds.length
            ? <Alert type="info" showIcon title={`已选择 ${collectIds.length} 个采集箱商品`} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先在采集箱勾选商品并点击“推送到自动上架”" /> },
          { key: "excel", label: "Excel SKU", children: <Upload.Dragger
            accept=".xlsx"
            maxCount={1}
            fileList={workbook ? [workbook] : []}
            beforeUpload={(file) => { setWorkbook(file); return false; }}
            onRemove={() => { setWorkbook(null); return true; }}
          ><CloudUploadOutlined /><p>上传包含商品 SKU 的 Excel 文件</p><span>最大 {byteLimitLabel(excelLimits.maxBytes)}，最多 {excelLimits.maxRows} 行；每一行独立处理</span></Upload.Dragger> },
        ]} />
      </Card>

      <Card title="2. 配置上架信息">
        <Form form={form} layout="vertical" initialValues={DEFAULT_FORM}>
          <div className="auto-listing-grid auto-listing-grid--four">
            <Form.Item name="targetStoreId" label="上架店铺" rules={[{ required: true, message: "请选择上架店铺" }]}>
              <Select options={stores.map((store) => {
                const presentation = safeCurrencyPresentation(storeCurrency(store));
                const label = safeStoreLabel(store);
                return {
                  value: store.id,
                  label: presentation ? `${label}（${presentation.name} ${presentation.currency}）` : `${label}（币种未同步）`,
                  disabled: !presentation,
                };
              })} />
            </Form.Item>
            <Form.Item name="targetWarehouseId" label="活跃 FBS / RFBS 仓库" rules={[{ required: true, message: "请选择活跃 FBS / RFBS 仓库" }]}>
              <Select options={warehouseChoice.options} placeholder="只显示后端确认可用或创建时可验证的仓库" />
            </Form.Item>
            <Form.Item name="stock" label="上架库存" rules={[{ required: true }]}><InputNumber min={1} precision={0} /></Form.Item>
            <Form.Item name="priceAdjustmentAmount"
              label={`售价加减（${currencyPresentation ? `${currencyPresentation.name} ${currencyPresentation.symbol}` : "请选择支持的店铺币种"}）`}
              rules={[{ required: true }]}><Input /></Form.Item>
          </div>
          {selectedStoreId && !currencyPresentation
            ? <Alert type="error" showIcon title="店铺币种尚未同步，请先同步店铺资料。" /> : null}
          <Alert type="info" showIcon title="RFBS 新店仓库将在创建任务时由后端只读验证，不会在验证阶段创建商品或修改库存。" />
          <Alert type="info" showIcon title="售价计算规则"
            description={`所有金额均按店铺原币计算。黑标价大于等于 80 ${currencyPresentation?.symbol || ""}：真实售价＝（黑标价－绿标价）×2.25＋黑标价；低于 80 ${currencyPresentation?.symbol || ""}：真实售价＝黑标价÷1.0715。最后再加上或减去上面的金额。`} />

          <div className="auto-listing-section-title">图片生成配置</div>
          <div className="auto-listing-grid auto-listing-grid--four">
            <Form.Item name="ratio" label="图片比例"><Select options={["16:9", "9:16", "2:3", "3:2", "1:1", "3:4", "4:3"].map((value) => ({ value }))} /></Form.Item>
            <Form.Item name="language" label="图片语言"><Select disabled options={[{ value: "ru", label: "俄语" }]} /></Form.Item>
            <Form.Item name="resolution" label="图片分辨率"><Select options={["1K", "2K", "4K"].map((value) => ({ value }))} /></Form.Item>
            <Form.Item name="quality" label="图片质量"><Select options={["Low", "Medium", "High", "Ultra"].map((value) => ({ value }))} /></Form.Item>
          </div>
          <div className="auto-listing-role-grid">
            {ROLE_FIELDS.map(([key, label, min, max]) => <Form.Item key={key} name={["roles", key]} label={label}>
              <InputNumber min={min} max={max} precision={0} />
            </Form.Item>)}
          </div>
          <div className="auto-listing-total">图片数量：<strong>{imageTotal}</strong> 张（允许 6～13 张）</div>
        </Form>
        <Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={submitting} onClick={createTask}>创建生成任务</Button>
      </Card>

      <Card title="3. 导入与任务进度" extra={<Button onClick={loadData}>刷新</Button>}>
        {imports.length ? <div className="auto-listing-imports">{imports.map((item) => {
          const progress = autoListingImportProgress(item);
          return <div key={item.id} className="auto-listing-import-row">
            <span>{item.sourceFileName}</span><span>{progress.statusLabel}</span><span>{progress.completed}/{progress.total}</span>
            <Button size="small" icon={<EyeOutlined />} disabled={Boolean(importActionId)} onClick={() => openImportDetail(item)}>查看失败行</Button>
          </div>;
        })}</div> : null}
        <Table rowKey="itemId" dataSource={taskRows} columns={taskColumns} pagination={{ pageSize: 10 }} locale={{ emptyText: "暂无自动上架任务" }} />
      </Card>
    </Spin>

    <Drawer title="生成结果审核" open={reviewOpen} onClose={closeReview} size="large">
      <Spin spinning={reviewLoading}>
        {review?.error ? <Alert type="error" title={review.error} /> : review ? <>
          <Card size="small" title="商品与目标"><p>{review.source?.title || review.source?.sku || "—"}</p><p>店铺：{storeLabels.get(String(review.target?.storeId || "")) || "—"}</p><p>仓库：{review.target?.warehouseLabel || review.target?.warehouseId || "—"}</p></Card>
          {review.source?.thumbnailUrl ? <Card size="small" title="采集来源图片"><div className="auto-listing-review-images"><img src={review.source.thumbnailUrl} alt="采集来源商品" /></div></Card> : null}
          {(review.visualGroups || []).map((group) => <Card key={group.key} size="small" title={`生成图片组：${group.key}`}>
            <div className="auto-listing-review-images">{(review.images || []).filter((image) => image.visualGroupKey === group.key).map((image) => <Card key={image.id || image.url} size="small" title={image.roleLabel || image.role}><img src={image.url} alt={image.roleLabel || "生成商品图"} /><Tag color={image.accepted ? "green" : "orange"}>{image.accepted ? "已通过检查" : "待检查"}</Tag></Card>)}</div>
          </Card>)}
          <Card title="富文本预览"><div className="auto-listing-rich-preview">{review.richContent?.previewText || review.richContent?.text || "暂无富文本内容"}</div></Card>
          <Card title="价格与事件记录"><pre>{JSON.stringify({ price: review.price, timeline: review.timeline }, null, 2)}</pre></Card>
        </> : <Empty description="暂无可审核内容" />}
      </Spin>
    </Drawer>

    <Drawer title="Excel 导入详情" open={importDetailOpen} onClose={closeImportDetail} size="large"
      extra={importDetail?.actions?.retry ? <Button type="primary" icon={<ReloadOutlined />}
        loading={importActionId === importDetail.id} onClick={retryFailedImportRows}>重试失败行</Button> : null}>
      <Spin spinning={importDetailLoading}>
        {importDetail?.error ? <Alert type="error" title={importDetail.error} /> : importDetail ? <>
          <Alert type={importDetail.recoverableFailedRows ? "warning" : "info"} showIcon
            title={`${importDetail.sourceFileName || "Excel"}：${importDetail.failedRows || 0} 行失败`}
            description={importDetail.recoverableFailedRows
              ? `其中 ${importDetail.recoverableFailedRows} 行可重新采集；重试会建立独立批次，不影响已成功商品。`
              : "没有可自动重试的失败行。"} />
          {importDetail.rowsTruncated ? <Alert type="info" showIcon title="失败行较多，当前仅显示前 1000 行" /> : null}
          <Table rowKey="rowNumber" pagination={{ pageSize: 20 }} dataSource={(importDetail.rows || []).map((row) => ({
            ...autoListingImportRowPresentation(row),
          }))} columns={[
            { title: "Excel 行", dataIndex: "rowNumber" },
            { title: "SKU", dataIndex: "sku", render: (value) => value || "—" },
            { title: "状态", dataIndex: "statusLabel", render: (value, row) => <Space direction="vertical" size={2}><Tag>{value}</Tag>{row.errorLabel ? <span>{row.errorLabel}</span> : null}</Space> },
            { title: "采集次数", dataIndex: "attemptCount" },
          ]} />
        </> : <Empty description="暂无导入详情" />}
      </Spin>
    </Drawer>
  </div>;
}
