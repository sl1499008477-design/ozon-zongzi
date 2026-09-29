import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Image,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Upload,
  message,
} from "antd";
import Table from "./PagedTable.jsx";
import {
  CheckOutlined,
  CloudUploadOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { autoListingWarehouseOptions } from "./auto-listing-config.js";
import { eligibleTargetStores } from "./collect-box-target-store.js";
import { apiRequest } from "./client-transport.js";
import {
  AI_LISTING_FORM_DEFAULTS,
  AI_LISTING_DELETED_RECOVERY_DESCRIPTION,
  AI_LISTING_DELETED_RETENTION_DESCRIPTION,
  assertAiListingGenerationAvailable,
  startAiListingPolling,
  aiListingPollDelay,
  aiListingDetailPollDelay,
  aiListingCurrency,
  aiListingCreationFeedback,
  aiListingPriceFailureMessage,
  isAiListingPriceSkipped,
  aiListingPurgeDetailEvidence,
  shouldClosePurgedAiListingDetail,
  aiListingTaskActions,
  aiListingCanRetrySku,
  aiListingTaskProgress,
  aiListingTaskStatus,
  aiListingTaskError,
  aiListingSkuStatus,
  aiListingImageStatusLabel,
  aiListingActionPayload,
  canRefreshAiListingPricing,
  aiListingSubmissionFailureReason,
  aiListingSubmissionNotices,
  aiListingCollectionSource,
  collectItemIdsFromSearch,
  groupAiListingImages,
  serializeAiListingConfig,
} from "./ai-listing-page-state.js";
import "./ai-listing-page.css";
import AiListingPresets from "./AiListingPresets.jsx";
import SalePricingSelect from "./SalePricingSelect.jsx";
import AiListingRevisionDialog from './AiListingRevisionDialog.jsx';
import { AI_HOME_STAGE_LABELS, aiListingHomeFilter, aiListingTaskListPath } from './ai-listing-home-filter.js';

const waitingForEnrichment = task => task.sourceType === "COLLECT_BOX" && task.status === "COLLECTING";
const CONTROL_LABELS = {pause:'暂停',cancel:'取消',delete:'删除',retry:'重试',resume:'恢复'};
const TASK_ACTION_LABELS = {...CONTROL_LABELS,permanentDelete:'永久删除'};
const GROUP_LABELS = {active:'执行中',paused:'已暂停',failed:'提交失败',errors:'错误',cancelled:'已取消',deleted:'已删除'};
const GROUP_CONTROL_ACTIONS = {
  active: ['pause', 'cancel', 'delete'],
  paused: ['cancel', 'delete', 'resume'],
  failed: ['delete', 'retry'],
  errors: ['delete', 'retry'],
  cancelled: ['delete', 'resume'],
  deleted: ['resume'],
};
const CONTROL_DESCRIPTIONS = {
  pause:'保存当前进度后暂停；已经发出的请求会接收并保存结果，再停止后续处理。',
  cancel:'停止后续处理和上架，保留已生成图片。已经发出的请求会接收并保存结果，可能产生费用。',
  delete:'从当前分组移除任务，可在“已删除”分组恢复。已发出的请求先保存结果；上架历史、图片和账单保留。',
  retry:'默认按原配置重试未完成部分，成功图片和成功上架的商品不会重复处理。结果未知的图片请求会保留待核实，普通重试不会再次生图；已保存的拼图会先重新切片。其他未完成图片重新生图可能产生费用。',
  resume:'沿用原任务、原配置和已保存图片，加入队列继续。结果未知的图片请求会保留待核实，不会自动重复发送。',
  permanentDelete:'永久删除后不可恢复。对应采集商品在没有其他 SKU 或任务继续使用时会一并删除；该商品专属的 COS 图片、视频和衍生资料会删除，共享素材、已上架商品正在使用的素材和必要的账务/提交记录会保留；提交结果未知不影响永久删除，相关回执和可能在用的素材会保留。',
};

function TaskStatusTag({task}) {
  const status = aiListingTaskStatus(task);
  return <Tooltip title={status.description}><Tag color={status.color} tabIndex={status.description ? 0 : undefined}>{status.label}</Tag></Tooltip>;
}

function SkuResult({row,task}) {
  if(!row.status&&!row.usedBlackPriceFallback&&row.priceBasis!=='BLACK_PRICE_FALLBACK')return null;
  const status=aiListingSkuStatus(row,task);
  return <><Tag color={status.color}>{status.label}</Tag>{status.description&&<div style={{fontSize:12,overflowWrap:'anywhere'}}>{status.description}</div>}</>;
}

function ImageFailureDetails({image}) {
  const error=image.errorMessage||image.lastError?.message;
  const diagnostic=image.lastError?.diagnostic;
  const attempt=diagnostic?.attempts?.at(-1);
  const details=[image.lastError?.code,
    diagnostic?.httpStatus?`HTTP ${diagnostic.httpStatus}`:attempt?.httpStatus?`HTTP ${attempt.httpStatus}`:null,
    diagnostic?.requestId?`请求 ID：${diagnostic.requestId}`:null,
    diagnostic?.stage?`阶段：${({source_download:'原图下载',slicing:'拼图切片'})[diagnostic.stage]||diagnostic.stage}`:null,
    diagnostic?.actual?.width&&diagnostic?.actual?.height?`图片尺寸：${diagnostic.actual.width} × ${diagnostic.actual.height}`:null,
    diagnostic?.detected?`检测分隔带：纵向 ${diagnostic.detected.verticalBands}，横向 ${diagnostic.detected.horizontalBands}`:null,
  ].filter(Boolean);
  if(!error&&!details.length&&!image.paidResultRetained&&!['RESULT_UNKNOWN','RESULT_UNAVAILABLE'].includes(image.status))return null;
  return <div style={{fontSize:12,marginTop:8,overflowWrap:'anywhere'}}>
    {error&&<div>{error}</div>}
    {image.status==='RESULT_UNKNOWN'&&<div>结果待核实，普通重试不会再次生图。</div>}
    {image.status==='RESULT_UNAVAILABLE'&&<div>原付费拼图已不可用，无法重新切片；普通重试不会重新生图，需核实后另行确认。</div>}
    {image.paidResultRetained&&<div>已保存完整拼图；重试会先用已有结果重新切片。</div>}
    {!!details.length&&<details><summary>失败详情</summary>{details.map((text,index)=><div key={index}>{text}</div>)}</details>}
  </div>;
}

function TaskCollectionSource({task}) {
  const source = aiListingCollectionSource(task);
  return <div className="ai-listing-source-cell"><span>{source.label}</span>
    {source.taskNames.map(name => <div key={name} className="ai-listing-source-task" title={name}>{name}</div>)}
  </div>;
}

function safeStoreLabel(store = {}) {
  return String(store.label || store.companyName || store.storeName || store.name || store.id || "经营店铺");
}

function storeCurrency(store = {}) {
  return String(store.currencyCode || store.companyCurrency || store.currency || "").toUpperCase();
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function excelPayload(file) {
  const name = String(file?.name || "").trim();
  if (!name.toLowerCase().endsWith(".xlsx") || /[/\\\u0000-\u001f\u007f]/u.test(name)
    || typeof file?.arrayBuffer !== "function" || file.size < 1 || file.size > 2_097_152) {
    throw Object.assign(new Error("请选择有效的 .xlsx 文件"), { code: "AI_LISTING_EXCEL_INVALID" });
  }
  return { name, contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
}

function TaskImages({ images = [], collecting = false, task }) {
  const [comparison, setComparison] = useState(null);
  const selected = images.find((image) => image.sku === comparison?.sku && image.index === comparison?.index);
  const groups = groupAiListingImages(images);
  if (!groups.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={collecting ? "正在采集原图" : "尚无可展示的任务图片"} />;
  return (
    <div className="ai-listing-image-groups">
      {groups.map((group) => (
        <section key={group.sku} className="ai-listing-image-group">
          <div className="ai-listing-sku">{group.sku}</div>
          <div className="ai-listing-image-grid">
            {group.images.map((image, position) => (
              <div key={`${group.sku}-${image.index}-${position}`}><button type="button" className="ai-listing-image-pair"
                aria-label={`放大对比 ${group.sku} 第 ${Number(image.index) + 1} 张图片`}
                onClick={() => setComparison({ sku: image.sku, index: image.index })}>
                <div><span>原图 {Number(image.index) + 1}</span><img loading="lazy" decoding="async" src={image.sourceUrl} alt={`${group.sku} 原图 ${Number(image.index) + 1}`} /></div>
                <div>
                  <span>生成图 {Number(image.index) + 1}</span>
                  {image.generatedUrl
                    ? <img loading="lazy" decoding="async" src={image.previewUrl || image.generatedUrl} alt={`${group.sku} 生成图 ${Number(image.index) + 1}`} />
                    : <div className="ai-listing-image-empty">{aiListingImageStatusLabel(image,task)}</div>}
                </div>
              </button><ImageFailureDetails image={image}/></div>
            ))}
          </div>
        </section>
      ))}
      <Modal open={Boolean(selected)} onCancel={() => setComparison(null)} footer={null}
        width="min(1280px, calc(100vw - 32px))" centered
        title={selected ? `图片对比 · SKU ${selected.sku} · 第 ${Number(selected.index) + 1} 张` : "图片对比"}>
        {selected && <div className="ai-listing-image-comparison">
          <section><h3>原图</h3><img loading="lazy" decoding="async" src={selected.sourceUrl} alt={`${selected.sku} 放大原图`} /></section>
          <section><h3>生成图</h3>{selected.generatedUrl
            ? <img loading="lazy" decoding="async" src={selected.generatedUrl} alt={`${selected.sku} 放大生成图`} />
            : <div className="ai-listing-comparison-empty">{aiListingImageStatusLabel(selected,task)}</div>}</section>
        </div>}
      </Modal>
    </div>
  );
}

function TaskCard({ task, busyAction, onAction, deletedView=false, completedView=false }) {
  const progress = aiListingTaskProgress(task);
  const waiting = waitingForEnrichment(task);
  const availableActions = aiListingTaskActions(task,{deletedView});
  const actions = completedView ? {retry:availableActions.retry} : availableActions;
  const priceSkipped = isAiListingPriceSkipped(task);
  const status = aiListingTaskStatus(task);
  const notices = aiListingSubmissionNotices(task.submissionResults);
  const hasPublicationWarnings = task.submissionResults?.some(row => row.publicationWarningDetails?.length || row.publicationWarnings?.length || row.warningMessage);
  const taskError = aiListingTaskError(task);
  return (
    <Card className="ai-listing-task-card" title={(
      <div className="ai-listing-task-title">
        <div><strong>{task.name || task.sku || "AI 上架任务"}</strong><span>{task.sku || "未提供 SKU"}</span></div>
        <Space wrap>
          <TaskStatusTag task={task}/>
          <Tag>{task.config?.generationMode === "GRID" ? "智能拼图切片" : "逐张生图"}</Tag>
          <Tag>{waiting ? "待资料补全" : `${progress.completed} / ${progress.total}`}</Tag>
        </Space>
      </div>
    )}>
      <div className="ai-listing-detail-source"><span>采集来源：</span><TaskCollectionSource task={task}/></div>
      {status.description && <p className="ai-listing-status-description">{status.description}</p>}
      {taskError || priceSkipped ? <Alert className="ai-listing-task-error" type={task.status==="GENERATING"?"info":task.quotaWait&&status.color==='gold'?"warning":"error"} showIcon
        message={priceSkipped ? "售价无效，已跳过" : taskError}
        description={priceSkipped ? <><p>{aiListingPriceFailureMessage(task)}</p><p>此商品不会继续上架，已有原图和生成图会保留。</p></> : undefined} /> : null}
      {task.status === "SUBMISSION_UNCERTAIN" ? (
        <Alert type="warning" showIcon message="提交结果未知；重试只会查询或恢复同一上架请求，当前不能安全取消。" />
      ) : null}
      {!!notices.warnings.length && <Alert type="warning" showIcon className="ai-listing-task-error"
        message={task.status === 'COMPLETED' && hasPublicationWarnings ? '库存已设置，商品卡片有警告' : '上架资料及商品卡片提示'}
        description={<ul>{notices.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>} />}
      {!!notices.info.length && <Alert type="info" showIcon className="ai-listing-task-error" message="可选资料说明"
        description={<>
          <p>以下信息包含来源尚未确认或未填写的可选资料，不能据此认定采集到的属性漏传。上架结果请查看商品导入和库存状态。</p>
          <details><summary>查看 {notices.info.length} 条说明</summary><ul>{notices.info.map((note, index) => <li key={index}>{note}</li>)}</ul></details>
        </>} />}
      {!!task.importRows?.length && <details><summary>Excel 导入来源 · {task.importSkus?.length || 1} 个 SKU</summary>{task.importRows.map(row=><div key={row.row}>第 {row.row} 条 · {row.sku}</div>)}</details>}
      {!!task.skuProgress?.length&&<Table rowKey="sku" size="small" dataSource={task.skuProgress} columns={[
        {title:'SKU',dataIndex:'sku'},
        {title:'图片',render:(_,row)=>`${row.completed} / ${row.total}`},
        {title:'处理结果 / 原因',render:(_,row)=><SkuResult row={row} task={task}/>},
      ]}/>}
      {waiting ? <Alert type="warning" showIcon message="等待 Seller 资料补全"
        description={<>
          <p>商品已加入采集箱，AI 正在等待商品类目、包装重量和尺寸等资料补全。</p>
          <p>请保持 1.0.8 或更新版本的采集助手运行并登录同一账号，助手会自动补全资料。如助手提示 Seller 登录失效，请在助手内完成登录并继续补全。补全后原任务会自动继续，无需重复创建。</p>
          <Space wrap><Button href="/ozon/products/collect">查看采集箱</Button><Button href="/ozon/downloads">下载新版采集助手</Button></Space>
        </>} /> : <TaskImages images={task.images} collecting={task.status === "COLLECTING"} task={task} />}
      {actions.approve && task.config?.generationMode === "GRID" && <Alert type="info" showIcon message="提交前请核对商品及包装上的品牌、Logo和参数，检查背景是否残留店铺水印或推广联系方式。" />}
      {!!task.submissionResults?.length && <>
        {task.status==='SUBMISSION_FAILED'&&<Alert type="warning" message="上架有未完成 SKU；重试只恢复失败项的导入、图片或库存。图片重传沿用已生成的完整图片组和原商品货号，已成功商品不会重复创建。"/>}
        <Table rowKey={row=>`${row.sku}:${row.offerId}`} size="small"  dataSource={task.submissionResults} columns={[
          {title:'SKU',dataIndex:'sku'},{title:'货号',dataIndex:'offerId'},
          {title:'商品导入',dataIndex:'importStatus',render:value=>({SUCCEEDED:'成功',FAILED:'失败',PENDING:'等待',UNKNOWN:'结果待确认'}[value]||value)},
          {title:'库存',dataIndex:'stockStatus',render:(value,row)=>row.publicationStatus==='IMAGE_FAILED'?'待图片修复':row.publicationStatus==='IMAGE_REPAIR_PENDING'?'等待图片处理':({COMPLETED:'成功',FAILED:'失败',PENDING:'等待'}[value]||value)},
          {title:'Ozon 状态',render:(_,row)=>row.publicationCheck?.statusName||'待核实'},
          {title:'原因 / 警告',dataIndex:'errors',render:(values,row)=>aiListingSubmissionFailureReason(row)},
          ...(onAction?[{title:'操作',render:(_,row)=>aiListingCanRetrySku(task,row)
            ?<Button disabled={!!busyAction} onClick={()=>onAction(task,'retry',{skus:[row.sku]})}>继续此 SKU</Button>:null}]:[]),
        ]}/>
      </>}

      {Object.values(actions).some(Boolean) ? (
        <div className="ai-listing-task-actions">
          {actions.approve ? <Button type="primary" icon={<CheckOutlined />} disabled={!!busyAction} loading={busyAction === `${task.id}:approve`} onClick={() => onAction(task, "approve")}>审核通过并提交</Button> : null}
          {Object.entries(TASK_ACTION_LABELS).filter(([action])=>actions[action] && !(action==='retry' && priceSkipped)).map(([action,label])=>
            <Button key={action} danger={['cancel','delete','permanentDelete'].includes(action)} disabled={!!busyAction}
              loading={busyAction===`${task.id}:${action}`} onClick={()=>onAction(task,action)}>{label}任务</Button>)}
        </div>
      ) : null}
    </Card>
  );
}

export default function AiListingPage({
  locationSearch = "",
  localData = {},
  account = null,
  binding = null,
  navigate,
  request = apiRequest,
}) {
  const [form] = Form.useForm();
  const accountId = String(account?.id || "");
  const collectIds = useMemo(() => collectItemIdsFromSearch(locationSearch), [locationSearch]);
  const collectSignature = collectIds.join("|");
  const [sourceMode, setSourceMode] = useState(collectIds.length ? "collect" : "excel");
  const [excelFile, setExcelFile] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [listError,setListError]=useState("");
  const listScopeRef=useRef("");
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(5);
  const [total,setTotal]=useState(0);
  const [taskGroup,setTaskGroup]=useState(() => aiListingHomeFilter(locationSearch).group);
  const [taskStage,setTaskStage]=useState(() => aiListingHomeFilter(locationSearch).stage);
  const [taskCounts,setTaskCounts]=useState({});
  useEffect(()=>{setTaskCounts({});},[accountId]);
  const [capabilities,setCapabilities]=useState(null);
  const [capabilityError,setCapabilityError]=useState("");
  const presetManualEditRef=useRef(null);
  const listRequestRef=useRef(null);
  const [channelStatus,setChannelStatus]=useState(null);
  const [channelStatusError,setChannelStatusError]=useState(false);
  const [excelErrors, setExcelErrors] = useState([]);
  const [collectRetryIds, setCollectRetryIds] = useState(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [batchPreview,setBatchPreview]=useState(null);
  const [batchResult,setBatchResult]=useState(null);
  const [taskSelection,setTaskSelection]=useState(null);
  const selectedTasks=taskSelection?.accountId===accountId && taskSelection.group===taskGroup
    ? taskSelection.rows.map(row=>tasks.find(task=>task.id===row.id)||row) : [];
  useEffect(()=>{setTaskSelection(null);setBatchPreview(null);setBatchResult(null);setBusyAction('');},[accountId,taskGroup,taskStage]);
  const actionAccountRef=useRef(accountId); actionAccountRef.current=accountId;
  useEffect(()=>{actionAccountRef.current=accountId;return()=>{actionAccountRef.current=null;};},[accountId]);
  const [activeTab, setActiveTab] = useState(() => new URLSearchParams(locationSearch).get("tab") === "tasks" ? "tasks" : "create");
  useEffect(() => {
    const filter = aiListingHomeFilter(locationSearch);
    setTaskGroup(filter.group); setTaskStage(filter.stage); setPage(1);
    if (filter.stage) setActiveTab('tasks');
  }, [locationSearch]);
  const changeTaskGroup = value => {
    setPage(1); setTaskStage(''); setTaskGroup(value);
    if (taskStage && navigate) navigate(`/ozon/tools/ai-listing?tab=tasks&group=${value}`);
  };
  const [pageVisible,setPageVisible]=useState(()=>typeof document==='undefined'||!document.hidden);
  const pollingStateRef=useRef({});
  pollingStateRef.current={visible:pageVisible,activeTab,activeCount:(taskCounts.active||0)
    +(taskGroup==='deleted'?(taskCounts.purging||0):0)};
  useEffect(()=>{const changed=()=>setPageVisible(!document.hidden);document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
  const listResponseVersionRef = useRef(0);
  const foregroundLoadVersionRef = useRef(0);
  const createIntentRef = useRef(null);
  const stores = useMemo(() => eligibleTargetStores(localData), [localData]);
  const storeIdsKey = JSON.stringify(stores.map(store => String(store.id || store.storeId || "")));
  const [storeQuotas, setStoreQuotas] = useState({accountId:"", items:{}});
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaRefresh, setQuotaRefresh] = useState(0);
  const quotaUpdatedAt = useRef(0);
  const storeOptionLabel = store => {
    const quota = storeQuotas.accountId === accountId ? storeQuotas.items[String(store.id || store.storeId)] : undefined;
    return `${safeStoreLabel(store)}（额度：${quota === undefined ? "读取中" : quota === null ? "暂不可用" : quota.toLocaleString("zh-CN")}）`;
  };
  const refreshQuotaOnOpen = open => {
    if (open && !quotaLoading && Date.now() - quotaUpdatedAt.current >= 60000) setQuotaRefresh(value => value + 1);
  };
  const selectedStoreId = Form.useWatch("targetStoreId", form) || "";
  const selectedWarehouseId = Form.useWatch("targetWarehouseId", form) || "";
  const autoSwitchStores = Form.useWatch("autoSwitchStores",form) || false;
  const fallbackStores = Form.useWatch("fallbackStores",form) || [];
  const generationMode = Form.useWatch("generationMode", form) || "GRID";
  const manualReview = Form.useWatch("manualReview", form) ?? false;
  const selectedStore = stores.find((store) => String(store.id || store.storeId || "") === selectedStoreId) || null;
  const currency = useMemo(() => {
    try { return aiListingCurrency(storeCurrency(selectedStore)); } catch { return null; }
  }, [selectedStore]);
  const warehouseChoice = useMemo(() => autoListingWarehouseOptions({
    warehouses: localData?.caches?.warehouses || localData?.warehouses || [],
    targetStoreId: selectedStoreId,
    selectedWarehouseId,
  }), [localData, selectedStoreId, selectedWarehouseId]);
  const collectRows = useMemo(() => {
    const byId = new Map((localData?.caches?.collectBox || []).map((item) => [String(item.id || ""), item]));
    return collectIds.map((id) => ({ id, item: byId.get(id) || null }));
  }, [collectSignature, localData]);

  useEffect(() => {
    if (!accountId || activeTab !== "create") return;
    const controller = new AbortController();
    const pending = JSON.parse(storeIdsKey);
    setStoreQuotas({accountId, items:{}});
    setQuotaLoading(true);
    const readNext = async () => {
      while (pending.length && !controller.signal.aborted) {
        const storeId = pending.shift();
        let remaining = null;
        try {
          const result = await request(`/ai-listing/stores/${encodeURIComponent(storeId)}/quota`, {signal:controller.signal, timeoutMs:20000});
          remaining = Number.isFinite(result.remaining) ? result.remaining : null;
        } catch { /* A failed quota read must not disable task configuration. */ }
        if (!controller.signal.aborted) setStoreQuotas(previous => ({accountId, items:{...previous.items, [storeId]:remaining}}));
      }
    };
    void Promise.all([readNext(), readNext()]).finally(() => {
      if (!controller.signal.aborted) {setQuotaLoading(false); quotaUpdatedAt.current = Date.now();}
    });
    return () => controller.abort();
  }, [accountId, storeIdsKey, activeTab, quotaRefresh, request]);

  const loadTasks = useCallback(async ({ quiet = false, force = false } = {}) => {
    if(listRequestRef.current){if(!force)return;listRequestRef.current.abort();listRequestRef.current=null;}
    const controller=new AbortController();listRequestRef.current=controller;
    const listVersion = ++listResponseVersionRef.current;
    const foregroundVersion = quiet ? null : ++foregroundLoadVersionRef.current;
    if (foregroundVersion !== null) setLoading(true);
    try {
      const result = await request(aiListingTaskListPath({group:taskGroup,stage:taskStage,page,pageSize}),{signal:controller.signal,timeoutMs:30000});
      if (listVersion === listResponseVersionRef.current) {setListError('');setTasks(Array.isArray(result?.tasks) ? result.tasks : []);const count=result.total??result.tasks?.length??0;setTotal(count);setTaskCounts(result.counts||{all:count});if(page>Math.max(1,Math.ceil(count/pageSize)))setPage(Math.max(1,Math.ceil(count/pageSize)));}
      return true;
    } catch (error) {
      if (listVersion === listResponseVersionRef.current && !controller.signal.aborted)setListError(error?.message || 'AI 上架任务读取失败，请重试');
      if (listVersion === listResponseVersionRef.current && foregroundVersion !== null) {
        message.error(error?.message || "AI 上架任务加载失败");
      }
      return false;
    } finally {
      if(listRequestRef.current===controller)listRequestRef.current=null;
      if (foregroundVersion !== null && foregroundVersion === foregroundLoadVersionRef.current) setLoading(false);
    }
  }, [accountId, request,page,pageSize,taskGroup,taskStage]);

  useEffect(() => {
    let first=true;
    listResponseVersionRef.current+=1;foregroundLoadVersionRef.current+=1;
    const scope=`${accountId}:${taskGroup}:${taskStage}:${page}:${pageSize}`;
    if(listScopeRef.current!==scope){setTasks([]);setListError('');listScopeRef.current=scope;}
    setLoading(false);
    const stop=accountId?startAiListingPolling({load:()=>{const quiet=!first;first=false;return loadTasks({quiet});},getInterval:()=>aiListingPollDelay(pollingStateRef.current)}):()=>{};
    return()=>{stop();listResponseVersionRef.current+=1;foregroundLoadVersionRef.current+=1;listRequestRef.current?.abort();listRequestRef.current=null;};
  },[accountId,loadTasks,activeTab,pageVisible]);

  useEffect(()=>{
    let stopped=false;setCapabilities(null);setCapabilityError("");
    request('/ai-listing/capabilities').then(result=>{if(!stopped)setCapabilities(result);}).catch(()=>{if(!stopped)setCapabilityError('生图能力读取失败，请刷新页面重试');});
    return()=>{stopped=true;};
  },[accountId,request]);

  useEffect(() => {
    let stopped=false;let timer;
    setChannelStatus(null);setChannelStatusError(false);
    const poll=async()=>{
      try {const result=await request("/ai-listing/channels");if(!stopped){setChannelStatus(result);setChannelStatusError(false);}}
      catch {if(!stopped)setChannelStatusError(true);}
      finally {if(!stopped)timer=setTimeout(poll,aiListingPollDelay(pollingStateRef.current));}
    };
    if(accountId)void poll();
    return ()=>{stopped=true;clearTimeout(timer);};
  },[accountId,request,activeTab,pageVisible]);

  useEffect(() => {
    setSourceMode(collectIds.length ? "collect" : "excel");
    setCollectRetryIds(null);
    setExcelErrors([]);
    createIntentRef.current = null;
  }, [collectSignature, accountId]);

  useEffect(() => {
    if (selectedStoreId || !stores.length) return;
    const currentId = String(localData?.currentStoreId || binding?.id || "");
    const initial = stores.find((store) => String(store.id || store.storeId || "") === currentId) || stores[0];
    form.setFieldValue("targetStoreId", String(initial.id || initial.storeId || ""));
  }, [binding, form, localData?.currentStoreId, selectedStoreId, stores]);

  useEffect(() => {
    if (selectedWarehouseId && !warehouseChoice.selectedWarehouseId) form.setFieldValue("targetWarehouseId", "");
    if (!selectedWarehouseId && warehouseChoice.options.length) form.setFieldValue("targetWarehouseId", warehouseChoice.options[0].value);
  }, [form, selectedWarehouseId, warehouseChoice]);

  const changeStore = (nextStoreId) => {
    const previousCurrency = storeCurrency(selectedStore);
    const nextStore = stores.find((store) => String(store.id || store.storeId || "") === nextStoreId);
    form.setFieldsValue({ targetStoreId: nextStoreId, targetWarehouseId: "" });
    if (previousCurrency && storeCurrency(nextStore) && previousCurrency !== storeCurrency(nextStore)) {
      form.setFieldsValue({priceAdjustmentAmount:"0",salePricingId:undefined,salePricingUpdatedAt:undefined});
      message.info("切换了店铺币种，请重新选择售价配置");
    }
    createIntentRef.current = null;
  };

  const createTask = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const values = await form.validateFields();
      assertAiListingGenerationAvailable(values.generationMode,capabilities);
      const {item: prompt} = await request(`/ai-listing/presets/prompts/${values.promptId}`);
      const config = serializeAiListingConfig({...values,prompt:prompt.content});
      let endpoint;
      let source;
      if (sourceMode === "collect") {
        const pendingIds = collectRetryIds ?? collectIds;
        if (!pendingIds.length) throw new Error("本次商品已处理，请先从采集箱选择需要创建任务的商品");
        endpoint = "/ai-listing/tasks/from-collect-box";
        const selected = JSON.parse(new URLSearchParams(locationSearch).get("variants") || "{}");
        source = { collectItemIds: pendingIds, selectedSkus: Object.fromEntries(pendingIds.filter(id => selected[id] !== undefined).map(id => [id, selected[id]])) };
      } else {
        if (!excelFile) throw new Error("请选择包含 SKU 的 .xlsx 文件");
        endpoint = "/ai-listing/imports/excel";
        source = await excelPayload(excelFile);
      }
      const signature = JSON.stringify({ endpoint, source, config });
      if (createIntentRef.current?.signature !== signature) {
        createIntentRef.current = { signature, idempotencyKey: crypto.randomUUID() };
      }
      const result = await request(endpoint, {
        method: "POST",
        body: { ...source, promptId: values.promptId, idempotencyKey: createIntentRef.current.idempotencyKey, config },
      });
      createIntentRef.current = null;
      listResponseVersionRef.current += 1;
      const feedback = aiListingCreationFeedback(result, sourceMode === "collect" ? source.collectItemIds : null);
      const created = feedback.tasks;
      setExcelErrors(feedback.errors);
      if (sourceMode === "collect") setCollectRetryIds(feedback.retryCollectItemIds);
      setTasks((current) => {
        const ids = new Set(created.map((task) => task.id));
        return [...created, ...current.filter((task) => !ids.has(task.id))];
      });
      setTotal(value=>value+created.length);
      setPage(1);
      setActiveTab("tasks");
      message[feedback.level](feedback.message);
    } catch (error) {
      if (Number(error?.status) >= 400 && Number(error?.status) < 500 && Number(error?.status) !== 408 && Number(error?.status) !== 429) {
        createIntentRef.current = null;
      }
      message.error(error?.message || "任务创建失败");
    } finally {
      setCreating(false);
    }
  };

  const runAction = async (task, action, options = {}) => {
    const key = `${task.id}:${action}`;
    const restoringDeleted=action==='resume'&&task.deletedAt;
    if (busyAction) return;
    setBusyAction(key);
    try {
      const endpointAction=action==='permanentDelete'?'permanent-delete':action;
      const result = await request(`/ai-listing/tasks/${encodeURIComponent(task.id)}/${endpointAction}`, { method: "POST", body: aiListingActionPayload(task,action,options) });
      if(actionAccountRef.current!==accountId)return false;
      if (result?.task) {
        listResponseVersionRef.current += 1;
        setTasks((current) => (action==='delete' && !result.task.controlAction)||action==='permanentDelete'||restoringDeleted ? current.filter(entry=>entry.id!==task.id)
          : current.map((entry) => entry.id === task.id ? {...entry,...result.task} : entry));
        if(action==='permanentDelete')setTaskSelection(current=>current?.accountId===accountId
          ? {...current,rows:current.rows.filter(row=>row.id!==task.id)} : current);
      }
      void loadTasks({force:true});
      if(action==='permanentDelete')message.info('已交给后台清理，可关闭页面；清理失败的任务会重新显示');
      else message.success(restoringDeleted ? `任务已恢复到${aiListingTaskStatus(result.task).label}，请手动重试或恢复继续`
        : result?.task?.controlAction ? `已请求${CONTROL_LABELS[action]}，正在保存当前结果`
        : action==='approve' ? '已通过审核，等待提交' : ['retry','resume'].includes(action) ? '已加入队列，等待继续处理' : `任务已${CONTROL_LABELS[action]}`);
      return result.task;
    } catch (error) {
      if(actionAccountRef.current!==accountId)return false;
      message.error(error?.message || "操作失败");
      if (error?.status === 409) void loadTasks({force:true});
      return false;
    } finally {
      if(actionAccountRef.current===accountId)setBusyAction("");
    }
  };

  const previewBatch=async action=>{
    if(busyAction||taskStage)return;
    if(action==='permanentDelete' && (taskGroup!=='deleted'||!selectedTasks.length))return;
    if(selectedTasks.length){
      const items=[],skipped=[];
      for(const task of selectedTasks){
        if(aiListingTaskActions(task,{deletedView:taskGroup==='deleted'})[action]
          && !(action==='retry'&&isAiListingPriceSkipped(task)))items.push({taskId:task.id,expectedVersion:task.version});
        else skipped.push({taskId:task.id,message:'当前状态不支持此操作，请刷新后核对'});
      }
      setBatchResult(null);setBatchPreview({action,group:taskGroup,total:selectedTasks.length,items,skipped,selected:true,accountId});
      return;
    }
    setBusyAction(`preview:${action}`);setBatchResult(null);
    try {
      const preview=await request('/ai-listing/tasks/batch/preview',{method:'POST',body:{action,group:taskGroup}});
      if(actionAccountRef.current===accountId) setBatchPreview({...preview,accountId});
    } catch(error){message.error(error.message || '读取批量操作范围失败');}
    finally{setBusyAction('');}
  };
  const applyBatch=async()=>{
    if(busyAction || !batchPreview?.items.length || batchPreview.accountId!==accountId)return;
    const preview=batchPreview;setBusyAction(`batch:${preview.action}`);
    const result={applied:0,pending:0,skipped:[...preview.skipped],errors:[],processed:0};
    try {
      // Execute only the confirmed version snapshot; never expand a selection.
      const chunkSize=preview.action==='permanentDelete'?1:50;
      for(let offset=0;offset<preview.items.length;offset+=chunkSize){
        if(actionAccountRef.current!==preview.accountId)return;
        let part;
        if(preview.action==='permanentDelete'){
          const item=preview.items[offset];
          try{
            await request(`/ai-listing/tasks/${encodeURIComponent(item.taskId)}/permanent-delete`,{method:'POST',body:{expectedVersion:item.expectedVersion}});
            if(actionAccountRef.current!==preview.accountId)return;
            listResponseVersionRef.current+=1;
            setTasks(current=>current.filter(task=>task.id!==item.taskId));
            part={applied:1,pending:0,skipped:[]};
          }catch(error){
            if(![404,409].includes(error.status))throw error;
            part={applied:0,pending:0,skipped:[{taskId:item.taskId,message:error.message}]};
          }
        }else part=await request('/ai-listing/tasks/batch/apply',{method:'POST',body:{action:preview.action,items:preview.items.slice(offset,offset+chunkSize)},timeoutMs:60000});
        if(actionAccountRef.current!==preview.accountId)return;
        result.applied+=part.applied;result.pending+=part.pending;result.skipped.push(...part.skipped);
        result.errors.push(...(part.errors||[]));result.processed+=Math.min(chunkSize,preview.items.length-offset);
      }
      setBatchPreview(null);
      if(preview.action==='permanentDelete'&&!result.skipped.length&&!result.errors.length){
        setBatchResult(null);message.info(`已交给后台清理 ${result.applied} 项，可关闭页面`);
      }else setBatchResult({...result,action:preview.action,group:preview.group});
    }catch(error){setBatchPreview(null);setBatchResult({...result,action:preview.action,group:preview.group,
      remaining:preview.items.length-result.processed,error:error.message||'网络请求中断，请刷新核对后再操作'});}
    finally{if(actionAccountRef.current===accountId){setTaskSelection(null);setBusyAction('');void loadTasks({force:true});}}
  };

  const createPanel = (
    <div className="ai-listing-create-grid">
      <Card title="1. 上架与图片设置" className="ai-listing-panel">
        <Form form={form} layout="vertical" initialValues={{...AI_LISTING_FORM_DEFAULTS,image:{...AI_LISTING_FORM_DEFAULTS.image,resolution:"1K"}}} onValuesChange={() => { presetManualEditRef.current?.();createIntentRef.current = null; }}>
          <AiListingPresets form={form} request={request} onManualEditRef={presetManualEditRef} onChange={() => { createIntentRef.current = null; }}>
          <Form.Item label="额度不足自动切换店铺" name="autoSwitchStores" valuePropName="checked"><Switch aria-label="额度不足自动切换店铺"/></Form.Item>
          {autoSwitchStores && <div style={{marginBottom:20}}>
            <p>下方上架店铺为首选；额度不足时依次尝试以下备用店铺。每家单独选仓库，库存和价格规则沿用当前配置。</p>
            <Form.List name="fallbackStores" rules={[{validator:(_,rows)=>rows?.length?Promise.resolve():Promise.reject(new Error("请添加至少一家备用店铺"))}]}>
              {(fields,{add,remove,move},{errors})=><>
                {fields.map((field,index)=><div key={field.key} className="ai-listing-route-row">
                  <span>备用 {index+1}</span>
                  <Form.Item name={[field.name,"targetStoreId"]} rules={[{required:true,message:"请选择店铺"}]}>
                    <Select aria-label={`备用店铺 ${index+1}`} placeholder="选择店铺" options={stores.filter(store=>{const id=String(store.id||store.storeId);return id!==selectedStoreId&&!fallbackStores.some((row,i)=>i!==index&&row?.targetStoreId===id);}).map(store=>({value:String(store.id||store.storeId),label:storeOptionLabel(store)}))} onOpenChange={refreshQuotaOnOpen} onChange={()=>form.setFieldValue(["fallbackStores",index,"targetWarehouseId"],undefined)}/>
                  </Form.Item>
                  <Form.Item name={[field.name,"targetWarehouseId"]} rules={[{required:true,message:"请选择仓库"}]}>
                    <Select aria-label={`备用仓库 ${index+1}`} placeholder="选择仓库" options={autoListingWarehouseOptions({warehouses:localData?.caches?.warehouses||localData?.warehouses||[],targetStoreId:fallbackStores[index]?.targetStoreId,selectedWarehouseId:fallbackStores[index]?.targetWarehouseId}).options}/>
                  </Form.Item>
                  <Space><Button disabled={index===0} onClick={()=>move(index,index-1)}>上移</Button><Button disabled={index===fields.length-1} onClick={()=>move(index,index+1)}>下移</Button><Button danger onClick={()=>remove(field.name)}>移除</Button></Space>
                </div>)}
                <Form.ErrorList errors={errors}/><Button onClick={()=>add({})}>添加备用店铺</Button>
              </>}
            </Form.List>
          </div>}
          <div className="ai-listing-quota-note">
            <span>额度按 SKU 计算，显示店铺今日剩余可新增 SKU 数量；多变体按实际 SKU 数量占用额度。</span>
            <Button type="link" size="small" loading={quotaLoading} onClick={() => setQuotaRefresh(value => value + 1)}>刷新额度</Button>
          </div>
          <div className="ai-listing-form-grid">
            <Form.Item label="上架店铺" name="targetStoreId" rules={[{ required: true, message: "请选择经营店铺" }]}>
              <Select placeholder="选择经营店铺" options={stores.map((store) => ({ value: String(store.id || store.storeId || ""), label: storeOptionLabel(store) }))} onOpenChange={refreshQuotaOnOpen} onChange={changeStore} />
            </Form.Item>
            <Form.Item label="FBS / RFBS 仓库" name="targetWarehouseId" rules={[{ required: true, message: "请选择仓库" }]}>
              <Select placeholder="选择仓库" options={warehouseChoice.options} />
            </Form.Item>
            <Form.Item label="上架库存" name="stock" rules={[{ required: true }]}><InputNumber min={0} precision={0} /></Form.Item>
            <SalePricingSelect form={form} request={request} currency={currency?.code} onChange={()=>{createIntentRef.current=null;}}/>
            <Form.Item label="生图方式" name="generationMode"><Select options={[{value:"GRID",label:"智能拼图切片（每个 SKU 一次生图）",disabled:capabilities?.grid?.available!==true},{value:"SINGLE",label:"逐张生图"}]} onChange={value=>{if(value==="GRID")form.setFieldsValue({image:{ratio:"3:4",resolution:"1K"}});}} /></Form.Item>
            <Form.Item label="图片比例" name={["image", "ratio"]}><Select disabled={generationMode === "GRID"} options={["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"].map((value) => ({ value }))} /></Form.Item>
            <Form.Item label="图片语言" name={["image", "language"]}><Select options={[{ value: "ru", label: "俄语" }, { value: "en", label: "英语" }, { value: "zh", label: "中文" }]} /></Form.Item>
            <Form.Item label="分辨率" name={["image", "resolution"]}><Select disabled={generationMode === "GRID"} options={["1K", "2K", "4K"].map((value) => ({ value }))} /></Form.Item>
            <Form.Item label="图片质量" name={["image", "quality"]}><Select options={["low", "medium", "high", "auto"].map((value) => ({ value }))} /></Form.Item>
          </div>
          {generationMode==="GRID"&&capabilities?.grid?.available!==true&&<Alert type="warning" showIcon message={capabilities?.grid?.reason||capabilityError||"正在检查智能拼图切片能力"}/> }
          </AiListingPresets>
          <div className="ai-listing-switch-row">
            <Form.Item label="使用采集品牌" name="brandMode" valuePropName="checked" getValueFromEvent={(checked) => checked ? "PREFER_SOURCE" : "FORCE_NO_BRAND"} getValueProps={(value) => ({ checked: value === "PREFER_SOURCE" })}>
              <Switch aria-label="使用采集品牌" />
            </Form.Item>
            <p>关闭时使用无品牌，并清除标题、简介、标签和富内容文字中的采集品牌名称；商品图片中的原有 logo 保留。</p>
            <Form.Item label="生成后人工审核" name="manualReview" valuePropName="checked"><Switch aria-label="生成后人工审核" /></Form.Item>
          </div>
          <Alert type={manualReview ? "info" : "warning"} showIcon message={manualReview ? "全部图片生成成功后将停在待审核状态；审核通过才提交到 Ozon。" : "全部图片生成成功后将自动提交到 Ozon，无需人工确认。"} />
        </Form>
      </Card>
      <Card title="2. 选择来源" className="ai-listing-panel">
        <Tabs activeKey={sourceMode} onChange={(key) => { setSourceMode(key); createIntentRef.current = null; }} items={[
          { key: "collect", label: "采集箱推送", children: collectRows.length ? (
            <div className="ai-listing-collect-selection">{collectRows.map(({ id, item }) => (
              <div key={id}><strong>{item?.name || item?.title || id}</strong><span>SKU：{item?.sku || "未提供"}</span>{new URLSearchParams(locationSearch).get("variants") && (()=>{try {const selected=JSON.parse(new URLSearchParams(locationSearch).get("variants"))[id];return selected?<span>已选 {selected.length} 个 SKU：{selected.join("、")}</span>:null;} catch{return null;}})()}</div>
            ))}</div>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请在采集箱勾选商品后推送到 AI 上架" /> },
          { key: "excel", label: "Excel SKU 上传", children: (
            <Upload.Dragger accept=".xlsx" maxCount={1} beforeUpload={(file) => { setExcelFile(file); createIntentRef.current = null; return false; }} onRemove={() => setExcelFile(null)} fileList={excelFile ? [excelFile] : []}>
              <CloudUploadOutlined className="ai-listing-upload-icon" />
              <p>点击或拖入 .xlsx 文件，按 SKU 逐行采集并创建任务</p>
              <p>新 SKU 由已登录同一账号的浏览器扩展采集，请保持电脑和浏览器运行。资料补全后自动继续生图。</p>
              <a href="/templates/ai-listing-sku.xlsx" download onClick={e=>e.stopPropagation()}>下载 SKU 导入模板</a>
            </Upload.Dragger>
          ) },
        ]} />
        {sourceMode === "collect" && collectRetryIds !== null && <p>{collectRetryIds.length ? `已确认创建的任务会保留，仅重试 ${collectRetryIds.length} 个明确未创建的商品。` : "本次商品已处理，已确认创建的任务不会再次提交。请在任务中心核对结果。"}</p>}
        <Button className="ai-listing-create-button" type="primary" size="large" icon={<ThunderboltOutlined />} loading={creating} disabled={(generationMode==="GRID"&&capabilities?.grid?.available!==true)||(sourceMode==="collect"&&collectRetryIds?.length===0)} onClick={createTask}>{sourceMode === "collect" && collectRetryIds?.length ? "重试未创建商品" : "创建 AI 上架任务"}</Button>
      </Card>
    </div>
  );

  const visibleTasks = taskGroup==='deleted'?tasks:tasks.filter(task=>task.status!=="COMPLETED");
  const taskCards = <AiListingTaskTable scopeKey={accountId} deletedView={taskGroup==='deleted'} isAdmin={account?.role === "admin"} stores={localData?.stores||[]} tasks={visibleTasks} loading={loading} busyAction={busyAction} onAction={runAction} request={request}
    rowSelection={taskStage ? undefined : {selectedRowKeys:selectedTasks.map(task=>task.id),preserveSelectedRowKeys:true,columnWidth:48,
      onChange:(_keys,rows)=>setTaskSelection({accountId,group:taskGroup,rows:rows.filter(Boolean)}),
      getCheckboxProps:task=>({disabled:loading||!!busyAction||!Object.values(aiListingTaskActions(task,{deletedView:taskGroup==='deleted'})).some(Boolean),'aria-label':`选择任务 ${task.sku||task.id}`})}}
    pagination={{current:page,pageSize,total,onChange:(next,size)=>{setPage(next);setPageSize(size);}}}/>;
  const taskPanel = (
    <div className="ai-listing-task-list">
      {excelErrors.length ? (
        <Alert
          type="warning"
          showIcon
          message={excelErrors.some(error => error.collectItemId) ? `采集商品未创建 ${excelErrors.length} 项` : `Excel 未导入 ${excelErrors.length} 行`}
          description={<div className="ai-listing-excel-errors">{excelErrors.map((error, index) => (
            <div key={`${error?.rowNumber || error?.row || index}-${index}`}>
              {error?.collectItemId ? `采集商品 ${error.collectItemId}` : `第 ${error?.rowNumber || error?.row || "?"} 行 · ${error?.rawSku || error?.sku || "空 SKU"}`} · {error?.message || error?.code || "任务未创建"}
            </div>
          ))}</div>}
        />
      ) : null}
      {taskStage && <Alert type="info" showIcon message={`首页筛选：${AI_HOME_STAGE_LABELS[taskStage]}`}
        description="仅展示当前账号符合此状态的任务。可逐项查看和处理；切换任务分类会清除筛选。"
        action={<Button onClick={() => changeTaskGroup('active')}>清除筛选</Button>} />}
      <Tabs aria-label="任务状态分类" activeKey={taskGroup} onChange={changeTaskGroup} items={[
        ...Object.entries(GROUP_LABELS),
      ].map(([key,label])=>({key,label:`${label} (${taskCounts[key]??0})`,disabled:!!busyAction}))}/>
      {taskGroup==='deleted'&&<Alert className="ai-listing-image-note" type="info" showIcon
        message="已删除任务保留 15 天" description={AI_LISTING_DELETED_RETENTION_DESCRIPTION}/>}
      {taskGroup==='deleted'&&taskCounts.purging>0&&<p role="status" aria-label="后台清理状态">
        后台清理 {taskCounts.purging} 项 · 可关闭页面，清理失败的任务会重新显示
      </p>}
      {listError&&<Alert type="error" showIcon message="任务列表读取失败" description={listError}
        action={<Button onClick={()=>loadTasks({force:true})} loading={loading}>重试读取</Button>}/>}
      {!taskStage && <div className="ai-listing-batch-toolbar">
        <Space wrap>{Object.entries(CONTROL_LABELS).filter(([action])=>GROUP_CONTROL_ACTIONS[taskGroup]?.includes(action)).map(([action,label])=><Button key={action}
          danger={['cancel','delete'].includes(action)} disabled={!!busyAction || loading || (!total&&!selectedTasks.length)}
          loading={busyAction===`preview:${action}` || busyAction===`batch:${action}`} onClick={()=>previewBatch(action)}>{selectedTasks.length?`${label}选中 (${selectedTasks.length})`:`全部${label}`}</Button>)}
          {taskGroup==='deleted'&&<Button danger disabled={!!busyAction||loading||!selectedTasks.length} loading={busyAction==='batch:permanentDelete'}
            onClick={()=>previewBatch('permanentDelete')}>永久删除{selectedTasks.length?` (${selectedTasks.length})`:''}</Button>}
          {!!selectedTasks.length&&<Button type="text" disabled={!!busyAction} onClick={()=>setTaskSelection(null)}>清空选择</Button>}
        </Space>
        <span>{selectedTasks.length?`已选 ${selectedTasks.length} 项（可跨页选择）；批量操作仅处理勾选项`
          :`范围：${GROUP_LABELS[taskGroup]}分组的全部任务，包含其他分页${taskGroup==='deleted'?'；永久删除须先勾选':''}`}</span>
      </div>}
      {batchResult && <Alert showIcon closable onClose={()=>setBatchResult(null)} type={batchResult.skipped.length||batchResult.errors.length||batchResult.error?'warning':'success'}
        message={`${TASK_ACTION_LABELS[batchResult.action]}：${batchResult.action==='permanentDelete'?'已接受清理':'已处理'} ${batchResult.applied} 项${batchResult.pending?`，其中 ${batchResult.pending} 项正在保存当前结果`:''}；跳过 ${batchResult.skipped.length} 项`}
        description={<>{batchResult.action==='permanentDelete'?<p>已接收的任务已移出列表，后台会继续清理；可关闭页面，共享素材会保留。清理失败的任务会重新显示。</p>
          :batchResult.group==='deleted'&&<p>{AI_LISTING_DELETED_RECOVERY_DESCRIPTION}</p>}{batchResult.error&&<p>{batchResult.error}。剩余 {batchResult.remaining} 项尚未确认，已接受的操作保留，请先刷新核对。</p>}
          {!!batchResult.errors.length&&<details><summary>查看 {batchResult.errors.length} 项未确认结果</summary>{batchResult.errors.map(item=><p key={item.taskId}>{item.taskId}：{item.message}</p>)}</details>}
          {!!batchResult.skipped.length&&<details><summary>查看跳过原因</summary>{[...new Set(batchResult.skipped.map(item=>item.message))].map(reason=><p key={reason}>{reason}：{batchResult.skipped.filter(item=>item.message===reason).length} 项</p>)}</details>}</>}/>}
      {taskCards}
      <Modal title={`${batchPreview?.selected?'批量':'全部'}${TASK_ACTION_LABELS[batchPreview?.action] || ''}`} open={!!batchPreview && batchPreview.accountId===accountId && batchPreview.group===taskGroup}
        okText={`确认${TASK_ACTION_LABELS[batchPreview?.action] || ''} ${batchPreview?.items.length || 0} 项`} cancelText="返回"
        confirmLoading={busyAction?.startsWith('batch:')} okButtonProps={{danger:['cancel','delete','permanentDelete'].includes(batchPreview?.action),disabled:!batchPreview?.items.length || !!busyAction}}
        onCancel={()=>{if(!busyAction)setBatchPreview(null);}} onOk={applyBatch} closable={!busyAction} maskClosable={!busyAction}>
        <p>范围：{GROUP_LABELS[batchPreview?.group]}分组{batchPreview?.selected?'中勾选的':'的全部'} {batchPreview?.total || 0} 个任务{batchPreview?.selected?'（仅所选项）':'（包含其他分页）'}。</p>
        <p>可处理 {batchPreview?.items.length || 0} 项，跳过 {batchPreview?.skipped.length || 0} 项。</p>
        <p>{batchPreview?.group==='deleted'&&batchPreview.action==='resume'?AI_LISTING_DELETED_RECOVERY_DESCRIPTION:CONTROL_DESCRIPTIONS[batchPreview?.action]}</p>
        {[...new Set(batchPreview?.skipped.map(item=>item.message) || [])].map(reason=><p key={reason}>{reason}：{batchPreview.skipped.filter(item=>item.message===reason).length} 项</p>)}
        <p>确认期间状态发生变化的任务会跳过，新加入的任务不会包含在本次操作中。</p>
      </Modal>
    </div>
  );

  return (
    <div className="source-page ai-listing-page">
      <div className="ai-listing-page-head">
        <div><span className="workspace-eyebrow">OZON SELLER WORKSPACE</span><h1>AI 上架</h1><p>用每张采集原图生成对应的新商品图，并沿用现有上架资料创建 Ozon 商品。</p></div>
        <Button icon={<ReloadOutlined />} onClick={() => loadTasks()} loading={loading}>刷新任务</Button>
      </div>
      <Card title="我的 AI 通道" className="ai-listing-panel" style={{marginBottom:20}}>
        {channelStatusError?<Alert type="warning" showIcon title="通道状态暂时无法更新，正在重新获取"/>:null}
        {channelStatus?.counts?<>
          <div className="ai-listing-channel-counts" aria-label="通道状态统计">
            {[["total","总数"],["working","工作中"],["idle","空闲"],["cooling","冷却中"],["abnormal","待恢复验证"],["attention","需人工处理"],["disabled","停用"]].map(([key,label]) => (
              <div className="ai-listing-channel-count" key={key}>
                <span>{label}</span><strong>{channelStatus.counts[key] || 0}</strong>
              </div>
            ))}
          </div>
        </>:<span>{channelStatusError?"暂未获取通道状态":"正在读取通道状态…"}</span>}
      </Card>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: "create", label: "创建任务", children: createPanel },
        { key: "tasks", label: `任务中心 (${taskCounts.all??total})`, children: taskPanel },
      ]} />
    </div>
  );
}

export function AiListingTaskTable({tasks,scopeKey='',completedView=false,deletedView=false,stores=[],isAdmin=false,loading=false,busyAction,onAction,request=apiRequest,pagination,rowSelection}) {
  const [detailTaskId,setDetailTaskId]=useState(null);
  const [detailTask,setDetailTask]=useState(null);
  const [detailError,setDetailError]=useState('');
  const [detailRefresh,setDetailRefresh]=useState(0);
  const [pendingAction,setPendingAction]=useState(null);
  const [revisionTask,setRevisionTask]=useState(null);
  const acceptedPurgeDetailRef=useRef(null);
  useEffect(()=>{
    let stopped=false,latestDetail;const controller=new AbortController();setDetailTask(null);setDetailError('');
    const load=async()=>{try{const result=await request(`/ai-listing/tasks/${encodeURIComponent(detailTaskId)}${deletedView?'?includeDeleted=1':''}`,{signal:controller.signal,timeoutMs:30000});if(!stopped){
      latestDetail=result.task;
      const evidence=aiListingPurgeDetailEvidence(result.task,{taskId:detailTaskId,scopeKey});
      if(evidence)acceptedPurgeDetailRef.current=evidence;
      setDetailTask(result.task);setDetailError('');
    }return true;}
      catch(error){if(!stopped){
        if(shouldClosePurgedAiListingDetail({error,taskId:detailTaskId,scopeKey,accepted:acceptedPurgeDetailRef.current})){
          acceptedPurgeDetailRef.current=null;latestDetail=null;setDetailTask(null);setDetailError('');
          setDetailTaskId(current=>current===detailTaskId?null:current);
        }else setDetailError(error.message||'任务详情读取失败');
      }return false;}};
    const stop=detailTaskId?startAiListingPolling({load,getInterval:()=>aiListingDetailPollDelay(latestDetail,typeof document==='undefined'||!document.hidden)}):()=>{};
    const resume=()=>{if(!document.hidden)setDetailRefresh(value=>value+1);};
    if(detailTaskId)document.addEventListener('visibilitychange',resume);
    return()=>{stopped=true;controller.abort();stop();document.removeEventListener('visibilitychange',resume);};
  },[detailTaskId,request,detailRefresh,deletedView,scopeKey]);
  const performAction=async(task,kind,options)=>{
    const result=await onAction?.(task,kind,options);
    const purgeEvidence=kind==='permanentDelete'?aiListingPurgeDetailEvidence(result,{taskId:task.id,scopeKey}):null;
    if(purgeEvidence){
      acceptedPurgeDetailRef.current=purgeEvidence;
      if(detailTaskId===task.id){setDetailTask(null);setDetailTaskId(null);}
    }
    if(result && kind==='delete' && !result.controlAction)setDetailTaskId(null);
    else setDetailRefresh(value=>value+1);
    return result;
  };
  const action=(task,kind,options={})=>{
    if(busyAction)return;
    if(kind==='retry'&&task.status==='SUBMITTED'&&!options.skus){setDetailTaskId(task.id);message.info('请在逐 SKU 结果中选择要继续处理的 SKU');return;}
    return kind === 'approve' ? performAction(task,kind) : setPendingAction({task,kind,refreshSalePricing:false,...options});
  };
  return <>
    <Table rowKey="id" rowSelection={rowSelection} loading={loading} dataSource={tasks} pagination={pagination} scroll={{x:isAdmin?1630:1460}} columns={[
      {title:"商品",key:"product",width:390,render:(_,t)=>{
        const groups=t.skuProgress||groupAiListingImages(t.images || []).map(g=>({sku:g.sku,completed:g.images.filter(i=>i.generatedUrl).length,total:g.images.length}));
        return <div className="ai-listing-product-cell">
          {t.thumbnail ? <Image className="ai-listing-product-thumbnail" width={56} height={56} src={t.thumbnail} alt={t.name||t.sku} preview={false} loading="lazy" referrerPolicy="no-referrer" fallback="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2756%27 height=%2756%27%3E%3Crect width=%2756%27 height=%2756%27 fill=%27%23f0f3f8%27/%3E%3Ctext x=%2728%27 y=%2732%27 text-anchor=%27middle%27 font-size=%279%27 fill=%27%2361718f%27%3E暂无图片%3C/text%3E%3C/svg%3E"/> : <span className="ai-listing-product-placeholder">暂无图片</span>}
          <div className="ai-listing-product-text"><strong className="ai-listing-product-title" title={t.name||t.sku}>{t.name||t.sku}</strong>
          <div className="ai-listing-product-meta">SKU：{t.sku}</div>
          {groups.length>1 && <details className="ai-listing-variants"><summary>多变体 · {groups.length} 个 SKU</summary>{groups.map(g=><div key={g.sku}>{g.sku} · {g.completed}/{g.total} 张 <SkuResult row={g} task={t}/></div>)}</details>}
          {groups.length===1&&<SkuResult row={groups[0]} task={t}/>}
        </div></div>;
      }},
      {title:completedView?"完成时间":"创建时间",key:"time",width:140,render:(_,t)=>{
        const value=completedView?t.updatedAt:t.createdAt;
        const date=value?new Date(value):null;
        if(!date||Number.isNaN(date.getTime()))return "—";
        return <time className="ai-listing-task-time" dateTime={date.toISOString()}><span>{date.toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}).replaceAll("/","-")}</span><span>{date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})}</span></time>;
      }},
      {title:"采集来源",key:"collectionSource",width:220,render:(_,t)=><TaskCollectionSource task={t}/>},
      {title:"状态",dataIndex:"status",width:160,render:(_,t)=><TaskStatusTag task={t}/>},
      {title:"图片进度",key:"progress",width:100,render:(_,t)=>{if(waitingForEnrichment(t))return "待资料补全";const p=aiListingTaskProgress(t);return `${p.completed} / ${p.total}`;}},
      {title:"上架店铺",key:"store",width:150,render:(_,t)=>{
        const targetId=t.submissionTarget?.targetStoreId||t.config?.targetStoreId;
        const store=stores.find(store=>String(store.id||store.storeId)===String(targetId));
        return store?safeStoreLabel(store):(t.submissionTarget?.storeLabel||targetId||(t.config?.autoSwitchStores?"等待分配":"首选店铺"));
      }},
      ...(isAdmin?[{title:"生图通道",dataIndex:"generationChannel",width:170,render:v=>v||"—"}]:[]),
      {title:"生图耗时",dataIndex:"generationDurationMs",width:110,render:v=>v==null?"—":`${Math.floor(v/60000)} 分 ${Math.floor(v/1000)%60} 秒`},
      {title:"操作",key:"actions",fixed:"right",width:190,render:(_,t)=><Space>
        <Button onClick={()=>setDetailTaskId(t.id)}>查看</Button>
        {onAction && <Dropdown trigger={['click']} menu={{items:Object.entries(TASK_ACTION_LABELS)
          .filter(([kind])=>(!completedView||kind==='retry')&&aiListingTaskActions(t,{deletedView})[kind] && !(kind==='retry' && isAiListingPriceSkipped(t)))
          .map(([kind,label])=>({key:kind,label:`${label}任务`,danger:['cancel','delete','permanentDelete'].includes(kind)})),onClick:({key})=>action(t,key)}}
          disabled={!!busyAction || !Object.entries(TASK_ACTION_LABELS).some(([kind])=>(!completedView||kind==='retry')&&aiListingTaskActions(t,{deletedView})[kind]&&!(kind==='retry'&&isAiListingPriceSkipped(t)))}>
          <Button aria-label={`操作任务 ${t.sku || t.id}`}>操作 ▾</Button>
        </Dropdown>}
      </Space>},
    ]}/>
    <Modal title="任务详情" open={!!detailTaskId} onCancel={()=>setDetailTaskId(null)} footer={null} width="90vw" destroyOnHidden>
      {detailError&&<Alert type="error" message={detailError}/>}
      {!detailTask&&!detailError&&<p>正在读取任务详情…</p>}
      {detailTask && <><TaskCard task={detailTask} busyAction={busyAction} onAction={action} deletedView={deletedView} completedView={completedView}/>
      {!detailTask.deletedAt && !!detailTask.submissionRevisions?.length && onAction && <Button type="primary" style={{marginTop:16}} disabled={!!busyAction} onClick={()=>setRevisionTask(detailTask)}>修订资料并重试</Button>}
      {detailTask.status==='COLLECTION_FAILED'&&detailTask.collectItemId&&<Alert style={{marginTop:16}} type="info" showIcon message="先检查采集资料的失败原因"
        description={<><p>在采集箱完成“重新补全”后，再重试此任务；已保存的图片会保留。</p><Button href={`/ozon/products/collect/edit/?id=${encodeURIComponent(detailTask.collectItemId)}`}>查看资料并重新补全</Button></>}/>}
      {isAdmin && !!detailTask.channelHistory?.length && <details style={{marginTop:16}}><summary>通道请求记录（耗时包含失败尝试，不含排队）</summary>{detailTask.channelHistory.map((r,i)=><p key={i}>{r.name} · {r.status === "SUCCEEDED" ? "成功" : r.status === "STARTED" ? "请求中" : "失败"}{r.errorCode ? ` · ${r.errorCode}` : ""}</p>)}</details>}</>}
    </Modal>
    {revisionTask&&<AiListingRevisionDialog key={`${revisionTask.id}:${revisionTask.version}`} task={revisionTask} request={request} onClose={()=>setRevisionTask(null)}
      onSaved={task=>{setRevisionTask(null);setDetailTask(task);setDetailRefresh(value=>value+1);message.success('资料已修订，失败项已加入队列');}}/>}
    <Modal title={`${TASK_ACTION_LABELS[pendingAction?.kind] || ''}任务`} open={!!pendingAction} zIndex={1100} okText={`确认${TASK_ACTION_LABELS[pendingAction?.kind] || ''}`} cancelText="返回"
      okButtonProps={{danger:['cancel','delete','permanentDelete'].includes(pendingAction?.kind),disabled:!!busyAction||(pendingAction?.kind==='retry'&&pendingAction.task.status==='COMPLETED'&&!pendingAction.refreshSalePricing)}} confirmLoading={busyAction === `${pendingAction?.task.id}:${pendingAction?.kind}`}
      onCancel={()=>{if(!busyAction)setPendingAction(null);}} closable={!busyAction} maskClosable={!busyAction}
      onOk={async()=>{if(busyAction)return;await performAction(pendingAction.task,pendingAction.kind,{refreshSalePricing:pendingAction.refreshSalePricing===true,...(pendingAction.skus?{skus:pendingAction.skus}:{})});setPendingAction(null);}}>
      <p>{pendingAction?.task.name || pendingAction?.task.sku}</p>
      {pendingAction?.skus&&<p>本次仅处理 SKU：{pendingAction.skus.join('、')}，保留原商品身份和其他变体结果。</p>}
      <p>{pendingAction?.task.deletedAt&&pendingAction.kind==='resume'?AI_LISTING_DELETED_RECOVERY_DESCRIPTION
        :pendingAction?.kind==='pause'&&pendingAction.task.submissionId
          ?'暂停本系统后续查询和写入，保留已收到的结果；已发送到 Ozon 的请求无法撤回。恢复后继续原提交记录。'
        :pendingAction?.kind==='retry'&&pendingAction.task.submissionStage==='image_failed'
          ?'将失败 SKU 的原有完整图片组重传到 Ozon，完成后继续设置库存。保留原商品货号、已生成图片和成功商品，不重新生图。'
          :CONTROL_DESCRIPTIONS[pendingAction?.kind]}</p>
      {pendingAction?.kind==='retry'&&canRefreshAiListingPricing(pendingAction.task)&&<>
        <Checkbox checked={pendingAction.refreshSalePricing===true} onChange={event=>setPendingAction(current=>({...current,refreshSalePricing:event.target.checked}))}>使用当前售价配置</Checkbox>
        <p>{pendingAction.task.status==='COMPLETED'
          ?'此任务已有成功上架商品。请先更新售价配置并勾选此项，仅恢复已跳过的 SKU；成功商品保留，不会重复提交。'
          :'勾选后，未提交的 SKU 使用当前保存的售价公式及缺绿价设置；成功商品不会重复提交。不勾选则保留任务原配置。'}</p>
      </>}
    </Modal>
  </>;
}

