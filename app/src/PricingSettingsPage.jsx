import React, { useEffect, useState } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Upload,
} from "antd";
import Table from "./PagedTable.jsx";
import {
  CloudUploadOutlined,
  DeleteOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { apiRequest, postMessageRequest } from "./client-transport.js";
import { SourceSectionTitle } from "./SourceTable.jsx";

const accountLastLoginText = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const pricingStatusMeta = {
  DRAFT: ["草稿", "default"],
  VALIDATED: ["已校验", "blue"],
  SCHEDULED: ["待生效", "orange"],
  ACTIVE: ["生效中", "green"],
  RETIRED: ["已停用", "default"],
};

export default function PricingSettingsPage({ account, binding }) {
  const { message } = AntApp.useApp();
  const [versions, setVersions] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState("默认参数");
  const [simulation, setSimulation] = useState({
    mode: "profit", purchaseCostCny: 100, sellingPriceCny: 200, weightG: 500,
    logisticsProvider: "XY", fulfillmentType: "RFBS", categoryId: "*",
  });
  const [simulationResult, setSimulationResult] = useState(null);
  const [officialFiles, setOfficialFiles] = useState([]);
  const [importingOfficial, setImportingOfficial] = useState(false);
  const [officialImportSummary, setOfficialImportSummary] = useState(null);
  const [fxStatus, setFxStatus] = useState({ probes: [], rate: null, intervalMinutes: 120 });
  const [fxLoading, setFxLoading] = useState(false);
  const [fxRefreshing, setFxRefreshing] = useState(false);
  const [fxModalOpen, setFxModalOpen] = useState(false);
  const [fxEditing, setFxEditing] = useState(null);
  const [fxForm] = Form.useForm();

  const loadVersions = async (preferredId = "") => {
    setLoading(true);
    try {
      const response = await apiRequest("/admin/pricing/versions");
      const next = response.versions || [];
      setVersions(next);
      const id = preferredId || config?.id || next.find((item) => item.status === "DRAFT")?.id || next.find((item) => item.status === "ACTIVE")?.id || next[0]?.id;
      if (id) {
        const detail = await apiRequest(`/admin/pricing/versions/${encodeURIComponent(id)}`);
        setConfig(detail.config);
      }
    } catch (error) {
      message.error(`加载算价配置失败：${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const loadFxStatus = async () => {
    setFxLoading(true);
    try {
      const response = await apiRequest("/admin/pricing/fx");
      setFxStatus(response || { probes: [], rate: null, intervalMinutes: 120 });
    } catch (error) {
      message.error(`加载动态汇率失败：${error.message}`);
    } finally {
      setFxLoading(false);
    }
  };

  useEffect(() => {
    loadVersions();
    loadFxStatus();
  }, []);

  if (account?.role !== "admin") {
    return <div className="source-page hidden-route-page"><Card><Empty description="仅管理员可管理算价配置" /></Card></div>;
  }

  const editable = ["DRAFT", "VALIDATED"].includes(config?.status);
  const patchConfig = (key, value) => setConfig((current) => ({ ...current, [key]: value }));
  const patchNested = (key, field, value) => setConfig((current) => ({ ...current, [key]: { ...(current?.[key] || {}), [field]: value } }));
  const patchRow = (key, index, field, value) => setConfig((current) => ({
    ...current,
    [key]: (current?.[key] || []).map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row),
  }));
  const addRow = (key, row) => setConfig((current) => ({ ...current, [key]: [...(current?.[key] || []), row] }));
  const removeRow = (key, index) => setConfig((current) => ({ ...current, [key]: (current?.[key] || []).filter((_, rowIndex) => rowIndex !== index) }));

  const createDraft = async (cloneVersionId = "") => {
    try {
      const response = await apiRequest("/admin/pricing/versions", { method: "POST", body: { scopeType: "global", cloneVersionId, note: cloneVersionId ? "从历史版本恢复" : "新算价配置" } });
      await loadVersions(response.config?.id);
      message.success(cloneVersionId ? "已复制为新草稿，请校验后发布" : "已创建配置草稿");
    } catch (error) {
      message.error(`创建失败：${error.message}`);
    }
  };

  const fileAsBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });

  const importOfficialCommission = async () => {
    if (!officialFiles.length) {
      message.warning("请先选择 Ozon 官方佣金表");
      return;
    }
    setImportingOfficial(true);
    try {
      const files = [];
      for (const item of officialFiles) {
        const file = item.originFileObj || item;
        files.push({
          name: file.name,
          contentType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          base64: await fileAsBase64(file),
        });
      }
      const response = await apiRequest("/admin/pricing/official-commission/import", {
        method: "POST",
        body: { files, cloneVersionId: config?.id || "" },
      });
      setOfficialFiles([]);
      setOfficialImportSummary(response.summary || null);
      setSection("佣金规则");
      await loadVersions(response.config?.id);
      message.success(`已导入 ${response.summary?.summaryRuleCount || 0} 条官方佣金规则，请校验后发布`);
    } catch (error) {
      message.error(`导入失败：${error.message}`);
    } finally {
      setImportingOfficial(false);
    }
  };

  const saveConfig = async () => {
    if (!config?.id || !editable) return;
    setSaving(true);
    try {
      const response = await apiRequest(`/admin/pricing/versions/${encodeURIComponent(config.id)}`, { method: "PUT", body: config });
      setConfig(response.config);
      await loadVersions(config.id);
      message.success("配置草稿已保存");
    } catch (error) {
      message.error(`保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const validateConfig = async () => {
    if (!config?.id) return;
    try {
      if (editable) await saveConfig();
      const response = await apiRequest(`/admin/pricing/versions/${encodeURIComponent(config.id)}/validate`, { method: "POST" });
      await loadVersions(config.id);
      message.success(response.validation?.valid ? "配置校验通过" : "配置校验失败");
    } catch (error) {
      message.error(error.message);
    }
  };

  const publishConfig = () => {
    if (!config?.id) return;
    Modal.confirm({
      title: "发布算价配置",
      content: `发布版本 V${config.versionNo} 后，新计算立即采用该版本；历史快照不会变化。`,
      okText: "立即发布",
      cancelText: "取消",
      onOk: async () => {
        try {
          if (editable) await saveConfig();
          await apiRequest(`/admin/pricing/versions/${encodeURIComponent(config.id)}/publish`, { method: "POST", body: {} });
          await loadVersions(config.id);
          message.success("算价配置已发布");
        } catch (error) {
          message.error(`发布失败：${error.message}`);
        }
      },
    });
  };

  const runSimulation = async () => {
    try {
      const response = await apiRequest("/admin/pricing/simulate", { method: "POST", body: { ...simulation, configVersionId: config?.id, storeId: binding?.id || "" } });
      setSimulationResult(response.result);
    } catch (error) {
      setSimulationResult(null);
      message.error(`模拟失败：${error.message}`);
    }
  };

  const openFxProbe = (probe = null) => {
    setFxEditing(probe);
    fxForm.setFieldsValue({ sku: probe?.sku || "", label: probe?.label || "", status: probe?.status || "ACTIVE" });
    setFxModalOpen(true);
  };

  const saveFxProbe = async (values) => {
    try {
      if (fxEditing?.id) {
        await apiRequest(`/admin/pricing/fx/probes/${encodeURIComponent(fxEditing.id)}`, { method: "PATCH", body: values });
      } else {
        await apiRequest("/admin/pricing/fx/probes", { method: "POST", body: values });
      }
      setFxModalOpen(false);
      setFxEditing(null);
      await loadFxStatus();
      message.success(fxEditing ? "汇率 SKU 已更新" : "汇率 SKU 已添加");
    } catch (error) {
      message.error(`保存失败：${error.message}`);
    }
  };

  const removeFxProbe = (probe) => {
    Modal.confirm({
      title: "删除汇率 SKU",
      content: `确认删除 SKU ${probe.sku}？其历史采价记录会一并删除。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await apiRequest(`/admin/pricing/fx/probes/${encodeURIComponent(probe.id)}`, { method: "DELETE" });
        await loadFxStatus();
        message.success("已删除");
      },
    });
  };

  const refreshFxNow = async () => {
    setFxRefreshing(true);
    try {
      const response = await postMessageRequest(
        { __jzcExt: 1, action: "refreshFxProbes", payload: {} },
        "__jzcExtResp",
        90_000,
      );
      await loadFxStatus();
      message.success(`汇率采集完成：1 CNY = ${Number(response?.data?.rate || 0).toFixed(4)} RUB`);
    } catch (error) {
      await loadFxStatus();
      message.error(`采集失败：${error.message}`);
    } finally {
      setFxRefreshing(false);
    }
  };

  const numericInput = (value, onChange, extra = {}) => <InputNumber value={value} onChange={(next) => onChange(next ?? 0)} controls={false} style={{ width: "100%" }} disabled={!editable} {...extra} />;
  const commissionColumns = [
    { title: "规则名称", width: 150, render: (_, row) => <Input value={row.ruleName} disabled={!editable} onChange={(event) => patchRow("commissionRules", config.commissionRules.indexOf(row), "ruleName", event.target.value)} /> },
    { title: "Ozon 类目键", width: 220, render: (_, row) => <Input value={row.ozonCategoryId} disabled={!editable} onChange={(event) => patchRow("commissionRules", config.commissionRules.indexOf(row), "ozonCategoryId", event.target.value)} /> },
    { title: "履约", width: 105, render: (_, row) => <Select value={row.fulfillmentType} disabled={!editable} style={{ width: "100%" }} options={["RFBS", "FBP", "WHD", "FBS", "FBO", "ALL"].map((value) => ({ value, label: value }))} onChange={(value) => patchRow("commissionRules", config.commissionRules.indexOf(row), "fulfillmentType", value)} /> },
    { title: "最低价 ₽", width: 110, render: (_, row) => numericInput(row.minPriceRub, (value) => patchRow("commissionRules", config.commissionRules.indexOf(row), "minPriceRub", value), { min: 0 }) },
    { title: "最高价 ₽", width: 110, render: (_, row) => numericInput(row.maxPriceRub, (value) => patchRow("commissionRules", config.commissionRules.indexOf(row), "maxPriceRub", value), { min: 0, placeholder: "不限" }) },
    { title: "佣金率 %", width: 105, render: (_, row) => numericInput(row.commissionRate, (value) => patchRow("commissionRules", config.commissionRules.indexOf(row), "commissionRate", value), { min: 0, max: 99 }) },
    { title: "操作", width: 70, render: (_, row) => <Button danger type="text" disabled={!editable} icon={<DeleteOutlined />} onClick={() => removeRow("commissionRules", config.commissionRules.indexOf(row))} /> },
  ];
  const logisticsColumns = [
    { title: "物流商", width: 110, render: (_, row) => <Input value={row.provider} disabled={!editable} onChange={(event) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "provider", event.target.value.toUpperCase())} /> },
    { title: "线路", width: 110, render: (_, row) => <Input value={row.routeCode} disabled={!editable} onChange={(event) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "routeCode", event.target.value)} /> },
    { title: "仓库", width: 105, render: (_, row) => <Input value={row.warehouseId} disabled={!editable} onChange={(event) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "warehouseId", event.target.value)} /> },
    { title: "起重 g", width: 95, render: (_, row) => numericInput(row.minWeightG, (value) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "minWeightG", value), { min: 0 }) },
    { title: "止重 g", width: 95, render: (_, row) => numericInput(row.maxWeightG, (value) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "maxWeightG", value), { min: 0, placeholder: "不限" }) },
    { title: "基础费 ¥", width: 100, render: (_, row) => numericInput(row.baseFeeCny, (value) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "baseFeeCny", value), { min: 0 }) },
    { title: "每 kg ¥", width: 100, render: (_, row) => numericInput(row.feePerKgCny, (value) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "feePerKgCny", value), { min: 0 }) },
    { title: "最低费 ¥", width: 100, render: (_, row) => numericInput(row.minimumFeeCny, (value) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "minimumFeeCny", value), { min: 0 }) },
    { title: "计体积重", width: 90, render: (_, row) => <Switch checked={Boolean(row.useVolumeWeight)} disabled={!editable} onChange={(value) => patchRow("logisticsRules", config.logisticsRules.indexOf(row), "useVolumeWeight", value)} /> },
    { title: "操作", width: 70, render: (_, row) => <Button danger type="text" disabled={!editable} icon={<DeleteOutlined />} onClick={() => removeRow("logisticsRules", config.logisticsRules.indexOf(row))} /> },
  ];
  const fxColumns = [
    { title: "SKU", dataIndex: "sku", width: 135 },
    { title: "备注", dataIndex: "label", width: 150, render: (value) => value || "—" },
    { title: "前台价 ₽", dataIndex: "rubPrice", width: 105, render: (value) => value == null ? "—" : Number(value).toFixed(2) },
    { title: "前台价 ¥", dataIndex: "cnyPrice", width: 105, render: (value) => value == null ? "—" : Number(value).toFixed(2) },
    { title: "隐含汇率", dataIndex: "impliedRate", width: 105, render: (value) => value == null ? "—" : Number(value).toFixed(4) },
    { title: "最近采集", dataIndex: "observedAt", width: 170, render: accountLastLoginText },
    { title: "状态", width: 105, render: (_, row) => <Tag color={row.status === "ACTIVE" ? "green" : "default"}>{row.status === "ACTIVE" ? "启用" : "停用"}</Tag> },
    { title: "错误", dataIndex: "lastError", width: 220, ellipsis: true, render: (value) => value || "—" },
    { title: "操作", width: 110, fixed: "right", render: (_, row) => <Space size={2}><Button type="link" size="small" onClick={() => openFxProbe(row)}>编辑</Button><Button danger type="link" size="small" onClick={() => removeFxProbe(row)}>删除</Button></Space> },
  ];

  return (
    <div className="source-page hidden-route-page pricing-settings-page">
      <SourceSectionTitle title="算价配置" subtitle="管理算价版本、物流规则与汇率设置" />
      <div className="pricing-settings-layout">
        <Card className="panel-card pricing-version-panel" loading={loading}>
          <div className="card-title-row"><span>配置版本</span><Button type="primary" icon={<PlusOutlined />} onClick={() => createDraft(config?.id || "")}>新建草稿</Button></div>
          <div className="pricing-version-list">
            {versions.map((item) => {
              const meta = pricingStatusMeta[item.status] || [item.status, "default"];
              return <button className={item.id === config?.id ? "active" : ""} key={item.id} type="button" onClick={() => loadVersions(item.id)}>
                <span>V{item.versionNo}</span><Tag color={meta[1]}>{meta[0]}</Tag><em>{item.note || "未命名版本"}</em>
              </button>;
            })}
          </div>
          {config?.status === "RETIRED" ? <Button block onClick={() => createDraft(config.id)}>复制此版本并恢复</Button> : null}
        </Card>

        <Card className="panel-card pricing-editor-panel" loading={loading}>
          <div className="card-title-row">
            <span>动态算价配置 {config ? <em>V{config.versionNo}</em> : null}</span>
            <Space wrap>
              <Button disabled={!editable} loading={saving} onClick={saveConfig}>保存草稿</Button>
              <Button disabled={!config || !editable} onClick={validateConfig}>校验</Button>
              <Button type="primary" disabled={!config || !["DRAFT", "VALIDATED"].includes(config.status)} onClick={publishConfig}>发布</Button>
            </Space>
          </div>
          {!config ? <Empty description="暂无算价配置" /> : <>
            <Alert type={config.status === "ACTIVE" ? "success" : "info"} showIcon message={`当前版本状态：${pricingStatusMeta[config.status]?.[0] || config.status}`} description="已发布版本不可直接修改；发布新版本不会改变历史算价与上架任务快照。" />
            {config.ruleConfirmationStatus !== "CONFIRMED" ? <Alert
              type="warning"
              showIcon
              message="这套规则的业务依据还没有确认"
              description="系统示例数字不能直接用于经营。请核对 Ozon 佣金文件、物流报价、汇率和各项费用来源，确认无误并保存后，才能校验、模拟和发布。"
            /> : null}
            <Segmented className="pricing-section-tabs" options={["默认参数", "佣金规则", "物流规则", "国内费用", "模拟计算"]} value={section} onChange={setSection} />

            {section === "默认参数" ? <div className="pricing-default-grid">
              <label>版本说明<Input value={config.note} disabled={!editable} onChange={(event) => patchConfig("note", event.target.value)} /></label>
              <label>规则依据状态<Select
                value={config.ruleConfirmationStatus || "UNCONFIRMED"}
                disabled={!editable}
                options={[
                  { value: "UNCONFIRMED", label: "待确认（不可发布）" },
                  { value: "CONFIRMED", label: "已逐项核对来源" },
                ]}
                onChange={(value) => patchConfig("ruleConfirmationStatus", value)}
              /></label>
              <label>广告费率 %{numericInput(config.defaults?.adRate, (value) => patchNested("defaults", "adRate", value), { min: 0, max: 99 })}</label>
              <label>提现费率 %{numericInput(config.defaults?.withdrawalRate, (value) => patchNested("defaults", "withdrawalRate", value), { min: 0, max: 99 })}</label>
              <label>退货损失率 %{numericInput(config.defaults?.returnLossRate, (value) => patchNested("defaults", "returnLossRate", value), { min: 0, max: 99 })}</label>
              <label>目标利润率 %{numericInput(config.defaults?.targetMarginRate, (value) => patchNested("defaults", "targetMarginRate", value), { min: 0, max: 99 })}</label>
              <label>前台折扣率 %{numericInput(config.defaults?.frontendDiscountRate, (value) => patchNested("defaults", "frontendDiscountRate", value), { min: 1, max: 100 })}</label>
              <label>其他固定费 ¥{numericInput(config.defaults?.otherFixedFeeCny, (value) => patchNested("defaults", "otherFixedFeeCny", value), { min: 0 })}</label>
            </div> : null}

            {section === "默认参数" ? <div className="pricing-fx-panel">
              <div className="card-title-row">
                <div>
                  <strong>动态 CNY/RUB 汇率</strong>
                  <span>每 2 小时按启用 SKU 的 Ozon 前台真实 RUB/CNY 售价计算，中位数去除异常值。</span>
                </div>
                <Space wrap>
                  <Button loading={fxRefreshing} onClick={refreshFxNow}>立即采集</Button>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openFxProbe()}>新增 SKU</Button>
                </Space>
              </div>
              {fxStatus.rate ? <Alert
                type={fxStatus.rate.stale ? "warning" : "success"}
                showIcon
                message={`1 CNY = ${Number(fxStatus.rate.rate).toFixed(6)} RUB`}
                description={`采样 ${fxStatus.rate.acceptedCount}/${fxStatus.rate.sampleCount}；可信度 ${fxStatus.rate.confidence}；计算时间 ${accountLastLoginText(fxStatus.rate.computedAt)}${fxStatus.rate.stale ? "；数据已超过 6 小时，请检查插件或 Ozon 登录态" : ""}`}
              /> : <Alert type="warning" showIcon message="尚无动态汇率" description="请新增能够同时返回 RUB 与 CNY 前台价的 SKU，并确保插件已登录后执行采集。产生首个有效快照前，系统仅保留历史版本汇率作为故障兜底。" />}
              <Table
                rowKey="id"
                size="small"
                loading={fxLoading}

                scroll={{ x: 1100 }}
                dataSource={fxStatus.probes || []}
                columns={fxColumns}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无汇率 SKU" /> }}
              />
            </div> : null}

            {section === "佣金规则" ? <>
              <div className="pricing-official-import">
                <div>
                  <strong>Ozon 官方佣金表</strong>
                  <span>上传后创建新草稿，并完整替换草稿中的旧佣金规则；原文件存入 MinIO。</span>
                </div>
                <Space wrap>
                  <Upload
                    accept=".xlsx"
                    multiple
                    maxCount={5}
                    beforeUpload={() => false}
                    fileList={officialFiles}
                    onChange={({ fileList }) => setOfficialFiles(fileList)}
                  >
                    <Button icon={<CloudUploadOutlined />}>选择官方表</Button>
                  </Upload>
                  <Button type="primary" loading={importingOfficial} disabled={!officialFiles.length} onClick={importOfficialCommission}>导入并生成草稿</Button>
                </Space>
              </div>
              {officialImportSummary ? <Alert type="success" showIcon message={`已导入 ${officialImportSummary.summaryRuleCount} 条规则`} description={`${officialImportSummary.categoryCount} 个官方类目；${officialImportSummary.detailMappingCount} 条商品类型映射；履约：${officialImportSummary.fulfillmentTypes?.join(" / ")}`} /> : null}
              {(config.officialImports || []).length ? <Alert type="info" showIcon message={`当前版本来自 ${config.officialImports.length} 份 Ozon 官方文件`} description={config.officialImports.map((item) => `${item.sourceName}（${item.fulfillmentTypes?.join("/")}，${item.summaryRuleCount} 条）`).join("；")} /> : null}
              <div className="pricing-table-actions"><span>按 Ozon 官方类目、履约方式和卢布售价区间匹配；未命中时不会静默套用通用费率。</span><Button disabled={!editable} icon={<PlusOutlined />} onClick={() => addRow("commissionRules", { ruleName: "新佣金规则", ozonCategoryId: "*", fulfillmentType: "RFBS", minPriceRub: 0, maxPriceRub: null, commissionRate: 0, priority: 100 })}>新增规则</Button></div>
              <Table rowKey={(row) => row.id || `${row.ruleName}-${row.fulfillmentType}-${row.minPriceRub}`} size="small" pagination={{ showTotal: (total) => `共 ${total} 条` }} scroll={{ x: 950 }} dataSource={config.commissionRules || []} columns={commissionColumns} />
            </> : null}

            {section === "物流规则" ? <>
              <div className="pricing-table-actions"><span>支持基础费、公斤费、最低费和体积重。</span><Button disabled={!editable} icon={<PlusOutlined />} onClick={() => addRow("logisticsRules", { provider: "XY", routeCode: "", warehouseId: "*", minWeightG: 0, maxWeightG: null, baseFeeCny: 0, feePerKgCny: 0, minimumFeeCny: 0, useVolumeWeight: false, volumeDivisor: 6000, priority: 100 })}>新增规则</Button></div>
              <Table rowKey={(row) => row.id || `${row.provider}-${row.minWeightG}`} size="small"  scroll={{ x: 1100 }} dataSource={config.logisticsRules || []} columns={logisticsColumns} />
            </> : null}

            {section === "国内费用" ? <div className="pricing-domestic-list">
              {(config.domesticFeeRules || []).map((row, index) => <div key={row.id || index}>
                <label>仓库 ID<Input value={row.warehouseId} disabled={!editable} onChange={(event) => patchRow("domesticFeeRules", index, "warehouseId", event.target.value)} /></label>
                <label>国内运费 ¥{numericInput(row.domesticShippingCny, (value) => patchRow("domesticFeeRules", index, "domesticShippingCny", value), { min: 0 })}</label>
                <label>代贴费 ¥{numericInput(row.labelingFeeCny, (value) => patchRow("domesticFeeRules", index, "labelingFeeCny", value), { min: 0 })}</label>
                <label>包装费 ¥{numericInput(row.packagingFeeCny, (value) => patchRow("domesticFeeRules", index, "packagingFeeCny", value), { min: 0 })}</label>
                <label>操作费 ¥{numericInput(row.operationFeeCny, (value) => patchRow("domesticFeeRules", index, "operationFeeCny", value), { min: 0 })}</label>
                <Button danger type="text" disabled={!editable} icon={<DeleteOutlined />} onClick={() => removeRow("domesticFeeRules", index)} />
              </div>)}
              <Button disabled={!editable} icon={<PlusOutlined />} onClick={() => addRow("domesticFeeRules", { warehouseId: "*", domesticShippingCny: 0, labelingFeeCny: 0, packagingFeeCny: 0, operationFeeCny: 0, priority: 100 })}>新增仓库费用</Button>
            </div> : null}

            {section === "模拟计算" ? <div className="pricing-simulator">
              <div className="pricing-default-grid">
                <label>模式<Select value={simulation.mode} options={[{ value: "profit", label: "利润计算" }, { value: "pricing", label: "反算售价" }]} onChange={(value) => setSimulation((old) => ({ ...old, mode: value }))} /></label>
                <label>采购成本 ¥<InputNumber value={simulation.purchaseCostCny} onChange={(value) => setSimulation((old) => ({ ...old, purchaseCostCny: value || 0 }))} /></label>
                <label>售价 ¥<InputNumber value={simulation.sellingPriceCny} disabled={simulation.mode === "pricing"} onChange={(value) => setSimulation((old) => ({ ...old, sellingPriceCny: value || 0 }))} /></label>
                <label>重量 g<InputNumber value={simulation.weightG} onChange={(value) => setSimulation((old) => ({ ...old, weightG: value || 0 }))} /></label>
                <label>物流商<Select value={simulation.logisticsProvider} options={[{ value: "XY" }, { value: "GUOO" }, { value: "CAINIAO" }]} onChange={(value) => setSimulation((old) => ({ ...old, logisticsProvider: value }))} /></label>
                <label>履约方式<Select value={simulation.fulfillmentType} options={[{ value: "RFBS" }, { value: "FBP" }, { value: "WHD" }, { value: "FBS" }, { value: "FBO" }]} onChange={(value) => setSimulation((old) => ({ ...old, fulfillmentType: value }))} /></label>
                <label>官方类目键<Input value={simulation.categoryId} onChange={(event) => setSimulation((old) => ({ ...old, categoryId: event.target.value }))} /></label>
              </div>
              <Button type="primary" onClick={runSimulation}>运行模拟</Button>
              {simulationResult ? <div className="pricing-simulation-result">
                <strong>售价 ¥{simulationResult.sellingPriceCny}</strong><strong>利润 ¥{simulationResult.netProfitCny}</strong><span>利润率 {simulationResult.profitMarginRate}%</span><span>佣金 {simulationResult.commissionRate}%</span><span>物流 ¥{simulationResult.logistics?.amount}</span>
              </div> : null}
            </div> : null}
          </>}
        </Card>
      </div>
      <Modal
        rootClassName="prototype-overlay"
        title={fxEditing ? "编辑汇率 SKU" : "新增汇率 SKU"}
        open={fxModalOpen}
        onCancel={() => setFxModalOpen(false)}
        onOk={() => fxForm.submit()}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={fxForm} layout="vertical" onFinish={saveFxProbe} requiredMark={false}>
          <Form.Item label="Ozon SKU" name="sku" rules={[{ required: true, pattern: /^\d{6,16}$/, message: "请输入 6-16 位数字 SKU" }]}>
            <Input placeholder="例如 2464728255" maxLength={16} />
          </Form.Item>
          <Form.Item label="备注" name="label"><Input placeholder="用于识别该商品" maxLength={120} /></Form.Item>
          <Form.Item label="状态" name="status">
            <Select options={[{ value: "ACTIVE", label: "启用" }, { value: "DISABLED", label: "停用" }]} />
          </Form.Item>
          <Alert type="info" showIcon message="价格必须来自同一 SKU、同一采集时刻；只有同时取得 RUB 与 CNY 前台竞品真实售价计算时才参与汇率计算。" />
        </Form>
      </Modal>
    </div>
  );
}