export function AiListingCompletedRecords({accountId,storeId,stores=[],isAdmin=false,request=apiRequest}) {
  const [tasks,setTasks]=useState([]),[error,setError]=useState(null),[total,setTotal]=useState(0),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(5),[refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false),[busyAction,setBusyAction]=useState('');
  // A changed store must render page one before its request is started.
  const scope=`${accountId}:${storeId}`;
  const actionScopeRef=useRef(scope);actionScopeRef.current=scope;
  useEffect(()=>()=>{actionScopeRef.current=null;},[]);
  useEffect(()=>{setBusyAction('');},[scope]);
  const [pageScope,setPageScope]=useState(scope);
  if(pageScope!==scope){setPageScope(scope);setPage(1);}
  useEffect(()=>{
    let stopped=false;const controller=new AbortController();setTasks([]);setError(null);setTotal(0);setLoading(Boolean(accountId&&storeId));
    if(accountId&&storeId)request(`/ai-listing/tasks?view=completed&storeId=${encodeURIComponent(storeId)}&limit=${pageSize}&offset=${(page-1)*pageSize}`,{signal:controller.signal,timeoutMs:30000})
      .then(result=>{if(!stopped){setTasks(result.tasks||[]);const count=result.total??result.tasks?.length??0;setTotal(count);if(page>Math.max(1,Math.ceil(count/pageSize)))setPage(Math.max(1,Math.ceil(count/pageSize)));}})
      .catch(()=>{if(!stopped)setError('AI 上架记录加载失败，请刷新重试');})
      .finally(()=>{if(!stopped)setLoading(false);});
    return()=>{stopped=true;controller.abort();};
  },[request,storeId,accountId,page,pageSize,refresh]);
  const retryIncomplete=async(task,kind,options={})=>{
    if(busyAction||kind!=='retry'||!aiListingTaskActions(task).retry)return false;
    if(task.status==='COMPLETED'&&(!canRefreshAiListingPricing(task)||options.refreshSalePricing!==true))return false;
    setBusyAction(`${task.id}:retry`);
    try{
      const result=await request(`/ai-listing/tasks/${encodeURIComponent(task.id)}/retry`,{method:'POST',body:aiListingActionPayload(task,'retry',options)});
      if(actionScopeRef.current!==scope)return false;
      setRefresh(value=>value+1);message.success('已请求恢复未完成的 SKU，成功商品保持不变');return result.task;
    }catch(error){if(actionScopeRef.current===scope){message.error(error.message||'恢复未完成的 SKU 失败');if(error.status===409)setRefresh(value=>value+1);}return false;}
    finally{if(actionScopeRef.current===scope)setBusyAction('');}
  };
  return <Card className="ai-listing-panel" title="AI 上架完成记录" extra={<Button onClick={()=>setRefresh(value=>value+1)}>刷新</Button>} style={{marginBottom:24}}>
    {error&&<Alert type="warning" message={error}/>}
    <AiListingTaskTable key={scope} completedView isAdmin={isAdmin} stores={stores} tasks={tasks} loading={loading} busyAction={busyAction} onAction={retryIncomplete} request={request} pagination={{current:page,pageSize,total,onChange:(next,size)=>{setPage(next);setPageSize(size);}}}/>
  </Card>;
}
