import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Card,
  Cascader,
  Checkbox,
  ConfigProvider,
  DatePicker,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popover,
  Segmented,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Tag,
  Tooltip,
  Upload,
} from "antd";
import {
  ApartmentOutlined,
  ApiOutlined,
  AppstoreOutlined,
  AreaChartOutlined,
  BellOutlined,
  CheckOutlined,
  ChromeOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  DollarOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  GiftOutlined,
  HomeOutlined,
  InboxOutlined,
  LinkOutlined,
  LoginOutlined,
  MenuOutlined,
  MessageOutlined,
  PictureOutlined,
  PlusOutlined,
  PrinterOutlined,
  SettingOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
} from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import {
  CATEGORY_DATA_ERROR_MESSAGE,
  categoryResolutionForCollectionTarget,
  listingTargetCategoryFieldsForStore,
  categoryItemScopeIsCurrent,
  categoryReadiness,
  manualCategoryResolution,
  requireCategoryReadiness,
  sourceCategoryEvidenceOf,
} from "./category-readiness.js";
import { useCategoryTreeReadiness } from "./use-category-tree-readiness.js";
import {
  dictionaryRowsOfResponse,
  useCategoryDictionaryReadiness,
} from "./use-category-dictionary-readiness.js";
import { postingMoneyGroups } from "./order-money.js";
import DataScreenPage from "./DataScreenPage.jsx";
import PricingSettingsPage from "./PricingSettingsPage.jsx";
import AccountSettingsPage from "./AccountSettingsPage.jsx";
import StoresSettingsPage from "./StoresSettingsPage.jsx";
import { createStoreDeletionCleanup } from "./store-deletion-cleanup.js";
import ProfitTrendPage from "./ProfitTrendPage.jsx";
import SourceTable, {
  SourceMetricStrip,
  SourceSectionTitle,
} from "./SourceTable.jsx";
import {
  dateInputValue,
  todayDateOnly,
} from "./store-date.js";
import {
  adaptiveTextColumnWidth,
  renderSourceTextCell,
  safeExternalHttpUrl,
  sourceCellText,
} from "./table-text.jsx";
import { apiRequest } from "./client-transport.js";
import { PRODUCT_BRAND } from "./brand.js";
import {
  dashboardMoneyGroups,
  dashboardSummaryMoney,
} from "./dashboard-money.js";
import { buildPrepareListingBody, collectAddReadiness, listingPreparationModel, listingSubmissionErrorIsDefinitive, listingSubmissionIntent, settleListingSubmissionIntent, targetStoreSelection } from "./collect-box-target-store.js";
import {
  collectEditDictionaryIdsOf,
  resolveCollectEditDictionaryValue,
  shouldApplyCollectEditDictionaryDefault,
} from "./collect-edit-dictionary-match.js";
import { normalizeCollectEditVariantRow } from "./collect-edit-variant-row.js";
import {
  collectEditEnrichmentBackfill,
  collectEditSourceCategorySnapshot,
  collectEditSourceCategoryVariant,
  collectEnrichmentEffectiveSummary,
  collectEnrichmentErrorSummary,
  collectEnrichmentListNeedsPolling,
  collectEnrichmentNeedsPolling,
  collectEnrichmentSuccessMessage,
  collectEnrichmentView,
  collectWorkflowStatus,
  runCollectEnrichmentRetry,
  startCollectEnrichmentPolling,
} from "./collect-enrichment-view.js";
import { STORE_SYNC_TYPES, runBackendStoreSync } from "./store-sync-coordinator.js";
import { storeSyncDetailText } from "./store-sync-presentation.js";
import {
  createCollectorAuthGenerationController,
  installCollectorAuthBridge,
  postCollectorAuthLogout,
  startCollectorAuthBridgeLifecycle,
} from "./collector-auth-bridge.js";
import {
  emptyLocalRuntimeData,
  localRuntimeStateFromApi,
} from "./local-runtime-state.js";
import { createLatestLocalStateRefresh } from "./latest-request-gate.js";
import {
  EXTENSION_CAPABILITIES,
  EXTENSION_DOWNLOAD_PATH,
  EXTENSION_POPUP_PREVIEW_PATH,
  EXTENSION_VERSION,
} from "./extension-page-contract.mjs";

const { Header, Sider, Content } = Layout;

const STORAGE_KEY = "qh-local-binding-v1";
const SETTINGS_KEY = "qh-local-settings-v1";
const collectEnrichmentTagColors = Object.freeze({
  processing: "processing",
  warning: "warning",
  danger: "error",
  success: "success",
});
const collectEnrichmentAlertTypes = Object.freeze({
  processing: "info",
  warning: "warning",
  danger: "error",
  success: "success",
});

const writeClipboardText = async (value) => {
  const text = String(value || "").trim();
  if (!text) return false;
  if (!navigator.clipboard?.writeText) return false;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("clipboard timeout")), 500)),
    ]);
    return true;
  } catch {
    return false;
  }
};

function SkuCopyButton({ message, sku }) {
  const buttonRef = useRef(null);
  const lastCopyAtRef = useRef(0);
  const messageRef = useRef(message);
  const skuRef = useRef(sku);

  useEffect(() => {
    messageRef.current = message;
    skuRef.current = sku;
  }, [message, sku]);

  const copySku = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - lastCopyAtRef.current < 600) return;
    lastCopyAtRef.current = now;
    if (await writeClipboardText(skuRef.current)) {
      messageRef.current.success("SKU 已复制");
      return;
    }
    messageRef.current.error("SKU 复制失败");
  };

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;
    const handleCopy = (event) => {
      copySku(event);
    };
    button.addEventListener("pointerdown", handleCopy, true);
    button.addEventListener("mousedown", handleCopy, true);
    button.addEventListener("click", handleCopy, true);
    return () => {
      button.removeEventListener("pointerdown", handleCopy, true);
      button.removeEventListener("mousedown", handleCopy, true);
      button.removeEventListener("click", handleCopy, true);
    };
  }, []);

  return (
    <button
      aria-label="复制 SKU"
      className="product-sku-copy"
      data-copy-sku={sku}
      onClickCapture={copySku}
      onPointerDownCapture={copySku}
      ref={buttonRef}
      title="复制 SKU"
      type="button"
    >
      <CopyOutlined />
    </button>
  );
}

const emptyLocalData = emptyLocalRuntimeData();

const pageTitles = {
  "/ozon/dashboard": "仪表盘",
  "/ozon/products/list": "商品列表",
  "/ozon/products/collect": "采集箱",
  "/ozon/products/collect/edit": "商品编辑",
  "/ozon/products/import-history": "上架记录",
  "/ozon/products/stocks": "库存管理",
  "/ozon/products/reshelf": "下架重上",
  "/ozon/tools/ai-poster-records": "AI 改图神器",
  "/ozon/ai-image": "AI 商品套图",
  "/ozon/promotions/prices": "价格与折扣",
  "/ozon/promotions/campaigns": "促销活动",
  "/ozon/promotions/auto-delete": "自动删促销",
  "/ozon/postings/list": "订单",
  "/ozon/postings/returns": "退货申请",
  "/ozon/postings/profit-trend": "利润趋势",
  "/datascreen": "数据大屏",
  "/ozon/postings/review-request": "索要好评",
  "/ozon/postings/pickup-reminder": "提醒取货",
  "/extension": "浏览器插件",
  "/ozon/messaging/templates": "消息模板",
  "/ozon/messaging/history": "发送记录",
  "/ozon/templates": "商品模板",
  "/ozon/settings/stores": "经营店铺",
  "/ozon/settings/accounts": "账号管理",
  "/ozon/settings/pricing": "算价配置",
  "/404": "404",
};

const routeAliases = {
  "/ozon/products": "/ozon/products/list",
  "/ozon/products/batch-upload": "/ozon/products/import-history",
  "/ozon/ai/image": "/ozon/tools/ai-poster-records",
  "/ozon/ai-image/editor": "/ozon/tools/ai-poster-records",
  "/ozon/ai/title": "/ozon/tools/ai-poster-records",
  "/ozon/promotions": "/ozon/promotions/campaigns",
  "/ozon/orders": "/ozon/postings/list",
  "/ozon/orders/shipments": "/ozon/postings/list",
  "/ozon/orders/returns": "/ozon/postings/returns",
  "/ozon/tools/pricing": "/ozon/promotions/prices",
  "/ozon/tools/stores": "/ozon/products/stocks",
  "/ozon/messages": "/ozon/messaging/templates",
  "/ozon/settings": "/ozon/settings/stores",
  "/login": "/ozon/dashboard",
};

const normalizePath = (value) => {
  const path = String(value || "/ozon/dashboard").split("?")[0].replace(/\/+$/, "");
  if (path === "" || path === "/") return "/ozon/dashboard";
  const aliased = routeAliases[path] || path;
  return pageTitles[aliased] ? aliased : "/404";
};

const visibleStoreName = (storeName, clientId, fallback = "已绑定门店") => {
  const value = String(storeName || "").trim();
  const rawClientId = String(clientId || "").trim();
  if (!value || (rawClientId && value === rawClientId)) return fallback;
  return value;
};

const openNativeDatePicker = (event) => {
  const input = event.currentTarget;
  if (typeof input?.showPicker !== "function") return;
  try {
    input.showPicker();
  } catch {
    // Some browsers only allow showPicker during direct pointer activation.
  }
};

const readJson = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const clearLocalAuthStorage = () => {
  const hadAuth =
    localStorage.getItem(STORAGE_KEY) ||
    localStorage.getItem("token") ||
    localStorage.getItem("currentOzonStoreId");
  if (!hadAuth) return false;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("token");
  localStorage.removeItem("currentOzonStoreId");
  localStorage.setItem("jz_logout_signal", String(Date.now()));
  window.dispatchEvent(new Event("jizhang-erp:logout"));
  return true;
};

const clearStoreStorage = () => {
  const hadStore = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("currentOzonStoreId");
  if (!hadStore) return false;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("currentOzonStoreId");
  return true;
};

const requestExtensionPing = async (timeoutMs = 1200) => {
  const reqId = `ping-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("本地浏览器插件未响应，请在 Chrome 重新加载本项目 extension 目录"));
    }, timeoutMs);
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.__jz !== "v1" || data.kind !== "ping.response" || data.reqId !== reqId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (!data.ok) reject(new Error(data.error || "插件桥返回失败"));
      else resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ __jz: "v1", kind: "ping.request", reqId }, window.location.origin);
  });
  return response;
};

const extensionSupportsLocalListing = (response = {}) =>
  response?.capabilities?.followSell === true &&
  response?.capabilities?.dryRunPreview === true &&
  response?.capabilities?.localListingBridge === true;

const listingBridgeStatusFromPing = (response = {}) => {
  const version = response.version || "未知版本";
  if (extensionSupportsLocalListing(response)) {
    return { status: "ok", version, error: "" };
  }
  return {
    status: "partial",
    version,
    error: `插件已响应${version ? ` · ${version}` : ""}，但缺少本地 follow-sell 上架桥能力`,
  };
};

const requestExtensionFollowSell = async ({
  storeId,
  sku,
  price,
  currencyCode,
  dryRun = false,
  offerId = "",
  offerIdPrefix = "",
  brand = "",
  modelName = "",
  stocks = [],
}) => {
  const reqId = `follow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("插件上架桥未响应，请确认本地插件已重新加载"));
    }, 180000);
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.__jz !== "v1" || data.kind !== "follow-sell.response" || data.reqId !== reqId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (!data.ok) reject(new Error(data.error || "插件上架失败"));
      else resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        __jz: "v1",
        kind: "follow-sell.request",
        reqId,
        storeId,
        sku,
        price,
        currencyCode,
        dryRun,
        offerId,
        offerIdPrefix,
        brand,
        modelName,
        stocks,
      },
      window.location.origin,
    );
  });
  return response;
};

const requestExtensionPrefetch = async ({ skus, timeoutMs = 120000 }) => {
  const reqId = `prefetch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("插件采集超时，请确认 Ozon 页面可访问并重新检测插件"));
    }, timeoutMs);
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.__jz !== "v1" || data.kind !== "prefetch.response" || data.reqId !== reqId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (!data.ok) reject(new Error(data.error || "插件采集失败"));
      else resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ __jz: "v1", kind: "prefetch.request", reqId, skus }, window.location.origin);
  });
  return response;
};

const formatDate = () => {
  const now = new Date();
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    now.getDay()
  ];
  const date = now.toISOString().slice(0, 10);
  return `${date} · ${week}`;
};

const menuItems = [
  {
    key: "/ozon/dashboard",
    icon: <DashboardOutlined />,
    label: "仪表盘",
  },
  {
    key: "products",
    icon: <ShoppingCartOutlined />,
    label: "商品",
    children: [
      { key: "/ozon/products/list", label: "商品列表" },
      { key: "/ozon/products/collect", label: "采集箱" },
      { key: "/ozon/products/import-history", label: "上架记录" },
      { key: "/ozon/products/stocks", label: "库存管理" },
      { key: "/ozon/products/reshelf", label: "下架重上" },
    ],
  },
  {
    key: "ai",
    icon: <ThunderboltOutlined />,
    label: "AI 工具",
    children: [
      { key: "/ozon/tools/ai-poster-records", label: "AI 改图神器" },
      { key: "/ozon/ai-image", label: "AI 商品套图" },
    ],
  },
  {
    icon: <GiftOutlined />,
    label: "促销",
    key: "promotions",
    children: [
      { key: "/ozon/promotions/prices", label: "价格与折扣" },
      { key: "/ozon/promotions/campaigns", label: "营销活动" },
      { key: "/ozon/promotions/auto-delete", label: "自动删促销" },
    ],
  },
  {
    key: "orders",
    icon: <DeploymentUnitOutlined />,
    label: "订单",
    children: [
      { key: "/ozon/postings/list", label: "订单" },
      { key: "/ozon/postings/returns", label: "退货申请" },
      { key: "/ozon/postings/profit-trend", label: "利润趋势" },
      { key: "/datascreen", label: "数据大屏" },
    ],
  },
  {
    key: "tools",
    icon: <ToolOutlined />,
    label: "工具",
    children: [
      { key: "/extension", label: "浏览器插件" },
    ],
  },
  {
    key: "messages",
    icon: <MessageOutlined />,
    label: "消息",
    children: [
      { key: "/ozon/messaging/templates", label: "消息模板" },
      { key: "/ozon/messaging/history", label: "发送记录" },
      { key: "/ozon/postings/review-request", label: "索要好评" },
      { key: "/ozon/postings/pickup-reminder", label: "提醒取货" },
    ],
  },
];

const routeParent = {
  "/ozon/products/list": "products",
  "/ozon/products/collect": "products",
  "/ozon/products/collect/edit": "products",
  "/ozon/products/import-history": "products",
  "/ozon/products/stocks": "products",
  "/ozon/products/reshelf": "products",
  "/ozon/tools/ai-poster-records": "ai",
  "/ozon/promotions/prices": "promotions",
  "/ozon/promotions/campaigns": "promotions",
  "/ozon/ai-image": "ai",
  "/ozon/promotions/auto-delete": "promotions",
  "/ozon/postings/list": "orders",
  "/ozon/postings/returns": "orders",
  "/ozon/postings/profit-trend": "orders",
  "/datascreen": "orders",
  "/ozon/postings/review-request": "messages",
  "/ozon/postings/pickup-reminder": "messages",
  "/extension": "tools",
  "/ozon/messaging/templates": "messages",
  "/ozon/messaging/history": "messages",
};

const dashboardMetricList = (summary = emptyLocalData.summary) => [
  { label: "今日订单", value: String(summary.todayPostings || 0), note: "— 持平", sub: "vs 昨日" },
  { label: "今日 GMV", value: dashboardSummaryMoney(summary, "today"), note: "— 持平", sub: "vs 昨日" },
  { label: "等待备货", value: String(summary.awaitingPackaging || 0), note: (summary.awaitingPackaging || 0) ? "需及时处理" : "暂无积压" },
  { label: "等待发运", value: String(summary.awaitingDeliver || 0), note: `合计待处理 ${summary.pendingPostings || 0}` },
  { label: "在售商品", value: `${summary.products || 0}个`, note: "多店聚合" },
  { label: "库存预警", value: "0SKU", note: "库存充足" },
  { label: "今日退货", value: "0", note: "退货率 0.0%" },
  { label: "7 日利润", value: "¥—", note: "需成本数据" },
];

const quickActions = [
  { icon: <SyncOutlined />, label: "一键同步全部", path: "sync" },
  { icon: <DollarOutlined />, label: "批量改价", path: "/ozon/promotions/prices" },
  { icon: <ThunderboltOutlined />, label: "AI 大模型改图", path: "/ozon/tools/ai-poster-records" },
  { icon: <ShoppingOutlined />, label: "1688 采集", path: "/ozon/products/collect" },
  { icon: <MessageOutlined />, label: "群发消息", path: "/ozon/messaging/templates" },
  {
    icon: <CloudUploadOutlined />,
    label: "批量上架",
    path: "/ozon/products/import-history",
  },
  { icon: <PrinterOutlined />, label: "打印发货单", path: "/ozon/postings/list" },
];

const featureLinks = [
  { icon: <InboxOutlined />, label: "采集箱", path: "/ozon/products/collect" },
  { icon: <AreaChartOutlined />, label: "利润趋势", path: "/ozon/postings/profit-trend" },
  { icon: <PictureOutlined />, label: "AI 大模型改图", path: "/ozon/tools/ai-poster-records", tag: "NEW" },
  { icon: <DeploymentUnitOutlined />, label: "17track", path: "/ozon/postings/list" },
  { icon: <GiftOutlined />, label: "营销活动", path: "/ozon/promotions/campaigns" },
];

const requiredSteps = [
  "绑定店铺",
  "安装浏览器插件",
  "同步商品数据",
  "处理首个订单",
];

const pluginWordmarkStyle = {
  width: "auto",
  maxWidth: 156,
  height: 36,
  objectFit: "contain",
};

export function AppShell({ initialState = null }) {
  const { message, modal } = AntApp.useApp();
  const [route, setRoute] = useState(() => initialState?.route || normalizePath(window.location.pathname));
  const [account, setAccount] = useState(() => initialState?.account || null);
  const [accounts, setAccounts] = useState([]);
  const [authChecked, setAuthChecked] = useState(() => initialState?.authChecked === true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [binding, setBinding] = useState(() => {
    const stored = readJson(STORAGE_KEY, null);
    return stored ? { ...stored, storeName: visibleStoreName(stored.storeName, stored.clientId) } : null;
  });
  const [settings, setSettings] = useState(() =>
    readJson(SETTINGS_KEY, { pluginInstalled: true, lastSync: null }),
  );
  const [localData, setLocalData] = useState(emptyLocalData);
  const [syncing, setSyncing] = useState(false);
  const [storeSyncStates, setStoreSyncStates] = useState([]);
  const [bindOpen, setBindOpen] = useState(false);
  const [editingBindingStore, setEditingBindingStore] = useState(null);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openKeys, setOpenKeys] = useState(() => {
    const parent = routeParent[normalizePath(window.location.pathname)];
    return parent ? [parent] : [];
  });
  const [form] = Form.useForm();
  const applyLocalStateRef = useRef(null);
  const localStateRefreshRef = useRef(null);
  const collectorAuthGenerationRef = useRef(null);
  const messageRef = useRef(message);
  messageRef.current = message;
  if (!collectorAuthGenerationRef.current) {
    collectorAuthGenerationRef.current = createCollectorAuthGenerationController();
  }

  const hasStore = Boolean(binding?.storeName);
  const isEditingBindingStore = Boolean(editingBindingStore?.id || editingBindingStore?.storeId);
  const pageTitle = pageTitles[route] || "仪表盘";
  const currentDate = useMemo(() => formatDate(), []);

  const applyLocalState = async (state) => {
    const nextAccount = state?.account || null;
    setAccount(nextAccount);
    setAccounts(state?.accounts || []);
    setLocalData(localRuntimeStateFromApi(state));
    if (!nextAccount) {
      setBinding(null);
      setAccounts([]);
      setLocalData(emptyLocalData);
      clearLocalAuthStorage();
      setAuthChecked(true);
      return;
    }
    if (state?.token) localStorage.setItem("token", state.token);
    if (state?.binding) {
      const storeName = visibleStoreName(state.binding.label || state.binding.companyName, state.binding.clientId);
      const nextBinding = {
        id: state.binding.id,
        storeName,
        clientId: state.binding.clientId || "",
        apiKeyMasked: state.binding.apiKeyMasked || "",
        currency: state.binding.currency || state.binding.currencyCode || state.binding.companyCurrency || "",
        currencyCode: state.binding.currencyCode || state.binding.currency || state.binding.companyCurrency || "",
        companyCurrency: state.binding.companyCurrency || state.binding.currency || state.binding.currencyCode || "",
        apiKeyCreatedAt: state.binding.apiKeyCreatedAt || "",
        apiKeyExpiresAt: state.binding.apiKeyExpiresAt || "",
        savedAt: state.binding.savedAt,
      };
      setBinding(nextBinding);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBinding));
      const restoredStoreId = state.currentStoreId || nextBinding.id || "";
      if (restoredStoreId) localStorage.setItem("currentOzonStoreId", restoredStoreId);
    } else {
      setBinding(null);
      clearStoreStorage();
    }
    if (state?.summary?.lastSyncAt) {
      const nextSettings = { ...settings, lastSync: state.summary.lastSyncAt };
      setSettings(nextSettings);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
    }
    setAuthChecked(true);
  };

  applyLocalStateRef.current = applyLocalState;
  if (!localStateRefreshRef.current) {
    localStateRefreshRef.current = createLatestLocalStateRefresh({
      readState: () => apiRequest("/local/state"),
      applyState: (state) => applyLocalStateRef.current(state),
    });
  }

  const refreshLocalState = React.useCallback(async ({ silent = true, source = "manual-refresh" } = {}) => {
    try {
      const result = await localStateRefreshRef.current({ source });
      return result.status === "applied" ? result.state : null;
    } catch (error) {
      if (!silent) messageRef.current.error(`本地 API 未启动: ${error.message}`);
      setAuthChecked(true);
      return null;
    }
  }, []);

  const handleStoreDeleted = createStoreDeletionCleanup({
    clearStoreStorage,
    readToken: () => localStorage.getItem("token"),
    setCurrentStoreId: (storeId) => localStorage.setItem("currentOzonStoreId", storeId),
    // Collector authentication is account-scoped and independent of store
    // Keep this legacy cleanup adapter neutral until it is removed.
    syncAuthToExtension: async () => true,
    logoutExtension: async () => true,
  });

  const collectorAuthAccountId = String(account?.id || "").trim();
  useEffect(() => {
    return startCollectorAuthBridgeLifecycle({
      accountId: authChecked ? collectorAuthAccountId : "",
      controller: collectorAuthGenerationRef.current,
      postLogout: (generationId) => postCollectorAuthLogout({ generationId }),
      installBridge: (transition) => installCollectorAuthBridge({
        generationId: transition.generationId,
        isLoggedIn: () => true,
        requestTicket: () => apiRequest("/extension/collector-auth/ticket", { method: "POST" }),
        announceReady: transition.announceReady,
      }),
    });
  }, [authChecked, collectorAuthAccountId]);

  useEffect(() => {
    const onPop = () => {
      const normalized = normalizePath(window.location.pathname);
      setRoute(normalized);
      const parent = routeParent[normalized];
      setOpenKeys(parent ? [parent] : []);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (route === "/404") {
      document.title = "404: This page could not be found.";
      return;
    }
    document.title = route === "/datascreen" ? `${PRODUCT_BRAND.displayName} · 订单数据大屏` : PRODUCT_BRAND.displayName;
  }, [route]);

  useEffect(() => {
    const parent = routeParent[route];
    setOpenKeys(parent ? [parent] : []);
  }, [route]);

  useEffect(() => {
    const mobileMediaQuery = window.matchMedia("(max-width: 600px)");
    const handleMobileViewportChange = (event) => {
      if (!event.matches) setMobileNavOpen(false);
    };
    mobileMediaQuery.addEventListener("change", handleMobileViewportChange);
    return () => mobileMediaQuery.removeEventListener("change", handleMobileViewportChange);
  }, []);

  useEffect(() => {
    refreshLocalState({ source: "initial-load" });
    const timer = window.setInterval(() => refreshLocalState({ source: "background-poll" }), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      const isMod = event.metaKey || event.ctrlKey;
      if (isMod && event.key.toLowerCase() === "r") {
        event.preventDefault();
        handleSync();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const navigate = (nextRoute) => {
    if (nextRoute === "sync") {
      handleSync();
      return;
    }
    if (nextRoute === "plugin") {
      setPluginOpen(true);
      setRoute("/extension");
      window.history.pushState({}, "", "/extension/");
      return;
    }
    const rawRoute = String(nextRoute || "");
    let nextSearch = "";
    try {
      nextSearch = new URL(rawRoute, window.location.origin).search;
    } catch {
      nextSearch = rawRoute.includes("?") ? rawRoute.slice(rawRoute.indexOf("?")) : "";
    }
    const normalized = normalizePath(nextRoute);
    setRoute(normalized);
    const parent = routeParent[normalized];
    setOpenKeys(parent ? [parent] : []);
    window.history.pushState({}, "", `${normalized}/${nextSearch}`);
  };

  const openBindModal = (store = null) => {
    setEditingBindingStore(store || null);
    setBindOpen(true);
  };

  const closeBindModal = () => {
    setBindOpen(false);
    setEditingBindingStore(null);
    form.resetFields();
  };

  const handleAccountLogin = async (values) => {
    if (loggingIn) return;
    setLoggingIn(true);
    try {
      const response = await apiRequest("/local/accounts/login", {
        method: "POST",
        body: {
          username: values.username,
          password: values.password,
        },
      });
      if (response.token) localStorage.setItem("token", response.token);
      await applyLocalState(response.state || {});
      message.success("登录成功");
      if (route === "/404") navigate("/ozon/dashboard");
    } catch (error) {
      message.error(error.message || "登录失败");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleAccountLogout = async () => {
    try {
      await apiRequest("/local/accounts/logout", { method: "POST" }).catch(() => {});
      clearLocalAuthStorage();
      setAccount(null);
      setAccounts([]);
      setBinding(null);
      setLocalData(emptyLocalData);
      setAuthChecked(true);
      message.success("已退出登录");
    } catch (error) {
      message.error(`退出失败: ${error.message}`);
    }
  };

  const runStoreSync = async (types) => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      openBindModal();
      return;
    }
    if (syncing) return;
    const requestedTypes = Array.isArray(types) && types.length ? types : STORE_SYNC_TYPES;
    const fullSync = requestedTypes.length === STORE_SYNC_TYPES.length;
    setSyncing(true);
    const nextSettings = { ...settings, lastSync: new Date().toISOString() };
    setSettings(nextSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
    const storeId = localData?.currentStoreId || binding?.id || localStorage.getItem("currentOzonStoreId");
    try {
      const labels = {
        WAREHOUSES: "仓库",
        PRODUCTS: "商品",
        POSTINGS: "订单",
        PROMOTIONS: "促销",
      };
      const states = await runBackendStoreSync({
        storeId,
        types: requestedTypes,
        request: apiRequest,
        onState: (nextStates) => {
          setStoreSyncStates((current) => {
            if (fullSync) return nextStates;
            const nextByType = new Map(current.map((item) => [item.type, item]));
            for (const item of nextStates) nextByType.set(item.type, item);
            return STORE_SYNC_TYPES
              .map((type) => nextByType.get(type))
              .filter(Boolean);
          });
          const running = nextStates.find((item) => item.status === "RUNNING");
          if (running) {
            message.loading({
              content: `正在从后端同步当前店铺${labels[running.type]}`,
              key: "store-sync",
              duration: 0,
            });
          }
        },
      });
      await refreshLocalState({ source: "store-sync" });
      const completedTypes = states
        .filter((item) => item.status === "SUCCESS")
        .map((item) => item.type);
      const failedTypes = states
        .filter((item) => item.status === "FAILED")
        .map((item) => item.type);
      if (failedTypes.length) {
        message.warning({
          content: `${failedTypes.map((type) => labels[type]).join(" / ")}同步失败，可单独重试；其他成功结果已保留`,
          key: "store-sync",
          duration: 6,
        });
      } else {
        message.success({
          content: `当前店铺同步完成 · ${completedTypes.map((type) => labels[type]).join(" / ")}`,
          key: "store-sync",
        });
      }
    } catch (error) {
      message.error({ content: `同步失败: ${error.message}`, key: "store-sync" });
    } finally {
      setSyncing(false);
    }
  };
  const handleSync = () => runStoreSync(STORE_SYNC_TYPES);
  const retryStoreSyncType = (type) => runStoreSync([type]);

  useEffect(() => {
    if (!bindOpen) return;
    form.setFieldsValue({
      clientId: editingBindingStore?.clientId || binding?.clientId || "",
      apiKey: "",
      label: editingBindingStore?.label || editingBindingStore?.companyName || binding?.storeName || "",
      apiKeyCreatedAt: dateInputValue(editingBindingStore?.apiKeyCreatedAt || binding?.apiKeyCreatedAt) || (editingBindingStore ? "" : todayDateOnly()),
    });
  }, [bindOpen, editingBindingStore, binding, form]);

  const saveBinding = async (values) => {
    try {
      const clientId = values.clientId.trim();
      const label = (values.label || "").trim();
      const editingStoreId = editingBindingStore?.id || editingBindingStore?.storeId || "";
      const response = editingStoreId
        ? await apiRequest(`/local/stores/${encodeURIComponent(editingStoreId)}`, {
          method: "PATCH",
          body: {
            label,
            apiKey: values.apiKey || "",
            apiKeyCreatedAt: values.apiKeyCreatedAt || "",
          },
        })
        : await apiRequest("/local/binding", {
          method: "POST",
          body: {
            label,
            clientId,
            apiKey: values.apiKey || "",
            apiKeyCreatedAt: values.apiKeyCreatedAt || todayDateOnly(),
          },
        });
      if (editingStoreId) {
        closeBindModal();
        await refreshLocalState({ source: "store-edit" });
        message.success("门店已修改");
        return;
      }
      const store = response.store;
      const nextBinding = {
        id: store.id,
        storeName: visibleStoreName(store.label || store.companyName, store.clientId),
        clientId: store.clientId,
        apiKeyMasked: store.apiKeyMasked || "已保存",
        currency: store.currency || store.currencyCode || store.companyCurrency || "",
        currencyCode: store.currencyCode || store.currency || store.companyCurrency || "",
        companyCurrency: store.companyCurrency || store.currency || store.currencyCode || "",
        apiKeyCreatedAt: store.apiKeyCreatedAt || "",
        apiKeyExpiresAt: store.apiKeyExpiresAt || "",
        savedAt: store.savedAt,
      };
      setBinding(nextBinding);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBinding));
      localStorage.setItem("token", response.token);
      localStorage.setItem("currentOzonStoreId", store.id);
      closeBindModal();
      await refreshLocalState({ source: "store-bind" });
      message.success("门店已绑定");
    } catch (error) {
      message.error(`保存失败: ${error.message}`);
    }
  };

  const switchCurrentStore = async (storeId) => {
    const target = (localData.stores || []).find((store) => String(store.id || store.storeId || "") === String(storeId || ""));
    if (!target) {
      message.warning("门店不存在");
      return;
    }
    if (String(target.id || target.storeId || "") === String(binding?.id || "")) {
      message.info("已是当前门店");
      return;
    }
    try {
      const response = await apiRequest("/local/current-store", {
        method: "POST",
        body: { storeId: target.id || target.storeId },
      });
      const store = response.store || target;
      const nextBinding = {
        id: store.id || store.storeId,
        storeName: visibleStoreName(store.label || store.companyName || target.label, store.clientId),
        clientId: store.clientId || target.clientId || "",
        apiKeyMasked: store.apiKeyMasked || target.apiKeyMasked || "已保存",
        currency: store.currency || store.currencyCode || store.companyCurrency || "",
        currencyCode: store.currencyCode || store.currency || store.companyCurrency || "",
        companyCurrency: store.companyCurrency || store.currency || store.currencyCode || "",
        apiKeyCreatedAt: store.apiKeyCreatedAt || target.apiKeyCreatedAt || "",
        apiKeyExpiresAt: store.apiKeyExpiresAt || target.apiKeyExpiresAt || "",
        savedAt: store.savedAt || target.savedAt,
      };
      setBinding(nextBinding);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBinding));
      localStorage.setItem("currentOzonStoreId", nextBinding.id);
      await refreshLocalState({ source: "store-switch" });
      message.success(`已切换到 ${nextBinding.storeName}`);
    } catch (error) {
      message.error(`切换失败: ${error.message}`);
    }
  };

  const clearBinding = () => {
    Modal.confirm({
      title: "解除当前门店绑定",
      content: "本地绑定信息会被清空，商品与订单数据不会生成替代数据。",
      okText: "解除绑定",
      cancelText: "取消",
      onOk: async () => {
        await apiRequest("/local/binding", { method: "DELETE" }).catch(() => {});
        setBinding(null);
        setLocalData(emptyLocalData);
        clearStoreStorage();
        message.success("已解除绑定");
      },
    });
  };

  const completeStepCount = [hasStore, settings.pluginInstalled, Boolean(settings.lastSync), false].filter(Boolean).length;
  const themeConfig = {
    token: {
      colorPrimary: "#005af8",
      colorPrimaryHover: "#004fe0",
      colorText: "#071737",
      colorTextSecondary: "#65718a",
      colorBorder: "#dce8f7",
      colorBgLayout: "#f6fafe",
      colorBgContainer: "#ffffff",
      borderRadius: 12,
      borderRadiusLG: 18,
      boxShadowSecondary: "0 12px 38px rgba(24, 79, 151, 0.08)",
      fontFamily:
        'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, -apple-system, sans-serif',
    },
    components: {
      Layout: {
        headerBg: "#fff",
        siderBg: "#fff",
        triggerBg: "#fff",
      },
      Card: {
        borderRadiusLG: 18,
      },
    },
  };

  const storeDropdownItems = [
    ...(localData.stores?.length ? localData.stores : []).map((store) => {
      const storeId = store.id || store.storeId;
      const isCurrent = String(storeId || "") === String(binding?.id || "");
      const label = visibleStoreName(store.label || store.companyName, store.clientId);
      return {
        key: `store:${storeId}`,
        label: (
          <div className="store-dropdown-row">
            <span>{label}</span>
            {isCurrent ? <Tag color="blue">当前</Tag> : null}
          </div>
        ),
      };
    }),
    ...(localData.stores?.length ? [{ type: "divider" }] : []),
    {
      key: hasStore ? "manage" : "bind",
      label: hasStore ? "管理店铺" : "去绑定门店",
    },
  ];

  const onStoreDropdownClick = ({ key }) => {
    if (key === "manage") {
      navigate("/ozon/settings/stores");
      return;
    }
    if (key === "bind") {
      openBindModal();
      return;
    }
    if (String(key).startsWith("store:")) {
      switchCurrentStore(String(key).slice("store:".length));
    }
  };

  const userPopover = (
    <div className="topbar-popover user-popover">
      <div className="user-popover-head">
        <strong>{account?.displayName || account?.username || "未登录"}</strong>
        <span>{account?.role === "admin" ? "管理员账号" : "普通账号"}</span>
      </div>
      {[
        ...(account?.role === "admin" ? [["账号管理", () => navigate("/ozon/settings/accounts")]] : []),
        ...(account?.role === "admin" ? [["算价配置", () => navigate("/ozon/settings/pricing")]] : []),
        ["退出登录", handleAccountLogout],
      ].map(([label, onClick]) => (
        <button className="user-popover-item" type="button" onClick={onClick} key={label}>
          {label}
        </button>
      ))}
    </div>
  );

  if (!authChecked) {
    return (
      <ConfigProvider autoInsertSpaceInButton={false} locale={zhCN} theme={themeConfig}>
        <LoginPage checking />
      </ConfigProvider>
    );
  }

  if (!account) {
    return (
      <ConfigProvider autoInsertSpaceInButton={false} locale={zhCN} theme={themeConfig}>
        <LoginPage loading={loggingIn} onLogin={handleAccountLogin} />
      </ConfigProvider>
    );
  }

  if (route === "/datascreen") {
    return (
      <ConfigProvider autoInsertSpaceInButton={false} locale={zhCN} theme={themeConfig}>
        <DataScreenPage
          hasStore={hasStore}
          binding={binding}
          localData={localData}
          navigate={navigate}
        />
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider
      autoInsertSpaceInButton={false}
      locale={zhCN}
      theme={themeConfig}
    >
      <Layout className="qh-shell prototype-shell">
        <Header className="qh-topbar">
          <a className="qh-brand" onClick={() => navigate("/ozon/dashboard")}>
            <img src={PRODUCT_BRAND.logoPrimaryUrl} alt={PRODUCT_BRAND.displayName} />
          </a>
          <Button
            aria-label="打开导航"
            className="prototype-mobile-menu-trigger"
            icon={<MenuOutlined />}
            onClick={() => setMobileNavOpen(true)}
            type="text"
          />
          <div className="qh-top-actions">
            <HeaderAction
              icon={<ChromeOutlined />}
              title="浏览器插件"
              subtitle="插件下载"
              tone="blue"
            />
            <Dropdown
              menu={{ items: storeDropdownItems, onClick: onStoreDropdownClick }}
              trigger={["click"]}
              placement="bottomRight"
              overlayClassName="topbar-overlay store-topbar-overlay prototype-overlay"
            >
              <span>
                <HeaderAction
                  icon={<ApartmentOutlined />}
                  title="当前门店"
                  subtitle={hasStore ? visibleStoreName(binding?.storeName, binding?.clientId) : "去绑定门店"}
                  tone="orange"
                />
              </span>
            </Dropdown>
            <Popover content={userPopover} trigger="click" placement="bottomRight" overlayClassName="topbar-overlay user-topbar-overlay prototype-overlay">
              <div className="qh-user">
                <UserOutlined />
                <div>
                  <span>当前用户</span>
                  <strong>已登录</strong>
                </div>
              </div>
            </Popover>
          </div>
        </Header>
        <Layout>
          <Sider
            width={216}
            className="qh-sider"
          >
            <Menu
              mode="inline"
              selectedKeys={[route]}
              openKeys={openKeys}
              onOpenChange={setOpenKeys}
              items={menuItems}
              onClick={({ key }) => navigate(key)}
            />
          </Sider>
          <Content className="qh-content">
            {route === "/ozon/dashboard" ? (
              <div className="qh-page-head">
                <div>
                  <span className="prototype-eyebrow">OZON SELLER WORKSPACE</span>
                  <h1>{pageTitle}</h1>
                  <p className="prototype-page-subtitle">
                    先看经营结果，再处理今天最重要的异常
                  </p>
                  <div className="qh-date-row">
                    <span>{currentDate}</span>
                    <span className="qh-dot" />
                    <span>自动同步 · 上次 {settings.lastSync ? new Date(settings.lastSync).toLocaleTimeString() : "—"}</span>
                  </div>
                </div>
                <div className="page-head-actions">
                  <Button type="primary" icon={<SyncOutlined />} onClick={handleSync} loading={syncing}>
                    全部同步
                    <kbd>⌘R</kbd>
                  </Button>
                </div>
              </div>
            ) : null}
            {route === "/ozon/dashboard" ? (
              <DashboardPage
                hasStore={hasStore}
                binding={binding}
                summary={localData.summary}
                completeStepCount={completeStepCount}
                navigate={navigate}
                onBind={openBindModal}
                onPlugin={() => setPluginOpen(true)}
                onSync={handleSync}
                onRetrySyncType={retryStoreSyncType}
                storeSyncStates={storeSyncStates}
                syncing={syncing}
              />
            ) : (
              <GenericPage
                route={route}
                binding={binding}
                hasStore={hasStore}
                localData={localData}
                onBind={openBindModal}
                onPlugin={() => setPluginOpen(true)}
                onSync={handleSync}
                onClear={clearBinding}
                onSwitchStore={switchCurrentStore}
                onRefresh={refreshLocalState}
                onStoreDeleted={handleStoreDeleted}
                account={account}
                accounts={accounts}
                navigate={navigate}
              />
            )}
          </Content>
        </Layout>
      </Layout>

      <Modal
        title={isEditingBindingStore ? "修改 API 授权门店" : "新增 API 授权门店"}
        rootClassName="prototype-overlay"
        open={bindOpen}
        onCancel={closeBindModal}
        footer={null}
        width={520}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={saveBinding}
          initialValues={{
            clientId: binding?.clientId || "",
            apiKey: "",
            label: binding?.storeName || "",
            apiKeyCreatedAt: dateInputValue(binding?.apiKeyCreatedAt) || todayDateOnly(),
          }}
        >
          <Form.Item
            label="Client-Id"
            name="clientId"
            rules={[{ required: true, message: "请输入 Client-Id" }]}
          >
            <Input prefix={<ApiOutlined />} placeholder="Ozon Client-Id" disabled={isEditingBindingStore} />
          </Form.Item>
          <Form.Item
            label="Api-Key"
            name="apiKey"
            extra={isEditingBindingStore ? "留空则不修改当前保存的 Api-Key。" : ""}
            rules={[{ required: !isEditingBindingStore, message: "请输入 Api-Key" }]}
          >
            <Input.Password prefix={<DatabaseOutlined className="bind-field-icon" />} placeholder="Ozon Api-Key" />
          </Form.Item>
          <Form.Item label="标签" name="label">
            <Input placeholder="可选，例如：主店" />
          </Form.Item>
          <Form.Item
            label="API Key 创建日期"
            name="apiKeyCreatedAt"
            extra="系统按创建日期自动计算 180 天有效期；未填写时默认采用新增店铺当天计算。"
          >
            <Input
              className="bind-date-input"
              type="date"
              placeholder="选择 API Key 创建日期"
              onClick={openNativeDatePicker}
            />
          </Form.Item>
          <div className="bind-actions">
            <Space>
              <Button onClick={closeBindModal}>取 消</Button>
              <Button type="primary" htmlType="submit">
                {isEditingBindingStore ? "保 存" : "新 增"}
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      <Drawer
        title="浏览器插件"
        rootClassName="prototype-overlay"
        open={pluginOpen}
        onClose={() => setPluginOpen(false)}
        size={520}
      >
        <PluginPanel />
      </Drawer>

      <Drawer
        className="prototype-mobile-nav"
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        placement="left"
        rootClassName="prototype-overlay"
        title={`${PRODUCT_BRAND.displayName} · Ozon 运营台`}
        width={288}
      >
        <Menu
          mode="inline"
          selectedKeys={[route]}
          openKeys={openKeys}
          onOpenChange={setOpenKeys}
          items={menuItems}
          onClick={({ key }) => {
            setMobileNavOpen(false);
            navigate(key);
          }}
        />
      </Drawer>

    </ConfigProvider>
  );
}

function HeaderAction({ icon, title, subtitle, tone = "default", onClick }) {
  return (
    <button className={`qh-header-action tone-${tone}`} onClick={onClick} type="button">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <em>{subtitle}</em>
      </div>
    </button>
  );
}

function LoginPage({ checking = false, loading = false, onLogin }) {
  return (
    <div className="sonli-login-page">
      <div className="sonli-login-card">
        <div className="sonli-login-brand">
          <img src={PRODUCT_BRAND.logoPrimaryUrl} alt={PRODUCT_BRAND.displayName} />
          <div>
            <span>Ozon 本地管理后台</span>
          </div>
        </div>
        {checking ? (
          <div className="sonli-login-checking">
            <SyncOutlined spin />
            <span>正在检查登录状态...</span>
          </div>
        ) : (
          <Form layout="vertical" onFinish={onLogin} requiredMark={false}>
            <Form.Item
              label="账号"
              name="username"
              rules={[{ required: true, message: "请输入管理员分配的账号" }]}
            >
              <Input prefix={<UserOutlined />} placeholder="请输入账号" autoComplete="username" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password prefix={<LoginOutlined />} placeholder="请输入密码" autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登 录
            </Button>
            <p className="sonli-login-note">账号由管理员统一分配，超出登录期限后将无法继续登录。</p>
          </Form>
        )}
      </div>
    </div>
  );
}

function DashboardPage({
  hasStore,
  binding,
  summary,
  completeStepCount,
  navigate,
  onBind,
  onPlugin,
  onSync,
  onRetrySyncType,
  storeSyncStates,
  syncing,
}) {
  const currentSummary = summary || emptyLocalData.summary;
  const metrics = dashboardMetricList(currentSummary);
  const weeklyMetrics = [
    ["本周 GMV", dashboardSummaryMoney(currentSummary, "week")],
    ["本周利润", "¥—"],
    ["本周订单", String(currentSummary.weekPostings || 0)],
    ["退货率", "0.0%"],
  ];
  return (
    <div className="dashboard-stack">
      <div className="metric-grid top">
        {metrics.slice(0, 4).map((metric) => (
          <MetricCard metric={metric} key={metric.label} />
        ))}
      </div>
      <div className="metric-grid">
        {metrics.slice(4).map((metric) => (
          <MetricCard metric={metric} key={metric.label} compact />
        ))}
      </div>
      {storeSyncStates.length ? (
        <Card className="panel-card">
          <div className="card-title-row">
            <span>店铺同步进度</span>
            <Tag>仅由后端 Seller API 执行</Tag>
          </div>
          <Space wrap>
            {storeSyncStates.map((state) => (
              <Space key={state.type} size={6}>
                <span>{({
                  WAREHOUSES: "仓库",
                  PRODUCTS: "商品",
                  POSTINGS: "订单",
                  PROMOTIONS: "促销",
                })[state.type] || state.type}</span>
                <Tag color={{
                  PENDING: "default",
                  RUNNING: "processing",
                  SUCCESS: "success",
                  FAILED: "error",
                }[state.status]}>
                  {state.status}
                </Tag>
                <span>{storeSyncDetailText(state)}</span>
                {state.status === "FAILED" ? (
                  <Button
                    disabled={syncing}
                    onClick={() => onRetrySyncType(state.type)}
                    size="small"
                  >
                    单独重试
                  </Button>
                ) : null}
              </Space>
            ))}
          </Space>
        </Card>
      ) : null}
      <div className="dashboard-main-grid">
        <Card className="panel-card todo-card">
          <div className="card-title-row">
            <span>待办与告警</span>
            <Button type="text" size="small" icon={<SettingOutlined />}>
              配置规则
            </Button>
          </div>
          <div className="todo-skeleton-list" aria-label="待办与告警空状态">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="todo-skeleton-row" key={index}>
                <span className="todo-skeleton left" />
                <span className="todo-skeleton-copy">
                  <span className="todo-skeleton title" />
                  <span className="todo-skeleton sub" />
                </span>
                <span className="todo-skeleton right" />
              </div>
            ))}
          </div>
        </Card>
        <Card className="panel-card overview-card">
          <div className="card-title-row">
            <span>业务速览</span>
            <Tag>数据滞后 ≤ 15 分钟</Tag>
          </div>
          <div className="empty-chart-grid">
            <div>
              <div className="chart-title">
                <span>订单状态</span>
                <em>共 {currentSummary.postingsTotal || currentSummary.postings || 0} 单</em>
              </div>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={(currentSummary.postingsTotal || currentSummary.postings) ? "订单明细请进入订单页" : "暂无订单"} />
            </div>
            <div>
              <div className="chart-title">
                <span>订单趋势</span>
                <Segmented size="small" options={["7 日", "30 日"]} />
              </div>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
            </div>
          </div>
        </Card>
      </div>
      <Card className="panel-card quick-card">
        <div className="card-title-row">
          <span>快捷操作</span>
          <em>
            常用操作一键触达 · <kbd>⌘K</kbd> 唤起命令面板
          </em>
        </div>
        <div className="quick-actions">
          {quickActions.map((item, index) => (
            <button
              type="button"
              className={index === 0 ? "primary" : ""}
              key={item.label}
              onClick={item.path === "sync" ? onSync : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
              {index === 0 ? <kbd>⌘R</kbd> : null}
            </button>
          ))}
        </div>
      </Card>
      <div className="dashboard-bottom-grid">
        <Card className="panel-card feature-card">
          <div className="feature-head">
            <span>功能入口</span>
            <Space size={6}>
              <Tag color="blue">{PRODUCT_BRAND.displayName}功能</Tag>
              <Tag>外部资源</Tag>
            </Space>
          </div>
          <div className="feature-grid">
            {featureLinks.map((item) => (
              <button key={item.label} type="button">
                {item.icon}
                <span>{item.label}</span>
                {item.tag ? <Tag color="blue">{item.tag}</Tag> : null}
              </button>
            ))}
          </div>
        </Card>
        <Card className="panel-card start-card">
          <div className="start-head">
            <span>快速上手</span>
            <strong>
              {completeStepCount}<em>/</em>{requiredSteps.length}
            </strong>
          </div>
          <p>完成全部步骤后此模块自动隐藏</p>
          <Steps
            orientation="vertical"
            current={completeStepCount}
            items={[
              {
                title: "绑定店铺",
                content: binding?.storeName || "添加 Ozon API Key",
                onClick: onBind,
              },
              {
                title: "安装浏览器插件",
                content: `${PRODUCT_BRAND.displayName}助手已安装`,
                onClick: onPlugin,
              },
              {
                title: "同步商品数据",
                content: "点击立即开始 · 预计 3 分钟",
                onClick: onSync,
              },
              {
                title: "处理首个订单",
                content: "查看订单列表学习发货流程",
                onClick: () => navigate("/ozon/postings/list"),
              },
            ]}
          />
        </Card>
      </div>
      <Card className="panel-card weekly-card">
        <div className="weekly-grid">
          {weeklyMetrics.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <p>每 5 分钟自动同步 · 上次 {currentSummary.lastSyncAt ? new Date(currentSummary.lastSyncAt).toLocaleTimeString() : "—"}</p>
      </Card>
    </div>
  );
}

function MetricCard({ metric, compact = false }) {
  return (
    <button className={`metric-card ${compact ? "compact" : ""}`}>
      <span>{metric.label}</span>
      <strong>{metric.value}</strong>
      <em>
        {metric.note}
        {metric.sub ? <small>{metric.sub}</small> : null}
      </em>
    </button>
  );
}

function GenericPage({ route, binding, hasStore, localData, onBind, onPlugin, onSync, onClear, onSwitchStore, onRefresh, onStoreDeleted, navigate, account, accounts }) {
  if (route === "/extension") {
    return (
      <Card className="panel-card">
        <PluginPanel />
      </Card>
    );
  }

  const pageProps = { route, binding, hasStore, localData, onBind, onPlugin, onSync, onClear, onSwitchStore, onRefresh, onStoreDeleted, navigate, account, accounts };
  if (route === "/ozon/products/list") return <ProductListPage {...pageProps} />;
  if (route.startsWith("/ozon/products/collect/edit")) return <CollectEditPage {...pageProps} />;
  if (route === "/ozon/products/collect") return <CollectPage {...pageProps} />;
  if (route === "/ozon/products/import-history") return <ImportHistoryPage {...pageProps} />;
  if (route === "/ozon/products/stocks") return <StocksPage {...pageProps} />;
  if (route === "/ozon/products/reshelf") return <ReshelfPage {...pageProps} />;
  if (route === "/ozon/tools/ai-poster-records") return <AiPosterPage {...pageProps} />;
  if (route === "/ozon/ai-image") return <AiImagePage />;
  if (route === "/ozon/promotions/prices") return <PriceDiscountPage {...pageProps} />;
  if (route === "/ozon/promotions/campaigns") return <CampaignsPage {...pageProps} />;
  if (route === "/ozon/promotions/auto-delete") return <AutoDeletePromoPage {...pageProps} />;
  if (route === "/ozon/postings/list") return <PostingsPage {...pageProps} />;
  if (route === "/ozon/postings/returns") return <ReturnsPage {...pageProps} />;
  if (route === "/ozon/postings/profit-trend") return <ProfitTrendPage {...pageProps} />;
  if (route === "/ozon/postings/review-request") return <MessageTaskPage {...pageProps} type="review" />;
  if (route === "/ozon/postings/pickup-reminder") return <MessageTaskPage {...pageProps} type="pickup" />;
  if (route === "/ozon/messaging/templates") return <MessageTemplatesPage {...pageProps} />;
  if (route === "/ozon/messaging/history") return <MessageHistoryPage {...pageProps} />;
  if (route === "/ozon/templates") return <ProductTemplatesPage {...pageProps} />;
  if (route === "/ozon/settings/stores") return <StoresSettingsPage {...pageProps} />;
  if (route === "/ozon/settings/accounts") return <AccountSettingsPage {...pageProps} />;
  if (route === "/ozon/settings/pricing") return <PricingSettingsPage {...pageProps} />;
  if (route === "/datascreen") return <DataScreenPage {...pageProps} />;

  return (
    <div className="source-404-page">
      <h2>404</h2>
      <p>This page could not be found.</p>
    </div>
  );
}

const storeLine = (binding, fallback = "数据定时自动同步") =>
  binding?.storeName ? `当前店铺：${binding.storeName} · ${fallback}` : "当前门店：去绑定门店";

const moneyText = (value, currency = "") => {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value);
  return currency && !text.includes(currency) ? `${currency}${text}` : text;
};

const stockEntries = (item = {}) =>
  Array.isArray(item.stocks?.stocks) ? item.stocks.stocks : [];

const stockCountValue = (row = {}) =>
  Number(
    row.present ??
    row.stock ??
    row.available ??
    row.quantity ??
    row.balance ??
    row.available_stock ??
    row.free_to_sell ??
    row.free_to_sell_amount ??
    row.count ??
    0
  ) || 0;

const stockTotal = (item = {}) => {
  const nested = stockEntries(item);
  if (nested.length) {
    return nested.reduce((sum, row) => sum + stockCountValue(row), 0);
  }
  return item.stocks?.present ?? item.stocks?.available ?? item.stock ?? "—";
};

const stockDistribution = (item = {}) => {
  const nested = stockEntries(item);
  if (!nested.length) return "—";
  return nested
    .map((row) => `${String(row.source || "stock").toUpperCase()} ${Number(row.present) || 0}`)
    .join(" / ");
};

const WAREHOUSE_NAME_TRANSLATIONS = new Map([
  ["Казань_РФЦ_НОВЫЙ", "喀山新履约仓"],
  ["ВОРОНЕЖ_2_РФЦ", "沃罗涅日 2 号履约仓"],
  ["ГРИВНО_РФЦ", "格里夫诺履约仓"],
  ["НОВОРОССИЙСК_РФЦ", "新罗西斯克履约仓"],
  ["ПУШКИНО_2_РФЦ", "普希金诺 2 号履约仓"],
  ["МАХАЧКАЛА_РФЦ", "马哈奇卡拉履约仓"],
  ["CEL Hunchun 2", "CEL 珲春 2 仓"],
  ["Ural Khorgos 2", "Ural 霍尔果斯 2 仓"],
]);

const displayWarehouseName = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return WAREHOUSE_NAME_TRANSLATIONS.get(raw) || raw;
};

const warehouseDisplayName = (warehouse = {}) => {
  const item = warehouse || {};
  return displayWarehouseName(
    item.name ||
    item.warehouse_name ||
    item.warehouseName ||
    item.title ||
    item.id ||
    ""
  );
};

const warehouseIsActive = (warehouse = {}) => {
  const status = String(
    warehouse.status ??
    warehouse.state ??
    warehouse.warehouse_status ??
    warehouse.warehouseStatus ??
    ""
  ).toLowerCase();
  if (["disabled", "archived", "archive", "inactive", "deleted", "blocked"].includes(status)) return false;
  if (warehouse.archived === true || warehouse.disabled === true || warehouse.isArchived === true) return false;
  if (warehouse.isActive === false || warehouse.is_active === false || warehouse.active === false) return false;
  return true;
};

const warehouseIsWritableFbs = (warehouse = {}) => {
  const type = String(
    warehouse.warehouse_type ??
    warehouse.warehouseType ??
    warehouse.type ??
    ""
  ).toLowerCase();
  return type !== "fbp";
};

const warehouseIdValue = (value = {}) =>
  value.warehouse_id ??
  value.warehouseId ??
  value.warehouse?.warehouse_id ??
  value.warehouse?.warehouseId ??
  value.warehouse?.id ??
  null;

const stockArrayFromValue = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.stocks)) return value.stocks;
  if (Array.isArray(value.result?.items)) return value.result.items;
  if (Array.isArray(value.result?.stocks)) return value.result.stocks;
  if (Array.isArray(value.result)) return value.result;
  return [];
};

const warehouseStockRows = (item = {}) => {
  const directSources = [
    item.warehouse_stocks,
    item.warehouseStocks,
    item.stock_by_warehouse,
    item.stockByWarehouse,
    item.stocks_by_warehouse,
    item.stocksByWarehouse,
    item.fbs_warehouse_stocks,
    item.fbsWarehouseStocks,
    item.stocks?.warehouse_stocks,
    item.stocks?.warehouseStocks,
  ];
  return directSources.flatMap(stockArrayFromValue);
};

const stockSourceGroup = (source = "") => {
  const text = String(source || "").toLowerCase();
  if (text.includes("fbo")) return "fbo";
  if (text.includes("fbs") || text.includes("rfbs")) return "fbs";
  return text || "stock";
};

const stockWarehouseEntries = (item = {}, warehouses = []) => {
  const warehouseList = Array.isArray(warehouses) ? warehouses : [];
  const warehouseById = new Map(
    warehouseList.flatMap((warehouse) => {
      const ids = [warehouse.id, warehouse.warehouse_id, warehouse.warehouseId].filter(Boolean).map(String);
      return ids.map((id) => [id, warehouse]);
    })
  );

  const makeEntry = (row = {}, index = 0, fallbackSource = "fbs") => {
    const count = stockCountValue(row);
    const warehouseId = warehouseIdValue(row);
    const matchedWarehouse = warehouseId ? warehouseById.get(String(warehouseId)) : null;
    const directName =
      row.warehouse_name ||
      row.warehouseName ||
      row.name ||
      row.warehouse?.name ||
      row.delivery_method?.warehouse ||
      row.delivery_method?.name ||
      warehouseDisplayName(matchedWarehouse);
    const source = String(row.source || fallbackSource || "stock").toLowerCase();
    const label = displayWarehouseName(directName) || (source.includes("fbo") ? "Ozon FBO仓" : "FBS 总库存");
    return {
      key: `${warehouseId || source || "stock"}-${index}`,
      warehouseId: warehouseId ? String(warehouseId) : "",
      label,
      present: count,
      reserved: Number(row.reserved ?? row.reserved_stock ?? row.reserved_amount ?? 0) || 0,
      source,
      sourceGroup: stockSourceGroup(source),
      writable: Boolean(warehouseId) && !source.includes("fbo"),
    };
  };

  const detailedEntries = warehouseStockRows(item)
    .map((row, index) => makeEntry(row, index, "fbs"))
    .filter((entry) => entry.present > 0);
  const detailedSourceGroups = new Set(detailedEntries.map((entry) => entry.sourceGroup));
  const nestedEntries = stockEntries(item)
    .map((row, index) => makeEntry(row, index, row.source || "stock"))
    .filter((entry) => entry.present > 0)
    .filter((entry) => {
      if (!detailedEntries.length) return true;
      if (detailedSourceGroups.has(entry.sourceGroup)) return false;
      if (!entry.warehouseId) return true;
      return !detailedEntries.some((detail) => detail.warehouseId === entry.warehouseId);
    });
  return [...nestedEntries, ...detailedEntries];
};

const stockWarehouseDistribution = (item = {}, warehouses = []) => {
  const entries = stockWarehouseEntries(item, warehouses).filter((entry) => entry.present > 0);
  return entries
    .map((entry) => `${entry.label}（${entry.present}）`)
    .join("\n") || "—";
};

const stockWarehouseEditorEntries = (item = {}, warehouses = []) => {
  const entries = stockWarehouseEntries(item, warehouses);
  const existingWritableIds = new Set(
    entries
      .filter((entry) => entry.warehouseId)
      .map((entry) => String(entry.warehouseId))
  );
  const editableWarehouses = (Array.isArray(warehouses) ? warehouses : [])
    .filter(warehouseIsActive)
    .filter(warehouseIsWritableFbs)
    .map((warehouse) => {
      const id = warehouse.id || warehouse.warehouse_id || warehouse.warehouseId;
      if (!id || existingWritableIds.has(String(id))) return null;
      return {
        key: `warehouse-${id}`,
        warehouseId: String(id),
        label: warehouseDisplayName(warehouse) || String(id),
        present: 0,
        reserved: 0,
        source: "warehouse",
        sourceGroup: "fbs",
        writable: true,
      };
    })
    .filter(Boolean);
  return [...entries, ...editableWarehouses];
};

const productStatus = (item = {}) =>
  item.statuses?.status_name ||
  item.statuses?.status ||
  item.visibility ||
  item.status ||
  item.state ||
  "—";

const firstProductImageUrl = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = firstProductImageUrl(item);
      if (resolved) return resolved;
    }
    return "";
  }
  if (typeof value === "object") {
    return firstProductImageUrl(
      value.url ||
      value.src ||
      value.link ||
      value.file_name ||
      value.image ||
      value.image_url ||
      value.imageUrl ||
      value.original ||
      value.preview
    );
  }
  return "";
};

const productImageUrl = (item = {}) =>
  firstProductImageUrl([
    item.primary_image,
    item.primaryImage,
    item.main_image,
    item.mainImage,
    item.image,
    item.image_url,
    item.imageUrl,
    item.images,
    item.pictures,
    item.photos,
    item.media,
  ]);

const PRODUCT_STATUS_BUCKETS = [
  { label: "销售中", tone: "success" },
  { label: "准备销售", tone: "processing" },
  { label: "错误", tone: "danger" },
  { label: "待修改", tone: "edit" },
  { label: "商品已下架", tone: "offline" },
  { label: "档案", tone: "archive" },
];

const productStatusMeta = (item = {}) => {
  const raw = String(productStatus(item) || "").trim();
  const rawSource = raw.toLowerCase();
  const rawHas = (tokens) => tokens.some((token) => rawSource.includes(token));
  const truthyFlag = (value) => value === true || String(value || "").toLowerCase() === "true";
  const visibilitySource = [
    item.visibility,
    item.visibilityFilter,
    item._visibility,
    item.product_visibility,
    item.productVisibility,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const isArchived =
    truthyFlag(item.is_archived) ||
    truthyFlag(item.archived) ||
    ["archived", "archive", "архив"].some((token) => visibilitySource.includes(token));
  const statusSource = [
    raw,
    item.statuses?.status,
    item.statuses?.status_name,
    item.statuses?.status_failed,
    item.statuses?.moderate_status,
    item.statuses?.validation_status,
    item.statuses?.status_description,
    item.statuses?.status_tooltip,
    item.visibility,
    item.visibilityFilter,
    item.status,
    item.state,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const has = (tokens) => tokens.some((token) => statusSource.includes(token));

  if (isArchived) return { label: "档案", tone: "archive", raw: raw || "档案" };
  if (!raw || raw === "—") return { label: "—", tone: "muted", raw };
  if (rawHas(["ошибка", "error", "failed", "rejected", "declined"])) return { label: "错误", tone: "danger", raw };
  if (rawHas(["не продается", "not for sale", "hidden", "inactive"])) return { label: "商品已下架", tone: "offline", raw };
  if (rawHas(["архив", "archived", "archive"])) return { label: "档案", tone: "archive", raw };
  if (rawHas(["продается", "for_sale", "for sale", "selling", "visible", "active", "on sale"])) {
    return { label: "销售中", tone: "success", raw };
  }
  if (rawHas(["готов", "ready", "pending", "moderation", "created"])) return { label: "准备销售", tone: "processing", raw };
  if (has(["ошибка", "error", "validation_error", "moderation_failed"])) {
    return { label: "错误", tone: "danger", raw };
  }
  if (has(["failed", "rejected", "declined", "invalid", "need", "edit", "исправ", "отклон"])) {
    return { label: "待修改", tone: "edit", raw };
  }
  if (has(["не продается", "not for sale", "hidden", "inactive", "stopped", "disabled", "blocked", "quarantine"])) {
    return { label: "商品已下架", tone: "offline", raw };
  }
  if (has(["архив", "archived", "archive"])) {
    return { label: "档案", tone: "archive", raw };
  }
  if (has(["готов", "ready", "price_sent", "pending", "moderation", "created"])) {
    return { label: "准备销售", tone: "processing", raw };
  }
  if (has(["продается", "for_sale", "for sale", "selling", "visible", "active", "on sale"])) {
    return { label: "销售中", tone: "success", raw };
  }
  return { label: raw, tone: "default", raw };
};

const productStoreRef = (binding = {}, localData = {}) => {
  const currentStoreId =
    localData?.currentStoreId ||
    binding?.id ||
    (typeof localStorage !== "undefined" ? localStorage.getItem("currentOzonStoreId") : "") ||
    "";
  const stores = localData?.stores || [];
  const currentStore = stores.find((store) =>
    String(store.id || store.storeId || "") === String(currentStoreId || "")
  );
  const bindingMatchesCurrentStore = !binding?.id || String(binding.id) === String(currentStoreId || "");
  const storeNames = new Set(
    [
      bindingMatchesCurrentStore ? binding?.storeName : "",
      currentStore?.label,
      currentStore?.companyName,
      currentStore?.storeName,
      currentStore?.name,
    ]
      .filter(Boolean)
      .map((name) => String(name).trim().toLowerCase())
  );
  return {
    storeId: currentStoreId,
    clientId: currentStore?.clientId || binding?.clientId || "",
    storeNames,
  };
};

const productBelongsToCurrentStore = (item = {}, ref = {}) => {
  const storeId = item.storeId || item.store_id || item.ozonStoreId || item.currentOzonStoreId || item.localStoreId;
  if (storeId) return Boolean(ref.storeId && String(storeId) === String(ref.storeId));
  const clientId = item.clientId || item.client_id || item.ozonClientId;
  if (clientId) return Boolean(ref.clientId && String(clientId) === String(ref.clientId));
  const storeName = item.storeName || item.store_name || item.shopName || item.companyName;
  return Boolean(storeName && ref.storeNames?.has(String(storeName).trim().toLowerCase()));
};

const scopedProductsForCurrentStore = (products = [], binding = {}, localData = {}) => {
  const list = Array.isArray(products) ? products : [];
  const ref = productStoreRef(binding, localData);
  if (!ref.storeId && !ref.clientId && !ref.storeNames.size) return [];
  return list.filter((item) => productBelongsToCurrentStore(item, ref));
};

const warehouseBelongsToCurrentStore = (item = {}, ref = {}) => {
  const storeId = item.storeId || item.store_id || item.ozonStoreId || item.currentOzonStoreId || item.localStoreId;
  if (storeId) return Boolean(ref.storeId && String(storeId) === String(ref.storeId));
  const clientId = item.clientId || item.client_id || item.ozonClientId;
  if (clientId) return Boolean(ref.clientId && String(clientId) === String(ref.clientId));
  const storeName = item.storeName || item.store_name || item.shopName || item.companyName;
  return Boolean(storeName && ref.storeNames?.has(String(storeName).trim().toLowerCase()));
};

const scopedWarehousesForCurrentStore = (warehouses = [], binding = {}, localData = {}) => {
  const list = Array.isArray(warehouses) ? warehouses : [];
  const ref = productStoreRef(binding, localData);
  if (!ref.storeId && !ref.clientId && !ref.storeNames.size) return [];
  return list.filter((item) => warehouseBelongsToCurrentStore(item, ref));
};

const productStatusFilterOptions = (products = []) => {
  const statusMap = new Map(PRODUCT_STATUS_BUCKETS.map((item) => [item.label, { ...item, count: 0 }]));
  for (const product of products) {
    const meta = productStatusMeta(product);
    const current = statusMap.get(meta.label);
    if (!current) continue;
    current.count += 1;
  }
  return PRODUCT_STATUS_BUCKETS.map((item) => statusMap.get(item.label) || { ...item, count: 0 });
};

const STOCK_PAGE_PRODUCT_STATUSES = new Set(["销售中", "准备销售"]);

const productVisibleInStockTable = (item = {}) =>
  STOCK_PAGE_PRODUCT_STATUSES.has(productStatusMeta(item).label);

const productPriceNumber = (value) => {
  if (value === null || value === undefined || value === "" || value === "—") return null;
  const raw = typeof value === "object" ? value.price || value.marketing_seller_price || value.marketing_price || value.value : value;
  const normalized = String(raw).replace(/[^\d,.-]/g, "").replace(",", ".");
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
};

const productPositivePrice = (value) => {
  const number = productPriceNumber(value);
  return number && number > 0 ? number : null;
};

const formatProductPrice = (value) => {
  const number = productPriceNumber(value);
  return number === null ? "—" : number.toFixed(2);
};

const hasCyrillicText = (value) => /[\u0400-\u04FF]/.test(String(value || ""));

const normalizeOzonText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。]+$/, "")
    .toLowerCase();

const OZON_MARKETING_TITLE_MAP = new Map([
  ["максимальный бустинг: усиление", "最大提升：大幅折扣"],
  ["максимальный бустинг", "最大提升"],
  ["учебные скидки", "学校用品折扣"],
  ["эластичный бустинг. без ограничения срока действия", "弹性提升（不限期）"],
]);

const OZON_PRODUCT_TITLE_MAP = new Map([
  ["левитирующая настольная лампа /с круглой подставкой", "悬浮台灯 / 圆形底座"],
]);

const OZON_PRODUCT_TITLE_REPLACEMENTS = [
  ["Левитирующая настольная лампа", "悬浮台灯"],
  ["С круглой подставкой", "圆形底座"],
  ["Уличный настенный светильник", "户外壁灯"],
  ["Настенно_потолочный светильник", "壁顶两用灯"],
  ["Уличный светильник", "户外灯"],
  ["Материал из алюминиевого сплава", "铝合金材质"],
  ["количество ламп:1шт", "灯头数量：1个"],
  ["Люстра", "吊灯"],
  ["Бра", "壁灯"],
  ["Светильник", "灯具"],
  ["настольная лампа", "台灯"],
  ["круглой подставкой", "圆形底座"],
];

const localizeOzonMarketingTitle = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "活动价";
  const normalized = normalizeOzonText(raw);
  const mapped = OZON_MARKETING_TITLE_MAP.get(normalized);
  if (mapped) return mapped;
  if (/рассрочка/i.test(raw)) return raw.replace(/РК\.?\s*/i, "").replace(/Рассрочка/i, "分期付款");
  return hasCyrillicText(raw) ? "平台活动价" : raw;
};

const localizeOzonProductTitle = (value, fallbackSku = "") => {
  const raw = String(value || "").trim();
  if (!raw) return fallbackSku ? `商品 SKU ${fallbackSku}` : "商品";
  const exact = OZON_PRODUCT_TITLE_MAP.get(normalizeOzonText(raw));
  if (exact) return exact;
  let localized = raw;
  for (const [source, target] of OZON_PRODUCT_TITLE_REPLACEMENTS) {
    localized = localized.split(source).join(target);
  }
  localized = localized
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s*,\s*/g, "，")
    .replace(/\s+/g, " ")
    .trim();
  if (hasCyrillicText(localized)) return fallbackSku ? `商品 SKU ${fallbackSku}` : "商品";
  return localized || (fallbackSku ? `商品 SKU ${fallbackSku}` : "商品");
};

const productScalarPrice = (item = {}) => (
  item.price && typeof item.price !== "object" ? item.price : null
);

const firstProductPositivePrice = (...values) => {
  for (const value of values) {
    const number = productPositivePrice(value);
    if (number) return number;
  }
  return null;
};

const productMarketingActionIsPrice = (action = {}) => {
  const title = String(action.title || "").toLowerCase();
  return !["рассроч", "bnpl", "кредит", "installment", "credit"].some((token) => title.includes(token));
};

const productEffectivePriceValue = (item = {}) => {
  const price = item.price && typeof item.price === "object" ? item.price : {};
  const priceInfo = item.price_info?.price && typeof item.price_info.price === "object"
    ? item.price_info.price
    : {};
  const base = firstProductPositivePrice(
    price.price,
    priceInfo.price,
    productScalarPrice(item),
  );
  const directMarketing = firstProductPositivePrice(
    price.marketing_seller_price,
    priceInfo.marketing_seller_price,
    item.price_info?.marketing_seller_price,
    item.marketing_seller_price,
    price.marketing_price,
    priceInfo.marketing_price,
    item.marketing_price,
  );
  if (directMarketing) return formatProductPrice(directMarketing);

  const actionValues = (item.marketing_actions?.actions || item.price_info?.marketing_actions?.actions || [])
    .filter(productMarketingActionIsPrice)
    .map((action) => productPositivePrice(action?.value))
    .filter(Boolean)
    .filter((value) => !base || (value <= base && value >= base * 0.1));
  if (actionValues.length) return formatProductPrice(Math.min(...actionValues));

  return formatProductPrice(
    base ||
    productPositivePrice(price.price) ||
    productPositivePrice(priceInfo.price) ||
    productPositivePrice(productScalarPrice(item)) ||
    productPositivePrice(priceInfo.old_price) ||
    productPositivePrice(item.old_price)
  );
};

const productPriceActionRows = (item = {}) => {
  const price = item.price && typeof item.price === "object" ? item.price : {};
  const priceInfo = item.price_info?.price && typeof item.price_info.price === "object"
    ? item.price_info.price
    : {};
  const base = firstProductPositivePrice(price.price, priceInfo.price, productScalarPrice(item));
  const rows = [];
  const pushRow = (row) => {
    const number = productPositivePrice(row.value);
    if (!number) return;
    if (row.source === "action" && base && (number > base || number < base * 0.1)) return;
    const key = `${row.title}-${number}-${row.date_from || ""}-${row.date_to || ""}`;
    if (rows.some((itemRow) => itemRow.key === key)) return;
    rows.push({
      key,
      title: row.title || "活动价",
      value: number,
      date_from: row.date_from || "",
      date_to: row.date_to || "",
      source: row.source || "",
    });
  };

  pushRow({
    title: "前台真实销售价",
    value: firstProductPositivePrice(
      price.marketing_seller_price,
      priceInfo.marketing_seller_price,
      item.price_info?.marketing_seller_price,
      item.marketing_seller_price,
      price.marketing_price,
      priceInfo.marketing_price,
      item.marketing_price,
    ),
  });
  for (const action of item.marketing_actions?.actions || item.price_info?.marketing_actions?.actions || []) {
    if (!productMarketingActionIsPrice(action)) continue;
    pushRow({
      title: localizeOzonMarketingTitle(action.title || "活动价"),
      value: action.value,
      date_from: action.date_from,
      date_to: action.date_to,
      source: "action",
    });
  }
  pushRow({ title: "商品原售价", value: base, source: "base" });
  pushRow({
    title: "划线价",
    value: firstProductPositivePrice(price.old_price, priceInfo.old_price, item.old_price),
    source: "old",
  });

  return rows.sort((left, right) => {
    if (left.source === "base" || left.source === "old") return 1;
    if (right.source === "base" || right.source === "old") return -1;
    return left.value - right.value;
  });
};

const productRows = (products = [], warehouses = []) =>
  products.map((item, index) => {
    const statusMeta = productStatusMeta(item);
    const image = productImageUrl(item);
    const sku = item.sku || item.ozon_sku || item.product_sku || item.product_id || item.id || item.offer_id || "";
    const offerId = item.offer_id || item.offerId || item.item_code || item.itemCode || "";
    return {
      id: item.id || item.product_id || item.offer_id || `product-${index}`,
      "#": index + 1,
      _image: image,
      _sku: sku,
      _offerId: offerId,
      _title: item.name || item.offer_id || item.product_id || "—",
      _statusMeta: statusMeta,
      _raw: item,
      _priceActions: productPriceActionRows(item),
      "图片": image,
      "商品信息": item.name || item.offer_id || item.product_id || "—",
      "状态": statusMeta.label,
      "价格": productEffectivePriceValue(item),
      "库存": stockTotal(item),
      "货源 (¥)": "—",
      "最后同步": item.syncedAt ? new Date(item.syncedAt).toLocaleString() : "—",
      "操作": "查看",
      "主图": image ? "已同步" : "—",
      "商品": item.name || item.offer_id || item.product_id || "—",
      "总库存": stockTotal(item),
      "仓库分布": stockWarehouseDistribution(item, warehouses),
      "类目佣金": item.commission || "—",
      "店铺": item.storeName || "当前店铺",
      "下架原因": "—",
    };
  });

const productPriceValue = (item = {}) =>
  productEffectivePriceValue(item);

const numberFromMoney = (value) => {
  if (value === null || value === undefined || value === "" || value === "—") return null;
  const raw = typeof value === "object" ? value.price || value.marketing_price || value.value : value;
  const normalized = String(raw).replace(/[^\d,.-]/g, "").replace(",", ".");
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
};

const sourceVariantAttributes = (sourceVariant = {}) =>
  Array.isArray(sourceVariant.attributes) ? sourceVariant.attributes : [];

const sourceVariantAttribute = (sourceVariant = {}, key) =>
  sourceVariantAttributes(sourceVariant).find((attr) => String(attr?.key ?? attr?.id ?? attr?.attribute_id) === String(key));

const sourceVariantText = (sourceVariant = {}, key) => {
  const attr = sourceVariantAttribute(sourceVariant, key);
  if (!attr) return "";
  if (attr.value !== undefined && attr.value !== null && String(attr.value).trim()) return String(attr.value).trim();
  const first = Array.isArray(attr.collection)
    ? attr.collection.find((value) => value !== undefined && value !== null && String(typeof value === "object" ? value.value || value.name || value.title || "" : value).trim())
    : null;
  return first == null ? "" : String(typeof first === "object" ? first.value || first.name || first.title || "" : first).trim();
};

const sourceVariantNumber = (sourceVariant = {}, key) => numberFromMoney(sourceVariantText(sourceVariant, key)) || 0;

const sourceVariantImages = (sourceVariant = {}) => {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const url = typeof value === "object" ? value.file_name || value.url || value.src || value.value : value;
    const text = String(url || "").trim();
    if (!text) return;
    const normalized = text.split("?")[0].split("#")[0].toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(text);
  };
  const primary = sourceVariantAttribute(sourceVariant, 4194);
  const gallery = sourceVariantAttribute(sourceVariant, 4195);
  push(primary?.value);
  if (Array.isArray(gallery?.collection)) gallery.collection.forEach(push);
  if (Array.isArray(sourceVariant.images)) sourceVariant.images.forEach(push);
  return out;
};

const buildSourceVariantImportItem = ({ sku, price, currencyCode, sourceVariant, title }) => {
  const images = sourceVariantImages(sourceVariant);
  if (!images.length) throw new Error("插件采集结果缺少图片，无法上架");
  const numericPrice = Number(price);
  const batchSalt = Date.now().toString(36).slice(-6);
  const offerId = `jz-${batchSalt}-${sku}`;
  return {
    offer_id: offerId,
    name: sourceVariantText(sourceVariant, 4180) || title || `Ozon SKU ${sku}`,
    price: numericPrice.toFixed(2),
    old_price: (numericPrice * 1.25).toFixed(2),
    vat: "0",
    currency_code: currencyCode || "RUB",
    images: images.map((url, index) => ({ file_name: url, default: index === 0 })),
    bundleComplexAttrs: sourceVariant._bundleComplexAttrs || undefined,
    scraped_description: sourceVariantText(sourceVariant, 4191) || sourceVariantText(sourceVariant, 4180) || title || `Ozon SKU ${sku}`,
    scraped_sku: String(sku),
    scraped_model_name: offerId,
    _sourceVariant: sourceVariant,
    weight: Math.round(sourceVariantNumber(sourceVariant, 4497)) || 100,
    weight_unit: "g",
    depth: Math.round(sourceVariantNumber(sourceVariant, 9454)) || 100,
    width: Math.round(sourceVariantNumber(sourceVariant, 9455)) || 100,
    height: Math.round(sourceVariantNumber(sourceVariant, 9456)) || 100,
    dimension_unit: "mm",
    barcode: sourceVariantText(sourceVariant, 7822),
    complex_attributes: [],
  };
};

const requestSourcePluginListing = async ({
  storeId,
  sku,
  price,
  currencyCode,
  title,
  dryRun = false,
  stocks = [],
}) => {
  const prefetch = await requestExtensionPrefetch({ skus: [String(sku)] });
  const sourceVariant = prefetch?.bySku?.[String(sku)] || prefetch?.bySku?.[sku];
  if (!sourceVariant) {
    const failed = Array.isArray(prefetch?.failed) ? prefetch.failed.find((row) => String(row?.sku) === String(sku)) : null;
    throw new Error(failed?.error || "源插件未采集到可上架的商品数据");
  }
  const item = buildSourceVariantImportItem({ sku, price, currencyCode, sourceVariant, title });
  if (stocks.length) item.stocks = stocks;
  const endpoint = dryRun ? "/ozon/products/import/preview" : "/ozon/products/import";
  const result = await apiRequest(endpoint, {
    method: "POST",
    body: {
      storeId,
      sku,
      strictTypeMatch: true,
      entry: "SOURCE_PLUGIN_PREFETCH",
      items: [item],
      stocks,
    },
  });
  return {
    ok: true,
    data: result,
    taskId: result?.result?.task_id || result?.task_id || result?.job?.taskId || null,
  };
};

const productCategoryId = (item = {}) =>
  item.type_id ||
  item.typeId ||
  item.description_category_id ||
  item.descriptionCategoryId ||
  item.category_id ||
  item.categoryId ||
  "unknown";

const productCategoryLabel = (item = {}, id = "unknown") =>
  item.category_name ||
  item.categoryName ||
  item.type_name ||
  item.typeName ||
  (id === "unknown" ? "未归类" : `类目 ID ${id}`);

const discountText = (item = {}) => {
  const current = numberFromMoney(productPriceValue(item));
  const old = numberFromMoney(item.price?.old_price || item.old_price || item.price?.marketing_price || item.marketing_price);
  if (current === null || old === null || old <= 0 || current >= old) return "—";
  return `${Math.max(0, Math.round((1 - current / old) * 100))}%`;
};

const priceDiscountRows = (products = [], activeTab = "价格") =>
  products.map((item, index) => ({
    id: item.id || item.product_id || item.offer_id || `price-product-${index}`,
    "主图": item.primary_image ? "已同步" : "—",
    "商品": item.name || item.offer_id || item.product_id || "—",
    "当前价格": moneyText(productPriceValue(item)),
    "划线价": moneyText(item.price?.old_price || item.old_price || item.price?.marketing_price || item.marketing_price),
    "折扣": discountText(item),
    "库存": stockTotal(item),
    "状态": productStatus(item),
    "目标价格": "—",
    "草稿状态": "待编辑",
    "操作": activeTab === "改价草稿" ? "查看" : "买家看 改价",
    _raw: item,
  }));

const importTaskStatusGroups = {
  "已完成": new Set(["SUCCESS", "SUCCEEDED", "COMPLETE", "COMPLETED", "DONE"]),
  "部分成功": new Set(["PARTIAL_SUCCESS", "PARTIAL"]),
  "已跳过": new Set(["SKIPPED"]),
  "处理中": new Set(["QUEUE_PENDING", "PENDING", "RUNNING", "QUEUED", "VALIDATING", "SUBMITTING", "OZON_ACCEPTED", "IMPORTING", "CHECKING", "PROCESSING", "CREATED", "RETRY_PENDING", "RECONCILING", "CANCEL_REQUESTED"]),
  "失败": new Set(["FAILED", "ERROR", "CHECK_FAILED"]),
};

const importTaskStatusLabel = (status) => {
  const normalized = String(status || "").toUpperCase();
  if (importTaskStatusGroups["已完成"].has(normalized)) return "已完成";
  if (importTaskStatusGroups["部分成功"].has(normalized)) return "部分成功";
  if (importTaskStatusGroups["已跳过"].has(normalized)) return "已跳过";
  if (importTaskStatusGroups["处理中"].has(normalized)) return "处理中";
  if (importTaskStatusGroups["失败"].has(normalized)) return "失败";
  return normalized || "—";
};

const importItemStatusLabel = (status) => {
  const normalized = String(status || "").toLowerCase();
  if (["imported", "success", "succeeded", "processed", "done", "complete", "completed", "finished"].includes(normalized)) return "已上架";
  if (normalized === "skipped") return "已跳过";
  if (["failed", "error", "rejected", "cancelled", "canceled", "validation_error"].includes(normalized)) return "失败";
  if (["pending", "processing", "created", "queued", "running", "importing", "checking", "in_progress"].includes(normalized)) return "处理中";
  return status || "—";
};

const importItemErrorText = (item = {}) => {
  if (Array.isArray(item.errors) && item.errors.length) {
    return item.errors.map((error) => error?.message || error?.description || error?.code || JSON.stringify(error)).join("；");
  }
  return item.error?.message || item.error || item.message || item.status_description || "—";
};

const importTaskCount = (task = {}) =>
  Number(task.itemCount ?? task.total ?? task.size ?? task.count ?? task.itemsCount ?? 0) || 0;

const importTaskSkuText = (task = {}) =>
  task.sku ||
  task.offer_id ||
  task.offerId ||
  task.taskId ||
  task.localTaskId ||
  task.clientJobId ||
  task.id ||
  "—";

const listingImportJobTypes = new Set(["IMPORT_BY_SKU", "PRODUCT_IMPORT", "PUBLIC_IMPORT", "FOLLOW_FROM_PUBLIC", "COLLECT_BOX_DRAFT"]);

const isListingImportJob = (job = {}) => listingImportJobTypes.has(String(job.type || "").toUpperCase());

const importTaskTypeLabel = (task = {}) => {
  const type = String(task.type || "").toUpperCase();
  return {
    IMPORT_BY_SKU: "SKU 上架",
    PRODUCT_IMPORT: "采集箱上架",
    COLLECT_BOX_DRAFT: "采集箱上架",
    PUBLIC_IMPORT: "公开商品上架",
    FOLLOW_FROM_PUBLIC: "公开商品跟卖",
  }[type] || "上架";
};

const importTaskRows = (tasks = []) =>
  tasks.map((task, index) => ({
    id: task.id || task.clientJobId || `import-task-${index}`,
    _task: task,
    "#": index + 1,
    "商品信息": importTaskCount(task) ? `${importTaskCount(task)} 个商品 · ${importTaskTypeLabel(task)}` : importTaskTypeLabel(task),
    "源 SKU": importTaskSkuText(task),
    "店铺": "当前店铺",
    "变体": Number(task.variantCount ?? task.variants ?? 0) || "—",
    "售价": moneyText(task.price || task.sell_price || task.amount),
    "状态": importTaskStatusLabel(task.status),
    "创建时间": task.createdAt ? new Date(task.createdAt).toLocaleString() : "—",
    "操作": "查看",
  }));

const importTaskSearchText = (task = {}) =>
  [
    task.id,
    task.clientJobId,
    task.taskId,
    task.localTaskId,
    task.sku,
    task.offer_id,
    task.offerId,
    task.status,
    task.error,
    task.errorMessage,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const importTaskMatchesStatus = (task, status) => {
  if (status === "全部") return true;
  const normalized = String(task.status || "").toUpperCase();
  return importTaskStatusGroups[status]?.has(normalized) || importTaskStatusLabel(normalized) === status;
};

const importTaskMatchesQuery = (task, query) => {
  const normalized = String(query || "").trim().toLowerCase();
  return !normalized || importTaskSearchText(task).includes(normalized);
};

const importTaskMatchesDateRange = (task, range) => {
  if (!Array.isArray(range) || !range[0] || !range[1]) return true;
  const time = new Date(task.createdAt || task.updatedAt || "").getTime();
  if (Number.isNaN(time)) return false;
  const start = pickerBoundaryMs(range[0], "start");
  const end = pickerBoundaryMs(range[1], "end");
  return (start == null || time >= start) && (end == null || time <= end);
};

const promotionDateText = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
};

const promotionSearchText = (promotion = {}) =>
  [
    promotion.id,
    promotion.action_id,
    promotion.title,
    promotion.description,
    promotion.action_type,
    promotion.discount_type,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const promotionMatchesQuery = (promotion, query) => {
  const normalized = String(query || "").trim().toLowerCase();
  return !normalized || promotionSearchText(promotion).includes(normalized);
};

const promotionStatusLabel = (promotion = {}) => {
  if (promotion.is_participating) return "参与中";
  if ((Number(promotion.potential_products_count) || 0) > 0) return "可参与";
  return "全部";
};

const promotionIsEndingSoon = (promotion = {}) => {
  const end = new Date(promotion.date_end || "");
  if (Number.isNaN(end.getTime())) return false;
  const diffDays = (end.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  return diffDays >= 0 && diffDays <= 7;
};

const promotionRows = (promotions = []) =>
  promotions.map((promotion, index) => ({
    id: promotion.id || promotion.action_id || `promotion-${index}`,
    "活动": promotion.title || promotion.id || "—",
    "状态": promotionStatusLabel(promotion),
    "折扣": promotion.discount_type || promotion.action_type || "—",
    "商品": `${Number(promotion.participating_products_count) || 0} / ${Number(promotion.potential_products_count) || 0}`,
    "活动周期": `${promotionDateText(promotion.date_start)} - ${promotionDateText(promotion.date_end)}`,
    "操作": "查看",
  }));

const promotionTypeText = (promotion = {}) =>
  promotion.action_type || promotion.discount_type || promotion.type || "—";

const promotionDiscountText = (promotion = {}) => {
  const value = promotion.discount_value ?? promotion.discount ?? promotion.max_discount;
  if (value === null || value === undefined || value === "") {
    return promotion.discount_type || promotion.action_type || "—";
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return `${numeric}%`;
  return String(value);
};

const autoDeletePromotionRows = (promotions = []) =>
  promotions.map((promotion, index) => ({
    id: promotion.id || promotion.action_id || `auto-delete-promotion-${index}`,
    "活动名称": promotion.title || promotion.id || "—",
    "类型": promotionTypeText(promotion),
    "折扣力度": promotionDiscountText(promotion),
    "商品数量": `${Number(promotion.participating_products_count) || 0} / ${Number(promotion.potential_products_count) || 0}`,
    "有效期": `${promotionDateText(promotion.date_start)} - ${promotionDateText(promotion.date_end)}`,
    "状态": promotionStatusLabel(promotion),
    "操作": "移除",
  }));

const productSearchText = (item = {}) =>
  [
    item.name,
    item.offer_id,
    item.product_id,
    item.id,
    item.barcode,
    item.sku,
    ...(Array.isArray(item.barcodes) ? item.barcodes : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const productMatchesQuery = (item, query) => {
  const normalized = String(query || "").trim().toLowerCase();
  return !normalized || productSearchText(item).includes(normalized);
};

const stockNumber = (item = {}) => {
  const nested = stockEntries(item);
  if (nested.length) {
    return nested.reduce((sum, row) => sum + (Number(row.present) || 0), 0);
  }
  return Number(item.stocks?.present ?? item.stocks?.available ?? item.stock ?? 0) || 0;
};

const productMatchesStockFilter = (item, filter) => {
  const stock = stockNumber(item);
  if (filter === "缺货") return stock <= 0;
  if (filter === "低库存") return stock > 0 && stock <= 10;
  return true;
};

const postingRows = (postings = []) =>
  postings.map((item, index) => ({
    id: item.id || item.posting_number || `posting-${index}`,
    "货件 / 状态": item.posting_number || item.order_id || "—",
    "商品": Array.isArray(item.products) ? `${item.products.length} 件商品` : "—",
    "店铺": "当前店铺",
    "订单金额": dashboardMoneyGroups(postingMoneyGroups(item)),
    "利润": "—",
    "仓库 / 配送": item.delivery_method?.warehouse || item.delivery_method?.name || "—",
    "倒计时": item.shipment_date ? new Date(item.shipment_date).toLocaleString() : "—",
    "操作": "查看",
  }));

const postingSearchText = (posting = {}) =>
  [
    posting.posting_number,
    posting.order_id,
    posting.status,
    posting.tracking_number,
    posting.tracking?.tracking_number,
    posting.delivery_method?.warehouse,
    posting.delivery_method?.name,
    ...(Array.isArray(posting.products)
      ? posting.products.flatMap((product) => [
          product.name,
          product.offer_id,
          product.sku,
          product.product_id,
          product.barcode,
        ])
      : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const postingBusinessTime = (posting = {}) =>
  posting.in_process_at ||
  posting.shipment_date ||
  posting.delivering_date ||
  posting.created_at ||
  posting.updated_at ||
  posting.syncedAt;

const postingMatchesQuery = (posting, query) => {
  const normalized = String(query || "").trim().toLowerCase();
  return !normalized || postingSearchText(posting).includes(normalized);
};

const pickerBoundaryMs = (value, edge) => {
  if (!value) return null;
  if (typeof value.startOf === "function" && typeof value.endOf === "function") {
    return (edge === "end" ? value.endOf("day") : value.startOf("day")).valueOf();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(edge === "end" ? 23 : 0, edge === "end" ? 59 : 0, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
  return date.getTime();
};

const postingMatchesDateRange = (posting, range) => {
  if (!Array.isArray(range) || !range[0] || !range[1]) return true;
  const time = new Date(postingBusinessTime(posting) || "").getTime();
  if (Number.isNaN(time)) return false;
  const start = pickerBoundaryMs(range[0], "start");
  const end = pickerBoundaryMs(range[1], "end");
  return (start == null || time >= start) && (end == null || time <= end);
};

const csvValue = (value) => {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const downloadCsv = (filename, columns, rows) => {
  const lines = [
    columns.map(csvValue).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ];
  const blob = new Blob(["\ufeff", lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const postingProductSummary = (posting = {}) => {
  const products = Array.isArray(posting.products) ? posting.products : [];
  if (!products.length) return "—";
  return products
    .slice(0, 2)
    .map((product) => {
      const name = product.name || product.offer_id || product.sku || product.product_id || "未命名商品";
      const quantity = Number(product.quantity) || 1;
      return `${product.offer_id || product.sku || ""} x${quantity} ${name}`.trim();
    })
    .join(" / ");
};

const postingDateTimeText = (value) => {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const postingMoney = (posting = {}) =>
  moneyText(
    posting.financial_data?.products?.[0]?.price ||
      posting.products?.[0]?.price ||
      posting.order_price ||
      posting.total_price,
  );

const postingDeliveryName = (posting = {}) =>
  posting.delivery_method?.name ||
  posting.delivery_method?.service_name ||
  posting.delivery_method?.delivery_method_name ||
  posting.delivery_method?.warehouse ||
  "—";

const messageTaskPostings = (postings = [], type) =>
  postings.filter((posting) => {
    const status = postingStatus(posting);
    if (type === "review") return status === "delivered";
    return status === "delivering";
  });

const messageTaskRows = (postings = [], type) =>
  postings.map((posting, index) => {
    const base = {
      id: posting.id || posting.posting_number || `${type}-message-${index}`,
      "操作": "发送",
      "店铺": "当前店铺",
      "货件编号": posting.posting_number || posting.order_id || "—",
      "图片": Array.isArray(posting.products) && posting.products.length ? "已同步" : "—",
      "货号，数量 名称": postingProductSummary(posting),
      "查看商品": "查看",
    };
    if (type === "review") {
      return {
        ...base,
        "发运": postingDateTimeText(posting.shipment_date || posting.in_process_at),
        "价格": postingMoney(posting),
        "仓库": posting.delivery_method?.warehouse || "—",
        "配送服务 方式": postingDeliveryName(posting),
        "送达": postingDateTimeText(posting.delivering_date || posting.updated_at || posting.syncedAt),
      };
    }
    return {
      ...base,
      "取货状态": "已到取件点",
      "物流单号": posting.tracking_number || posting.tracking?.tracking_number || "—",
      "配送": postingDeliveryName(posting),
      "最近物流时间": postingDateTimeText(posting.delivering_date || posting.updated_at || posting.syncedAt),
    };
  });

const rowMatchesAllTerms = (row, terms = []) =>
  terms.every((term) => {
    const normalized = String(term || "").trim().toLowerCase();
    if (!normalized) return true;
    return Object.values(row).some((value) => String(value || "").toLowerCase().includes(normalized));
  });

const postingStatusTabs = [
  "所有订单",
  "等待备货",
  "等待发运",
  "已超时",
  "运输中",
  "有争议的",
  "已签收",
  "已取消",
];

const postingStatusMap = {
  "等待备货": ["awaiting_packaging"],
  "等待发运": ["awaiting_deliver"],
  "运输中": ["delivering"],
  "有争议的": ["arbitration", "dispute"],
  "已签收": ["delivered"],
  "已取消": ["cancelled"],
};

const postingStatus = (posting = {}) => String(posting.status || "").toLowerCase();

const isLatePosting = (posting = {}) => {
  const status = postingStatus(posting);
  if (!["awaiting_packaging", "awaiting_deliver"].includes(status)) return false;
  const deadline = new Date(posting.shipment_date || posting.delivering_date || "");
  return !Number.isNaN(deadline.getTime()) && deadline.getTime() < Date.now();
};

const postingMatchesTab = (posting, tab) => {
  if (tab === "所有订单") return true;
  if (tab === "已超时") return isLatePosting(posting);
  return (postingStatusMap[tab] || []).includes(postingStatus(posting));
};

const postingStatusCount = (postings, statusCounts, tab) => {
  if (tab === "所有订单") return postings.length;
  if (tab === "已超时") return postings.filter(isLatePosting).length;
  return (postingStatusMap[tab] || []).reduce((sum, status) => sum + (statusCounts[status] || 0), 0);
};

const returnTypeMatches = (item = {}, activeType = "退货申请 (rFBS)") => {
  const text = String(item.type || item.kind || "").toLowerCase();
  if (activeType.includes("rFBS")) return !text || text.includes("rfbs") || text.includes("return");
  if (activeType === "FBS") return text.includes("fbs") && !text.includes("rfbs");
  if (activeType === "FBO") return text.includes("fbo");
  return true;
};

const returnSearchText = (item = {}) =>
  [
    item.id,
    item.returnId,
    item.return_id,
    item.refundId,
    item.refund_id,
    item.postingNumber,
    item.posting_number,
    item.sku,
    item.offer_id,
    item.productName,
    item.product_name,
    item.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const returnMatchesQuery = (item, query) => {
  const normalized = String(query || "").trim().toLowerCase();
  return !normalized || returnSearchText(item).includes(normalized);
};

const returnStatusText = (item = {}) => String(item.status || item.state || "").toLowerCase();

const returnIsPendingApproval = (item) => /approv|pending|requested|created|new|待审|待处理/.test(returnStatusText(item));

const returnIsWaitingReturn = (item) => /waiting.*return|awaiting.*return|returning|待退|等待退货/.test(returnStatusText(item));

const returnIsWaitingRefund = (item) => /refund|money|compensat|待退款|等待退款/.test(returnStatusText(item));

const returnDateText = (item = {}) =>
  postingDateTimeText(item.requestedAt || item.createdAt || item.created_at || item.return_date || item.updatedAt);

const returnRows = (items = []) =>
  items.map((item, index) => ({
    id: item.id || item.returnId || item.return_id || item.refundId || item.refund_id || `return-${index}`,
    "申请 / 货件": item.id || item.returnId || item.return_id || item.refundId || item.refund_id || item.postingNumber || item.posting_number || "—",
    "店铺": item.storeName || "当前店铺",
    "商品": item.productName || item.product_name || item.sku || item.offer_id || "—",
    "申请时间": returnDateText(item),
    "操作": "查看",
  }));

const warehouseRows = (warehouses = []) =>
  warehouses.map((item, index) => ({
    id: item.id || item.warehouse_id || `warehouse-${index}`,
    "主图": "—",
    "商品": item.name || item.warehouse_name || `仓库 ${index + 1}`,
    "总库存": "—",
    "仓库分布": item.name || item.warehouse_name || "—",
    "操作": "查看",
  }));

function StatusChips({ items, active = "全部", onChange }) {
  return (
    <div className="source-chip-row">
      {items.map((item) => (
        <button
          className={item.label === active ? "active" : ""}
          key={item.label}
          onClick={() => onChange?.(item.label)}
          type="button"
        >
          <span>{item.label}</span>
          {item.count !== undefined ? <strong>{item.count}</strong> : null}
        </button>
      ))}
    </div>
  );
}

function SourceStatusTabs({ items, active, onChange }) {
  return (
    <div className="source-status-tabs">
      {items.map((item) => {
        const label = typeof item === "string" ? item : item.label;
        const count = typeof item === "string" ? undefined : item.count;
        return (
          <button
            className={label === active ? "active" : ""}
            key={label}
            onClick={() => onChange?.(label)}
            type="button"
          >
            <span>{label}</span>
            {count !== undefined ? <strong>{count}</strong> : null}
          </button>
        );
      })}
    </div>
  );
}

function SourceLineTabs({ items, active, onChange }) {
  return (
    <div className="source-line-tabs">
      {items.map((item) => (
        <button
          className={item === active ? "active" : ""}
          key={item}
          onClick={() => onChange?.(item)}
          type="button"
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function PromotionStatusButtons({ items, active, onChange }) {
  return (
    <div className="promotion-status-buttons">
      {items.map((item) => (
        <button
          className={`${item.label === active ? "active" : ""} ${item.tone ? `tone-${item.tone}` : ""}`.trim()}
          key={item.label}
          onClick={() => onChange?.(item.label)}
          type="button"
        >
          <span>{item.label}</span>
          <strong>{item.count}</strong>
        </button>
      ))}
    </div>
  );
}

function SourceFilterDrawer({
  title = "筛选",
  open,
  onClose,
  fields = [],
  onSubmit,
  onReset,
}) {
  const [form] = Form.useForm();
  return (
    <Drawer
      rootClassName="prototype-overlay"
      title={title}
      open={open}
      onClose={onClose}
      size="large"
      extra={
        <Space>
          <Button
            onClick={() => {
              form.resetFields();
              onReset?.();
            }}
          >
            重置
          </Button>
          <Button
            type="primary"
            onClick={() => {
              onSubmit?.(form.getFieldsValue());
              onClose?.();
            }}
          >
            查询
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" className="source-filter-form">
        {fields.map((field) => (
          <Form.Item label={field.label} name={field.name} key={field.name}>
            {field.type === "dateRange" ? (
              <DatePicker.RangePicker className="full-control" />
            ) : field.type === "select" ? (
              <Select
                placeholder={field.placeholder || "请选择"}
                options={field.options || []}
                allowClear
              />
            ) : field.type === "textarea" ? (
              <Input.TextArea
                rows={4}
                placeholder={field.placeholder}
                allowClear
              />
            ) : field.type === "numberRange" ? (
              <Space.Compact className="full-control">
                <Input placeholder="最小" />
                <Input placeholder="最大" />
              </Space.Compact>
            ) : (
              <Input placeholder={field.placeholder || field.label} allowClear />
            )}
          </Form.Item>
        ))}
      </Form>
    </Drawer>
  );
}

function ProductStatusFilters({ reshelf = false }) {
  return (
    <div className="product-filters">
      <StatusChips
        items={[
          { label: "全部" },
          { label: "销售中", count: reshelf ? 0 : undefined },
          { label: "准备出售", count: 0 },
          { label: "错误", count: 0 },
          { label: "待修改", count: 0 },
          { label: "已下架", count: 0 },
          { label: "已归档", count: reshelf ? 0 : undefined },
        ]}
      />
      <div className="price-index">
        <span>价格指数</span>
        {["全部", "超值", "有利", "中等", "不利"].map((item) => (
          <button className={item === "全部" ? "active" : ""} key={item}>{item}</button>
        ))}
      </div>
    </div>
  );
}

function ProductListPage({ binding, hasStore, localData, onSync, navigate }) {
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState("");
  const [activeStatus, setActiveStatus] = useState("销售中");
  const [pageSizeChoice, setPageSizeChoice] = useState("20");
  const [priceDetail, setPriceDetail] = useState(null);
  const products = scopedProductsForCurrentStore(localData?.caches?.products || [], binding, localData);
  const statusOptions = productStatusFilterOptions(products);
  useEffect(() => {
    if (activeStatus !== "所有" && !statusOptions.some((item) => item.label === activeStatus)) {
      setActiveStatus("所有");
    }
  }, [activeStatus, statusOptions]);
  const visibleProducts = products.filter((item) => {
    const meta = productStatusMeta(item);
    return (activeStatus === "所有" || meta.label === activeStatus) && productMatchesQuery(item, query);
  });
  const rows = productRows(visibleProducts);
  const resolvedPageSize = pageSizeChoice === "全部" ? Math.max(rows.length, 1) : Number(pageSizeChoice) || 20;
  const priceColumns = [
    {
      title: "活动",
      dataIndex: "title",
      key: "title",
      ellipsis: true,
      render: (value) => <span className="source-table-cell-text" title={value}>{value}</span>,
    },
    {
      title: "活动价",
      dataIndex: "value",
      key: "value",
      width: 110,
      render: (value) => formatProductPrice(value),
    },
    {
      title: "开始时间",
      dataIndex: "date_from",
      key: "date_from",
      width: 150,
      render: (value) => value ? new Date(value).toLocaleString() : "—",
    },
    {
      title: "结束时间",
      dataIndex: "date_to",
      key: "date_to",
      width: 150,
      render: (value) => value ? new Date(value).toLocaleString() : "—",
    },
  ];
  const columns = [
    {
      title: "图片",
      dataIndex: "_image",
      width: 72,
      ellipsis: false,
      render: (value) => (
        value ? (
          <img className="product-thumb" src={value} alt="" loading="lazy" />
        ) : (
          <span className="product-thumb product-thumb-empty">—</span>
        )
      ),
    },
    {
      title: "商品信息",
      dataIndex: "商品信息",
      width: 280,
      render: (value, row) => {
        const title = row._title || value || "—";
        const sku = row._sku || "";
        const offerId = row._offerId || "";
        return (
          <div className="product-info-cell">
            <span className="source-table-cell-text product-info-name" title={title}>{title}</span>
            {sku ? (
              <span className="product-sku-row">
                <span className="product-sku-text" title={sku}>SKU：{sku}</span>
                <SkuCopyButton message={message} sku={sku} />
              </span>
            ) : null}
            {offerId ? (
              <span className="product-sku-row">
                <span className="product-sku-text" title={offerId}>货号：{offerId}</span>
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      title: "状态",
      dataIndex: "状态",
      width: 120,
      render: (value, row) => {
        const meta = row._statusMeta || { label: value || "—", tone: "default", raw: value || "" };
        return (
          <span className={`product-status-tag status-${meta.tone}`} title={meta.raw || meta.label}>
            {meta.label}
          </span>
        );
      },
    },
    {
      title: "售价",
      dataIndex: "价格",
      width: 108,
      render: (value, row) => (
        <Button
          className="product-price-link"
          onClick={() => setPriceDetail(row)}
          size="small"
          type="link"
        >
          {value}
        </Button>
      ),
    },
    "库存",
    "货源 (¥)",
    "最后同步",
  ];
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="商品列表"
        subtitle={storeLine(binding)}
        actions={[
          <Button type="primary" icon={<DatabaseOutlined />} onClick={() => navigate("/ozon/products/stocks")} key="stocks">库存管理</Button>,
          <Button type="primary" icon={<SyncOutlined />} onClick={onSync} key="sync">同步全部</Button>,
        ]}
      />
      <Card className="panel-card source-card">
        <div className="table-action-row">
          <Input.Search
            className="toolbar-search"
            placeholder="搜 SKU / 货号 / 标题…"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => message.success(`查询完成 · ${rows.length} 条`)}
          />
          <div className="table-result-title">共 {rows.length} 个</div>
        </div>
        <div className="product-status-filters" aria-label="商品状态筛选">
          {statusOptions.map((item) => (
            <button
              className={`product-status-filter status-${item.tone}${activeStatus === item.label ? " active" : ""}`}
              type="button"
              aria-pressed={activeStatus === item.label}
              key={`${item.label}-${item.tone}`}
              onClick={() => setActiveStatus(item.label)}
            >
              <span>{item.label}</span>
              <em>{item.count}</em>
            </button>
          ))}
          <button
            className={`product-status-filter status-all${activeStatus === "所有" ? " active" : ""}`}
            type="button"
            aria-pressed={activeStatus === "所有"}
            onClick={() => setActiveStatus("所有")}
          >
            <span>所有</span>
            <em>{products.length}</em>
          </button>
        </div>
        <SourceTable
          hasStore={hasStore}
          key={`${activeStatus}-${query}-${pageSizeChoice}`}
          rows={rows}
          columns={columns}
          pageSize={resolvedPageSize}
          pageSizeControl={(
            <div className="product-page-size-control">
              <span>每页显示</span>
              <Select
                size="small"
                value={pageSizeChoice}
                options={[
                  { value: "20", label: "20" },
                  { value: "50", label: "50" },
                  { value: "100", label: "100" },
                  { value: "全部", label: "全部" },
                ]}
                onChange={setPageSizeChoice}
                popupMatchSelectWidth={false}
              />
            </div>
          )}
          scrollX={1180}
          empty="暂无商品"
          sourceEmpty
        />
      </Card>
      <Modal
        rootClassName="prototype-overlay"
        title="商品活动价格"
        open={Boolean(priceDetail)}
        footer={null}
        onCancel={() => setPriceDetail(null)}
        width={760}
      >
        {priceDetail ? (
          <div className="product-price-modal">
            <div className="product-price-modal-head">
              <strong>{localizeOzonProductTitle(priceDetail._title, priceDetail._sku)}</strong>
              <span>SKU：{priceDetail._sku || "—"}</span>
              <span>货号：{priceDetail._offerId || "—"}</span>
              <span>当前展示价：{priceDetail["价格"]}</span>
            </div>
            <Table
              columns={priceColumns}
              dataSource={priceDetail._priceActions || []}
              pagination={false}
              rowKey="key"
              size="small"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function CollectPage({ hasStore, localData, onBind, onRefresh, navigate }) {
  const { message } = AntApp.useApp();
  const [activeStatus, setActiveStatus] = useState("全部");
  const [sourceFilter, setSourceFilter] = useState();
  const [collectInput, setCollectInput] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [retryingEnrichmentId, setRetryingEnrichmentId] = useState("");
  const [retryEnrichmentOverrides, setRetryEnrichmentOverrides] = useState({});
  const collectItems = localData?.caches?.collectBox || [];
  const rows = collectItems.map((item, index) => {
    const id = item.id || "collect-" + index;
    const enrichment = collectEnrichmentEffectiveSummary(item, retryEnrichmentOverrides[id]);
    const enrichmentView = collectEnrichmentView(enrichment);
    return {
      id,
      _image: item.image || item.primaryImage || (item.images || [])[0] || "",
      _title: item.name || item.title || item.productUrl || "—",
      _enrichment: enrichment,
      _enrichmentView: enrichmentView,
      sku: item.sku || item.id || "",
      "商品信息": item.name || item.title || item.productUrl || "—",
      "采集价格": item.price || item.priceText || "—",
      "卖家 / 来源": item.source || item.seller || item.sellerName || "—",
      "品牌": item.brand || "—",
      "下单链接": item.productUrl || item.url || "—",
      "采集时间": item.createdAt ? new Date(item.createdAt).toLocaleString() : "—",
      "状态": collectWorkflowStatus(item),
      "操作": "查看",
    };
  });
  const sourceOptions = [
    ...Array.from(new Set(rows.map((row) => row["卖家 / 来源"]).filter((value) => value && value !== "—"))).map((value) => ({
      value,
      label: value,
    })),
  ];
  const visibleRows = rows.filter((row) => {
    const statusMatched = activeStatus === "全部" || row["状态"] === activeStatus;
    const sourceMatched = !sourceFilter || row["卖家 / 来源"] === sourceFilter;
    return statusMatched && sourceMatched;
  });
  const sellerSourceColumnWidth = adaptiveTextColumnWidth(visibleRows, "卖家 / 来源", { min: 132, max: 220 });
  const visibleRowIdSignature = visibleRows.map((row) => row.id).join("|");
  const visibleEnrichmentPollKey = visibleRows
    .map((row) => `${row.id}:${String(row._enrichment?.status || "")}`)
    .join("|");
  const countByStatus = (status) => rows.filter((row) => row["状态"] === status).length;
  useEffect(() => {
    const visibleIds = new Set(visibleRows.map((row) => row.id));
    setSelectedRowKeys((keys) => keys.filter((key) => visibleIds.has(key)));
  }, [visibleRowIdSignature]);
  useEffect(() => {
    setRetryEnrichmentOverrides((current) => {
      let changed = false;
      const next = {};
      for (const [itemId, override] of Object.entries(current)) {
        const currentItem = collectItems.find((item) => String(item?.id || "") === itemId);
        if (currentItem && override?.baseItem === currentItem) next[itemId] = override;
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [collectItems]);
  useEffect(() => {
    if (
      typeof onRefresh !== "function"
      || !collectEnrichmentListNeedsPolling(visibleRows.map((row) => row._enrichment))
    ) return undefined;
    return startCollectEnrichmentPolling({
      refresh: () => onRefresh({ silent: true, source: "collect-list-poll" }),
      setIntervalFn: window.setInterval.bind(window),
      clearIntervalFn: window.clearInterval.bind(window),
    });
  }, [visibleEnrichmentPollKey, onRefresh]);
  const retryCollectEnrichment = async (collectItemId) => {
    const itemId = String(collectItemId || "").trim();
    if (!itemId || retryingEnrichmentId) return;
    const sourceItem = collectItems.find((item) => String(item?.id || "") === itemId);
    if (!sourceItem) return;
    setRetryingEnrichmentId(itemId);
    message.loading({ content: "正在重新提交资料补全…", key: `collect-enrichment-${itemId}`, duration: 0 });
    try {
      const { notice } = await runCollectEnrichmentRetry({
        item: sourceItem,
        request: apiRequest,
        applyOverride: (override) => {
          setRetryEnrichmentOverrides((current) => ({ ...current, [itemId]: override }));
        },
        refresh: onRefresh,
        refreshSource: "collect-list-retry",
      });
      message[notice.type]({ content: notice.content, key: `collect-enrichment-${itemId}` });
    } catch (error) {
      message.error({ content: `重新补全失败: ${error?.message || error}`, key: `collect-enrichment-${itemId}` });
    } finally {
      setRetryingEnrichmentId("");
    }
  };
  const deleteCollectItems = (ids = []) => {
    const targetIds = Array.from(new Set(ids.map((id) => String(id || "")).filter(Boolean)));
    if (!targetIds.length) {
      message.warning("请选择要删除的采集商品");
      return;
    }
    Modal.confirm({
      title: targetIds.length > 1 ? "批量删除采集商品" : "删除采集商品",
      content: targetIds.length > 1
        ? `确认删除已选 ${targetIds.length} 个采集商品？`
        : "确认删除该采集商品？",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await apiRequest(
            targetIds.length > 1
              ? "/ozon/collect-box/batch"
              : `/ozon/collect-box/${encodeURIComponent(targetIds[0])}`,
            {
              method: "DELETE",
              body: targetIds.length > 1 ? { ids: targetIds } : undefined,
            },
          );
          setSelectedRowKeys((keys) => keys.filter((key) => !targetIds.includes(String(key))));
          message.success(targetIds.length > 1 ? `已删除 ${targetIds.length} 个采集商品` : "采集商品已删除");
          void Promise.resolve(onRefresh?.({ silent: true })).catch(() => {
            message.warning("采集箱刷新失败，请稍后手动刷新");
          });
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };
  const handleCollectAdd = async (value) => {
    const token = localStorage.getItem("token");
    const readiness = collectAddReadiness({ value, token });
    if (!readiness.ok) {
      message.warning(readiness.message);
      return;
    }
    const { input, isUrl } = readiness;
    if (!isUrl) {
      // SKU 输入：调用后端抓取端点，自动从 ozon.ru 获取竞品数据
      message.loading({ content: "正在从 ozon.ru 抓取商品数据…", key: "collect-scrape", duration: 0 });
      try {
        const resp = await apiRequest("/ozon/collect-box/scrape", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: { sku: input },
        });
        if (resp?.scraped) {
          const enrichment = resp?.enrichment || resp?.data?.enrichment;
          message.success({
            content: enrichment
              ? collectEnrichmentSuccessMessage(enrichment)
              : "已抓取商品数据并加入采集箱",
            key: "collect-scrape",
          });
        } else {
          message.warning({ content: "未能抓取到商品数据，已创建待处理条目", key: "collect-scrape" });
        }
        await onRefresh?.();
        return;
      } catch (error) {
        message.error({ content: `抓取失败: ${error.message}`, key: "collect-scrape" });
        // 失败后仍尝试普通添加
      }
    }
    try {
      const response = await apiRequest("/ozon/collect-box", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: {
          productUrl: isUrl ? input : "",
          sku: isUrl ? "" : input,
          name: input,
          source: isUrl ? "链接添加" : "SKU 添加",
          status: "待处理",
          raw: { input },
        },
      });
      message.success(collectEnrichmentSuccessMessage(response?.enrichment || response?.data?.enrichment));
      await onRefresh?.();
    } catch (error) {
      message.error(`添加失败: ${error.message}`);
    }
  };
  return (
    <div className="source-page collect-page">
      <Card className="collect-add-card">
        <div className="collect-add-head">
          <div className="collect-title-icon">
            <InboxOutlined />
          </div>
          <div className="collect-title-copy">
            <div className="collect-title-row">添加采集商品</div>
            <span className="collect-subtitle">粘贴 Ozon 商品链接 / 直接输入 SKU，回车快速添加</span>
          </div>
        </div>
        <div className="collect-input-row">
          <div className="collect-input-wrap">
            <Input
              size="large"
              prefix={<LinkOutlined />}
              value={collectInput}
              onChange={(event) => setCollectInput(event.target.value)}
              placeholder="https://www.ozon.ru/product/... 或直接输入 SKU"
              onPressEnter={(event) => handleCollectAdd(event.currentTarget.value)}
            />
          </div>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => handleCollectAdd(collectInput)}>
            添加采集
          </Button>
        </div>
        <div className="collect-tips">
          <Tag color="blue" icon={<CheckOutlined />}>自动识别价格 / 重量 / 卖家</Tag>
          <Tag color="orange" icon={<ThunderboltOutlined />}>安装插件后一键采集</Tag>
        </div>
      </Card>
      <div className="collect-filter-row">
        <StatusChips
          active={activeStatus}
          onChange={setActiveStatus}
          items={[
            { label: "全部", count: rows.length },
            { label: "待处理", count: countByStatus("待处理") },
            { label: "已上架", count: countByStatus("已上架") },
            { label: "已跳过", count: countByStatus("已跳过") },
            { label: "失败", count: countByStatus("失败") },
          ]}
        />
        <div className="collect-filter-actions">
          <Button
            danger
            disabled={!selectedRowKeys.length}
            icon={<DeleteOutlined />}
            onClick={() => deleteCollectItems(selectedRowKeys)}
          >
            批量删除
          </Button>
          <Select
            className="source-select"
            value={sourceFilter}
            onChange={setSourceFilter}
            placeholder="按来源筛选"
            allowClear
            showSearch
            options={sourceOptions}
          />
        </div>
      </div>
      <div className="collect-table-panel">
        <SourceTable
          hasStore={hasStore}
          rows={visibleRows}
          selectedRowKeys={selectedRowKeys}
          onSelectionChange={setSelectedRowKeys}
          columns={[
            { title: "商品信息", dataIndex: "商品信息", render: (value, row) => (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {row._image ? <img src={row._image} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} /> : null}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
              </div>
            ) },
            "采集价格",
            {
              title: "卖家 / 来源",
              dataIndex: "卖家 / 来源",
              width: sellerSourceColumnWidth,
              render: renderSourceTextCell,
            },
            "品牌",
            {
              title: "下单链接",
              dataIndex: "下单链接",
              width: 220,
              render: (value) => {
                const text = sourceCellText(value);
                const href = safeExternalHttpUrl(value);
                if (!href) return renderSourceTextCell(value);
                return (
                  <a className="source-table-link" href={href} target="_blank" rel="noreferrer" title={text}>
                    {text}
                  </a>
                );
              },
            },
            "采集时间",
            {
              title: "状态",
              dataIndex: "状态",
              width: 210,
              render: (value, row) => {
                const view = row._enrichmentView;
                if (!view?.label) return value;
                return (
                  <div className="collect-enrichment-cell">
                    <Tag color={collectEnrichmentTagColors[view.tone]}>{view.label}</Tag>
                    {view.detail ? <span title={view.detail}>{view.detail}</span> : null}
                  </div>
                );
              },
            },
            { title: "操作", dataIndex: "操作", width: 230, ellipsis: false, render: (value, row) => (
              <Space size={6} wrap={false}>
                <Button type="link" size="small" onClick={() => navigate(`/ozon/products/collect/edit/?id=${encodeURIComponent(row.id)}`)}>{value}</Button>
                {row._enrichmentView?.retryable ? (
                  <Button
                    type="link"
                    size="small"
                    loading={retryingEnrichmentId === String(row.id)}
                    onClick={() => retryCollectEnrichment(row.id)}
                  >
                    重新补全
                  </Button>
                ) : null}
                <Button type="link" danger size="small" onClick={() => deleteCollectItems([row.id])}>删除</Button>
              </Space>
            ) },
          ]}
          empty="暂无采集商品，请在上方添加"
          sourceEmpty
          scrollX={1260}
        />
      </div>
    </div>
  );
}

const collectEditText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return collectEditText(value.text || value.value || value.name || value.title || value.url || value.file_name || "");
  return String(value).trim();
};

const collectEditFirst = (...values) => {
  for (const value of values) {
    const text = collectEditText(value);
    if (text) return text;
  }
  return "";
};

const collectEditImages = (item = {}, activeImage = "") => {
  const images = [];
  const seen = new Set();
  const push = (value) => {
    const url = collectEditText(value);
    if (!url) return;
    const key = url.split("?")[0].split("#")[0].toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    images.push(url);
  };
  push(activeImage);
  push(item.image);
  push(item.primaryImage);
  push(item.primary_image);
  push(item.main_image);
  push(item.mainImage);
  push(item.picture);
  push(item.coverImage);
  push(item.cover_image);
  [item.images, item.imageUrls, item.image_urls, item.pictures, item.photos, item.media, item.gallery].forEach((list) => {
    if (Array.isArray(list)) list.forEach(push);
  });
  return images;
};

const collectEditVariantSourceRows = (item = {}) => {
  const lists = [
    item.variants,
    item.variantData?.variants,
    item.variant_data?.variants,
    item.raw?.variants,
    item.raw?.variantData?.variants,
    item.raw?.variant_data?.variants,
    item.skuList,
    item.sku_list,
    item.raw?.skuList,
    item.raw?.sku_list,
  ];
  const rows = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const variant of list) {
      if (!variant || typeof variant !== "object") continue;
      const key = collectEditFirst(
        variant.sku,
        variant.variant_id,
        variant.product_id,
        variant.productId,
        variant.offer_id,
        variant.offerId,
      ) || JSON.stringify(variant).slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(variant);
    }
  }
  return rows;
};

const collectEditVariantSourceSnapshot = (item = {}, variant = {}, sku = "") => {
  const direct = [
    variant.sourceVariant,
    variant._sourceVariant,
    variant.variantData,
    variant.variant_data,
    variant.sv,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value));
  if (direct) return direct;
  if (Array.isArray(variant.attributes) && variant.attributes.length) return variant;

  // Older collection records only retained the anchor source snapshot. It is safe
  // to use that snapshot for the anchor SKU, but copying it to sibling SKUs would
  // silently make every variant share the same category attributes and dimensions.
  const anchorSku = String(collectEditFirst(item.sku, item.product_id, item.productId, item.id) || "");
  if (String(sku || "") !== anchorSku) return {};
  return [
    item._sourceVariant,
    item.variantData,
    item.variant_data,
    item.raw?.variantData,
    item.raw?.variant_data,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
};

const collectEditAspectName = (variant = {}) => {
  const values = variant.aspectValues || variant.aspect_values || variant.aspects || {};
  if (!values || typeof values !== "object" || Array.isArray(values)) return "";
  return Object.entries(values)
    .map(([key, value]) => {
      const text = collectEditText(value);
      return text ? `${key}: ${text}` : "";
    })
    .filter(Boolean)
    .join(" / ");
};

const collectEditSourceUrl = (item = {}, sku = "") =>
  collectEditFirst(item.sourceUrl, item.source_url, item.productUrl, item.product_url, item.url, item.link, item["下单链接"]) ||
  (sku ? `https://www.ozon.ru/product/${sku}/` : "");

const collectEditDimensionSources = (item = {}) => [
  item.listingDraft,
  item.listingDraft?.logistics,
  item,
  item.raw,
  item.variantData,
  item.variant_data,
  item._sourceVariant,
  item.raw?.variantData,
  item.raw?.variant_data,
].filter((source) => source && typeof source === "object");

const collectEditDimensionAttributeText = (attr = {}) => {
  const direct = collectEditFirst(attr.value, attr.text, attr.name_value, attr.value_name, attr.display_value, attr.displayValue);
  if (direct !== "") return String(direct).trim();
  const list = Array.isArray(attr.values) && attr.values.length
    ? attr.values
    : (Array.isArray(attr.collection) ? attr.collection : []);
  return list
    .map((value) => collectEditFirst(value?.value, value?.name, value?.title, value?.text, value?.content, value?.display_value, value?.displayValue, value))
    .filter(Boolean)
    .join("、");
};

const collectEditDimensionNumber = (raw, kind = "dimension", attrId = "") => {
  const text = String(raw || "").replace(",", ".").trim();
  const value = numberFromMoney(text);
  if (!value || value <= 0) return 0;
  const lower = text.toLowerCase();
  if (kind === "weight") {
    if (/(кг|kg)/i.test(lower)) return Math.round(value * 1000);
    if (String(attrId) === "4383" && value < 100) return Math.round(value * 1000);
    return Math.round(value);
  }
  if (/(см|cm)/i.test(lower)) return Math.round(value * 10);
  if (/(мм|mm)/i.test(lower)) return Math.round(value);
  if (/(^|\s)(м|m)(\s|$)/i.test(lower)) return Math.round(value * 1000);
  return Math.round(value);
};

const collectEditDimension = (item = {}, keys = [], fallback = "100", attrIds = [], kind = "dimension") => {
  const sources = collectEditDimensionSources(item);
  for (const source of sources) {
    for (const key of keys) {
      const value = collectEditDimensionNumber(source[key], kind);
      if (value && value > 0) return String(value);
    }
  }
  const idSet = new Set(attrIds.map((id) => String(id)));
  for (const source of sources) {
    const attrs = Array.isArray(source.attributes) ? source.attributes : [];
    for (const attr of attrs) {
      const id = String(collectEditFirst(attr.id, attr.attribute_id, attr.attributeId, attr.key) || "");
      if (!idSet.has(id)) continue;
      const value = collectEditDimensionNumber(collectEditDimensionAttributeText(attr), kind, id);
      if (value && value > 0) return String(value);
    }
  }
  return fallback;
};

const collectEditPackageDimension = (draftValue, item = {}, keys = [], attrIds = [], kind = "dimension") => {
  const sourceValue = collectEditDimension(item, keys, "", attrIds, kind);
  const draftText = collectEditFirst(draftValue);
  if (!draftText) return sourceValue;
  if (String(draftText).trim() === "100" && !sourceValue) return "";
  return draftText;
};

const collectEditAttributeScalar = (value) => {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object") {
    return collectEditFirst(
      value.value,
      value.name,
      value.title,
      value.text,
      value.content,
      value.display_value,
      value.displayValue,
      value.id,
      value.dictionary_value_id,
      value.dictionaryValueId,
    );
  }
  return String(value).trim();
};

const collectEditAttributeValue = (attr = {}) => {
  const direct = collectEditAttributeScalar(collectEditFirst(attr.value, attr.text, attr.name_value, attr.value_name, attr.display_value, attr.displayValue));
  if (direct) return direct;
  const list = Array.isArray(attr.values) && attr.values.length
    ? attr.values
    : (Array.isArray(attr.collection) ? attr.collection : []);
  return list
    .map(collectEditAttributeScalar)
    .filter(Boolean)
    .join("、");
};

const collectEditRawAttributeList = (...sources) => {
  const rows = [];
  const seen = new Set();
  const pushList = (list = []) => {
    if (!Array.isArray(list)) return;
    for (const attr of list) {
      if (!attr || typeof attr !== "object") continue;
      const id = collectEditFirst(attr.id, attr.attribute_id, attr.attributeId, attr.key);
      const value = collectEditAttributeValue(attr);
      if (!id || !value) continue;
      const key = `${id}:${value}`.slice(0, 240);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(attr);
    }
  };
  const pushSource = (source = {}) => {
    if (!source || typeof source !== "object") return;
    pushList(source.attributes);
    pushList(source.variantData?.attributes);
    pushList(source.variant_data?.attributes);
    pushList(source.raw?.attributes);
    pushList(source.raw?.variantData?.attributes);
    pushList(source.raw?.variant_data?.attributes);
    pushList(source._sourceVariant?.attributes);
  };
  sources.forEach(pushSource);
  return rows;
};

const collectEditRawComplexAttributes = (...sources) => {
  const groups = [];
  const seen = new Set();
  const pushList = (list = []) => {
    if (!Array.isArray(list)) return;
    for (const group of list) {
      if (!group || typeof group !== "object") continue;
      const attrs = Array.isArray(group.attributes) ? group.attributes : [];
      if (!attrs.length) continue;
      const key = `${collectEditFirst(group.id, group.complex_id, group.complexId) || "complex"}:${JSON.stringify(attrs).slice(0, 180)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(group);
    }
  };
  const pushSource = (source = {}) => {
    if (!source || typeof source !== "object") return;
    pushList(source.complex_attributes);
    pushList(source.complexAttributes);
    pushList(source.variantData?.complex_attributes);
    pushList(source.variantData?.complexAttributes);
    pushList(source.variant_data?.complex_attributes);
    pushList(source.variant_data?.complexAttributes);
    pushList(source.raw?.complex_attributes);
    pushList(source.raw?.complexAttributes);
    pushList(source.raw?.variantData?.complex_attributes);
    pushList(source.raw?.variantData?.complexAttributes);
    pushList(source.raw?.variant_data?.complex_attributes);
    pushList(source.raw?.variant_data?.complexAttributes);
    pushList(source._sourceVariant?.complex_attributes);
    pushList(source._sourceVariant?.complexAttributes);
  };
  sources.forEach(pushSource);
  return groups;
};

const collectEditAttributeRows = (...sources) => {
  const rows = [];
  const seen = new Map();
  const hiddenAttrIds = new Set(["4194", "4195", "11254"]);
  const pushList = (list = [], complexId = "") => {
    if (!Array.isArray(list)) return;
    for (const attr of list) {
      if (!attr || typeof attr !== "object") continue;
      const id = collectEditFirst(attr.id, attr.attribute_id, attr.attributeId, attr.key);
      if (hiddenAttrIds.has(String(id))) continue;
      const value = collectEditAttributeValue(attr);
      if (!value) continue;
      const label = collectEditFirst(attr.name, attr.attribute_name, attr.attributeName, attr.title, attr.key) || (id ? `Ozon 属性 ${id}` : "Ozon 属性");
      const key = `${complexId || "attr"}:${id || label}:${value}`.slice(0, 240);
      const dictionaryIds = collectEditDictionaryIdsOf(attr);
      const existing = seen.get(key);
      if (existing) {
        existing.dictionaryIds = [...new Set([...(existing.dictionaryIds || []), ...dictionaryIds])];
        continue;
      }
      const row = {
        key,
        id,
        label,
        value: value.length > 180 ? `${value.slice(0, 180)}...` : value,
        rawValue: value,
        dictionaryIds,
        required: attr.is_required === true || attr.required === true,
      };
      seen.set(key, row);
      rows.push(row);
    }
  };
  const pushSource = (source = {}) => {
    if (!source || typeof source !== "object") return;
    pushList(source.attributes);
    pushList(source.variantData?.attributes);
    pushList(source.variant_data?.attributes);
    pushList(source.raw?.attributes);
    pushList(source.raw?.variantData?.attributes);
    pushList(source.raw?.variant_data?.attributes);
    pushList(source._sourceVariant?.attributes);
    const complexLists = [
      source.complex_attributes,
      source.complexAttributes,
      source.variantData?.complex_attributes,
      source.variantData?.complexAttributes,
      source.raw?.variantData?.complex_attributes,
    ];
    complexLists.forEach((list) => {
      if (!Array.isArray(list)) return;
      list.forEach((group, index) => pushList(group?.attributes, collectEditFirst(group?.id, group?.complex_id, `complex-${index}`)));
    });
  };
  sources.forEach(pushSource);
  return rows.slice(0, 60);
};

const collectEditSourceVariant = (item = {}, sku = "") => {
  const variants = collectEditVariantSourceRows(item);
  const skuText = String(sku || "").trim();
  const selectedVariant = variants.find((variant) => {
    const ids = [
      variant.sku,
      variant.product_id,
      variant.productId,
      variant.variant_id,
      variant.variantId,
      variant.offer_id,
      variant.offerId,
      variant.id,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return skuText && ids.includes(skuText);
  }) || variants[0] || {};
  const sources = [
    item._sourceVariant,
    item.variantData,
    item.variant_data,
    item.raw?.variantData,
    item.raw?.variant_data,
    item.raw,
    item,
    selectedVariant,
  ].filter((source) => source && typeof source === "object");
  const merged = sources.reduce((acc, source) => ({ ...acc, ...source }), {});
  const sourceCategoryVariant = collectEditSourceCategoryVariant(item);
  const attributes = collectEditRawAttributeList(...sources, sourceCategoryVariant);
  const complexAttributes = collectEditRawComplexAttributes(...sources);
  return {
    ...merged,
    description_category_id: collectEditFirst(
      merged.description_category_id,
      merged.descriptionCategoryId,
      sourceCategoryVariant.description_category_id,
    ),
    type_id: collectEditFirst(
      merged.type_id,
      merged.typeId,
      sourceCategoryVariant.type_id,
    ),
    attributes: attributes.length ? attributes : (Array.isArray(merged.attributes) ? merged.attributes : []),
    complex_attributes: complexAttributes.length ? complexAttributes : (Array.isArray(merged.complex_attributes) ? merged.complex_attributes : []),
  };
};

export const collectEditPreviewPayload = ({
  item = {},
  sku = "",
  title = "",
  price = "",
  currencyCode = "CNY",
  productImageList = [],
  variantRows = [],
  brand = "",
  modelName = "",
  offerPrefix = "jz-",
  description = "",
  tags = [],
  richContent = "",
  packageWeight = "",
  packageLength = "",
  packageWidth = "",
  packageHeight = "",
  warehouseId = "",
  stock = "",
  targetStoreId = "",
  taxonomyScope = "OZON:DEFAULT",
}) => {
  const sourceVariant = collectEditSourceVariant(item, sku);
  const attributes = collectEditRawAttributeList(sourceVariant, item);
  const complexAttributes = collectEditRawComplexAttributes(sourceVariant, item);
  const numericPrice = numberFromMoney(price);
  const firstVariant = variantRows[0] || {};
  const offerId = collectEditFirst(firstVariant.offerId, firstVariant.offer_id) || `${offerPrefix || "jz-"}${sku || item.sku || Date.now()}`;
  const sourceCategory = collectEditSourceCategorySnapshot(item);
  const targetResolution = categoryResolutionForCollectionTarget(item, {
    targetStoreId,
    taxonomyScope,
  });
  const targetFields = listingTargetCategoryFieldsForStore(targetResolution, targetStoreId);
  const payload = {
    offer_id: offerId,
    name: title || collectEditFirst(item.name, item.title, sku) || `Ozon SKU ${sku}`,
    price: numericPrice ? numericPrice.toFixed(2) : String(price || ""),
    old_price: collectEditFirst(firstVariant.oldPrice, item.old_price, item.oldPrice) || (numericPrice ? (numericPrice * 1.25).toFixed(2) : ""),
    vat: "0",
    currency_code: currencyCode || "CNY",
    images: productImageList.map((url, index) => ({ file_name: url, default: index === 0 })),
    scraped_description: description || collectEditAttributeValue({ values: sourceVariant.attributes?.filter?.((attr) => String(collectEditFirst(attr.id, attr.attribute_id, attr.key)) === "4191") }) || title,
    scraped_sku: String(sku || item.sku || ""),
    scraped_model_name: modelName || offerId,
    brand,
    _aiHashtags: Array.isArray(tags) ? tags : [],
    richContent,
    _sourceVariant: sourceVariant,
    sourceCategory,
    attributes,
    complex_attributes: complexAttributes,
    bundleComplexAttrs: sourceVariant._bundleComplexAttrs || undefined,
    barcode: collectEditFirst(item.barcode, sourceVariant.barcode),
    ...(targetFields.descriptionCategoryId
      ? { description_category_id: targetFields.descriptionCategoryId }
      : {}),
    ...(targetFields.typeId ? { type_id: targetFields.typeId } : {}),
    dimension_unit: "mm",
    weight_unit: "g",
  };
  const weight = numberFromMoney(packageWeight);
  const depth = numberFromMoney(packageLength);
  const width = numberFromMoney(packageWidth);
  const height = numberFromMoney(packageHeight);
  if (weight) payload.weight = Math.round(weight);
  if (depth) payload.depth = Math.round(depth);
  if (width) payload.width = Math.round(width);
  if (height) payload.height = Math.round(height);
  const stockRows = collectEditListingStockRows({
    warehouseId,
    stock,
    sku: payload.scraped_sku,
    offerId: payload.offer_id,
  });
  if (stockRows.length) {
    payload.stocks = stockRows;
    payload.stock = stockRows[0].stock;
    payload.warehouse_id = stockRows[0].warehouse_id;
  }
  return payload;
};

const collectEditListingStockRows = ({ warehouseId = "", stock = "", sku = "", offerId = "" } = {}) => {
  const warehouseText = String(warehouseId || "").trim();
  if (!warehouseText) return [];
  const stockValue = Math.max(0, Math.floor(numberFromMoney(stock) || 0));
  const numericWarehouseId = Number(warehouseText);
  return [{
    warehouse_id: Number.isFinite(numericWarehouseId) ? numericWarehouseId : warehouseText,
    stock: stockValue,
    ...(offerId ? { offer_id: String(offerId) } : {}),
    ...(sku ? { sku: Number(sku) || String(sku) } : {}),
  }];
};

const collectEditCategoryNodeName = (node = {}, descriptionId = "", typeId = "") =>
  collectEditFirst(
    node.category_name,
    node.categoryName,
    node.type_name,
    node.typeName,
    node.name,
    node.title,
    node.label,
  ) || (typeId ? `类型 ${typeId}` : descriptionId ? `类目 ${descriptionId}` : "未命名类目");

const collectEditCategoryChildren = (node = {}) => {
  for (const key of ["children", "childs", "items", "categories", "types"]) {
    if (Array.isArray(node?.[key])) return node[key];
  }
  return [];
};

const collectEditCategoryTreeOptions = (nodes = [], inheritedDescriptionId = "", pathKey = "cat") =>
  (Array.isArray(nodes) ? nodes : [])
    .map((node, index) => {
      if (!node || typeof node !== "object") return null;
      const rawDescriptionId = collectEditFirst(
        node.description_category_id,
        node.descriptionCategoryId,
        node.category_id,
        node.categoryId,
        node.id && !node.type_id && !node.typeId ? node.id : "",
      );
      const descriptionCategoryId = rawDescriptionId || inheritedDescriptionId || "";
      const typeId = collectEditFirst(node.type_id, node.typeId);
      const label = collectEditCategoryNodeName(node, descriptionCategoryId, typeId);
      const value = `${pathKey}-${index}-${descriptionCategoryId || "category"}-${typeId || "node"}`;
      const children = collectEditCategoryTreeOptions(collectEditCategoryChildren(node), descriptionCategoryId, value);
      return {
        value,
        label,
        descriptionCategoryId,
        typeId,
        raw: node,
        ...(children.length ? { children } : {}),
      };
    })
    .filter(Boolean);

const collectEditFindCategoryOptionPath = (options = [], descriptionCategoryId = "", typeId = "", path = []) => {
  const targetDescriptionId = String(descriptionCategoryId || "");
  const targetTypeId = String(typeId || "");
  if (!targetDescriptionId && !targetTypeId) return null;
  for (const option of Array.isArray(options) ? options : []) {
    const nextPath = [...path, option];
    const descriptionMatches = targetDescriptionId && String(option.descriptionCategoryId || "") === targetDescriptionId;
    const typeMatches = targetTypeId && String(option.typeId || "") === targetTypeId;
    if (descriptionMatches && (!targetTypeId || typeMatches)) return nextPath;
    const childPath = collectEditFindCategoryOptionPath(option.children, descriptionCategoryId, typeId, nextPath);
    if (childPath) return childPath;
  }
  return null;
};

const collectEditCategoryDisplayPath = (optionPath = []) =>
  (Array.isArray(optionPath) ? optionPath : [])
    .map((option) => collectEditText(option?.label))
    .filter(Boolean)
    .join(" / ");

const collectEditSchemaId = (schema = {}) =>
  collectEditFirst(schema.id, schema.attribute_id, schema.attributeId, schema.key);

const collectEditAttributeLabelById = {
  "85": "品牌",
  "4381": "颜色代码",
  "4383": "商品重量",
  "4386": "包装类型",
  "4180": "商品名称",
  "4191": "商品简介",
  "4192": "商品描述",
  "4389": "生产国家",
  "4384": "包装清单",
  "4497": "包装重量",
  "5269": "防护等级",
  "5480": "安装件",
  "6315": "光源类型",
  "6317": "照明类型",
  "6319": "功率",
  "6322": "照明面积",
  "6324": "控制方式",
  "6328": "灯光模式数量",
  "6605": "宽度",
  "7703": "高度",
  "7822": "货号",
  "8229": "商品类型",
  "8383": "光通量",
  "8385": "光色",
  "8386": "色温",
  "8790": "PDF 文档",
  "8873": "附加属性",
  "9024": "型号代码",
  "9048": "型号代码",
  "9070": "附加属性",
  "8962": "单个商品内件数",
  "9454": "包装长",
  "9455": "包装宽",
  "9456": "包装高",
  "9802": "长度",
  "10096": "颜色",
  "10097": "颜色名称",
  "10654": "电压",
  "10400": "保修期",
  "11254": "富内容 JSON",
  "11650": "包装数量",
  "12138": "是否含光源",
  "21837": "款式",
  "21841": "款式",
  "22270": "生产方式",
  "22273": "款式",
  "22219": "镜子形状",
  "22232": "附加属性",
  "22390": "附加属性",
  "22824": "附加属性",
  "23171": "主题标签",
  "23249": "附加属性",
  "23379": "商品组",
  "23380": "海关编码",
  "23524": "条形码",
  "23536": "附加属性",
};

const collectEditAttributeLabelByName = {
  "#хештеги": "主题标签",
  "бренд": "品牌",
  "вид": "款式",
  "высота": "高度",
  "гарантия": "保修期",
  "декоративные элементы": "装饰元素",
  "длина": "长度",
  "документ pdf": "PDF 文档",
  "единиц в одном товаре": "单个商品内件数",
  "количество в упаковке": "包装数量",
  "комплектация": "包装清单",
  "материал": "材质",
  "материал рамы": "框架材质",
  "модель": "型号",
  "назначение": "用途",
  "название": "名称",
  "название модели": "型号名称",
  "название цвета": "颜色名称",
  "особенности": "特点",
  "подсветка": "背光",
  "размер": "尺寸",
  "размещение зеркала": "镜子安装方式",
  "серия": "系列",
  "страна-изготовитель": "生产国家",
  "стиль": "风格",
  "тип": "类型",
  "тип выключателя": "开关类型",
  "тип зеркала": "镜子类型",
  "тип лампы": "灯具类型",
  "тип освещения": "照明类型",
  "тип подсветки": "背光类型",
  "форма зеркала": "镜子形状",
  "цвет": "颜色",
  "ширина": "宽度",
  "хештеги": "主题标签",
};

const collectEditTranslateAttributeLabel = (label = "", id = "") => {
  const idText = String(id || "").trim();
  if (idText && collectEditAttributeLabelById[idText]) return collectEditAttributeLabelById[idText];
  const raw = String(label || "").trim();
  if (!raw) return idText ? `Ozon 属性 ${idText}` : "Ozon 属性";
  const normalized = raw
    .replace(/\s+/g, " ")
    .replace(/[()（）]\s*\d+\s*[()（）]?/g, "")
    .trim()
    .toLowerCase();
  if (/^(attribute|атрибут|свойство|property|属性)\s*\d*$/i.test(normalized)) {
    return idText ? `Ozon 属性 ${idText}` : "Ozon 属性";
  }
  if (collectEditAttributeLabelByName[normalized]) return collectEditAttributeLabelByName[normalized];
  for (const [source, translated] of Object.entries(collectEditAttributeLabelByName)) {
    if (normalized.includes(source)) return translated;
  }
  return /[\u0400-\u04FF]/.test(raw) && idText ? `Ozon 属性 ${idText}` : raw;
};

const collectEditSchemaLabel = (schema = {}) => {
  const id = collectEditSchemaId(schema);
  const label = collectEditFirst(schema.name, schema.attribute_name, schema.attributeName, schema.title, schema.key);
  return collectEditTranslateAttributeLabel(label, id);
};

const collectEditSchemaIsBrand = (schema = {}, label = "") => {
  const id = String(collectEditSchemaId(schema) || "").trim();
  if (id === "85") return true;
  const rawLabel = String(collectEditFirst(schema.name, schema.attribute_name, schema.attributeName, schema.title, schema.key) || "")
    .trim()
    .toLowerCase();
  const translatedLabel = String(label || collectEditSchemaLabel(schema)).trim();
  return translatedLabel === "品牌" || rawLabel === "brand" || rawLabel === "бренд";
};

const collectEditDictionaryValueText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    return collectEditFirst(
      value.value,
      value.name,
      value.title,
      value.label,
      value.text,
      value.display_value,
      value.displayValue,
      value.id,
      value.dictionary_value_id,
      value.dictionaryValueId,
    );
  }
  return collectEditText(value);
};

const collectEditNormalizeDictionaryText = (value) =>
  collectEditDictionaryValueText(value)
    .replace(/\s+/g, " ")
    .replace(/[()（）]/g, "")
    .replace(/ё/g, "е")
    .trim()
    .toLowerCase();

const COLLECT_EDIT_NO_BRAND_VALUE = "Нет бренда";

const collectEditDictionaryAliasGroups = [
  [COLLECT_EDIT_NO_BRAND_VALUE, "无品牌", "нет бренда", "без бренда", "no brand", "no-name", "not brand", "без торговой марки"],
  ["中国", "китай", "china"],
  ["俄罗斯", "россия", "russia"],
  ["白俄罗斯", "беларусь", "belarus"],
  ["土耳其", "турция", "turkey"],
  ["意大利", "италия", "italy"],
  ["德国", "германия", "germany"],
  ["法国", "франция", "france"],
  ["西班牙", "испания", "spain"],
  ["波兰", "польша", "poland"],
  ["越南", "вьетнам", "vietnam"],
  ["韩国", "корея", "южная корея", "korea"],
  ["未注明", "не указана", "не указан", "не указано"],
  ["是", "да", "yes", "true"],
  ["否", "нет", "no", "false"],
  ["开启", "включение", "включить"],
  ["关闭", "выключение", "выключить"],
  ["黑色", "черный", "чёрный", "black"],
  ["红色", "красный", "red"],
  ["橙色", "оранжевый", "orange"],
  ["黄色", "желтый", "жёлтый", "yellow"],
  ["绿色", "зеленый", "зелёный", "green"],
  ["蓝色", "синий", "голубой", "blue"],
  ["紫色", "фиолетовый", "purple"],
  ["粉色", "розовый", "pink"],
  ["米色", "бежевый", "beige"],
  ["灰色", "серый", "gray", "grey"],
  ["银色", "серебристый", "silver"],
  ["金色", "золотой", "gold"],
  ["棕色", "коричневый", "brown"],
  ["白色", "белый", "white"],
  ["暖白", "теплый белый", "тёплый белый", "warm white"],
  ["冷白", "холодный белый", "cool white", "cold white"],
  ["中性白", "нейтральный белый"],
  ["紫外线", "ультрафиолетовый", "ultraviolet"],
  ["红外线", "инфракрасный", "infrared"],
  ["LED", "светодиодная", "светодиодный", "светодиодное"],
  ["LED灯", "led лампа", "светодиодная лампа"],
  ["卤素", "галогенная", "галогенный", "галогенное"],
  ["荧光", "люминесцентная", "люминесцентный", "люминесцентное"],
  ["白炽灯", "лампа накаливания"],
  ["荧光灯（节能）", "люминесцентная (энергосберегающая)", "люминесцентный (энергосберегающий)", "энергосберегающая"],
  ["氙气灯（HID）", "ксенон (hid)", "ксеноновая"],
  ["暖光", "теплый свет", "тёплый свет"],
  ["冷光", "холодный свет"],
  ["自然光", "естественный свет"],
  ["日光白", "дневной белый"],
  ["白天光", "дневной свет"],
  ["自动开启", "автоматическое включение"],
  ["自动关闭", "автоматическое выключение"],
  ["星空投影仪", "астропланетарий", "планетарий"],
  ["夜灯", "ночник"],
  ["射灯", "спот", "точечный светильник"],
  ["筒灯", "даунлайт"],
  ["壁灯", "настенный светильник", "бра"],
  ["户外灯", "уличный светильник"],
  ["吊灯", "люстра"],
  ["台灯", "настольная лампа"],
  ["落地灯", "торшер"],
  ["安装支架", "монтажная скоба"],
  ["吸顶灯", "потолочный светильник"],
  ["室内镜", "зеркало интерьерное"],
  ["壁挂镜", "зеркало настенное"],
  ["带灯镜", "зеркало с подсветкой"],
  ["单面", "одностороннее", "односторонний", "односторонняя"],
  ["双面", "двустороннее", "двусторонний", "двусторонняя"],
  ["矩形", "прямоугольное", "прямоугольный", "прямоугольная"],
  ["圆形", "круглое", "круглый", "круглая", "круг"],
  ["方形", "квадратное", "квадратный", "квадратная", "квадрат"],
  ["椭圆形", "овальное", "овальный", "овальная"],
  ["拱形", "арочное", "арочный", "арочная"],
  ["纸箱", "картонная коробка"],
  ["纸质包装", "бумажная обертка", "бумажная обёртка"],
  ["塑料袋", "пластиковый пакет", "полиэтиленовый пакет"],
  ["桶装", "ведерко", "ведёрко"],
  ["吸塑包装", "блистер"],
  ["气泡膜", "пупырчатая пленка", "воздушно-пузырчатая пленка"],
  ["泡沫包装", "пенопласт"],
  ["套装", "набор", "комплект"],
  ["灯体、光源、安装配件", "корпус лампы, источник света, установка"],
  ["灯体", "корпус лампы"],
  ["光源", "источник света"],
  ["安装配件", "установка"],
  ["墙面安装", "настенное крепление", "настенный монтаж"],
  ["吊装", "подвесной монтаж"],
  ["嵌入式安装", "встраиваемый монтаж"],
  ["真空吸盘式", "на вакуумной присоске"],
  ["支架式", "в стойку"],
  ["遥控器", "пульт ду"],
  ["遥控", "дистанционное управление"],
  ["触控", "сенсорное управление"],
  ["触控开关", "сенсорный выключатель", "сенсорная кнопка"],
  ["机身开关", "выключатель на корпусе"],
  ["按键开关", "кнопочный выключатель"],
  ["调光器", "диммер"],
  ["工厂生产", "фабричное производство"],
  ["手工制作", "ручная работа"],
  ["手工原创", "ручная, авторская работа", "авторская работа"],
  ["混合生产", "смешанное производство"],
  ["无防护", "без защиты"],
  ["防潮", "влагозащита", "влагозащищенный", "влагозащищенная"],
  ["防尘", "пылезащита"],
  ["可低温工作", "работа при минусовых температурах", "работа при низких температурах"],
  ["防水", "водозащита", "водонепроницаемый", "водонепроницаемая"],
  ["防溅水", "защита от брызг"],
  ["运动传感器", "датчик движения"],
  ["光传感器", "датчик освещенности"],
  ["内置电池", "встроенный аккумулятор"],
  ["原装电池", "оригинальный аккумулятор"],
  ["电池供电", "питание от батареек"],
  ["USB供电", "питание от usb", "usb"],
  ["220V电源", "220 в", "220v"],
  ["哑光", "матовый", "матовая", "матовое"],
  ["亮面", "глянцевый", "глянцевая", "глянцевое"],
  ["镜面", "зеркальный", "зеркальная", "зеркальное"],
  ["透明", "прозрачный", "прозрачная", "прозрачное"],
  ["塑料", "пластик"],
  ["金属", "металл"],
  ["玻璃", "стекло"],
  ["铝", "алюминий"],
  ["钢", "сталь"],
  ["不锈钢", "нержавеющая сталь"],
  ["木材", "дерево"],
  ["陶瓷", "керамика"],
  ["橡胶", "резина"],
  ["硅胶", "силикон"],
  ["亚克力", "акрил"],
  ["复古", "ретро"],
  ["现代", "современный", "современная", "современное"],
  ["极简", "минимализм"],
  ["经典", "классический", "классическая", "классическое"],
  ["Rubetek（品牌）", "rubetek"],
  ["12个月", "12 месяцев"],
  ["1年", "1 год"],
  ["2年", "2 года"],
  ["3年", "3 года"],
];

const collectEditDictionaryTranslations = new Map(
  collectEditDictionaryAliasGroups.flatMap((group) => {
    const zh = group.find((item) => /[\u4E00-\u9FFF]/.test(item)) || group[0];
    return group.map((item) => [collectEditNormalizeDictionaryText(item), zh]);
  }),
);

const collectEditDictionaryValueAliases = (value) => {
  const normalized = collectEditNormalizeDictionaryText(value);
  const aliases = new Set(normalized ? [normalized] : []);
  for (const group of collectEditDictionaryAliasGroups) {
    const normalizedGroup = group.map(collectEditNormalizeDictionaryText).filter(Boolean);
    if (normalizedGroup.includes(normalized)) {
      normalizedGroup.forEach((item) => aliases.add(item));
    }
  }
  return aliases;
};

const collectEditDictionaryExactTranslation = (value) => {
  const normalized = collectEditNormalizeDictionaryText(value);
  return collectEditDictionaryTranslations.get(normalized) || "";
};

const collectEditDictionaryPartialTranslation = (value) => {
  const normalized = collectEditNormalizeDictionaryText(value);
  if (!normalized) return "";
  const candidates = [...collectEditDictionaryTranslations.entries()]
    .filter(([source]) => source && source.length >= 4 && !["true", "false", "нет", "yes"].includes(source))
    .sort((a, b) => b[0].length - a[0].length);
  const found = candidates.find(([source]) => normalized.includes(source));
  return found ? found[1] : "";
};

const collectEditTranslateDictionaryValue = (value) => {
  const text = collectEditDictionaryValueText(value);
  if (collectEditDictionaryValueAliases(text).has("нет бренда")) return COLLECT_EDIT_NO_BRAND_VALUE;
  const exact = collectEditDictionaryExactTranslation(text);
  if (exact) return exact;
  const parts = text
    .split(/\s*[,;/|，、]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    let changed = false;
    const translated = parts.map((part) => {
      const partTranslation = collectEditDictionaryExactTranslation(part);
      if (partTranslation) {
        changed = true;
        return partTranslation;
      }
      return part;
    });
    if (changed) return translated.join("、");
  }
  const partial = collectEditDictionaryPartialTranslation(text);
  if (partial) return partial;
  return text;
};

const collectEditFormatDictionaryOption = (item = {}) => {
  const value = collectEditDictionaryValueText(item);
  if (!value) return null;
  const rawLabel = collectEditFirst(item?.value, item?.name, item?.title, item?.label, value);
  return {
    value: String(value),
    label: String(collectEditTranslateDictionaryValue(rawLabel || value)),
    rawLabel: String(rawLabel || value),
    searchText: [value, rawLabel, collectEditTranslateDictionaryValue(rawLabel || value)]
      .map(collectEditDictionaryValueText)
      .filter(Boolean)
      .join(" "),
    dictionaryValueId: collectEditFirst(item?.id, item?.dictionary_value_id, item?.dictionaryValueId),
  };
};

const collectEditRenderDictionaryOption = (option) => {
  const data = option?.data || option || {};
  const raw = collectEditFirst(data.rawLabel, data.value, data.label);
  const text = collectEditDictionaryValueText(raw);
  if (data.syntheticNoBrand) {
    return (
      <span className="collect-edit-dictionary-option" title="Нет бренда">
        Нет бренда
      </span>
    );
  }
  const translated = collectEditTranslateDictionaryValue(text);
  return (
    <span className="collect-edit-dictionary-option" title={text && translated !== text ? text : undefined}>
      {translated || text}
    </span>
  );
};

const collectEditSchemaOptions = (schema = {}) => {
  const source = [
    schema.values,
    schema.options,
    schema.dictionary_values,
    schema.dictionaryValues,
    schema.allowed_values,
    schema.allowedValues,
  ].find((candidate) => Array.isArray(candidate));
  if (!Array.isArray(source)) return [];
  return source
    .map(collectEditFormatDictionaryOption)
    .filter(Boolean);
};

const collectEditSchemaIsMultiple = (schema = {}) => {
  const type = String(collectEditFirst(schema.type, schema.attribute_type, schema.attributeType) || "").toLowerCase();
  return schema.is_collection === true ||
    schema.isCollection === true ||
    schema.collection === true ||
    schema.multiple === true ||
    ["collection", "multiselect", "multi_select", "multi-select"].includes(type);
};

const collectEditSchemaControlType = (schema = {}, options = []) => {
  const type = String(collectEditFirst(schema.type, schema.attribute_type, schema.attributeType) || "").toLowerCase();
  const dictionaryId = Number(collectEditFirst(schema.dictionary_id, schema.dictionaryId) || 0);
  if (dictionaryId > 0 || options.length || ["select", "enum", "dictionary", "multiselect", "multi_select", "multi-select"].includes(type)) {
    return "select";
  }
  if (["integer", "decimal", "float", "number"].includes(type)) return "number";
  return "text";
};

const collectEditAttributeSubmitValues = (row = {}, rawValue) => {
  const resolvedValue = row.controlType === "select"
    ? collectEditResolveSelectControlValue(rawValue, row)
    : rawValue;
  const list = Array.isArray(resolvedValue)
    ? resolvedValue.map((item) => collectEditDictionaryValueText(item)).filter(Boolean)
    : String(resolvedValue || "")
      .split(row.multiple ? /[、,;；|]/ : /\u0000/)
      .map((item) => item.trim())
      .filter(Boolean);
  return list.map((value) => {
    const submitValue = collectEditSchemaIsBrand(row, row.label) && collectEditDictionaryValueAliases(value).has("нет бренда")
      ? COLLECT_EDIT_NO_BRAND_VALUE
      : value;
    const option = collectEditFindDictionaryOption(row, submitValue);
    const dictionaryValueId = collectEditFirst(option?.dictionaryValueId, option?.id);
    return {
      value: String(submitValue),
      ...(dictionaryValueId ? { dictionary_value_id: Number(dictionaryValueId) || dictionaryValueId } : {}),
    };
  });
};

const collectEditSelectValues = (value, multiple = false) => {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value]
    : String(value || "")
      .split(multiple ? /[、,;；|]/ : /\u0000/);
  return list
    .map((item) => collectEditDictionaryValueText(item))
    .filter(Boolean);
};

const collectEditFindDictionaryOption = (row = {}, value) => {
  const options = Array.isArray(row.options) ? row.options : [];
  if (!options.length) return null;
  const rawValue = collectEditDictionaryValueText(value);
  const valueAliases = collectEditDictionaryValueAliases(rawValue);
  for (const option of options) {
    const candidateTexts = [
      option?.value,
      option?.label,
      option?.rawLabel,
      option?.id,
      option?.dictionaryValueId,
    ];
    if (candidateTexts.some((item) => valueAliases.has(collectEditNormalizeDictionaryText(item)))) {
      return option;
    }
  }
  return null;
};

const collectEditDefaultBrandAttributeValue = (options = []) => {
  const noBrandOption = collectEditFindDictionaryOption({ options }, COLLECT_EDIT_NO_BRAND_VALUE) ||
    collectEditFindDictionaryOption({ options }, "без бренда") ||
    collectEditFindDictionaryOption({ options }, "无品牌") ||
    collectEditFindDictionaryOption({ options }, "no brand");
  if (noBrandOption?.value) return COLLECT_EDIT_NO_BRAND_VALUE;
  return COLLECT_EDIT_NO_BRAND_VALUE;
};

const collectEditNoBrandOption = () => ({
  value: COLLECT_EDIT_NO_BRAND_VALUE,
  label: COLLECT_EDIT_NO_BRAND_VALUE,
  rawLabel: COLLECT_EDIT_NO_BRAND_VALUE,
  searchText: "Нет бренда без бренда нет бренда 无品牌 no brand",
  dictionaryValueId: "",
  syntheticNoBrand: true,
});

const collectEditEnsureBrandOptions = (options = []) => {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  if (collectEditFindDictionaryOption({ options: list }, COLLECT_EDIT_NO_BRAND_VALUE)) return list;
  return [collectEditNoBrandOption(), ...list];
};

const collectEditResolveSelectControlValue = (value, row = {}) => {
  const values = collectEditSelectValues(value, row.multiple);
  const isBrandRow = collectEditSchemaIsBrand(row, row.label);
  const resolved = [];
  const seen = new Set();
  for (const item of values) {
    const option = collectEditFindDictionaryOption(row, item);
    const itemIsNoBrand = isBrandRow && collectEditDictionaryValueAliases(item).has("нет бренда");
    const nextValue = itemIsNoBrand
      ? COLLECT_EDIT_NO_BRAND_VALUE
      : collectEditDictionaryValueText(option?.value || item);
    if (!nextValue || seen.has(nextValue)) continue;
    seen.add(nextValue);
    resolved.push(nextValue);
  }
  if (row.multiple) return resolved;
  return resolved[0] || undefined;
};

const collectEditSelectControlValue = (value, row = {}) => {
  return collectEditResolveSelectControlValue(value, row);
};

const collectEditRequiredValueFilled = (value, row = null) => {
  if (row?.controlType === "select") {
    const values = collectEditSelectValues(value, row.multiple);
    if (!values.length) return false;
    if (collectEditSchemaIsBrand(row, row.label) && values.some((item) => collectEditDictionaryValueAliases(item).has("нет бренда"))) {
      return true;
    }
    if (Array.isArray(row.options) && row.options.length) {
      return values.some((item) => !!collectEditFindDictionaryOption(row, item));
    }
    return values.some((item) => collectEditDictionaryValueText(item) !== "");
  }
  if (Array.isArray(value)) {
    return value.some((item) => collectEditDictionaryValueText(item) !== "");
  }
  return collectEditText(value) !== "";
};

const collectEditTranslateAttributeDescription = (description = "", label = "", id = "") => {
  const text = String(description || "").trim();
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const exact = {
    "значение выбирается из справочника": "该属性需要从 Ozon 字典中选择。",
    "заполните значение из справочника": "请从 Ozon 字典中选择该属性值。",
    "обязательный атрибут": "该属性为当前类目的必填项。",
    "необязательный атрибут": "该属性为当前类目的可选项。",
  };
  if (exact[normalized]) return exact[normalized];
  if (/[\u0400-\u04FF]/.test(text)) {
    const name = label || (id ? `属性 ${id}` : "该属性");
    return `${name} 是 Ozon 当前类目返回的属性，请按采集商品的真实信息填写。`;
  }
  return text;
};

const collectEditAttributeEvidenceMap = (rows = []) => {
  const map = new Map();
  for (const row of rows) {
    const id = collectEditFirst(row.id);
    if (!id) continue;
    const key = String(id);
    const existing = map.get(key);
    if (existing) {
      existing.dictionaryIds = [...new Set([
        ...(existing.dictionaryIds || []),
        ...(Array.isArray(row.dictionaryIds) ? row.dictionaryIds : []),
      ])];
      continue;
    }
    map.set(key, {
      value: row.rawValue || row.value || "",
      dictionaryIds: Array.isArray(row.dictionaryIds) ? [...row.dictionaryIds] : [],
    });
  }
  return map;
};

const collectEditTags = (item = {}, title = "") => {
  const parts = [
    item.brand,
    item.category,
    item.category_name,
    item.type_name,
    title,
  ].flatMap((value) => collectEditText(value).split(/[\s,.;:;|\/\\()[\]{}"'«»]+/));
  const seen = new Set();
  return parts
    .map((value) => value.replace(/^#+/, "").trim())
    .filter((value) => value.length >= 3)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
};

const collectEditRichContent = (title = "", images = []) => {
  if (!images.length) return "";
  return JSON.stringify(
    {
      widgetName: "raShowcase",
      type: "roll",
      blocks: images.slice(0, 6).map((url, index) => ({
        img: { src: url },
        ...(index === 0 && title ? { title: { content: title } } : {}),
      })),
    },
    null,
    2,
  );
};

const collectEditSanitizedHashtags = (tags = []) => {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const parts = collectEditText(raw)
      .replace(/#/g, " #")
      .split(/[\s,，;；、]+/u)
      .map((part) => part.replace(/^#+/u, "").replace(/[^\p{L}\p{N}_]+/gu, "").trim())
      .filter(Boolean);
    for (const part of parts) {
      const tag = `#${part.slice(0, 29)}`;
      const key = tag.toLocaleLowerCase("ru-RU");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= 30) return out;
    }
  }
  return out;
};

const collectEditRichContentLooksValid = (value = "") => {
  let parsed = null;
  try {
    parsed = JSON.parse(String(value || ""));
  } catch {
    return false;
  }
  const widgets = Array.isArray(parsed?.content) ? parsed.content : [parsed];
  return widgets.some((widget) =>
    collectEditText(widget?.widgetName) &&
    collectEditText(widget?.type) &&
    Array.isArray(widget?.blocks) &&
    widget.blocks.some((block) => block && typeof block === "object" && Object.keys(block).length),
  );
};

const collectEditContentRating = ({
  title = "",
  description = "",
  richContent = "",
  tags = [],
  images = [],
  categoryMatched = false,
  requiredAttributesReady = false,
  filledCategoryAttributeCount = 0,
  totalCategoryAttributeCount = 0,
  variantReady = false,
  packageReady = false,
} = {}) => {
  const missing = [];
  let score = 0;
  const add = (ok, weight, label) => {
    if (ok) score += weight;
    else missing.push(label);
  };
  const cleanTitle = collectEditText(title);
  const cleanDescription = collectEditText(description);
  const safeTags = collectEditSanitizedHashtags(tags);
  const imageCount = Array.isArray(images) ? images.filter(Boolean).length : 0;
  const imageScore = imageCount >= 6 ? 15 : imageCount >= 3 ? 12 : imageCount ? 6 : 0;
  if (imageScore) score += imageScore;
  if (imageCount < 3) missing.push("至少 3 张商品图片");
  const attributeCoverage = totalCategoryAttributeCount
    ? filledCategoryAttributeCount / totalCategoryAttributeCount
    : 0;

  add(cleanTitle.length >= 20 && cleanTitle.length <= 200, 10, "标题长度建议 20-200 字符");
  add(cleanDescription.length >= 80, 15, "商品描述至少 80 字符");
  add(collectEditRichContentLooksValid(richContent), 10, "富内容 JSON 需要符合 Ozon 模板");
  add(safeTags.length > 0 && safeTags.length <= 30, 5, "主题标签 1-30 个且格式合规");
  add(categoryMatched, 10, "产品类目已匹配");
  add(requiredAttributesReady, 15, "必填类目属性已填写");
  add(totalCategoryAttributeCount > 0 && attributeCoverage >= 0.6, 10, "类目属性填写覆盖率不低于 60%");
  add(variantReady, 5, "变体 SKU、名称和售价完整");
  add(packageReady, 5, "物流重量和尺寸完整");

  return {
    score: Math.max(0, Math.min(100, score)),
    missing,
    sanitizedTagCount: safeTags.length,
    alertType: score >= 85 ? "success" : score >= 60 ? "warning" : "info",
  };
};

export const collectEditVariantRows = ({
  item = {},
  sku = "",
  title = "",
  price = "",
  images = [],
  offerPrefix = "jz-",
  targetStoreId = "",
  taxonomyScope = "OZON:DEFAULT",
}) => {
  const sourceRows = collectEditVariantSourceRows(item);
  const rows = sourceRows.length ? sourceRows : [item];
  return rows.map((variant, index) => {
    const aspectName = collectEditAspectName(variant);
    const commercialFields = normalizeCollectEditVariantRow({
      variant,
      index,
      rowCount: rows.length,
      fallbackSku: sku,
      fallbackTitle: title,
      fallbackPrice: price,
      offerPrefix,
      aspectName,
    });
    const rowSku = commercialFields.sku;
    const sourceVariant = collectEditVariantSourceSnapshot(item, variant, rowSku);
    const rowImages = collectEditImages({ ...sourceVariant, ...variant }, images[index] || images[0] || "");
    const targetResolution = categoryResolutionForCollectionTarget(item, {
      targetStoreId,
      taxonomyScope,
      legacyResolution: variant.categoryResolution || item.listingDraft?.categoryResolution,
    });
    const targetFields = listingTargetCategoryFieldsForStore(
      targetResolution,
      targetStoreId,
    );
    return {
      key: `${rowSku || sku || "sku"}-${index}`,
      index: index + 1,
      image: rowImages[0] || images[0] || "",
      images: rowImages,
      cover: rowImages[1] || rowImages[0] || images[0] || "",
      video: collectEditFirst(variant.video, variant.videoUrl, variant.video_url),
      sku: commercialFields.sku,
      offerId: commercialFields.offerId,
      name: commercialFields.name,
      purchasePrice: collectEditFirst(variant.purchase_price, variant.cost_price),
      sellPrice: commercialFields.sellPrice,
      oldPrice: commercialFields.oldPrice,
      stock: commercialFields.stock,
      sourceVariant,
      description: collectEditFirst(variant.description, sourceVariant.description, sourceVariantText(sourceVariant, 4191)),
      richContent: collectEditFirst(variant.richContent, variant.rich_content, sourceVariant.richContent, sourceVariantText(sourceVariant, 11254)),
      barcode: collectEditFirst(variant.barcode, sourceVariant.barcode, sourceVariantText(sourceVariant, 7822)),
      sourceCategory: sourceCategoryEvidenceOf({ _sourceVariant: sourceVariant }),
      ...(targetResolution ? { categoryResolution: targetResolution } : {}),
      descriptionCategoryId: targetFields.descriptionCategoryId || "",
      typeId: targetFields.typeId || "",
      categoryAttributes: Array.isArray(variant.categoryAttributes) ? variant.categoryAttributes : undefined,
      packageWeight: collectEditFirst(variant.packageWeight, variant.weight, sourceVariantText(sourceVariant, 4497)),
      packageLength: collectEditFirst(variant.packageLength, variant.depth, sourceVariantText(sourceVariant, 9454)),
      packageWidth: collectEditFirst(variant.packageWidth, variant.width, sourceVariantText(sourceVariant, 9455)),
      packageHeight: collectEditFirst(variant.packageHeight, variant.height, sourceVariantText(sourceVariant, 9456)),
      bundleComplexAttrs: variant.bundleComplexAttrs || sourceVariant._bundleComplexAttrs || undefined,
    };
  });
};

export const collectEditCategoryPreviewSeed = ({
  item = {},
  targetStoreId = "",
  taxonomyScope = "OZON:DEFAULT",
  collectCandidate = false,
} = {}) => {
  const draft = item?.listingDraft || {};
  const categoryResolution = categoryResolutionForCollectionTarget(item, {
    targetStoreId,
    taxonomyScope,
  });
  const categoryFields = listingTargetCategoryFieldsForStore(
    categoryResolution,
    targetStoreId,
  );
  return {
    categoryResolution,
    descriptionCategoryId: collectEditFirst(
      categoryFields.descriptionCategoryId,
      collectCandidate ? "" : draft.descriptionCategoryId,
      collectCandidate ? "" : draft.description_category_id,
      collectCandidate ? "" : item.description_category_id,
      collectCandidate ? "" : item.descriptionCategoryId,
    ),
    typeId: collectEditFirst(
      categoryFields.typeId,
      collectCandidate ? "" : draft.typeId,
      collectCandidate ? "" : draft.type_id,
      collectCandidate ? "" : item.type_id,
      collectCandidate ? "" : item.typeId,
    ),
  };
};

function CollectEditPage({ binding, hasStore, localData, onBind, onRefresh, navigate }) {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [listingResult, setListingResult] = useState(null);
  const [sku, setSku] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [currencyCode, setCurrencyCode] = useState("CNY");
  const [image, setImage] = useState("");
  const [brand, setBrand] = useState("");
  const [modelName, setModelName] = useState("");
  const [offerPrefix, setOfferPrefix] = useState("jz-");
  const [description, setDescription] = useState("");
  const [descriptionMode, setDescriptionMode] = useState("编辑");
  const [tags, setTags] = useState([]);
  const [richContent, setRichContent] = useState("");
  const [packageWeight, setPackageWeight] = useState("");
  const [packageLength, setPackageLength] = useState("");
  const [packageWidth, setPackageWidth] = useState("");
  const [packageHeight, setPackageHeight] = useState("");
  const [listingWarehouseId, setListingWarehouseId] = useState("");
  const [listingStock, setListingStock] = useState("5");
  const [targetStoreId, setTargetStoreId] = useState(() => String(localStorage.getItem("currentOzonStoreId") || binding?.id || localData?.currentStoreId || ""));
  const [sourceLink, setSourceLink] = useState("");
  const [note, setNote] = useState("");
  const [variantRows, setVariantRows] = useState([]);
  const [selectedVariantKeys, setSelectedVariantKeys] = useState([]);
  const [previewItem, setPreviewItem] = useState(null);
  const [categoryAutoError, setCategoryAutoError] = useState("");
  const [categorySchema, setCategorySchema] = useState([]);
  const [categorySchemaLoading, setCategorySchemaLoading] = useState(false);
  const [categorySchemaError, setCategorySchemaError] = useState("");
  const [categoryAttributeValues, setCategoryAttributeValues] = useState({});
  const [enrichmentRetrying, setEnrichmentRetrying] = useState(false);
  const [enrichmentRetryOverride, setEnrichmentRetryOverride] = useState(null);
  const categoryAutoPreviewKeyRef = useRef("");
  const collectEditInitScopeRef = useRef("");
  const collectEditDimensionDirtyRef = useRef(new Set());
  const collectEditActiveItemIdRef = useRef("");
  const collectEditEnrichmentGenerationRef = useRef(0);
  const listingSubmissionIntentRef = useRef(null);
  const params = new URLSearchParams(window.location.search);
  const itemId = params.get("id") || "";
  const currentStoreId = localStorage.getItem("currentOzonStoreId") || binding?.id || localData?.currentStoreId || "";
  const { stores: targetStores, options: targetStoreOptions, selectedStoreId } = targetStoreSelection(localData, currentStoreId, targetStoreId);
  React.useEffect(function() {
    if (selectedStoreId !== targetStoreId) setTargetStoreId(selectedStoreId);
  }, [targetStoreId, selectedStoreId]);
  const collectItems = localData?.caches?.collectBox || [];
  const productItems = localData?.caches?.products || [];
  const collectCandidate = collectItems.find(function(i) {
    return String(i.id) === String(itemId) || String(i.sku) === String(itemId);
  });
  const productCandidate = productItems.find(function(i) {
    return [i.id, i.product_id, i.offer_id, i.sku].some(function(value) {
      return String(value || "") === String(itemId);
    });
  });
  const candidateItem = collectCandidate || productCandidate;
  const candidateStoreId = collectEditFirst(
    candidateItem?.storeId,
    candidateItem?.store_id,
    candidateItem?.ozonStoreId,
    candidateItem?.ozon_store_id,
    candidateItem?.bindingId,
    candidateItem?.binding_id,
  );
  const itemScopeCurrent = Boolean(collectCandidate) || categoryItemScopeIsCurrent({
    currentStoreId,
    localStateStoreId: localData?.currentStoreId,
    itemStoreId: candidateStoreId,
  });
  const item = itemScopeCurrent ? candidateItem : null;
  collectEditActiveItemIdRef.current = itemScopeCurrent
    ? collectEditFirst(candidateItem?.id, candidateItem?.collectItemId)
    : "";
  const scopedPreviewItem = itemScopeCurrent ? previewItem : null;
  const effectiveEnrichment = collectEnrichmentEffectiveSummary(item, enrichmentRetryOverride);
  const enrichmentView = collectEnrichmentView(effectiveEnrichment);
  const enrichmentPollStatus = String(effectiveEnrichment?.status || "");
  React.useEffect(function() {
    if (enrichmentRetryOverride && enrichmentRetryOverride.baseItem !== item) {
      setEnrichmentRetryOverride(null);
    }
  }, [item, enrichmentRetryOverride]);
  React.useEffect(function() {
    if (
      typeof onRefresh !== "function"
      || !collectEnrichmentNeedsPolling(effectiveEnrichment)
    ) return undefined;
    return startCollectEnrichmentPolling({
      refresh: () => onRefresh({ silent: true, source: "collect-edit-poll" }),
      setIntervalFn: window.setInterval.bind(window),
      clearIntervalFn: window.clearInterval.bind(window),
    });
  }, [itemId, enrichmentPollStatus, onRefresh]);
  const retryCollectEnrichment = async function() {
    if (!item?.id || !enrichmentView.retryable || enrichmentRetrying) return;
    setEnrichmentRetrying(true);
    message.loading({ content: "正在重新提交资料补全…", key: "collect-edit-enrichment", duration: 0 });
    try {
      const sourceItem = item;
      const { notice } = await runCollectEnrichmentRetry({
        item: sourceItem,
        request: apiRequest,
        applyOverride: setEnrichmentRetryOverride,
        refresh: onRefresh,
        refreshSource: "collect-edit-retry",
      });
      message[notice.type]({ content: notice.content, key: "collect-edit-enrichment" });
    } catch (error) {
      message.error({ content: `重新补全失败: ${error?.message || error}`, key: "collect-edit-enrichment" });
    } finally {
      setEnrichmentRetrying(false);
    }
  };
  const preparationModel = listingPreparationModel({ localData, targetStoreId: selectedStoreId, collectItem: item });
  const categoryStoreId = preparationModel.categoryStoreId;
  React.useEffect(function() { if (listingSubmissionIntentRef.current && listingSubmissionIntentRef.current.collectItemId !== itemId) listingSubmissionIntentRef.current = listingSubmissionIntent(listingSubmissionIntentRef.current, { collectItemId: itemId, targetStoreId: listingSubmissionIntentRef.current.targetStoreId }); }, [itemId]);
  const selectListingTarget = (value) => {
    const next = String(value || "");
    if (listingSubmissionIntentRef.current) listingSubmissionIntentRef.current = listingSubmissionIntent(listingSubmissionIntentRef.current, { collectItemId: itemId, targetStoreId: next });
    setPreviewItem(null);
    setCategoryAutoError("");
    categoryAutoPreviewKeyRef.current = "";
    setTargetStoreId(next);
  };
  const storeCurrencyCode = preparationModel.currencyCode;
  const readCategoryTree = React.useCallback((language) => apiRequest(`/ozon/categories/tree?language=${encodeURIComponent(language)}`, {
    headers: { "x-ozon-store-id": categoryStoreId },
  }), [categoryStoreId]);
  const categoryTree = useCategoryTreeReadiness({ hasStore: Boolean(categoryStoreId), currentStoreId: categoryStoreId, itemId, readTree: readCategoryTree });
  const { scopedTrees, categoryTreeLoading, categoryDataError, categoryTreeReady, loadCategoryTrees,
    categoryAutoLoading, beginCategoryAutoRequest, categoryAutoRequestIsCurrent, finishCategoryAutoRequest } = categoryTree;
  const listingWarehouseOptions = preparationModel.warehouses
    .filter(warehouseIsActive)
    .filter(warehouseIsWritableFbs)
    .map((warehouse) => {
      const id = warehouse.id || warehouse.warehouse_id || warehouse.warehouseId;
      if (!id) return null;
      return {
        value: String(id),
        label: warehouseDisplayName(warehouse) || String(id),
      };
    })
    .filter(Boolean)
    .filter((option, index, options) => options.findIndex((item) => item.value === option.value) === index);
  const listingWarehouseOptionKey = listingWarehouseOptions.map((option) => option.value).join("|");

  React.useEffect(function() {
    if (item) {
      const draft = item.listingDraft || {};
      const itemScope = [
        categoryStoreId,
        itemId,
        collectEditFirst(item.id, item.sku, item.product_id, item.offer_id),
      ].join("|");
      if (collectEditInitScopeRef.current === itemScope) return;
      collectEditInitScopeRef.current = itemScope;
      collectEditDimensionDirtyRef.current = new Set();
      const categorySeed = collectEditCategoryPreviewSeed({
        item,
        targetStoreId: categoryStoreId,
        collectCandidate: Boolean(collectCandidate),
      });
      const storedCategoryResolution = categorySeed.categoryResolution;
      const seededDescriptionCategoryId = categorySeed.descriptionCategoryId;
      const seededTypeId = categorySeed.typeId;
      setPreviewItem(storedCategoryResolution || (seededDescriptionCategoryId && seededTypeId) ? {
        description_category_id: seededDescriptionCategoryId || "",
        type_id: seededTypeId || "",
        ...(storedCategoryResolution ? { categoryResolution: storedCategoryResolution } : {}),
        categoryPath: collectEditFirst(draft.categoryPath, item.categoryPath, item.category_path, item.category, item.category_name, item.type_name),
      } : null);
      setCategoryAutoError("");
      setCategorySchema([]);
      setCategorySchemaError("");
      setCategoryAttributeValues({});
      categoryAutoPreviewKeyRef.current = "";
      const nextSku = String(draft.sku || item.sku || item.product_id || item.offer_id || item.id || "");
      const nextTitle = collectEditFirst(draft.title, item.name, item.title, item.offer_id);
      const nextPrice = collectEditFirst(draft.price, item.price?.price, item.price, item.priceText, item.marketing_price);
      const nextCurrency = collectEditFirst(storeCurrencyCode, draft.currencyCode, item.price?.currency_code, item.priceCurrency, item.currencyCode, item.currency_code, item.currency) || "CNY";
      const nextImages = collectEditImages({ ...item, images: draft.images || item.images }, draft.image || "");
      const nextOfferPrefix = draft.offerPrefix || "jz-";
      const draftVariants = Array.isArray(draft.variants) ? draft.variants : [];
      const variantSourceItem = draftVariants.length
        ? { ...item, variants: draftVariants }
        : item;
      setSku(nextSku);
      setTitle(nextTitle);
      setPrice(nextPrice);
      setCurrencyCode(nextCurrency);
      setImage(nextImages[0] || "");
      setBrand(collectEditFirst(draft.brand, item.brand) || "Нет бренда");
      setModelName(collectEditFirst(draft.modelName, item.modelName, item.model_name, item.offer_id, nextSku));
      setOfferPrefix(nextOfferPrefix);
      setDescription(collectEditFirst(draft.description, item.description, item.desc, item.subtitle, nextTitle));
      setDescriptionMode("编辑");
      setTags(Array.isArray(draft.tags) && draft.tags.length ? draft.tags : collectEditTags(item, nextTitle));
      setRichContent(collectEditFirst(draft.richContent) || collectEditRichContent(nextTitle, nextImages));
      setPackageWeight(collectEditPackageDimension(
        draft.packageWeight,
        item,
        ["weightG", "weight", "package_weight", "weight_g", "scraped_weight"],
        ["4497", "4383"],
        "weight",
      ));
      setPackageLength(collectEditPackageDimension(
        draft.packageLength,
        item,
        ["lengthMm", "depth", "package_length", "length", "depth_mm", "scraped_depth"],
        ["9454", "9802"],
        "dimension",
      ));
      setPackageWidth(collectEditPackageDimension(
        draft.packageWidth,
        item,
        ["widthMm", "width", "package_width", "width_mm", "scraped_width"],
        ["9455", "6605"],
        "dimension",
      ));
      setPackageHeight(collectEditPackageDimension(
        draft.packageHeight,
        item,
        ["heightMm", "height", "package_height", "height_mm", "scraped_height"],
        ["9456", "7703"],
        "dimension",
      ));
      const seededWarehouseId = collectEditFirst(draft.listingWarehouseId, draft.warehouseId, draft.warehouse_id, item.listingWarehouseId, item.warehouse_id, item.warehouseId);
      const hasSeededWarehouse = seededWarehouseId && listingWarehouseOptions.some((option) => option.value === String(seededWarehouseId));
      setListingWarehouseId(hasSeededWarehouse ? String(seededWarehouseId) : listingWarehouseOptions[0]?.value || "");
      setListingStock(collectEditFirst(draft.listingStock, draft.stock, item.listingStock, item.listing_stock, "5"));
      setSourceLink(collectEditFirst(draft.sourceLink) || collectEditSourceUrl(item, nextSku));
      setNote(collectEditFirst(draft.note, item.note, item.remark));
      setVariantRows(collectEditVariantRows({ item: variantSourceItem, sku: nextSku, title: nextTitle, price: nextPrice, images: nextImages, offerPrefix: nextOfferPrefix, targetStoreId: categoryStoreId }));
      setSelectedVariantKeys([]);
    } else {
      setPreviewItem(null);
      setCategoryAutoError("");
      setCategorySchema([]);
      setCategorySchemaError("");
      setCategoryAttributeValues({});
      categoryAutoPreviewKeyRef.current = "";
    }
  }, [itemId, item, itemScopeCurrent, storeCurrencyCode, categoryStoreId, listingWarehouseOptionKey]);

  React.useEffect(function() {
    if (!item || !itemScopeCurrent) return;
    if (!collectEditFirst(item.id, item.collectItemId)) return;
    const generation = collectEditEnrichmentGenerationRef.current + 1;
    collectEditEnrichmentGenerationRef.current = generation;
    const backfill = (field, setValue) => {
      setValue((currentValue) => collectEditEnrichmentBackfill({
        current: { [field]: currentValue },
        item,
        activeItemId: collectEditActiveItemIdRef.current,
        generation,
        latestGeneration: collectEditEnrichmentGenerationRef.current,
        dirtyFields: [...collectEditDimensionDirtyRef.current],
      })[field]);
    };
    backfill("packageWeight", setPackageWeight);
    backfill("packageLength", setPackageLength);
    backfill("packageWidth", setPackageWidth);
    backfill("packageHeight", setPackageHeight);
  }, [itemId, item, itemScopeCurrent]);

  React.useEffect(function() {
    if (!listingWarehouseId && listingWarehouseOptions.length) {
      setListingWarehouseId(listingWarehouseOptions[0].value);
    }
  }, [listingWarehouseId, listingWarehouseOptionKey]);

  const categoryTreeOptionsZh = useMemo(() => collectEditCategoryTreeOptions(scopedTrees.zhTree), [scopedTrees]);
  const categoryTreeOptionsRu = useMemo(() => collectEditCategoryTreeOptions(scopedTrees.ruTree), [scopedTrees]);

  const runListingRequest = async function({ dryRun = false } = {}) {
    if (!itemScopeCurrent) {
      message.error("当前商品店铺数据未就绪，不能预检或上架");
      return;
    }
    if (preparationModel.listingBlocked) {
      message.warning([enrichmentView.label || "资料补全未完成", enrichmentView.detail].filter(Boolean).join("："));
      return;
    }
    try {
      requireCategoryReadiness(categoryReadinessInput);
    } catch (error) {
      message.error(error.message);
      return;
    }
    if (!dryRun && listingRequiredMissingFields.length) {
      message.warning(listingMissingRequiredText);
      return;
    }
    if (!item?.id || !isCollectItem) {
      message.warning("请从采集箱进入商品信息编辑页后再上架");
      return;
    }
    if (!sku) {
      message.warning("请输入 SKU");
      return;
    }
    if (!hasStore) {
      if (!categoryStoreId) { message.warning("请先选择上架店铺"); onBind?.(); return; }
    }
    const numericPrice = numberFromMoney(price);
    if (!numericPrice || numericPrice <= 0) {
      message.warning("请输入有效售价");
      return;
    }
    const storeId = categoryStoreId;
    if (dryRun && !storeId) { message.warning("未找到目标店铺，请重新选择"); onBind?.(); return; }
    if (!dryRun && !targetStores.length) { message.warning("请先启用已保存凭据的经营店铺"); onBind?.(); return; }
    if (!dryRun && !categoryStoreId) { message.warning("请选择目标经营店铺"); onBind?.(); return; }
    const submissionIntent = dryRun ? null : listingSubmissionIntent(listingSubmissionIntentRef.current, { collectItemId: item.id, targetStoreId: categoryStoreId });
    if (submissionIntent) listingSubmissionIntentRef.current = submissionIntent;
    setLoading(true);
    setListingResult({
      status: "pending",
      title: dryRun ? "正在预检上架数据" : "正在提交上架任务",
      detail: dryRun ? "正在保存当前草稿，并用数据库草稿做 Ozon 上架预检。" : `正在保存当前草稿，并冻结目标店铺「${targetStoreOptions.find((option) => option.value === categoryStoreId)?.label || categoryStoreId}」。`,
    });
    message.loading({
      content: dryRun ? "正在保存草稿并预检上架数据…" : "正在保存草稿并提交上架…",
      key: "edit-submit",
      duration: 0,
    });
    try {
      const draftSave = await saveListingDraft({ silent: true, onlyIfChanged: true });
      const targetBody = dryRun ? { storeId } : buildPrepareListingBody({ collectItemId: item.id, targetStoreId: categoryStoreId, requestId: submissionIntent.requestId });
      const result = await apiRequest(`/ozon/collect-box/${encodeURIComponent(item.id)}/listing/${dryRun ? "preview" : "submit"}`, {
        method: "POST",
        body: {
          ...targetBody,
          strictTypeMatch: false,
          entry: dryRun ? "COLLECT_BOX_DRAFT_PREVIEW" : "COLLECT_BOX_DRAFT_SUBMIT",
          retryFailed: !dryRun,
        },
      });
      if (!dryRun && listingSubmissionIntentRef.current?.requestId === submissionIntent.requestId) listingSubmissionIntentRef.current = settleListingSubmissionIntent(submissionIntent, { definitive: true });
      if (dryRun && result?.ok) {
        const preview = result || {};
        const first = Array.isArray(preview.items) ? preview.items[0] : null;
        if (first) setPreviewItem(first);
        const summary = first
          ? `类目 ${first.description_category_id || "—"} / 类型 ${first.type_id || "—"} / 属性 ${first.attributeCount || 0} / 图片 ${first.imageCount || 0}`
          : `共 ${preview.itemCount || 0} 个商品`;
        setListingResult({
          status: "success",
          title: "预检通过",
          detail: summary,
        });
        message.success({ content: `预检通过：${summary}`, key: "edit-submit", duration: 5 });
        return;
      }
      if (result?.ok) {
        await onRefresh?.();
        const taskId = result.task_id || result.result?.task_id || result.job?.taskId || "";
        setListingResult({
          status: "pending",
          title: result.queued ? "已进入正式上架队列" : "Ozon 已受理，等待最终结果",
          detail: taskId
            ? `任务 ID ${taskId}；${draftSave?.unchanged ? "页面未修改，直接使用已有草稿快照" : "已保存修改并生成不可变快照"}。`
            : "上架任务已创建，正在等待 Worker 处理。",
        });
        message.info({ content: result.queued ? "已进入上架队列，最终结果请以上架记录为准" : "Ozon 已受理，最终结果请以上架记录为准", key: "edit-submit" });
        setTimeout(function() { navigate("/ozon/products/import-history"); }, 800);
      } else {
        setListingResult({
          status: "error",
          title: "上架提交失败",
          detail: result?.message || result?.error || "未知错误",
        });
        message.error({ content: "上架提交失败: " + (result?.message || result?.error || "未知错误"), key: "edit-submit" });
      }
    } catch (error) {
      if (!dryRun && listingSubmissionIntentRef.current?.requestId === submissionIntent.requestId) listingSubmissionIntentRef.current = settleListingSubmissionIntent(submissionIntent, { definitive: listingSubmissionErrorIsDefinitive(error) });
      const incompleteSummary = collectEnrichmentErrorSummary(error);
      if (incompleteSummary) {
        const blockedView = collectEnrichmentView(incompleteSummary);
        const detail = blockedView.detail || "资料补全完成后才能预检或上架";
        setListingResult({
          status: "warning",
          title: blockedView.label || "资料补全未完成",
          detail,
        });
        message.warning({ content: detail, key: "edit-submit" });
        try {
          await onRefresh?.({ silent: true });
        } catch {
          // The stable 422 remains visible even if the follow-up refresh fails.
        }
      } else {
        setListingResult({
          status: "error",
          title: dryRun ? "上架预检失败" : "上架失败",
          detail: error?.message || String(error),
        });
        message.error({ content: "上架失败: " + (error?.message || error), key: "edit-submit" });
      }
    } finally {
      setLoading(false);
    }
  };

  const productImageList = collectEditImages(item || {}, image);
  const isCollectItem = Boolean(itemScopeCurrent && item?.id && collectItems.some(function(i) { return String(i.id) === String(item.id); }));
  const runCollectPreview = async function({ silent = false } = {}) {
    if (!item || !itemScopeCurrent) return null;
    if (preparationModel.listingBlocked) {
      if (!silent) {
        message.warning([enrichmentView.label || "资料补全未完成", enrichmentView.detail].filter(Boolean).join("："));
      }
      return null;
    }
    if (!categoryTreeReady || !categoryDictionaryReady) {
      const detail = categoryVisibleError || CATEGORY_DATA_ERROR_MESSAGE;
      setCategoryAutoError(detail);
      if (!silent) message.error(detail);
      return null;
    }
    if (!categoryStoreId) {
      if (!silent) message.warning("请先选择上架店铺");
      return null;
    }
    const numericPrice = numberFromMoney(price);
    if (!sku || !numericPrice || !productImageList.length) {
      const detail = "自动匹配类目需要 SKU、售价和至少 1 张商品图片";
      setCategoryAutoError(detail);
      if (!silent) message.warning(detail);
      return null;
    }
    const request = beginCategoryAutoRequest();
    const requestIsCurrent = () => categoryAutoRequestIsCurrent(request);
    if (!silent) {
      message.loading({ content: "正在根据采集数据自动匹配类目…", key: "collect-category-preview", duration: 0 });
    }
    try {
      const payload = collectEditPreviewPayload({
        item,
        sku,
        title,
        price,
        currencyCode: storeCurrencyCode || currencyCode,
        productImageList,
        variantRows,
        brand,
        modelName,
        offerPrefix,
        description,
        tags,
        richContent,
        packageWeight,
        packageLength,
        packageWidth,
        packageHeight,
        warehouseId: listingWarehouseId,
        stock: listingStock,
        targetStoreId: categoryStoreId,
      });
      const result = await apiRequest("/ozon/products/import/preview", {
        method: "POST",
        body: {
          storeId: categoryStoreId,
          sku,
          strictTypeMatch: false,
          entry: "COLLECT_EDIT_AUTO_CATEGORY",
          items: [payload],
          stocks: payload.stocks || [],
        },
      });
      if (!requestIsCurrent()) return null;
      const first = Array.isArray(result?.items) ? result.items[0] : null;
      if (first) setPreviewItem(first);
      if (!first?.description_category_id || !first?.type_id) {
        const reason = first?.categoryResolution?.reason;
        const detail = reason === "TARGET_TYPE_AMBIGUOUS"
          ? "目标店铺存在多个同名商品类型，请手动选择"
          : reason === "SOURCE_TYPE_MISSING"
            ? "采集来源缺少可核验的商品类型，请手动选择"
            : "目标店铺未找到唯一对应类型，请手动选择";
        setCategoryAutoError(detail);
        if (!silent) message.warning({ content: detail, key: "collect-category-preview", duration: 4 });
        return null;
      }
      setCategoryAutoError("");
      if (!silent) {
        message.success({
          content: `已匹配类目：${first.description_category_id} / ${first.type_id}`,
          key: "collect-category-preview",
          duration: 4,
        });
      }
      return first;
    } catch (error) {
      if (!requestIsCurrent()) return null;
      const detail = error?.message || String(error);
      setCategoryAutoError(detail);
      if (!silent) message.error({ content: "类目匹配失败: " + detail, key: "collect-category-preview", duration: 5 });
      return null;
    } finally {
      finishCategoryAutoRequest(request);
    }
  };

  const handleCategoryPreview = function() {
    runCollectPreview({ silent: false });
  };

  const handlePreview = function() {
    runListingRequest({ dryRun: true });
  };

  const handleSubmit = function() {
    runListingRequest({ dryRun: false });
  };

  const buildListingDraft = function() {
    const sourceCategory = collectEditSourceCategorySnapshot(item);
    const hasSourceCategory = Boolean(
      sourceCategory.descriptionCategoryId
      || sourceCategory.typeName
      || sourceCategory.typeIdCandidate
      || sourceCategory.path.length
      || sourceCategory.attributes.length
    );
    const editedCategoryAttributes = categoryAttributeInputRows.map((row) => {
      const rawValue = categoryAttributeValues[row.key] ?? row.value ?? "";
      const value = row.controlType === "select"
        ? collectEditResolveSelectControlValue(rawValue, row)
        : rawValue;
      return {
        id: row.id,
        name: row.label,
        value,
        values: collectEditAttributeSubmitValues(row, value),
        required: row.required,
        dictionaryId: row.dictionaryId || "",
        multiple: row.multiple,
      };
    });
    const anchorSku = String(sku || "");
    const anchorIndex = Math.max(0, variantRows.findIndex((row) => String(row.sku || "") === anchorSku));
    const draftVariants = variantRows.map((row, index) => {
      const {
        descriptionCategoryId: _historicalDescriptionCategoryId,
        description_category_id: _historicalDescriptionCategoryIdSnake,
        typeId: _historicalTypeId,
        type_id: _historicalTypeIdSnake,
        ...rowWithoutCategoryRoots
      } = row;
      const rowResolution = categoryResolutionForCollectionTarget(item, {
        targetStoreId: categoryStoreId,
        legacyResolution: row.categoryResolution || currentDraft.categoryResolution,
      }) || categoryResolution;
      const rowTarget = listingTargetCategoryFieldsForStore(rowResolution, categoryStoreId);
      const normalizedRow = {
        ...rowWithoutCategoryRoots,
        sourceCategory: sourceCategoryEvidenceOf({
          sourceCategory: row.sourceCategory,
          _sourceVariant: row.sourceVariant,
        }),
        ...(rowResolution ? { categoryResolution: rowResolution } : {}),
        descriptionCategoryId: rowTarget.descriptionCategoryId || "",
        typeId: rowTarget.typeId || "",
      };
      if (index !== anchorIndex) return normalizedRow;
      return {
        ...normalizedRow,
        description,
        richContent,
        brand,
        tags,
        packageWeight,
        packageLength,
        packageWidth,
        packageHeight,
        descriptionCategoryId: rowTarget.descriptionCategoryId || "",
        typeId: rowTarget.typeId || "",
        categoryPath: categoryLabel,
        categoryPathZh: categoryLabel,
        categoryPathRu: categoryRussianLabel,
        categoryAttributes: editedCategoryAttributes,
      };
    });
    return {
      sku,
      title,
      price,
      currencyCode,
      image: productImageList[0] || "",
      images: productImageList,
      brand,
      modelName,
      offerPrefix,
      description,
      tags,
      richContent,
      packageWeight,
      packageLength,
      packageWidth,
      packageHeight,
      listingWarehouseId,
      warehouseId: listingWarehouseId,
      listingStock,
      stock: listingStock,
      descriptionCategoryId: categoryDescriptionId || "",
      typeId: categoryTypeId || "",
      categoryPath: categoryLabel,
      categoryPathZh: categoryLabel,
      categoryPathRu: categoryRussianLabel,
      categoryResolution,
      ...(hasSourceCategory ? { sourceCategory } : {}),
      // Kept for compatibility with older drafts. The server applies this only
      // to the anchor SKU; sibling variants use their own categoryAttributes or
      // sourceVariant snapshot.
      categoryAttributes: editedCategoryAttributes,
      sourceLink,
      note,
      variants: draftVariants,
      savedAt: new Date().toISOString(),
    };
  };

  const saveListingDraft = async function({ silent = false, onlyIfChanged = false } = {}) {
    if (!itemScopeCurrent || !item?.id || !isCollectItem) {
      const detail = "当前商品店铺数据未就绪，暂不能写回草稿";
      if (!silent) message.warning(detail);
      throw new Error(detail);
    }
    const draft = buildListingDraft();
    const comparableDraft = (value = {}) => {
      const next = { ...(value || {}) };
      delete next.savedAt;
      return JSON.stringify(next);
    };
    if (onlyIfChanged && comparableDraft(draft) === comparableDraft(item.listingDraft || {})) {
      return { draft: item.listingDraft || draft, saved: item, unchanged: true };
    }
    try {
      const saved = await apiRequest(`/ozon/collect-box/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: {
          expectedVersion: Number(item.draftVersion || 1),
          name: title,
          title,
          sku,
          price,
          currency_code: currencyCode,
          image: productImageList[0] || image,
          images: productImageList,
          brand,
          attributes: draft.categoryAttributes
            .filter((row) => row.id && (Array.isArray(row.values) ? row.values.length : row.value))
            .map((row) => ({
              id: row.id,
              name: row.name,
              values: Array.isArray(row.values) && row.values.length ? row.values : [{ value: row.value }],
              is_required: row.required,
            })),
          productUrl: sourceLink,
          listingDraft: draft,
        },
      });
      await onRefresh?.();
      if (!silent) message.success("草稿已保存");
      return { draft, saved, unchanged: false };
    } catch (error) {
      if (!silent) message.error("草稿保存失败: " + (error?.message || error));
      throw error;
    }
  };

  const handleSaveDraft = async function() {
    await saveListingDraft({ silent: false }).catch(function() {});
  };
  const currentDraft = item?.listingDraft || {};
  const categoryResolution = categoryResolutionForCollectionTarget(item, {
    targetStoreId: categoryStoreId,
    legacyResolution: scopedPreviewItem?.categoryResolution || currentDraft.categoryResolution,
  });
  const categoryTargetFields = listingTargetCategoryFieldsForStore(
    categoryResolution,
    categoryStoreId,
  );
  const categoryDescriptionId = collectEditFirst(
    categoryTargetFields.descriptionCategoryId,
    isCollectItem ? "" : scopedPreviewItem?.description_category_id,
    isCollectItem ? "" : item?.description_category_id,
    isCollectItem ? "" : item?.descriptionCategoryId,
    isCollectItem ? "" : currentDraft.descriptionCategoryId,
    isCollectItem ? "" : currentDraft.description_category_id,
  );
  const categoryTypeId = collectEditFirst(
    categoryTargetFields.typeId,
    isCollectItem ? "" : scopedPreviewItem?.type_id,
    isCollectItem ? "" : item?.type_id,
    isCollectItem ? "" : item?.typeId,
    isCollectItem ? "" : currentDraft.typeId,
    isCollectItem ? "" : currentDraft.type_id,
  );
  const categoryMatched = Boolean(categoryDescriptionId && categoryTypeId);
  const categoryDictionaryTargets = useMemo(() => categorySchema
    .map((schema) => {
      const id = Number(collectEditSchemaId(schema));
      const key = String(collectEditSchemaId(schema) || collectEditSchemaLabel(schema) || "").trim();
      const schemaOptions = collectEditSchemaOptions(schema);
      const dictionaryId = Number(collectEditFirst(schema.dictionary_id, schema.dictionaryId) || 0);
      return key && id > 0 && collectEditSchemaControlType(schema, schemaOptions) === "select"
        && !schemaOptions.length && dictionaryId > 0 ? { key, attributeId: id } : null;
    })
    .filter(Boolean), [categorySchema]);
  const readCategoryDictionaryValues = React.useCallback(async ({
    storeId,
    descriptionCategoryId,
    typeId,
    attributeId,
  }) => {
    const response = await apiRequest(
      `/ozon/description-category/${encodeURIComponent(typeId)}/attributes/${encodeURIComponent(attributeId)}/values?descriptionCategoryId=${encodeURIComponent(descriptionCategoryId)}&limit=5000`,
      { headers: { "x-ozon-store-id": storeId } },
    );
    return dictionaryRowsOfResponse(response);
  }, []);
  const {
    categoryAttributeOptions,
    categoryDictionaryLoading,
    categoryDictionaryError,
    categoryDictionaryReady,
    retryCategoryDictionaryValues,
  } = useCategoryDictionaryReadiness({
    storeId: categoryStoreId,
    itemId,
    descriptionCategoryId: categoryDescriptionId,
    typeId: categoryTypeId,
    targets: categoryDictionaryTargets,
    readValues: readCategoryDictionaryValues,
    formatOption: collectEditFormatDictionaryOption,
  });
  const categoryVisibleError = categoryDataError || categoryDictionaryError;
  const categoryReadinessInput = {
    descriptionCategoryId: categoryDescriptionId,
    typeId: categoryTypeId,
    loading: categoryTreeLoading,
    error: categoryDataError,
    dictionaryLoading: categoryDictionaryLoading,
    dictionaryError: categoryDictionaryError,
    treeCount: categoryTreeReady ? Math.min(scopedTrees.zhTree.length, scopedTrees.ruTree.length) : 0,
  };
  const categoryReadinessState = categoryReadiness(categoryReadinessInput);
  const categoryOptionPathZh = collectEditFindCategoryOptionPath(categoryTreeOptionsZh, categoryDescriptionId, categoryTypeId);
  const categoryOptionPathRu = collectEditFindCategoryOptionPath(categoryTreeOptionsRu, categoryDescriptionId, categoryTypeId);
  const categoryPathZh = collectEditCategoryDisplayPath(categoryOptionPathZh);
  const categoryPathRu = collectEditCategoryDisplayPath(categoryOptionPathRu);
  const categoryCascaderValue = categoryOptionPathZh?.length ? categoryOptionPathZh.map((option) => option.value) : undefined;
  const categoryLabel = categoryPathZh || collectEditFirst(
    scopedPreviewItem?.categoryPathZh,
    scopedPreviewItem?.categoryPath,
    scopedPreviewItem?.category_path,
    scopedPreviewItem?.category,
    scopedPreviewItem?.category_name,
    scopedPreviewItem?.type_name,
    item?.categoryPath,
    item?.category_path,
    item?.category,
    item?.category_name,
    item?.type_name,
  ) || (categoryMatched ? `类目 ${categoryDescriptionId || "—"} / 类型 ${categoryTypeId || "—"}` : "点击内容体检后自动匹配");
  const categoryRussianLabel = categoryPathRu || collectEditFirst(
    scopedPreviewItem?.categoryPathRu,
    scopedPreviewItem?.category_path_ru,
    scopedPreviewItem?.categoryPath,
    scopedPreviewItem?.category_path,
    item?.categoryPathRu,
    item?.category_path_ru,
    item?.categoryPath,
    item?.category_path,
    item?.category,
  ) || (categoryMatched ? "俄语类目待加载" : "俄语类目待匹配");
  const sourceCategory = sourceCategoryEvidenceOf(
    scopedPreviewItem?.categoryResolution ? scopedPreviewItem : item,
  );
  const sourceCategoryLabel = sourceCategory.path.length
    ? sourceCategory.path.join(" / ")
    : sourceCategory.typeName || (sourceCategory.descriptionCategoryId ? `来源类目 ${sourceCategory.descriptionCategoryId}` : "来源类目暂无数据");
  const handleCategoryChange = function(_, selectedOptions = []) {
    const options = Array.isArray(selectedOptions) ? selectedOptions : [];
    const leaf = options[options.length - 1];
    const nextDescriptionId = [...options].reverse().map((option) => option?.descriptionCategoryId).find(Boolean) || "";
    const nextTypeId = collectEditFirst(leaf?.typeId);
    if (!nextDescriptionId || !nextTypeId) {
      message.warning("请选择最末级商品类型");
      return;
    }
    const nextZhPath = collectEditCategoryDisplayPath(options);
    const nextRuPath = collectEditCategoryDisplayPath(
      collectEditFindCategoryOptionPath(categoryTreeOptionsRu, nextDescriptionId, nextTypeId),
    ) || nextZhPath;
    setPreviewItem((prev) => ({
      ...(prev || {}),
      description_category_id: nextDescriptionId,
      type_id: nextTypeId,
      categoryPath: nextZhPath,
      categoryPathZh: nextZhPath,
      categoryPathRu: nextRuPath,
      category_name: nextZhPath,
      type_name: collectEditText(leaf?.label),
      categoryResolution: manualCategoryResolution({
        source: sourceCategory,
        targetStoreId: categoryStoreId,
        descriptionCategoryId: nextDescriptionId,
        typeId: nextTypeId,
      }),
    }));
    setCategoryAutoError("");
  };
  const retryCategoryData = function() {
    if (categoryDataError) loadCategoryTrees();
    if (categoryDictionaryError) retryCategoryDictionaryValues();
  };
  const attributeRows = collectEditAttributeRows(
    scopedPreviewItem,
    currentDraft,
    item,
    collectEditSourceCategoryVariant(item),
  );
  const sourceAttributeEvidenceMap = collectEditAttributeEvidenceMap(attributeRows);
  const categoryAttributeInputRows = Array.isArray(categorySchema)
    ? categorySchema
        .map((schema) => {
          const id = String(collectEditSchemaId(schema) || "").trim();
          const label = collectEditSchemaLabel(schema);
          const key = id || label;
          const schemaOptions = collectEditSchemaOptions(schema);
          const loadedOptions = Array.isArray(categoryAttributeOptions[key]) ? categoryAttributeOptions[key] : [];
          const isBrandSchema = collectEditSchemaIsBrand(schema, label);
          const baseOptions = loadedOptions.length ? loadedOptions : schemaOptions;
          const options = isBrandSchema ? collectEditEnsureBrandOptions(baseOptions) : baseOptions;
          const multiple = collectEditSchemaIsMultiple(schema);
          const controlType = collectEditSchemaControlType(schema, options);
          const defaultValue = isBrandSchema
            ? collectEditDefaultBrandAttributeValue(options)
            : "";
          const sourceEvidence = sourceAttributeEvidenceMap.get(key) || { value: "", dictionaryIds: [] };
          const capturedSourceValue = isBrandSchema ? defaultValue : sourceEvidence.value || defaultValue;
          const currentValue = categoryAttributeValues[key];
          const idResolution = !isBrandSchema && controlType === "select"
            ? resolveCollectEditDictionaryValue({
                dictionaryIds: sourceEvidence.dictionaryIds,
                options,
                multiple,
              })
            : { matchedById: false, value: undefined };
          const useIdValue = shouldApplyCollectEditDictionaryDefault({
            currentValue,
            sourceValue: capturedSourceValue,
            matchedById: idResolution.matchedById,
          });
          const sourceValue = currentValue ?? capturedSourceValue;
          const value = controlType === "select"
            ? useIdValue
              ? idResolution.value
              : collectEditResolveSelectControlValue(sourceValue, { multiple, options })
            : sourceValue;
          return {
            key,
            id,
            label,
            value,
            required: schema.is_required === true || schema.required === true,
            dictionaryId: collectEditFirst(schema.dictionary_id, schema.dictionaryId),
            type: collectEditFirst(schema.type, schema.attribute_type, schema.attributeType),
            controlType,
            multiple,
            options,
            description: collectEditTranslateAttributeDescription(
              collectEditFirst(schema.description, schema.hint),
              label,
              id,
            ),
          };
        })
        .filter((row) => row.key)
    : [];

  React.useEffect(function() {
    let active = true;
    if (!categoryDescriptionId || !categoryTypeId || !categoryStoreId) {
      setCategorySchema([]);
      setCategorySchemaError("");
      setCategorySchemaLoading(false);
      return undefined;
    }
    setCategorySchemaLoading(true);
    setCategorySchemaError("");
    apiRequest(
      `/ozon/description-category/${encodeURIComponent(categoryTypeId)}/attributes?descriptionCategoryId=${encodeURIComponent(categoryDescriptionId)}`,
      {
        headers: { "x-ozon-store-id": categoryStoreId },
      },
    )
      .then((response) => {
        if (!active) return;
        const rows = Array.isArray(response?.items)
          ? response.items
          : Array.isArray(response?.data)
            ? response.data
            : [];
        setCategorySchema(rows);
      })
      .catch((error) => {
        if (!active) return;
        setCategorySchema([]);
        setCategorySchemaError(error?.message || String(error));
      })
      .finally(() => {
        if (active) setCategorySchemaLoading(false);
      });
    return () => {
      active = false;
    };
  }, [categoryDescriptionId, categoryTypeId, categoryStoreId]);

  React.useEffect(function() {
    if (!categorySchema.length) {
      setCategoryAttributeValues((prev) => Object.keys(prev || {}).length ? {} : prev);
      return;
    }
    const next = {};
    const forcedDefaultKeys = new Set();
    const idMatchedSourceValues = new Map();
    for (const schema of categorySchema) {
      const id = String(collectEditSchemaId(schema) || "").trim();
      const label = collectEditSchemaLabel(schema);
      const key = id || label;
      if (!key) continue;
      const schemaOptions = collectEditSchemaOptions(schema);
      const loadedOptions = Array.isArray(categoryAttributeOptions[key]) ? categoryAttributeOptions[key] : [];
      const isBrandSchema = collectEditSchemaIsBrand(schema, label);
      const baseOptions = loadedOptions.length ? loadedOptions : schemaOptions;
      const options = isBrandSchema ? collectEditEnsureBrandOptions(baseOptions) : baseOptions;
      if (isBrandSchema) {
        next[key] = collectEditDefaultBrandAttributeValue(options);
        forcedDefaultKeys.add(key);
      } else {
        const sourceEvidence = sourceAttributeEvidenceMap.get(key) || { value: "", dictionaryIds: [] };
        const multiple = collectEditSchemaIsMultiple(schema);
        const idResolution = resolveCollectEditDictionaryValue({
          dictionaryIds: sourceEvidence.dictionaryIds,
          options,
          multiple,
        });
        next[key] = idResolution.matchedById ? idResolution.value : sourceEvidence.value || "";
        if (idResolution.matchedById) idMatchedSourceValues.set(key, sourceEvidence.value || "");
      }
    }
    const scope = `${categoryStoreId}:${itemId}:${categoryDescriptionId}:${categoryTypeId}`;
    setCategoryAttributeValues((prev) => {
      if (prev?.__scope === scope) {
        let changed = false;
        const merged = { ...prev };
        for (const [key, value] of Object.entries(next)) {
          if (idMatchedSourceValues.has(key)) {
            const applyIdDefault = shouldApplyCollectEditDictionaryDefault({
              currentValue: merged[key],
              sourceValue: idMatchedSourceValues.get(key),
              matchedById: true,
            });
            if (applyIdDefault && merged[key] !== value) {
              merged[key] = value;
              changed = true;
            }
            continue;
          }
          if (!forcedDefaultKeys.has(key) && merged[key] !== undefined && !(collectEditText(merged[key]) === "" && collectEditText(value))) continue;
          if (forcedDefaultKeys.has(key) && merged[key] === value) continue;
          merged[key] = value;
          changed = true;
        }
        return changed ? merged : prev;
      }
      return { __scope: scope, ...next };
    });
  }, [categoryStoreId, itemId, categoryDescriptionId, categoryTypeId, categorySchema, categoryAttributeOptions, previewItem, item, brand]);

  React.useEffect(function() {
    if (!item || preparationModel.listingBlocked || !categoryStoreId || !categoryTreeReady || !categoryDictionaryReady || categoryMatched || categoryAutoLoading) return;
    if (!sku || !numberFromMoney(price) || !productImageList.length) return;
    const key = [
      itemId,
      categoryStoreId,
      sku,
      price,
      productImageList.length,
      variantRows.length,
      storeCurrencyCode || currencyCode,
    ].join("|");
    if (categoryAutoPreviewKeyRef.current === key) return;
    categoryAutoPreviewKeyRef.current = key;
    runCollectPreview({ silent: true });
  }, [
    item,
    itemId,
    preparationModel.listingBlocked,
    categoryStoreId,
    categoryTreeReady,
    categoryDictionaryReady,
    categoryMatched,
    categoryAutoLoading,
    sku,
    price,
    productImageList.length,
    variantRows.length,
    storeCurrencyCode,
    currencyCode,
  ]);

  const hasPackageDimensions = [packageWeight, packageLength, packageWidth, packageHeight]
    .every((value) => numberFromMoney(value) > 0);
  const activeCurrencyCode = storeCurrencyCode || currencyCode;
  const listingStockNumber = numberFromMoney(listingStock);
  const listingStockReady = collectEditText(listingStock) !== "" && listingStockNumber !== null && listingStockNumber >= 0;
  const listingWarehouseReady = listingWarehouseOptions.some((option) => option.value === String(listingWarehouseId));
  const requiredCategoryAttributeRows = categoryAttributeInputRows.filter((row) => row.required);
  const missingRequiredCategoryAttributes = requiredCategoryAttributeRows
    .filter((row) => !collectEditRequiredValueFilled(categoryAttributeValues[row.key] ?? row.value, row))
    .map((row) => row.label || row.key);
  const variantRequiredReady = Boolean(variantRows.length) && variantRows.every((row) => {
    const rowPrice = collectEditFirst(row.sellPrice, row.price, price);
    return collectEditRequiredValueFilled(collectEditFirst(row.offerId, row.offer_id))
      && collectEditRequiredValueFilled(collectEditFirst(row.name, row.title))
      && numberFromMoney(rowPrice) > 0;
  });
  const enrichmentListingBlockedText = preparationModel.listingBlocked
    ? [enrichmentView.label || "资料补全未完成", enrichmentView.detail].filter(Boolean).join("：")
    : "";
  const listingRequiredMissingFields = [
    preparationModel.listingBlocked ? "资料补全完成" : "",
    !targetStoreId ? "上架店铺" : "",
    !collectEditRequiredValueFilled(sku) ? "SKU（商品编码）" : "",
    !collectEditRequiredValueFilled(title) ? "俄语标题" : "",
    !collectEditRequiredValueFilled(description) ? "商品简介/描述" : "",
    numberFromMoney(price) <= 0 ? "售价" : "",
    !productImageList.length ? "商品图片" : "",
    !collectEditRequiredValueFilled(brand) ? "品牌" : "",
    !collectEditRequiredValueFilled(activeCurrencyCode) ? "上架货币" : "",
    !listingWarehouseReady ? "上架仓库" : "",
    !listingStockReady ? "上架库存" : "",
    !hasPackageDimensions ? "包装重量和尺寸" : "",
    !categoryMatched ? "产品类目" : "",
    !categoryReadinessState.ready ? "真实类目数据可用" : "",
    categorySchemaLoading ? "类目属性加载完成" : "",
    categorySchemaError ? "类目属性重新加载" : "",
    !variantRequiredReady ? "变体 SKU 货号、名称和售价" : "",
    ...missingRequiredCategoryAttributes.map((label) => `类目属性「${label}」`),
  ].filter(Boolean);
  const listingMissingRequiredText = enrichmentListingBlockedText || (listingRequiredMissingFields.length
    ? `请先完善必填项：${listingRequiredMissingFields.slice(0, 6).join("、")}${listingRequiredMissingFields.length > 6 ? `等 ${listingRequiredMissingFields.length} 项` : ""}`
    : "");
  const listingSubmitDisabledReason = listingMissingRequiredText || categoryReadinessState.message;
  const listingSubmitDisabled = loading || Boolean(listingRequiredMissingFields.length) || !categoryReadinessState.ready;
  const readyChecks = [
    !preparationModel.listingBlocked,
    Boolean(targetStoreId),
    collectEditRequiredValueFilled(sku),
    collectEditRequiredValueFilled(title),
    numberFromMoney(price) > 0,
    Boolean(productImageList.length),
    collectEditRequiredValueFilled(brand),
    hasPackageDimensions,
    categoryReadinessState.ready && !categorySchemaLoading && !categorySchemaError && !missingRequiredCategoryAttributes.length,
    listingWarehouseReady,
    listingStockReady,
    variantRequiredReady,
  ];
  const readyCount = readyChecks.filter(Boolean).length;
  const readyPercent = Math.round((readyCount / readyChecks.length) * 100);
  const filledCategoryAttributeCount = categoryAttributeInputRows
    .filter((row) => collectEditRequiredValueFilled(categoryAttributeValues[row.key] ?? row.value, row))
    .length;
  const contentRating = collectEditContentRating({
    title,
    description,
    richContent,
    tags,
    images: productImageList,
    categoryMatched: categoryMatched && !categorySchemaLoading && !categorySchemaError,
    requiredAttributesReady: !categorySchemaLoading && !categorySchemaError && !missingRequiredCategoryAttributes.length,
    filledCategoryAttributeCount,
    totalCategoryAttributeCount: categoryAttributeInputRows.length,
    variantReady: variantRequiredReady,
    packageReady: hasPackageDimensions,
  });
  const sectionNav = [
    { title: "店铺与基础", note: hasStore ? "已选 1" : "未绑定" },
    { title: "产品类目", note: categoryMatched ? "已匹配" : categoryAutoLoading ? "匹配中" : "AI 自动匹配" },
    { title: "标题与文案", note: title ? "已填写" : "待填写" },
    { title: "物流尺寸", note: packageWeight && packageLength && packageWidth && packageHeight ? "已填写" : "待填写" },
    { title: "类目属性", note: categoryAttributeInputRows.length ? `${categoryAttributeInputRows.length} 项` : categorySchemaLoading ? "加载中" : "待匹配" },
    { title: "变体设置", note: `${variantRows.length || 1} 个变体` },
    { title: "货源信息", note: sourceLink ? "已填写" : "可选" },
  ];
  const reindexVariantRows = (rows) => rows.map((row, index) => ({ ...row, index: index + 1 }));
  const updateVariantRow = (key, patch) => {
    setVariantRows((rows) => rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  };
  const duplicateVariantRow = (row) => {
    setVariantRows((rows) => reindexVariantRows([
      ...rows,
      {
        ...row,
        key: `${row.key}-copy-${Date.now()}`,
        offerId: `${row.offerId || offerPrefix}${rows.length + 1}`,
      },
    ]));
  };
  const deleteVariantRow = (key) => {
    if (variantRows.length <= 1) {
      message.warning("至少保留 1 个变体");
      return;
    }
    if (!variantRows.some((row) => row.key === key)) {
      message.warning("未找到要删除的变体");
      return;
    }
    setVariantRows((rows) => reindexVariantRows(rows.filter((row) => row.key !== key)));
    setSelectedVariantKeys((keys) => keys.filter((value) => value !== key));
    message.success("已删除变体");
  };
  const deleteSelectedVariants = () => {
    if (!selectedVariantKeys.length) return;
    const selectedSet = new Set(selectedVariantKeys);
    const nextRows = variantRows.filter((row) => !selectedSet.has(row.key));
    if (!nextRows.length) {
      message.warning("至少保留 1 个变体");
      return;
    }
    setVariantRows(reindexVariantRows(nextRows));
    setSelectedVariantKeys([]);
    message.success(`已删除 ${variantRows.length - nextRows.length} 个变体`);
  };
  const variantColumns = [
    { title: "#", dataIndex: "index", width: 48, fixed: "left" },
    { title: "图片", dataIndex: "image", width: 76, render: (value) => value ? <img className="collect-edit-table-image" src={value} alt="" /> : <span className="collect-edit-empty-cell">—</span> },
    { title: "视频封面", dataIndex: "cover", width: 86, render: (value) => value ? <img className="collect-edit-table-image" src={value} alt="" /> : <span className="collect-edit-empty-cell">—</span> },
    { title: "视频", dataIndex: "video", width: 130, render: (value, row) => <Input size="small" value={value} placeholder="视频链接" onChange={(event) => updateVariantRow(row.key, { video: event.target.value })} /> },
    { title: "SKU 货号", dataIndex: "offerId", width: 190, render: (value, row) => <Input size="small" value={value} onChange={(event) => updateVariantRow(row.key, { offerId: event.target.value })} /> },
    { title: "SKU 名称", dataIndex: "name", width: 280, render: (value, row) => <Input size="small" value={value} onChange={(event) => updateVariantRow(row.key, { name: event.target.value })} /> },
    { title: "采购价", dataIndex: "purchasePrice", width: 112, render: (value, row) => <Input size="small" value={value} placeholder="—" onChange={(event) => updateVariantRow(row.key, { purchasePrice: event.target.value })} /> },
    { title: `售价 ${currencyCode === "CNY" ? "¥" : currencyCode}`, dataIndex: "sellPrice", width: 120, render: (value, row, index) => (
      <Input
        size="small"
        value={value}
        onChange={(event) => {
          updateVariantRow(row.key, { sellPrice: event.target.value });
          if (index === 0) setPrice(event.target.value);
        }}
      />
    ) },
    { title: `划线价 ${currencyCode === "CNY" ? "¥" : currencyCode}`, dataIndex: "oldPrice", width: 120, render: (value, row) => <Input size="small" value={value} onChange={(event) => updateVariantRow(row.key, { oldPrice: event.target.value })} /> },
    { title: "库存", dataIndex: "stock", width: 92, render: (value, row) => <Input size="small" value={value} onChange={(event) => updateVariantRow(row.key, { stock: event.target.value })} /> },
    { title: "操作", dataIndex: "actions", width: 112, fixed: "right", render: (_, row) => (
      <Space size={4}>
        <Button size="small" type="link" onClick={(event) => { event.stopPropagation(); duplicateVariantRow(row); }}>复制</Button>
        <Button size="small" type="link" danger disabled={variantRows.length <= 1} onClick={(event) => { event.stopPropagation(); deleteVariantRow(row.key); }}>删除</Button>
      </Space>
    ) },
  ];

  if (!itemId || !item) {
    return (
      <div className="source-page">
        <Card>
          <Empty description="未找到采集商品" />
        </Card>
      </div>
    );
  }

  return (
    <div className="source-page collect-edit-page">
      <div className="collect-edit-header">
        <div className="collect-edit-product">
          <div className="collect-edit-cover">
            {productImageList[0] ? <img src={productImageList[0]} alt="" /> : <PictureOutlined />}
          </div>
          <div className="collect-edit-title-block">
            <h1>{title || "商品信息编辑"}</h1>
            <div className="collect-edit-meta">
              <span>SKU {sku || "—"}</span>
              <span>{variantRows.length || 1} 个变体</span>
              <span>{productImageList.length} 张图片</span>
            </div>
          </div>
        </div>
        <div className="collect-edit-head-actions">
          <Button onClick={function() { navigate("/ozon/products/collect"); }}>返回列表</Button>
          <div className="collect-edit-ready">
            <span>{readyCount}/{readyChecks.length}</span>
            <strong>{readyPercent}% 就绪</strong>
            <div><i style={{ width: `${readyPercent}%` }} /></div>
          </div>
        </div>
      </div>

      {enrichmentView.label ? (
        <Alert
          className="collect-enrichment-alert"
          type={collectEnrichmentAlertTypes[enrichmentView.tone] || "info"}
          showIcon
          message={enrichmentView.label}
          description={enrichmentView.detail || (enrichmentView.listingBlocked
            ? "资料会在后台继续补全，完成前不能预检或上架。"
            : "商品补全资料已可用于上架。")}
          action={enrichmentView.retryable ? (
            <Button size="small" loading={enrichmentRetrying} onClick={retryCollectEnrichment}>
              重新补全
            </Button>
          ) : undefined}
        />
      ) : null}
      <Alert
        className="collect-listing-status"
        type="success"
        showIcon
        message="正式上架链路"
        description="插件只负责前置采集入库；当前页面保存草稿后，预检和上架都会使用数据库中的最新草稿，不会重新通过插件采集商品数据。"
        action={
          <Space>
            <Button size="small" onClick={handleSaveDraft}>保存草稿</Button>
          </Space>
        }
      />
      <Alert
        className="collect-content-rating"
        type={contentRating.alertType}
        showIcon
        message={`内容评级 ${contentRating.score}/100`}
        description={contentRating.missing.length
          ? `按 Ozon 商品内容规则本地评估，建议继续完善：${contentRating.missing.slice(0, 5).join("、")}${contentRating.missing.length > 5 ? `等 ${contentRating.missing.length} 项` : ""}。主题标签将按上传规则清洗为 ${contentRating.sanitizedTagCount} 个。`
          : `当前内容完整度较好；主题标签将按上传规则清洗为 ${contentRating.sanitizedTagCount} 个，富内容 JSON 会在上传前按 Ozon 模板合规化。`}
      />
      {listingResult ? (
        <Alert
          className="collect-listing-result"
          type={listingResult.status === "success" ? "success" : listingResult.status === "pending" ? "info" : listingResult.status === "warning" ? "warning" : "error"}
          showIcon
          message={listingResult.title}
          description={listingResult.detail}
        />
      ) : null}

      <div className="collect-edit-body">
        <aside className="collect-edit-anchor">
          {sectionNav.map((section) => (
            <a key={section.title} href={`#${section.title}`}>
              <span>{section.title}</span>
              <em>{section.note}</em>
            </a>
          ))}
        </aside>

        <div className="collect-edit-main">
          <section className="collect-edit-section" id="店铺与基础">
            <div className="collect-edit-section-head">
              <div>
                <h2>店铺与基础</h2>
                <p>{hasStore ? "已选 1" : "未绑定店铺"}</p>
              </div>
              <Space>
                <Button size="small" onClick={onBind}>店铺管理 →</Button>
                <Button size="small" onClick={() => message.success("已选择当前店铺")}>全选</Button>
                <Button size="small" onClick={() => message.info("当前店铺会保留用于上架")}>清空</Button>
              </Space>
            </div>
            <Form layout="vertical" className="collect-edit-grid">
              <Form.Item label="上架店铺">
                <Select showSearch value={targetStoreId || undefined} options={targetStoreOptions} placeholder="明确选择目标经营店铺" notFoundContent="没有启用且已保存凭据的经营店铺" optionFilterProp="label" onChange={selectListingTarget} />
              </Form.Item>
              <Form.Item label="品牌">
                <Input value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="Нет бренда" />
              </Form.Item>
              <Form.Item label="上架货币">
                <Select
                  value={currencyCode}
                  onChange={setCurrencyCode}
                  options={[
                    { value: "CNY", label: "[¥] 人民币" },
                    { value: "RUB", label: "[₽] 卢布" },
                    { value: "USD", label: "[$] 美元" },
                    { value: "EUR", label: "[€] 欧元" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="合并变体型号">
                <Input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="输入型号" />
              </Form.Item>
              <Form.Item label="货号前缀 offer_id 前缀">
                <Input value={offerPrefix} onChange={(event) => setOfferPrefix(event.target.value)} placeholder="jz-" />
              </Form.Item>
              <Form.Item label="SKU（商品编码）">
                <Input value={sku} onChange={(event) => setSku(event.target.value)} placeholder="输入 SKU" />
              </Form.Item>
              <Form.Item label="上架仓库">
                <Select
                  showSearch
                  value={listingWarehouseId || undefined}
                  options={listingWarehouseOptions}
                  placeholder="选择上架库存仓库"
                  notFoundContent="当前店铺暂无可写 FBS 仓库"
                  optionFilterProp="label"
                  onChange={(value) => setListingWarehouseId(value || "")}
                />
              </Form.Item>
              <Form.Item label="上架库存">
                <InputNumber
                  min={0}
                  precision={0}
                  value={Number(listingStock) || 0}
                  onChange={(value) => setListingStock(String(value ?? 0))}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Form>
          </section>

          <section className="collect-edit-section" id="产品类目">
            <div className="collect-edit-section-head">
              <div>
                <h2>产品类目</h2>
                <p>{categoryMatched ? (categoryResolution?.method === "MANUAL" ? "已人工选择目标店铺类目" : "已按采集数据核验目标店铺类目") : categoryAutoLoading ? "正在核验目标店铺类目" : "来源类目已保留，目标店铺类目待核验"}</p>
              </div>
              <Tooltip rootClassName="prototype-overlay" title={categoryMatched ? "已拿到可用于 Ozon 上架的类目和类型 ID" : "系统会优先使用采集到的类目、类型和属性自动匹配"}>
                <Tag color={categoryMatched ? "green" : categoryAutoLoading ? "processing" : "default"}>{categoryMatched ? "已匹配" : categoryAutoLoading ? "匹配中" : "待匹配"}</Tag>
              </Tooltip>
            </div>
            {categoryVisibleError ? (
              <Alert
                type="error"
                showIcon
                message="未能从 Ozon 获取真实类目数据"
                description="请检查店铺凭据或网络后重试。获取成功前不能预检或上架。"
                action={<Button size="small" loading={categoryTreeLoading || categoryDictionaryLoading} onClick={retryCategoryData}>重试</Button>}
              />
            ) : null}
            <div className="collect-edit-category-row">
              <AppstoreOutlined />
              <Cascader
                allowClear={false}
                className="collect-edit-category-cascader"
                disabled={!categoryTreeReady}
                displayRender={(labels) => labels.length ? labels.join(" / ") : categoryLabel}
                expandTrigger="click"
                notFoundContent={categoryTreeLoading ? "正在加载类目..." : "暂无类目"}
                onChange={handleCategoryChange}
                options={categoryTreeOptionsZh}
                placeholder={categoryAutoLoading && !categoryMatched ? "正在根据采集数据自动匹配类目..." : categoryLabel}
                showSearch={{
                  filter: (inputValue, path) => path.some((option) =>
                    collectEditText(option.label).toLowerCase().includes(String(inputValue || "").toLowerCase()),
                  ),
                }}
                suffixIcon={categoryTreeLoading || categoryAutoLoading ? <SyncOutlined spin /> : undefined}
                value={categoryCascaderValue}
              />
            </div>
            <div className="collect-edit-attr-strip">
              <span title={`来源 description_category_id: ${sourceCategory.descriptionCategoryId || "—"} / 候选 type_id: ${sourceCategory.typeIdCandidate || "—"}`}>
                采集来源：{sourceCategoryLabel}
              </span>
            </div>
            <div className="collect-edit-attr-strip">
              <span title={`description_category_id: ${categoryDescriptionId || "—"} / type_id: ${categoryTypeId || "—"}`}>
                目标店铺：{categoryMatched ? `${categoryRussianLabel}（${categoryDescriptionId} / ${categoryTypeId}）` : categoryAutoLoading ? "正在核验" : "待手动选择或自动核验"}
              </span>
            </div>
            {categoryAutoError ? <div className="collect-edit-empty-note">目标类目待处理：{categoryAutoError}</div> : null}
          </section>

          <section className="collect-edit-section" id="标题与文案">
            <div className="collect-edit-section-head">
              <div>
                <h2>标题与文案</h2>
                <p>{title ? "已填写" : "待填写"}</p>
              </div>
              <Button size="small" icon={<ThunderboltOutlined />} onClick={() => message.info("AI 优化已接入按钮位，当前保留原始采集文案")}>AI 优化</Button>
            </div>
            <Form layout="vertical">
              <Form.Item label="俄语标题">
                <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="输入俄语标题" />
              </Form.Item>
              <div className="collect-edit-field-note">{title.length} 字符 · 建议 50-80</div>
              <Form.Item label="简介">
                <Segmented
                  size="small"
                  value={descriptionMode}
                  onChange={setDescriptionMode}
                  options={["编辑", "预览"]}
                />
                {descriptionMode === "编辑" ? (
                  <Input.TextArea
                    className="collect-edit-description"
                    value={description}
                    rows={5}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="商品描述（支持 HTML 格式）"
                  />
                ) : (
                  <div className="collect-edit-preview">{description || "暂无商品描述"}</div>
                )}
              </Form.Item>
              <Form.Item label={`主题标签 ${tags.length}/30`}>
                <div className="collect-edit-tag-row">
                  {tags.length ? tags.map((tag) => <Tag key={tag}>#{tag}</Tag>) : <span>暂无标签</span>}
                </div>
              </Form.Item>
              <Form.Item label="JSON 富内容">
                <Input.TextArea
                  value={richContent}
                  rows={6}
                  onChange={(event) => setRichContent(event.target.value)}
                  placeholder="Ozon 富内容 JSON"
                />
              </Form.Item>
            </Form>
          </section>

          <section className="collect-edit-section" id="物流尺寸">
            <div className="collect-edit-section-head">
              <div>
                <h2>物流尺寸</h2>
                <p>{hasPackageDimensions ? "已填写" : "待填写"}</p>
              </div>
            </div>
            <Form layout="vertical" className="collect-edit-size-grid">
              <Form.Item label="包装重量">
                <Input value={packageWeight} suffix="克" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageWeight");
                  setPackageWeight(event.target.value);
                }} />
              </Form.Item>
              <Form.Item label="包装长">
                <Input value={packageLength} suffix="毫米" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageLength");
                  setPackageLength(event.target.value);
                }} />
              </Form.Item>
              <Form.Item label="包装宽">
                <Input value={packageWidth} suffix="毫米" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageWidth");
                  setPackageWidth(event.target.value);
                }} />
              </Form.Item>
              <Form.Item label="包装高">
                <Input value={packageHeight} suffix="毫米" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageHeight");
                  setPackageHeight(event.target.value);
                }} />
              </Form.Item>
            </Form>
          </section>

          <section className="collect-edit-section" id="类目属性">
            <div className="collect-edit-section-head">
              <div>
                <h2>类目属性</h2>
                <p>
                  {categoryMatched
                    ? categorySchemaLoading
                      ? "正在加载当前类目可填写属性"
                      : categoryAttributeInputRows.length
                        ? `可填写 ${categoryAttributeInputRows.length} 项，已按采集数据预输入`
                        : "当前类目未返回可填写属性"
                    : "等待类目自动匹配完成"}
                </p>
              </div>
              <Tag color={categoryAttributeInputRows.length ? "blue" : "default"}>
                {categoryAttributeInputRows.length ? "已加载类目属性" : "待加载"}
              </Tag>
            </div>
            <div className="collect-edit-attribute-grid">
              <div><span>品牌</span><strong>{brand || "Нет бренда"}</strong></div>
              <div><span>评分</span><strong>{item?.rating ? `${item.rating}★` : "—"}</strong></div>
              <div><span>评价数</span><strong>{item?.reviewCount || "—"}</strong></div>
              <div><span>卖家</span><strong>{item?.sellerName || item?.seller || "—"}</strong></div>
              <div><span>类目 ID</span><strong>{categoryDescriptionId || "—"}</strong></div>
              <div><span>类型 ID</span><strong>{categoryTypeId || "—"}</strong></div>
            </div>
            {categorySchemaError ? (
              <div className="collect-edit-empty-note">类目属性加载失败：{categorySchemaError}</div>
            ) : categorySchemaLoading ? (
              <div className="collect-edit-empty-note">正在从 Ozon 读取当前类目可填写属性，请稍等。</div>
            ) : categoryAttributeInputRows.length ? (
              <Form layout="vertical" className="collect-edit-attribute-form">
                {categoryAttributeInputRows.map((row) => (
                  <Form.Item
                    key={row.key}
                    label={(
                      <span className="collect-edit-attribute-label">
                        <span>{row.label}</span>
                        {row.required ? <Tag color="orange">必填</Tag> : null}
                      </span>
                    )}
                    tooltip={row.description || undefined}
                  >
                    {row.controlType === "select" ? (
                      <Select
                        mode={row.multiple ? "multiple" : undefined}
                        showSearch
                        allowClear={!row.required}
                        value={collectEditSelectControlValue(categoryAttributeValues[row.key] ?? row.value, row)}
                        options={row.options}
                        placeholder={row.required ? "请选择必填属性" : "请选择属性"}
                        notFoundContent={row.options.length ? null : "暂无可选项"}
                        optionFilterProp="searchText"
                        optionLabelProp="value"
                        optionRender={collectEditRenderDictionaryOption}
                        onChange={(value) => setCategoryAttributeValues((prev) => ({
                          ...prev,
                          [row.key]: collectEditSelectControlValue(value, row),
                        }))}
                      />
                    ) : String(categoryAttributeValues[row.key] ?? row.value ?? "").length > 90 ? (
                      <Input.TextArea
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        value={categoryAttributeValues[row.key] ?? row.value ?? ""}
                        onChange={(event) => setCategoryAttributeValues((prev) => ({ ...prev, [row.key]: event.target.value }))}
                        placeholder={row.required ? "必填属性" : "可选属性"}
                      />
                    ) : (
                      <Input
                        value={categoryAttributeValues[row.key] ?? row.value ?? ""}
                        onChange={(event) => setCategoryAttributeValues((prev) => ({ ...prev, [row.key]: event.target.value }))}
                        placeholder={row.required ? "必填属性" : "可选属性"}
                      />
                    )}
                  </Form.Item>
                ))}
              </Form>
            ) : (
              <div className="collect-edit-empty-note">
                {categoryMatched
                  ? "Ozon 没有返回当前类目的可填写属性，或当前 API Key 暂时无法读取该类目属性。"
                  : "类目自动匹配完成后，系统会按 Ozon 当前类目可填写内容生成输入框，并把采集到的数据预输入。"}
              </div>
            )}
          </section>

          <section className="collect-edit-section" id="变体设置">
            <div className="collect-edit-section-head">
              <div>
                <h2>变体设置</h2>
                <p>{variantRows.length || 1} 个变体</p>
              </div>
              <Space>
                <Button size="small" icon={<PlusOutlined />} onClick={() => duplicateVariantRow(variantRows[0] || collectEditVariantRows({ item, sku, title, price, images: productImageList, offerPrefix, targetStoreId: categoryStoreId })[0])}>添加变体</Button>
                <Button size="small" danger disabled={!selectedVariantKeys.length} onClick={deleteSelectedVariants}>批量删除变体</Button>
              </Space>
            </div>
            <Table
              className="collect-edit-variant-table"
              size="small"
              rowKey="key"
              columns={variantColumns}
              dataSource={variantRows}
              pagination={false}
              scroll={{ x: 1420 }}
              rowSelection={{
                selectedRowKeys: selectedVariantKeys,
                onChange: setSelectedVariantKeys,
              }}
            />
          </section>

          <section className="collect-edit-section" id="货源信息">
            <div className="collect-edit-section-head">
              <div>
                <h2>货源信息</h2>
                <p>可选</p>
              </div>
            </div>
            <Form layout="vertical">
              <Form.Item label="货源链接">
                <Input value={sourceLink} onChange={(event) => setSourceLink(event.target.value)} placeholder="Ozon 商品链接" />
              </Form.Item>
              <Form.Item label="备注">
                <Input.TextArea value={note} rows={3} onChange={(event) => setNote(event.target.value)} placeholder="备注" />
              </Form.Item>
            </Form>
          </section>

          <div className="collect-edit-footer-actions">
            {listingSubmitDisabledReason ? (
              <div className="collect-edit-submit-reason">{listingSubmitDisabledReason}</div>
            ) : null}
            <Button icon={<ThunderboltOutlined />} onClick={() => message.info("AI 一键生成保留当前采集文案，未写入示例数据")}>AI 一键生成俄文文案</Button>
            <Button loading={categoryAutoLoading} disabled={preparationModel.listingBlocked || !categoryReadinessState.ready} aria-label="上架预检" onClick={handlePreview} icon={<EyeOutlined />}>内容体检</Button>
            <Button onClick={handleSaveDraft}>保存草稿</Button>
            <Tooltip rootClassName="prototype-overlay" title={listingSubmitDisabledReason || ""}>
              <span className="collect-edit-submit-wrapper">
                <Button type="primary" loading={loading} disabled={listingSubmitDisabled} aria-label="提交上架到 Ozon" onClick={handleSubmit} icon={<CloudUploadOutlined />}>上架到 Ozon</Button>
              </span>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportHistoryPage({ binding, hasStore, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [activeStatus, setActiveStatus] = useState("全部");
  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState(null);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [detailTask, setDetailTask] = useState(null);
  const statusRefreshInFlightRef = useRef(false);
  const currentStoreId = String(binding?.id || localData?.currentStoreId || "");
  const tasks = Object.values(localData?.jobs || {})
    .filter((task) => isListingImportJob(task) && currentStoreId && String(task.storeId || "") === currentStoreId)
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
  const refreshableTasks = tasks.filter((task) => {
    const status = String(task.status || "").toUpperCase();
    const taskId = task.ozonTaskId || task.taskId;
    return taskId && ["QUEUE_PENDING", "QUEUED", "VALIDATING", "SUBMITTING", "OZON_ACCEPTED", "RUNNING", "PENDING", "PROCESSING", "CREATED", "CHECKING", "RETRY_PENDING", "RECONCILING"].includes(status);
  });
  const refreshableTaskKey = refreshableTasks.map((task) => task.ozonTaskId || task.taskId).join("|");
  const filteredTasks = tasks.filter((task) =>
    importTaskMatchesStatus(task, activeStatus) &&
    importTaskMatchesQuery(task, query) &&
    importTaskMatchesDateRange(task, dateRange),
  );
  const rows = importTaskRows(filteredTasks);
  const selectedDetailTask = detailTask
    ? tasks.find((task) => String(task.id || task.localTaskId || task.clientJobId) === String(detailTask.id || detailTask.localTaskId || detailTask.clientJobId)) || detailTask
    : null;
  const openImportTaskDetail = async (task) => {
    setDetailTask(task);
    if (task?.pipelineVersion !== "v3") return;
    try {
      const id = task.id || task.localTaskId || task.clientJobId;
      const result = await apiRequest(`/ozon/products/import/jobs/${encodeURIComponent(id)}`);
      if (result?.job) setDetailTask(result.job);
    } catch (error) {
      message.warning(`任务事件读取失败: ${error?.message || error}`);
    }
  };
  const detailStatusItems = selectedDetailTask?.statusResponse?.result?.items || selectedDetailTask?.statusResponse?.items || [];
  const detailStatusItem = detailStatusItems[0] || null;
  const importHistoryColumns = [
    "#",
    "商品信息",
    "源 SKU",
    "店铺",
    "变体",
    "售价",
    "状态",
    "创建时间",
    {
      title: "操作",
      dataIndex: "操作",
      width: 88,
      render: (_value, row) => (
        <Button type="link" size="small" onClick={() => openImportTaskDetail(row._task || row)}>查看</Button>
      ),
    },
  ];
  const completedCount = tasks.filter((task) => importTaskMatchesStatus(task, "已完成")).length;
  const partialCount = tasks.filter((task) => importTaskMatchesStatus(task, "部分成功")).length;
  const skippedCount = tasks.filter((task) => importTaskMatchesStatus(task, "已跳过")).length;
  const processingCount = tasks.filter((task) => importTaskMatchesStatus(task, "处理中")).length;
  const failedCount = tasks.filter((task) => importTaskMatchesStatus(task, "失败")).length;
  const todayKey = localDayFormatter.format(new Date());
  const todayCount = tasks.filter((task) => {
    const date = new Date(task.createdAt || "");
    return !Number.isNaN(date.getTime()) && localDayFormatter.format(date) === todayKey;
  }).reduce((sum, task) => sum + importTaskCount(task), 0);
  const finishedCount = completedCount + partialCount + skippedCount + failedCount;
  const successRate = finishedCount ? `${Math.round(((completedCount + partialCount) / finishedCount) * 100)}%` : "—";
  const resetFilters = () => {
    setActiveStatus("全部");
    setQuery("");
    setDateRange(null);
    message.success("已重置");
  };
  const runSearch = () => message.success(`查询完成 · ${rows.length} 条`);
  const refreshImportStatuses = async ({ silent = false } = {}) => {
    if (!hasStore) {
      if (!silent) message.warning("请先绑定门店");
      return;
    }
    if (statusRefreshInFlightRef.current) return;
    const targets = refreshableTasks;
    if (!targets.length) {
      if (!silent) message.info("暂无需要刷新的上架任务");
      return;
    }
    statusRefreshInFlightRef.current = true;
    setRefreshingStatus(true);
    if (!silent) {
      message.loading({ content: `正在刷新 ${targets.length} 个上架任务状态…`, key: "import-status-refresh", duration: 0 });
    }
    try {
      let ok = 0;
      let failed = 0;
      for (const task of targets) {
        try {
          await apiRequest("/ozon/products/import/status", {
            method: "POST",
            body: {
              task_id: task.ozonTaskId || task.taskId,
              storeId: binding?.id,
            },
          });
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      await onRefresh?.();
      if (silent) {
        return;
      }
      if (failed) {
        message.warning({ content: `状态刷新完成 · 成功 ${ok} · 失败 ${failed}`, key: "import-status-refresh" });
      } else {
        message.success({ content: `状态刷新完成 · ${ok} 个任务`, key: "import-status-refresh" });
      }
    } finally {
      statusRefreshInFlightRef.current = false;
      setRefreshingStatus(false);
    }
  };
  useEffect(() => {
    if (!hasStore || !refreshableTaskKey) return undefined;
    const firstRefreshTimer = window.setTimeout(() => {
      refreshImportStatuses({ silent: true });
    }, 1200);
    const timer = window.setInterval(() => {
      refreshImportStatuses({ silent: true });
    }, 15000);
    return () => {
      window.clearTimeout(firstRefreshTimer);
      window.clearInterval(timer);
    };
  }, [hasStore, refreshableTaskKey]);
  return (
    <div className="source-page">
      <div className="stat-strip">
        {[
          ["累计批次", String(tasks.length), "全部历史"],
          ["今日上品（含变体）", String(todayCount), todayCount ? "今日已提交" : "今日暂无"],
          ["处理中", String(processingCount), processingCount ? "当前有队列" : "当前无队列"],
          ["成功率", successRate, "基于已结束任务"],
        ].map(([title, value, note]) => (
          <Card className="stat-card" key={title}>
            <span>{title}</span>
            <strong>{value}</strong>
            <em>{note}</em>
          </Card>
        ))}
      </div>
      <Card className="panel-card source-card">
        <div className="filter-panel">
          <label>状态</label>
          <PromotionStatusButtons
            active={activeStatus}
            onChange={setActiveStatus}
            items={[
              { label: "全部", count: tasks.length, tone: "primary" },
              { label: "已完成", count: completedCount, tone: "success" },
              { label: "部分成功", count: partialCount, tone: "primary" },
              { label: "已跳过", count: skippedCount, tone: "default" },
              { label: "处理中", count: processingCount, tone: "primary" },
              { label: "失败", count: failedCount, tone: "danger" },
            ]}
          />
          <label>搜索</label>
          <Input.Search
            placeholder="搜索 SKU / 货号"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={runSearch}
          />
          <label>创建时间</label>
          <DatePicker.RangePicker value={dateRange} onChange={setDateRange} placeholder={["开始日期", "结束日期"]} />
          <Space>
            <Button onClick={resetFilters}>重 置</Button>
            <Button type="primary" onClick={runSearch}>查询</Button>
          </Space>
        </div>
      </Card>
      <Card className="panel-card source-card">
        <div className="table-action-row">
          <strong>导入批次列表 · 共 {rows.length} 条</strong>
          <Space>
            <Button icon={<SyncOutlined />} loading={refreshingStatus} onClick={refreshImportStatuses}>刷新状态</Button>
            <Button disabled>批量删除 (0)</Button>
            <Button>全部展开</Button>
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rows={rows}
          columns={importHistoryColumns}
          empty="暂无数据"
          sourceEmpty
          scrollX={1180}
        />
      </Card>
      <Modal
        rootClassName="prototype-overlay"
        title="上架任务详情"
        open={!!selectedDetailTask}
        onCancel={() => setDetailTask(null)}
        footer={<Button onClick={() => setDetailTask(null)}>关闭</Button>}
        width={720}
      >
        {selectedDetailTask ? (
          <div className="import-detail-panel">
            <div><span>任务类型</span><strong>{importTaskTypeLabel(selectedDetailTask)}</strong></div>
            <div><span>本地任务 ID</span><strong>{selectedDetailTask.localTaskId || selectedDetailTask.id || "—"}</strong></div>
            <div><span>Ozon 任务 ID</span><strong>{selectedDetailTask.ozonTaskId || selectedDetailTask.taskId || "—"}</strong></div>
            <div><span>源 SKU</span><strong>{importTaskSkuText(selectedDetailTask)}</strong></div>
            <div><span>状态</span><strong>{importTaskStatusLabel(selectedDetailTask.status)}</strong></div>
            <div><span>Ozon item 状态</span><strong>{detailStatusItem?.status || "—"}</strong></div>
            <div><span>offer_id</span><strong>{detailStatusItem?.offer_id || selectedDetailTask.items?.[0]?.offer_id || "—"}</strong></div>
            <div><span>product_id</span><strong>{detailStatusItem?.product_id || "—"}</strong></div>
            <div><span>商品数</span><strong>{selectedDetailTask.normalizedItemCount || selectedDetailTask.itemCount || "—"}</strong></div>
            <div><span>更新时间</span><strong>{selectedDetailTask.updatedAt ? new Date(selectedDetailTask.updatedAt).toLocaleString() : "—"}</strong></div>
            {selectedDetailTask.snapshot ? (
              <>
                <div><span>草稿版本</span><strong>v{selectedDetailTask.snapshot.draftVersion || 1}</strong></div>
                <div><span>快照哈希</span><strong>{selectedDetailTask.snapshot.hash?.slice(0, 16) || "—"}</strong></div>
              </>
            ) : null}
            <div className="wide"><span>状态说明</span><strong>{selectedDetailTask.statusMessage || "—"}</strong></div>
            <div className="wide">
              <span>错误信息</span>
              <strong>
                {selectedDetailTask.errorMessage ||
                  (Array.isArray(detailStatusItem?.errors) && detailStatusItem.errors.length
                    ? detailStatusItem.errors.map((item) => item.message || item.code || JSON.stringify(item)).join("；")
                    : "—")}
              </strong>
            </div>
            {detailStatusItems.length ? (
              <div className="wide">
                <span>商品处理明细</span>
                <Table
                  size="small"
                  pagination={false}
                  rowKey={(row, index) => `${row.offer_id || row.product_id || "item"}-${index}`}
                  dataSource={detailStatusItems}
                  scroll={{ x: 680 }}
                  columns={[
                    { title: "offer_id", dataIndex: "offer_id", width: 190 },
                    { title: "product_id", dataIndex: "product_id", width: 130, render: renderSourceTextCell },
                    { title: "处理结果", dataIndex: "status", width: 100, render: (value) => importItemStatusLabel(value) },
                    { title: "说明 / 错误", key: "message", width: 260, render: (_value, row) => importItemErrorText(row) },
                  ]}
                />
              </div>
            ) : null}
            {Array.isArray(selectedDetailTask.events) && selectedDetailTask.events.length ? (
              <div className="wide">
                <span>任务事件</span>
                <Table
                  size="small"
                  pagination={false}
                  rowKey="id"
                  dataSource={selectedDetailTask.events}
                  columns={[
                    { title: "时间", dataIndex: "createdAt", width: 170, render: (value) => value ? new Date(value).toLocaleString() : "—" },
                    { title: "状态", dataIndex: "toStatus", width: 130, render: importTaskStatusLabel },
                    { title: "说明", dataIndex: "message", render: renderSourceTextCell },
                  ]}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function StocksPage({ binding, hasStore, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [activeStock, setActiveStock] = useState("全部");
  const [query, setQuery] = useState("");
  const [pageSizeChoice, setPageSizeChoice] = useState("20");
  const [syncingStocks, setSyncingStocks] = useState(false);
  const [stockEditor, setStockEditor] = useState(null);
  const products = scopedProductsForCurrentStore(localData?.caches?.products || [], binding, localData);
  const stockTableProducts = products.filter(productVisibleInStockTable);
  const warehouses = scopedWarehousesForCurrentStore(localData?.caches?.warehouses || [], binding, localData);
  const outOfStockCount = stockTableProducts.filter((item) => productMatchesStockFilter(item, "缺货")).length;
  const lowStockCount = stockTableProducts.filter((item) => productMatchesStockFilter(item, "低库存")).length;
  const filteredProducts = stockTableProducts.filter((item) =>
    productMatchesQuery(item, query) && productMatchesStockFilter(item, activeStock)
  );
  const rows = productRows(filteredProducts, warehouses);
  const resolvedPageSize = pageSizeChoice === "全部" ? Math.max(rows.length, 1) : Number(pageSizeChoice) || 20;
  const openStockEditor = (row) => {
    const product = row?._raw || {};
    const entries = stockWarehouseEditorEntries(product, warehouses);
    setStockEditor({ row, product, entries });
  };
  const closeStockEditor = () => {
    setStockEditor(null);
  };
  const stockEditorEntries = stockEditor?.entries || [];
  const stockColumns = [
    {
      title: "主图",
      dataIndex: "_image",
      width: 72,
      ellipsis: false,
      render: (value) => (
        value ? (
          <img className="product-thumb" src={value} alt="" loading="lazy" />
        ) : (
          <span className="product-thumb product-thumb-empty">—</span>
        )
      ),
    },
    {
      title: "商品",
      dataIndex: "商品",
      width: 300,
      render: (value, row) => {
        const title = row._title || value || "—";
        const sku = row._sku || "";
        const offerId = row._offerId || "";
        return (
          <div className="product-info-cell">
            <span className="source-table-cell-text product-info-name" title={title}>{title}</span>
            {sku ? (
              <span className="product-sku-row">
                <span className="product-sku-text" title={sku}>SKU：{sku}</span>
                <SkuCopyButton message={message} sku={sku} />
              </span>
            ) : null}
            {offerId ? (
              <span className="product-sku-row">
                <span className="product-sku-text" title={offerId}>货号：{offerId}</span>
              </span>
            ) : null}
          </div>
        );
      },
    },
    "总库存",
    {
      title: "仓库分布",
      dataIndex: "仓库分布",
      width: 260,
      render: (value) => {
        const text = value === null || value === undefined || value === "" ? "—" : String(value);
        const lines = text === "—" ? ["—"] : text.split("\n").filter(Boolean);
        return (
          <div className="stock-warehouse-lines" title={text}>
            {lines.map((line) => <span key={line}>{line}</span>)}
          </div>
        );
      },
    },
    {
      title: "操作",
      dataIndex: "操作",
      width: 88,
      render: (_, row) => (
        <Button
          className="source-table-link"
          onClick={() => openStockEditor(row)}
          size="small"
          type="link"
        >
          查看
        </Button>
      ),
    },
  ];
  const refreshStocks = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingStocks) return;
    setSyncingStocks(true);
    message.loading({ content: "正在只读同步库存", key: "stocks-sync", duration: 0 });
    try {
      const storeId = localData?.currentStoreId || binding?.id;
      const warehouseReport = await apiRequest("/local/sync/WAREHOUSES", {
        method: "POST",
        body: { storeId },
      });
      const productReport = await apiRequest("/local/sync/PRODUCTS", {
        method: "POST",
        body: { storeId },
      });
      await onRefresh?.();
      const productCount = Number(productReport?.job?.fetchedCount ?? productReport?.fetchedCount) || 0;
      const warehouseCount = Number(warehouseReport?.job?.fetchedCount ?? warehouseReport?.fetchedCount) || 0;
      message.success({ content: `库存已刷新 · 商品 ${productCount} · 仓库 ${warehouseCount}`, key: "stocks-sync" });
    } catch (error) {
      message.error({ content: `库存同步失败: ${error.message}`, key: "stocks-sync" });
    } finally {
      setSyncingStocks(false);
    }
  };
  const searchStocks = () => message.success(`查询完成 · ${rows.length} 条`);
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="库存管理"
        subtitle="只读查看各商品库存与仓库分布；安全库存写入队列上线前暂不支持直接修改"
      />
      <div className="stock-top-grid">
        <Card className="panel-card source-card stock-main-card">
          <div className="card-title-row">
            <span>商品库存</span>
          </div>
          <div className="stock-summary-grid">
            {[
              ["商品总数", String(stockTableProducts.length), "销售中/准备销售商品"],
              ["缺货 (全部)", String(outOfStockCount), outOfStockCount ? "需补货" : "当前店铺无缺货"],
              ["低库存 ≤10 (全部)", String(lowStockCount), lowStockCount ? "需关注" : "当前店铺无低库存"],
            ].map(([title, value, note]) => (
              <div key={title}>
                <span>{title}</span>
                <strong>{value}</strong>
                <em>{note}</em>
              </div>
            ))}
          </div>
        </Card>
        <Card className="panel-card source-card stock-draft-card">
          <span>写入模式</span>
          <strong>只读</strong>
          <em>等待安全任务队列与对账流程</em>
        </Card>
      </div>
      <Card className="panel-card source-card">
        <div className="card-title-row">
          <span>库存</span>
          <Space>
            <Button loading={syncingStocks} onClick={refreshStocks} type="primary">刷新</Button>
          </Space>
        </div>
        <div className="filter-panel inline">
          <PromotionStatusButtons
            active={activeStock}
            onChange={setActiveStock}
            items={[
              { label: "全部", count: stockTableProducts.length, tone: "primary" },
              { label: "缺货", count: outOfStockCount, tone: "primary" },
              { label: "低库存", count: lowStockCount, tone: "primary" },
            ]}
          />
          <Input.Search
            placeholder="搜索商品名 / 货号"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={searchStocks}
          />
        </div>
        <div className="table-result-title">商品库存· 共 {rows.length} 条</div>
        <SourceTable
          hasStore={hasStore}
          key={`${activeStock}-${query}-${pageSizeChoice}`}
          rows={rows}
          columns={stockColumns}
          pageSize={resolvedPageSize}
          pageSizeControl={(
            <div className="product-page-size-control">
              <span>每页显示</span>
              <Select
                size="small"
                value={pageSizeChoice}
                options={[
                  { value: "20", label: "20" },
                  { value: "50", label: "50" },
                  { value: "100", label: "100" },
                  { value: "全部", label: "全部" },
                ]}
                onChange={setPageSizeChoice}
                popupMatchSelectWidth={false}
              />
            </div>
          )}
          empty={false}
          sourceEmpty
        />
      </Card>
      <Modal
        rootClassName="prototype-overlay"
        title="查看 SKU 库存"
        open={!!stockEditor}
        onCancel={closeStockEditor}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <div className="stock-edit-modal">
          <div className="product-price-modal-head">
            <strong title={stockEditor?.row?._title}>{stockEditor?.row?._title || "—"}</strong>
            <span>SKU：{stockEditor?.row?._sku || "—"}</span>
            <span>货号：{stockEditor?.row?._offerId || "—"}</span>
          </div>
          <Alert
            message="当前为只读模式。为避免网络超时造成重复写入，单独修改库存功能将在持久化任务和对账流程完成后开放。"
            showIcon
            type="info"
          />
          <Table
            size="small"
            pagination={false}
            rowKey="key"
            dataSource={stockEditorEntries}
            columns={[
              {
                title: "仓库",
                dataIndex: "label",
                render: (value, entry) => (
                  <div className="stock-edit-warehouse">
                    <strong title={value}>{value}</strong>
                    <span>{entry.warehouseId ? `仓库 ID：${entry.warehouseId}` : "缺少仓库 ID"}</span>
                  </div>
                ),
              },
              {
                title: "当前库存",
                dataIndex: "present",
                width: 100,
              },
              {
                title: "预留",
                dataIndex: "reserved",
                width: 90,
              },
              {
                title: "写入状态",
                dataIndex: "writeStatus",
                width: 140,
                render: () => <Tag>只读</Tag>,
              },
            ]}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无库存明细" />,
            }}
          />
        </div>
      </Modal>
    </div>
  );
}

function ReshelfPage({ binding, hasStore, localData, onSync }) {
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState("");
  const products = localData?.caches?.products || [];
  const rows = productRows(products.filter((item) => productMatchesQuery(item, query)));
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="下架重上"
        subtitle={storeLine(binding)}
        actions={[
          <Button danger disabled key="reshelf">下架重上</Button>,
          <Button type="primary" icon={<SyncOutlined />} onClick={onSync} key="sync">同步全部</Button>,
        ]}
      />
      <Card className="panel-card source-card">
        <div className="table-action-row">
          <Input.Search
            className="toolbar-search"
            placeholder="搜 SKU / 货号 / 标题…"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => message.success(`查询完成 · ${rows.length} 条`)}
          />
          <div className="table-result-title">共 {rows.length} 个</div>
        </div>
        <SourceTable
          hasStore={hasStore}
          rows={rows}
          columns={["商品信息", "类目佣金", "店铺", "状态", "下架原因", "价格", "库存", "货源 (¥)", "最后同步", "操作"]}
          empty={false}
          sourceEmpty
          scrollX={1480}
        />
      </Card>
    </div>
  );
}

function AiPosterPage({ localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [imageLinks, setImageLinks] = useState("");
  const [uploadedImageCount, setUploadedImageCount] = useState(0);
  const [status, setStatus] = useState("全部状态");
  const [productName, setProductName] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [query, setQuery] = useState("");
  const [dateStart, setDateStart] = useState(null);
  const [dateEnd, setDateEnd] = useState(null);
  const [submittingAiTask, setSubmittingAiTask] = useState(false);
  const parsedImageLinks = imageLinks
    .split(/[\n\r,\s]+/)
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value))
    .slice(0, 10);
  const imageCount = Math.min(10, uploadedImageCount + parsedImageLinks.length);
  const submitCost = imageCount ? imageCount : 0;
  const aiJobs = Object.values(localData?.jobs || {})
    .filter((job) => String(job.type || "").toUpperCase() === "AI_POSTER")
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
  const aiStatusText = (job = {}) => {
    const raw = String(job.status || "").toUpperCase();
    if (["SUCCESS", "COMPLETED", "DONE"].includes(raw)) return "已完成";
    if (["FAILED", "ERROR"].includes(raw)) return "失败";
    return "处理中";
  };
  const filteredAiJobs = aiJobs.filter((job) => {
    const statusText = aiStatusText(job);
    const createdAt = new Date(job.createdAt || "");
    const createdMs = createdAt.getTime();
    const start = pickerBoundaryMs(dateStart, "start");
    const end = pickerBoundaryMs(dateEnd, "end");
    const queryText = String(query || "").trim().toLowerCase();
    const searchable = [job.clientJobId, job.id, job.productName, job.categoryName]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    return (status === "全部状态" || statusText === status) &&
      (!queryText || searchable.includes(queryText)) &&
      (start == null || (!Number.isNaN(createdMs) && createdMs >= start)) &&
      (end == null || (!Number.isNaN(createdMs) && createdMs <= end));
  });
  const rows = filteredAiJobs.map((job, index) => ({
    id: job.id || job.clientJobId || `ai-poster-${index}`,
    "原图": `${Number(job.imageCount || 0)} 张`,
    "改图结果": aiStatusText(job) === "已完成" ? "已生成" : "本地记录",
    "货号": job.productName || job.clientJobId || "本地任务",
    "状态": aiStatusText(job),
    "创建时间": job.createdAt ? new Date(job.createdAt).toLocaleString() : "—",
    "操作": "查看",
  }));
  const submitAiTask = async () => {
    if (!imageCount) {
      message.warning("请先上传图片或填写图片链接");
      return;
    }
    setSubmittingAiTask(true);
    try {
      const clientJobId = `ai-poster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await apiRequest("/ozon/sync/client-report", {
        method: "POST",
        body: {
          clientJobId,
          type: "AI_POSTER",
          status: "PENDING",
          imageCount,
          uploadedImageCount,
          linkCount: parsedImageLinks.length,
          productName: productName.trim(),
          categoryName: categoryName.trim(),
          localOnly: true,
        },
      });
      setImageLinks("");
      setUploadedImageCount(0);
      await onRefresh?.();
      message.success(`AI 改图任务已记录 · ${imageCount} 张`);
    } catch (error) {
      message.error(`任务记录失败: ${error.message}`);
    } finally {
      setSubmittingAiTask(false);
    }
  };
  const resetFilters = () => {
    setQuery("");
    setDateStart(null);
    setDateEnd(null);
    setStatus("全部状态");
    message.info("筛选条件已重置");
  };
  const addImageFiles = (files) => {
    const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    setUploadedImageCount((current) => {
      const next = Math.min(10, current + imageFiles.length);
      message.success(`已识别 ${next} 张图片`);
      return next;
    });
  };
  return (
    <div className="source-page ai-page">
      <SourceSectionTitle
        title="AI 改图神器"
        subtitle="Gemini 大模型改图历史 · 原图 vs 改图 实时对比"
        actions={[<Select className="source-select narrow" key="status" value={status} onChange={setStatus} options={[{ value: "全部状态", label: "全部状态" }, { value: "处理中", label: "处理中" }, { value: "已完成", label: "已完成" }, { value: "失败", label: "失败" }]} />]}
      />
      {!collapsed ? (
        <Card className="panel-card ai-upload">
          <div className="card-title-row">
            <span>Gemini 快速改图 <em>上传图片或粘贴图片链接,无需绑定商品</em></span>
            <Button onClick={() => setCollapsed(true)}>收起</Button>
          </div>
          <div className="ai-upload-label">上传图片</div>
          <label
            className="upload-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              addImageFiles(event.dataTransfer.files);
            }}
            onPaste={(event) => addImageFiles(event.clipboardData.files)}
          >
            <input
              className="upload-drop-input"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                addImageFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <PictureOutlined />
            <strong>点击、拖拽,或 Ctrl/⌘+V 粘贴图片</strong>
            <span>支持多张,单次最多 10 张</span>
          </label>
          <div className="ai-work-grid">
            <div className="ai-link-panel">
              <label>或粘贴图片链接</label>
              <Input.TextArea
                rows={5}
                placeholder={"每行一个图片链接,http(s)://...\nhttps://example.com/a.jpg"}
                value={imageLinks}
                onChange={(event) => setImageLinks(event.target.value)}
              />
            </div>
            <div className="ai-queue-panel">
              <strong>已识别 {imageCount} 条</strong>
              <span>待处理图片{imageCount} / 10</span>
              <p>上传 / 拖拽 / Ctrl·⌘+V 粘贴图片,或在右侧粘贴图片链接 —— 都会汇总到这里</p>
            </div>
          </div>
          <div className="ai-meta-row">
            <label className="ai-meta-field">
              <span>商品名(可选)</span>
              <Input placeholder="例:女士夏季短袖 T 恤" allowClear value={productName} onChange={(event) => setProductName(event.target.value)} />
            </label>
            <label className="ai-meta-field">
              <span>类目(可选)</span>
              <Input placeholder="例:服饰 / 电子 / 家居" allowClear value={categoryName} onChange={(event) => setCategoryName(event.target.value)} />
            </label>
            <Tag className="ai-submit-summary">将提交 {imageCount} 张,预计消耗 {submitCost}</Tag>
          </div>
          <Space>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={submittingAiTask}
              onClick={submitAiTask}
            >
              开始生成
            </Button>
          </Space>
        </Card>
      ) : (
        <Button icon={<PictureOutlined />} onClick={() => setCollapsed(false)}>展开上传</Button>
      )}
      <Card className="panel-card source-card">
        <div className="filter-panel inline">
          <DatePicker placeholder="开始日期" value={dateStart} onChange={setDateStart} />
          <DatePicker placeholder="结束日期" value={dateEnd} onChange={setDateEnd} />
          <Input.Search placeholder="搜索货号" allowClear value={query} onChange={(event) => setQuery(event.target.value)} onSearch={() => message.success(`查询完成 · ${rows.length} 条`)} />
          <Button type="primary" onClick={() => message.success(`查询完成 · ${rows.length} 条`)}>查询</Button>
          <Button onClick={resetFilters}>重置</Button>
        </div>
        <SourceTable
          hasStore
          rows={rows}
          rowSelection={false}
          columns={["原图", "改图结果", "货号", "状态", "创建时间", "操作"]}
          empty="暂无改图记录"
          sourceEmpty
        />
      </Card>
    </div>
  );
}

function AiImagePage() {
  return (
    <div className="ai-image-gated-page">
      <div className="ai-image-gated-content">
        <AppstoreOutlined />
        <h2>AI 商品套图</h2>
        <p>该功能正在灰度内测中，尚未对当前账号开放。</p>
      </div>
    </div>
  );
}

function SourceQueryBar({
  fields = [],
  buttons = [],
  expanded,
  onToggle,
  onReset,
  onSearch,
  values = {},
  onFieldChange,
}) {
  return (
    <Card className="panel-card source-card">
      <div className="source-query-grid">
        {fields.map((field) => (
          <label key={field.name}>
            <span>{field.label}</span>
            {field.type === "select" ? (
              <Select
                placeholder={field.placeholder || "请选择"}
                options={field.options || []}
                allowClear
                value={values[field.name]}
                onChange={(value) => onFieldChange?.(field.name, value)}
              />
            ) : (
              <Input
                placeholder={field.placeholder || "请输入"}
                allowClear
                value={values[field.name]}
                onChange={(event) => onFieldChange?.(field.name, event.target.value)}
              />
            )}
          </label>
        ))}
        <Space className="source-query-actions">
          {buttons.includes("重 置") ? <Button onClick={onReset}>重 置</Button> : null}
          {buttons.includes("查 询") ? <Button type="primary" onClick={onSearch}>查 询</Button> : null}
          {onToggle ? (
            <Button type="link" onClick={onToggle}>
              {expanded ? "收起" : "展开"}
            </Button>
          ) : null}
        </Space>
      </div>
    </Card>
  );
}

function SourcePager({ current = 1, total = 1, pageSize = 20 }) {
  return (
    <div className="source-pager">
      <span>共 0 条 · 第 {current} / {total} 页</span>
      <Space size={4}>
        <Button size="small">‹</Button>
        <Button size="small" type="primary">{current}</Button>
        <Button size="small">›</Button>
      </Space>
      <span>每页</span>
      <Select
        size="small"
        value={pageSize}
        options={[10, 20, 50, 100].map((value) => ({ value, label: `${value}` }))}
      />
      <span>条</span>
    </div>
  );
}

function PriceDiscountPage({ hasStore, binding, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [activeTab, setActiveTab] = useState("价格");
  const [query, setQuery] = useState("");
  const [draftIds, setDraftIds] = useState([]);
  const [syncingProducts, setSyncingProducts] = useState(false);
  const products = localData?.caches?.products || [];
  const draftIdSet = useMemo(() => new Set(draftIds), [draftIds]);
  const visibleProducts = products
    .filter((item) => productMatchesQuery(item, query))
    .filter((item, index) => {
      if (activeTab !== "改价草稿") return true;
      const id = item.id || item.product_id || item.offer_id || `price-product-${index}`;
      return draftIdSet.has(String(id));
    });
  const rows = priceDiscountRows(visibleProducts, activeTab).map((row) => ({
    ...row,
    _drafted: draftIdSet.has(String(row.id)),
  }));
  const syncProducts = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingProducts) return;
    setSyncingProducts(true);
    try {
      message.loading({ content: "正在只读同步商品价格", key: "price-products-sync", duration: 0 });
      const response = await apiRequest("/local/sync/PRODUCTS", { method: "POST", body: { storeId: binding?.id } });
      await onRefresh?.();
      const fetched = Number(response?.job?.fetchedCount ?? response?.fetchedCount) || 0;
      message.success({ content: `商品价格已刷新 · ${fetched} 条`, key: "price-products-sync" });
    } catch (error) {
      message.error({ content: `刷新失败: ${error.message}`, key: "price-products-sync" });
    } finally {
      setSyncingProducts(false);
    }
  };
  const addDraft = (record) => {
    const id = String(record.id);
    setDraftIds((current) => current.includes(id) ? current : [...current, id]);
    message.success("已加入本地改价草稿");
  };
  const removeDraft = (record) => {
    const id = String(record.id);
    setDraftIds((current) => current.filter((item) => item !== id));
    message.success("已移出草稿");
  };
  const openBuyerView = (record) => {
    const url = record._raw?.url || record._raw?.product_url || record._raw?.productUrl || record._raw?.link;
    if (!url) {
      message.info("暂无买家页链接");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const priceColumns = [
    "主图",
    "商品",
    "当前价格",
    ...(activeTab === "折扣" ? ["划线价", "折扣"] : []),
    ...(activeTab === "选择商品" ? ["库存", "状态"] : []),
    ...(activeTab === "改价草稿" ? ["目标价格", "草稿状态"] : []),
    {
      title: "操作",
      dataIndex: "操作",
      width: activeTab === "改价草稿" ? 112 : 156,
      render: (_value, record) => activeTab === "改价草稿" ? (
        <Button type="link" size="small" onClick={() => removeDraft(record)}>移出草稿</Button>
      ) : (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => openBuyerView(record)}>买家看</Button>
          <Button type="link" size="small" onClick={() => addDraft(record)} disabled={record._drafted}>改价</Button>
        </Space>
      ),
    },
  ];
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="价格与折扣"
        subtitle="从商品列表选品并设置售价 / 划线价 / 折扣,先加入草稿,确认无误后一键同步到 Ozon。"
      />
      <Card className="panel-card source-card">
        <SourceLineTabs
          active={activeTab}
          onChange={setActiveTab}
          items={["价格", "折扣", "选择商品", "改价草稿"]}
        />
        <div className="table-action-row">
          <label className="source-inline-field">
            <span>搜索</span>
            <Input
              className="toolbar-search"
              placeholder="请输入"
              allowClear
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Space>
            <Button onClick={() => {
              setQuery("");
              message.success("已重置");
            }}>重 置</Button>
            <Button type="primary" onClick={() => message.success(`查询完成 · ${rows.length} 条`)}>查 询</Button>
            <Button loading={syncingProducts} onClick={syncProducts}>刷新</Button>
            {activeTab === "改价草稿" ? (
              <Button disabled={!draftIds.length} onClick={() => {
                setDraftIds([]);
                message.success("草稿已清空");
              }}>
                清空草稿
              </Button>
            ) : null}
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rows={rows}
          rowSelection={false}
          loading={syncingProducts}
          columns={priceColumns}
          empty="暂无数据"
          sourceEmpty
          scrollX={1120}
        />
      </Card>
    </div>
  );
}

function CampaignsPage({ hasStore, binding, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [activeStatus, setActiveStatus] = useState("全部");
  const [query, setQuery] = useState("");
  const [syncingPromotions, setSyncingPromotions] = useState(false);
  const promotions = localData?.caches?.promotions || [];
  const counts = {
    total: promotions.length,
    participating: promotions.filter((item) => item.is_participating).length,
    available: promotions.filter((item) => !item.is_participating && (Number(item.potential_products_count) || 0) > 0).length,
    endingSoon: promotions.filter(promotionIsEndingSoon).length,
  };
  const filteredPromotions = promotions.filter((promotion) => {
    if (!promotionMatchesQuery(promotion, query)) return false;
    if (activeStatus === "参与中") return Boolean(promotion.is_participating);
    if (activeStatus === "可参与") return !promotion.is_participating && (Number(promotion.potential_products_count) || 0) > 0;
    if (activeStatus === "即将结束") return promotionIsEndingSoon(promotion);
    return true;
  });
  const rows = promotionRows(filteredPromotions);
  const syncPromotions = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingPromotions) return;
    setSyncingPromotions(true);
    try {
      message.loading({ content: "正在只读同步促销活动", key: "promotions-sync", duration: 0 });
      await apiRequest("/local/sync/PROMOTIONS", { method: "POST", body: { storeId: binding?.id } });
      await onRefresh?.();
      message.success({ content: "促销活动已同步", key: "promotions-sync" });
    } catch (error) {
      message.error({ content: `同步失败: ${error.message}`, key: "promotions-sync" });
    } finally {
      setSyncingPromotions(false);
    }
  };
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="促销活动"
        subtitle="实时同步 Ozon 平台促销活动，掌握参与状态、商品数量与活动周期"
      />
      <SourceMetricStrip
        items={[
          ["全部活动", String(counts.total), "平台当前可见活动"],
          ["参与中", String(counts.participating), counts.participating ? "本店已参与" : "暂未参与"],
          ["可参与", String(counts.available), counts.available ? "可加入活动" : "尚未加入"],
          ["即将结束（7天内）", String(counts.endingSoon), counts.endingSoon ? "需关注" : "暂无临期活动"],
        ]}
      />
      <Card className="panel-card source-card">
        <div className="filter-panel inline">
          <span className="source-filter-label">筛选</span>
          <Input.Search
            className="toolbar-search"
            placeholder="搜索活动名称 / ID"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => message.success(`查询完成 · ${rows.length} 条`)}
          />
          <PromotionStatusButtons
            active={activeStatus}
            onChange={setActiveStatus}
            items={[
              { label: "全部", count: counts.total },
              { label: "参与中", count: counts.participating },
              { label: "可参与", count: counts.available },
              { label: "即将结束", count: counts.endingSoon },
            ]}
          />
          <Button loading={syncingPromotions} onClick={syncPromotions}>刷新</Button>
        </div>
      </Card>
      <Card className="panel-card source-card">
        <div className="table-result-title">活动列表· 共 {rows.length} 条</div>
        <SourceTable
          hasStore={hasStore}
          rows={rows}
          rowSelection={false}
          columns={["活动", "状态", "折扣", "商品", "活动周期", "操作"]}
          empty="暂无数据"
          sourceEmpty
          scrollX={1050}
          showPageSizeText
        />
      </Card>
    </div>
  );
}

function AutoDeletePromoPage({ hasStore, binding, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [queryExpanded, setQueryExpanded] = useState(false);
  const [syncingPromotions, setSyncingPromotions] = useState(false);
  const [filters, setFilters] = useState({ name: "", type: undefined, status: undefined });
  const promotions = localData?.caches?.promotions || [];
  const storeLabel = hasStore ? (binding?.storeName || binding?.storeId || "当前店铺") : "加载店铺中…";
  const typeOptions = Array.from(new Set(promotions.map(promotionTypeText).filter((value) => value && value !== "—")))
    .map((value) => ({ value, label: value }));
  const statusOptions = Array.from(new Set(promotions.map(promotionStatusLabel).filter(Boolean)))
    .map((value) => ({ value, label: value }));
  const filteredPromotions = promotions.filter((promotion) => {
    const matchesName = promotionMatchesQuery(promotion, filters.name);
    const matchesType = !filters.type || promotionTypeText(promotion) === filters.type;
    const matchesStatus = !filters.status || promotionStatusLabel(promotion) === filters.status;
    return matchesName && matchesType && matchesStatus;
  });
  const rows = autoDeletePromotionRows(filteredPromotions);
  const warnReadonly = () => message.warning("本地复刻仅做只读验证，自动删促销写入已禁用");
  const updateFilter = (name, value) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };
  const resetFilters = () => {
    setFilters({ name: "", type: undefined, status: undefined });
    message.success("已重置");
  };
  const syncPromotions = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingPromotions) return;
    setSyncingPromotions(true);
    try {
      message.loading({ content: "正在只读同步促销活动", key: "auto-delete-promotions-sync", duration: 0 });
      await apiRequest("/local/sync/PROMOTIONS", { method: "POST", body: { storeId: binding?.id } });
      await onRefresh?.();
      message.success({ content: "促销活动已同步", key: "auto-delete-promotions-sync" });
    } catch (error) {
      message.error({ content: `同步失败: ${error.message}`, key: "auto-delete-promotions-sync" });
    } finally {
      setSyncingPromotions(false);
    }
  };
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="促销活动自动清理 · 利润保护"
        subtitle="按设定频率自动检测各店铺正在参与的促销，将折扣力度 ≥「最大可接受折扣」的活动商品自动移出，避免被过深折扣拖垮利润。检测在服务端定时执行，无需保持页面打开。 首次使用请先点下方「从 Ozon 同步」拉取当前店铺的促销活动。"
      />
      <Card className="panel-card source-card auto-delete-config-card">
        <div className="card-title-row">
          <span>自动清理配置</span>
          <Tag>{storeLabel}</Tag>
        </div>
        <div className="auto-delete-config-grid">
          <label className="auto-delete-config-item switch-item">
            <span>自动清理</span>
            <Switch checked={false} checkedChildren="开" unCheckedChildren="关" onChange={warnReadonly} />
          </label>
          <label className="auto-delete-config-item">
            <span>最大可接受折扣 %</span>
            <Input value="30" onChange={warnReadonly} />
          </label>
          <label className="auto-delete-config-item">
            <span>检测频率</span>
            <Select
              value="daily"
              options={[{ value: "daily", label: "每天一次" }]}
              onChange={warnReadonly}
            />
          </label>
        </div>
      </Card>
      <SourceQueryBar
        fields={[
          { label: "活动名称", name: "name", placeholder: "请输入" },
          { label: "类型", name: "type", type: "select", placeholder: "请选择", options: typeOptions },
          ...(queryExpanded
            ? [
                { label: "状态", name: "status", type: "select", placeholder: "请选择", options: statusOptions },
              ]
            : []),
        ]}
        buttons={["重 置", "查 询"]}
        expanded={queryExpanded}
        values={filters}
        onFieldChange={updateFilter}
        onToggle={() => setQueryExpanded((value) => !value)}
        onReset={resetFilters}
        onSearch={() => message.success(`查询完成，共 ${rows.length} 条`)}
      />
      <Card className="panel-card source-card">
        <div className="table-action-row">
          <strong>当前店铺促销活动 · 共 {rows.length} 条</strong>
          <Space>
            <Button loading={syncingPromotions} onClick={syncPromotions}>从 Ozon 同步</Button>
            <Button loading={syncingPromotions} onClick={syncPromotions}>刷新</Button>
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rows={rows}
          loading={syncingPromotions}
          rowSelection={false}
          columns={["活动名称", "类型", "折扣力度", "商品数量", "有效期", "状态", "操作"]}
          empty={hasStore ? "暂无促销活动，请先从 Ozon 同步" : "请先绑定门店"}
          sourceEmpty
          scrollX={1080}
        />
      </Card>
    </div>
  );
}

function PostingsPage({ binding, hasStore, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [activeStatus, setActiveStatus] = useState("所有订单");
  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState(null);
  const [syncingPostings, setSyncingPostings] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  const summary = localData?.summary || emptyLocalData.summary;
  const postings = localData?.caches?.postings || [];
  const statusCounts = summary.statusCounts || {};
  const statusItems = postingStatusTabs.map((label) => ({
    label,
    count: postingStatusCount(postings, statusCounts, label),
  }));
  const filteredPostings = postings.filter((posting) =>
    postingMatchesTab(posting, activeStatus) &&
    postingMatchesQuery(posting, query) &&
    postingMatchesDateRange(posting, dateRange),
  );
  const rows = postingRows(filteredPostings);
  const orderColumns = ["倒计时", "货件 / 状态", "店铺", "商品", "仓库 / 配送", "订单金额", "利润", "操作"];

  const syncPostings = async (days, successText) => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingPostings) return;
    setSyncingPostings(true);
    message.loading({ content: "正在只读同步订单", key: "postings-sync", duration: 0 });
    try {
      const report = await apiRequest("/local/sync/POSTINGS", {
        method: "POST",
        body: { storeId: binding?.id, postingsSinceDays: days },
      });
      await onRefresh?.();
      const fetched = Number(report?.fetchedCount) || 0;
      message.success({ content: `${successText} · ${fetched} 条`, key: "postings-sync" });
    } catch (error) {
      message.error({ content: `同步失败: ${error.message}`, key: "postings-sync" });
    } finally {
      setSyncingPostings(false);
    }
  };

  const resetFilters = () => {
    setQuery("");
    setDateRange(null);
    setActiveStatus("所有订单");
    message.success("已重置");
  };

  const exportOrders = () => {
    if (!rows.length) {
      message.warning("暂无可导出的数据");
      return;
    }
    downloadCsv(`qh-orders-${localDayFormatter.format(new Date())}.csv`, orderColumns, rows);
    message.success(`已导出 ${rows.length} 条订单`);
  };

  return (
    <div className="source-page">
      <SourceSectionTitle
        title="订单"
        subtitle={`${formatDate()} · ${binding?.storeName || "当前店铺"} · 已关闭自动同步`}
        actions={[
          <Button key="refresh" loading={syncingPostings} onClick={() => syncPostings(30, "订单已刷新")}><span>刷新</span></Button>,
          <Button className="dark-action-button" key="pull" loading={syncingPostings} onClick={() => syncPostings(1, "最新订单已拉取")}>拉取最新订单</Button>,
          <Button key="doing" loading={syncingPostings} onClick={() => syncPostings(7, "进行中订单已刷新")}>刷新进行中订单</Button>,
        ]}
      />
      <Alert
        type="info"
        showIcon
        message="同步范围：已同步过：上次同步前 1 天至现在；首次同步：最近 30 天至现在"
      />
      <SourceMetricStrip
        items={[
          ["本周 GMV", dashboardSummaryMoney(summary, "week"), "当前店铺"],
          ["本周利润", "¥—", "当前店铺"],
          ["本周利润率", "—%", "当前店铺"],
          ["待处理", String(summary.pendingPostings || 0), (summary.pendingPostings || 0) ? "需及时处理" : "↑ 全部已处理"],
        ]}
      />
      <Card className="panel-card source-card">
        <SourceStatusTabs
          active={activeStatus}
          onChange={setActiveStatus}
          items={statusItems}
        />
        <div className="table-action-row">
          <Space wrap>
            <Select className="source-select" value="current" options={[{ value: "current", label: "当前店铺" }]} />
            <Select className="source-select narrow" value="postingNumber" options={[{ value: "postingNumber", label: "货件编号" }]} />
            <Input
              className="toolbar-search wide"
              placeholder="搜索货件号 / SKU / 货号 / 物流单号…"
              allowClear
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onPressEnter={() => message.success(`筛选完成 · ${rows.length} 条`)}
            />
            <DatePicker.RangePicker value={dateRange} onChange={setDateRange} placeholder={["下单时间", "结束时间"]} />
            <Button onClick={() => message.success(`筛选完成 · ${rows.length} 条`)}>筛 选</Button>
            <Button onClick={resetFilters}>重 置</Button>
            <Button className="warning-action-button" onClick={exportOrders}>订单导出</Button>
          </Space>
          <Space>
            <span className="sync-label">自动同步</span>
            <Switch
              size="small"
              checked={autoSync}
              onChange={(checked) => {
                setAutoSync(checked);
                message.info(checked ? "已开启本地自动同步开关" : "已关闭自动同步");
              }}
            />
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rows={rows}
          columns={orderColumns}
          empty="暂无数据"
          sourceEmpty
          scrollX={1280}
        />
      </Card>
      <SourceMetricStrip
        items={[
          ["近 7 天订单", "—", "当前筛选"],
          ["客单价", "¥—", "当前筛选"],
          ["当前筛选", `${rows.length}`, "条订单"],
          ["待处理", "0", "已关闭自动同步"],
        ]}
      />
    </div>
  );
}

function ReturnsPage({ binding, hasStore, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [activeType, setActiveType] = useState("退货申请 (rFBS)");
  const [query, setQuery] = useState("");
  const [syncingReturns, setSyncingReturns] = useState(false);
  const returnItems = [
    ...(localData?.caches?.returns || []),
    ...(localData?.caches?.refunds || []),
  ];
  const visibleItems = returnItems.filter((item) => returnTypeMatches(item, activeType) && returnMatchesQuery(item, query));
  const rows = returnRows(visibleItems);
  const pendingApprovalCount = visibleItems.filter(returnIsPendingApproval).length;
  const waitingReturnCount = visibleItems.filter(returnIsWaitingReturn).length;
  const waitingRefundCount = visibleItems.filter(returnIsWaitingRefund).length;
  const refreshReturns = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingReturns) return;
    setSyncingReturns(true);
    try {
      const response = await apiRequest(`/ozon/returns?type=${encodeURIComponent(activeType)}&q=${encodeURIComponent(query)}`);
      await onRefresh?.();
      message.success(`退货缓存已刷新 · ${Number(response?.total) || 0} 条`);
    } catch (error) {
      message.error(`刷新失败: ${error.message}`);
    } finally {
      setSyncingReturns(false);
    }
  };
  const runSearch = () => message.success(`搜索完成 · ${rows.length} 条`);
  const resetReturns = () => {
    setQuery("");
    message.success("已重置");
  };
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="退货 / 退款"
        subtitle={`${formatDate()} · ${binding?.storeName || "—"} · 透传 Ozon API,刷新即同步`}
        actions={[<Button key="refresh" loading={syncingReturns} onClick={refreshReturns}>刷新</Button>]}
      />
      <SourceMetricStrip
        items={[
          ["本页申请数", String(rows.length), "已到末页"],
          ["待审批", String(pendingApprovalCount), pendingApprovalCount ? "需处理" : "无待处理"],
          ["等待退货", String(waitingReturnCount), waitingReturnCount ? "等待买家退回" : "无"],
          ["等待退款", String(waitingRefundCount), waitingRefundCount ? "需跟进退款" : "无"],
        ]}
      />
      <Card className="panel-card source-card">
        <SourceStatusTabs
          active={activeType}
          onChange={setActiveType}
          items={["退货申请 (rFBS)", "FBS", "FBO"]}
        />
        <div className="table-action-row">
          <Space>
            <Input
              className="toolbar-search wide"
              placeholder="搜索货件号 / 货号 / SKU"
              allowClear
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onPressEnter={runSearch}
            />
            <Button className="dark-action-button" onClick={runSearch}>搜 索</Button>
            <Button onClick={resetReturns}>重 置</Button>
          </Space>
          <Tag>{returnItems.length ? "本地缓存,按当前店铺过滤" : "暂无本地退货缓存"}</Tag>
        </div>
        <SourceTable
          hasStore={hasStore}
          rowSelection={false}
          rows={rows}
          columns={["申请 / 货件", "店铺", "商品", "申请时间", "操作"]}
          empty="暂无数据"
          sourceEmpty
          scrollX={980}
        />
        <div className="source-pager">
          <span>第 1 页</span>
          <span>·</span>
          <span>本页 {rows.length} 条</span>
          <span>20/页</span>
          <Button size="small" disabled>上一页</Button>
          <Button size="small" type="primary" disabled>下一页</Button>
        </div>
      </Card>
    </div>
  );
}

function MessageTaskPage({ type, hasStore, binding, localData, onRefresh, navigate }) {
  const isReview = type === "review";
  const { message } = AntApp.useApp();
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [taskOpen, setTaskOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [syncingPostings, setSyncingPostings] = useState(false);
  const [filters, setFilters] = useState({
    postingNumber: "",
    extra: "",
    productName: "",
    sku: "",
  });
  const postings = localData?.caches?.postings || [];
  const messageHistory = localData?.caches?.messageHistory || [];
  const localRecords = messageHistory.filter((item) => item.kind === type);
  const candidatePostings = messageTaskPostings(postings, type);
  const rows = messageTaskRows(candidatePostings, type).filter((row) =>
    rowMatchesAllTerms(row, [filters.postingNumber, filters.extra, filters.productName, filters.sku])
  );
  const selectedRows = rows.filter((row) => selectedRowKeys.includes(row.id));
  const showTaskMonitor = () => {
    setTaskOpen(true);
  };
  const showTemplateModal = () => {
    setTemplateOpen(true);
  };
  const handleSync = async (label) => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingPostings) return;
    setSyncingPostings(true);
    message.loading({ content: "正在只读同步订单", key: `message-task-sync-${type}`, duration: 0 });
    try {
      const report = await apiRequest("/local/sync/POSTINGS", {
        method: "POST",
        body: { storeId: binding?.id, postingsSinceDays: label.includes("全部") ? 60 : 30 },
      });
      await onRefresh?.();
      const fetched = Number(report?.fetchedCount) || 0;
      message.success({ content: `${label}已同步 · ${fetched} 条`, key: `message-task-sync-${type}` });
    } catch (error) {
      message.error({ content: `同步失败: ${error.message}`, key: `message-task-sync-${type}` });
    } finally {
      setSyncingPostings(false);
    }
  };
  const updateFilter = (name, value) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };
  const resetFilters = () => {
    setFilters({ postingNumber: "", extra: "", productName: "", sku: "" });
    setSelectedRowKeys([]);
    message.success("已重置");
  };
  const recordLocalSend = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (!selectedRows.length) {
      message.warning("请先选择数据");
      return;
    }
    const templateName = isReview ? "索要好评" : "提醒取货";
    const content = isReview
      ? "本地记录：索要好评邀请未真实发送"
      : "本地记录：取货提醒未真实发送";
    try {
      await apiRequest("/ozon/message-history/batch", {
        method: "POST",
        body: {
          items: selectedRows.map((row) => ({
            kind: type,
            receiver: row["货件编号"],
            postingNumber: row["货件编号"],
            templateName,
            content,
            status: "local_record",
          })),
        },
      });
      setSelectedRowKeys([]);
      await onRefresh?.();
      message.success(`已记录 ${selectedRows.length} 条本地发送记录`);
    } catch (error) {
      message.error(`记录失败: ${error.message}`);
    }
  };
  return (
    <div className="source-page">
      <SourceSectionTitle
        title={isReview ? "索要好评" : "提醒取货"}
        subtitle={`${formatDate()} · 当前店铺`}
        actions={[
          isReview ? <Button key="template" onClick={showTemplateModal}>文案模板</Button> : null,
          <Button key="monitor" onClick={showTaskMonitor}>任务监控 (0)</Button>,
        ].filter(Boolean)}
      />
      <SourceMetricStrip
        items={isReview
          ? [
              ["当前筛选", String(rows.length), "条候选记录"],
              ["待发送", String(rows.length), "本页待处理"],
              ["已发送", String(localRecords.length), "本地记录"],
              ["失败 / 不可发", "0", "需查看原因"],
            ]
          : [
              ["当前筛选", String(rows.length), "条候选记录"],
              ["待发送", String(rows.length), "本页待处理"],
              ["已发送", String(localRecords.length), "本地记录"],
              ["到货未取", String(rows.length), "本页可提醒"],
            ]}
      />
      <Card className="panel-card source-card">
        <div className="table-action-row">
          <Space wrap>
            <Select className="source-select" value="current" options={[{ value: "current", label: "当前店铺" }]} />
            <Input
              className="toolbar-search compact"
              placeholder="货件编号"
              allowClear
              value={filters.postingNumber}
              onChange={(event) => updateFilter("postingNumber", event.target.value)}
            />
            <Input
              className="toolbar-search compact"
              placeholder={isReview ? "货号" : "物流单号"}
              allowClear
              value={filters.extra}
              onChange={(event) => updateFilter("extra", event.target.value)}
            />
            <Input
              className="toolbar-search compact"
              placeholder="商品名称"
              allowClear
              value={filters.productName}
              onChange={(event) => updateFilter("productName", event.target.value)}
            />
            <Input
              className="toolbar-search compact"
              placeholder="SKU"
              allowClear
              value={filters.sku}
              onChange={(event) => updateFilter("sku", event.target.value)}
            />
            {!isReview ? (
              <>
                <Select className="source-select" value="arrived" options={[{ value: "arrived", label: "已到取件点" }]} />
                <Select className="source-select" value="notPicked" options={[{ value: "notPicked", label: "买家未取" }]} />
              </>
            ) : null}
            <Button onClick={() => message.success("筛选条件已应用")}>筛选</Button>
            <Button onClick={resetFilters}>重置</Button>
          </Space>
          <Space wrap>
            {isReview ? <Button onClick={() => navigate("/ozon/messaging/history")}>查看结果</Button> : null}
            <Button loading={syncingPostings} onClick={() => handleSync("当前店铺")}>同步当前店铺</Button>
            <Button loading={syncingPostings} onClick={() => handleSync("全部店铺")}>同步全部店铺</Button>
            <Button disabled={!selectedRowKeys.length} onClick={recordLocalSend}>批量发送</Button>
          </Space>
        </div>
        <Alert
          type="info"
          showIcon
          message={isReview
            ? "建议仅对履约体验稳定、商品质量有把握的订单发送评价邀请，以提升好评转化并降低负面反馈风险。"
            : "默认仅展示已到取件点且买家未取的订单；需要排查更多物流阶段时，可切换到货状态和取货状态筛选。"}
        />
        <SourceTable
          hasStore={hasStore}
          selectedRowKeys={selectedRowKeys}
          onSelectionChange={setSelectedRowKeys}
          rows={rows}
          columns={isReview
            ? ["操作", "店铺", "货件编号", "发运", "图片", "货号，数量 名称", "查看商品", "价格", "仓库", "配送服务 方式", "送达"]
            : ["操作", "店铺", "货件编号", "取货状态", "图片", "货号，数量 名称", "物流单号", "配送", "最近物流时间", "查看商品"]}
          empty="暂无数据"
          sourceEmpty
          scrollX={isReview ? 1540 : 1420}
        />
      </Card>
      <Modal
        rootClassName="prototype-overlay"
        title="索要好评文案模板"
        open={templateOpen}
        footer={null}
        onCancel={() => setTemplateOpen(false)}
        width={760}
      >
        <div className="review-template-modal">
          <p className="review-template-copy">
            可为不同店铺保存多套文案，发送前选择模板后仍可临时修改。
          </p>
          <div className="review-template-action">
            <Button type="primary">新建模板</Button>
          </div>
          <SourceTable
            hasStore={hasStore}
            rowSelection={false}
            columns={["模板名称", "适用范围", "内容预览", "操作"]}
            empty="暂无文案模板"
            sourceEmpty
            scrollX={640}
          />
        </div>
      </Modal>
      <Drawer
        rootClassName="prototype-overlay"
        title="任务监控"
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        width={420}
      >
        {isReview ? (
          <div className="task-empty-list">
            <Tag>{localRecords.length} 条本地记录</Tag>
            <p>{localRecords.length ? "最近本地记录已写入发送记录" : "暂无本页触发的任务"}</p>
          </div>
        ) : (
          <SourceTable
            hasStore={hasStore}
            rowSelection={false}
            rows={localRecords.slice(0, 20).map((item) => ({
              id: item.id,
              "店铺": item.storeName || "当前店铺",
              "状态": "本地记录",
              "错误": "未真实发送",
            }))}
            columns={["店铺", "状态", "错误"]}
            empty="暂无数据"
            sourceEmpty
            scrollX={360}
          />
        )}
      </Drawer>
    </div>
  );
}

const messageTemplateCategoryOptions = [
  { value: "review", label: "索要好评" },
  { value: "pickup", label: "提醒取货" },
  { value: "custom", label: "自定义" },
];

const messageTemplateCategoryLabel = (value) =>
  messageTemplateCategoryOptions.find((item) => item.value === value)?.label || "自定义";

const formatTemplateTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const rangeBoundary = (value, position) => {
  if (!value) return null;
  if (position === "start" && value.startOf) return value.startOf("day").valueOf();
  if (position === "end" && value.endOf) return value.endOf("day").valueOf();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
};

function MessageTemplatesPage({ hasStore, localData, onRefresh }) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [templateForm] = Form.useForm();
  const [expanded, setExpanded] = useState(false);
  const [filters, setFilters] = useState({});
  const [templateOpen, setTemplateOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const templates = localData?.caches?.messageTemplates || [];

  const filteredTemplates = useMemo(() => {
    const values = filters || {};
    const nameFilter = String(values.templateName || "").trim().toLowerCase();
    const contentFilter = String(values.contentPreview || "").trim().toLowerCase();
    const categoryFilter = values.category || "";
    const [startValue, endValue] = values.updatedAt || [];
    const startAt = rangeBoundary(startValue, "start");
    const endAt = rangeBoundary(endValue, "end");
    return templates.filter((item) => {
      const itemName = String(item.templateName || item.name || "").toLowerCase();
      const itemContent = String(item.content || "").toLowerCase();
      const updatedAt = new Date(item.updatedAt || item.createdAt || "").getTime();
      if (nameFilter && !itemName.includes(nameFilter)) return false;
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (contentFilter && !itemContent.includes(contentFilter)) return false;
      if (startAt !== null && (!updatedAt || updatedAt < startAt)) return false;
      if (endAt !== null && (!updatedAt || updatedAt > endAt)) return false;
      return true;
    });
  }, [filters, templates]);

  const openCreateTemplate = () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    setEditingTemplate(null);
    templateForm.resetFields();
    setTemplateOpen(true);
  };

  const openEditTemplate = (record) => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    setEditingTemplate(record);
    templateForm.setFieldsValue({
      templateName: record.templateName || record.name || "",
      category: record.category || "custom",
      content: record.content || "",
    });
    setTemplateOpen(true);
  };

  const closeTemplateModal = () => {
    setTemplateOpen(false);
    setEditingTemplate(null);
    templateForm.resetFields();
  };

  const saveTemplate = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    const values = await templateForm.validateFields();
    setSaving(true);
    try {
      const isEditing = Boolean(editingTemplate?.id);
      await apiRequest(
        isEditing ? `/ozon/message-templates/${encodeURIComponent(editingTemplate.id)}` : "/ozon/message-templates",
        {
          method: isEditing ? "PUT" : "POST",
          body: values,
        },
      );
      await onRefresh?.();
      closeTemplateModal();
      message.success("模板已保存");
    } catch (error) {
      message.error(`保存失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = (record) => {
    modal.confirm({
      title: "删除模板",
      icon: null,
      content: "确认删除该模板？",
      okText: "删 除",
      okButtonProps: { danger: true },
      cancelText: "取 消",
      onOk: async () => {
        try {
          await apiRequest(`/ozon/message-templates/${encodeURIComponent(record.id)}`, { method: "DELETE" });
          await onRefresh?.();
          message.success("模板已删除");
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };

  const rows = filteredTemplates.map((item) => ({
    ...item,
    id: item.id,
    "模板名称": item.templateName || item.name || "—",
    "分类": messageTemplateCategoryLabel(item.category),
    "内容预览": item.content || "",
    "更新时间": formatTemplateTime(item.updatedAt || item.createdAt),
  }));

  const columns = [
    "模板名称",
    "分类",
    {
      title: "内容预览",
      dataIndex: "内容预览",
      key: "内容预览",
      width: 280,
      render: (value) => {
        const text = String(value || "");
        return <span className="source-table-cell-text" title={text || "—"}>{text || "—"}</span>;
      },
    },
    "更新时间",
    {
      title: "操作",
      dataIndex: "操作",
      key: "操作",
      width: 96,
      ellipsis: false,
      render: (_, record) => (
        <Space size={2}>
          <Tooltip rootClassName="prototype-overlay" title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditTemplate(record)} />
          </Tooltip>
          <Tooltip rootClassName="prototype-overlay" title="删除">
            <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => deleteTemplate(record)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="source-page">
      <Card className="panel-card source-card">
        <Form form={form} layout="inline" className="template-query-form">
          <Form.Item label="模板名称" name="templateName">
            <Input placeholder="请输入" allowClear />
          </Form.Item>
          <Form.Item label="分类" name="category">
            <Select
              className="template-category-select"
              placeholder="请选择"
              allowClear
              options={messageTemplateCategoryOptions}
            />
          </Form.Item>
          {expanded && (
            <>
              <Form.Item label="内容预览" name="contentPreview">
                <Input placeholder="请输入" allowClear />
              </Form.Item>
              <Form.Item label="更新时间" name="updatedAt">
                <DatePicker.RangePicker placeholder={["", ""]} />
              </Form.Item>
            </>
          )}
          <Space>
            <Button
              onClick={() => {
                form.resetFields();
                setFilters({});
                message.success("已重置");
              }}
            >
              重 置
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setFilters(form.getFieldsValue());
                message.success(`查询完成 · ${rows.length} 条`);
              }}
            >
              查 询
            </Button>
            <a onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "展开"}
            </a>
          </Space>
        </Form>
      </Card>
      <Card className="panel-card source-card">
        <div className="table-action-row">
          <strong>模板列表</strong>
          <Space size={12}>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateTemplate}>
              新建模板
            </Button>
            <Button type="text" size="small" className="source-icon-button" icon={<SyncOutlined />} />
            <Button type="text" size="small" className="source-icon-button" icon={<SettingOutlined />} />
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rowSelection={false}
          columns={columns}
          rows={rows}
          empty="暂无模板"
          sourceEmpty
          scrollX={980}
        />
      </Card>
      <Modal
        rootClassName="prototype-overlay"
        title={editingTemplate ? "编辑模板" : "新建模板"}
        open={templateOpen}
        className="message-template-modal"
        wrapClassName="message-template-modal-wrap"
        okText="保 存"
        cancelText="取 消"
        confirmLoading={saving}
        onOk={saveTemplate}
        onCancel={closeTemplateModal}
        footer={[
          <Button key="cancel" onClick={closeTemplateModal}>
            取 消
          </Button>,
          <Button key="submit" type="primary" loading={saving} onClick={saveTemplate}>
            保 存
          </Button>,
        ]}
        destroyOnHidden
        transitionName=""
        maskTransitionName=""
      >
        <Form form={templateForm} layout="vertical" className="template-preview">
          <Form.Item label="模板名称" name="templateName" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input placeholder="请输入" maxLength={80} />
          </Form.Item>
          <Form.Item label="所属分类" name="category" rules={[{ required: true, message: "请选择分类" }]}>
            <Select placeholder="请选择" options={messageTemplateCategoryOptions} />
          </Form.Item>
          <Form.Item label="消息内容" name="content">
            <Input.TextArea rows={5} placeholder="请输入" maxLength={2000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

const messageHistoryStatusLabel = (value) => ({
  local_record: "本地记录",
  success: "成功",
  failed: "失败",
  pending: "待发送",
}[value] || "本地记录");

function MessageHistoryPage({ hasStore, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [expanded, setExpanded] = useState(false);
  const [filters, setFilters] = useState({});
  const historyRecords = localData?.caches?.messageHistory || [];
  const filteredRecords = useMemo(() => {
    const values = filters || {};
    const receiverFilter = String(values.receiver || "").trim().toLowerCase();
    const templateFilter = String(values.template || "").trim().toLowerCase();
    const contentFilter = String(values.content || "").trim().toLowerCase();
    const statusFilter = values.status || "";
    const [startValue, endValue] = values.sentAt || [];
    const startAt = rangeBoundary(startValue, "start");
    const endAt = rangeBoundary(endValue, "end");
    return historyRecords.filter((item) => {
      const receiver = String(item.receiver || item.postingNumber || "").toLowerCase();
      const template = String(item.templateName || "").toLowerCase();
      const content = String(item.content || "").toLowerCase();
      const sentAt = new Date(item.sentAt || item.createdAt || "").getTime();
      if (receiverFilter && !receiver.includes(receiverFilter)) return false;
      if (templateFilter && !template.includes(templateFilter)) return false;
      if (contentFilter && !content.includes(contentFilter)) return false;
      if (statusFilter && item.status !== statusFilter) return false;
      if (startAt !== null && (!sentAt || sentAt < startAt)) return false;
      if (endAt !== null && (!sentAt || sentAt > endAt)) return false;
      return true;
    });
  }, [filters, historyRecords]);
  const rows = filteredRecords.map((item) => ({
    id: item.id,
    "接收人": item.receiver || item.postingNumber || "—",
    "使用模板": item.templateName || "—",
    "发送内容": item.content || "—",
    "状态": messageHistoryStatusLabel(item.status),
    "发送时间": formatTemplateTime(item.sentAt || item.createdAt),
    "操作": "查看",
  }));
  return (
    <div className="source-page">
      <Card className="panel-card source-card">
        <Form form={form} layout="inline" className="template-query-form">
          <Form.Item label="接收人" name="receiver">
            <Input placeholder="请输入" allowClear />
          </Form.Item>
          <Form.Item label="使用模板" name="template">
            <Input placeholder="请输入" allowClear />
          </Form.Item>
          {expanded && (
            <>
              <Form.Item label="发送内容" name="content">
                <Input placeholder="请输入" allowClear />
              </Form.Item>
              <Form.Item label="状态" name="status">
                <Select
                  className="template-category-select"
                  placeholder="请选择"
                  allowClear
                  options={[
                    { value: "local_record", label: "本地记录" },
                    { value: "success", label: "成功" },
                    { value: "failed", label: "失败" },
                    { value: "pending", label: "待发送" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="发送时间" name="sentAt">
                <DatePicker.RangePicker placeholder={["", ""]} />
              </Form.Item>
            </>
          )}
          <Space>
            <Button
              onClick={() => {
                form.resetFields();
                setFilters({});
                message.success("已重置");
              }}
            >
              重 置
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setFilters(form.getFieldsValue());
                message.success(`查询完成 · ${rows.length} 条`);
              }}
            >
              查 询
            </Button>
            <a onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "展开"}
            </a>
          </Space>
        </Form>
      </Card>
      <Card className="panel-card source-card">
        <div className="table-action-row table-action-row-compact">
          <strong>历史记录</strong>
          <Space size={12}>
            <Button
              type="text"
              size="small"
              className="source-icon-button"
              icon={<SyncOutlined />}
              onClick={async () => {
                await onRefresh?.();
                message.success("已刷新");
              }}
            />
            <Button type="text" size="small" className="source-icon-button" icon={<SettingOutlined />} />
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rowSelection={false}
          rows={rows}
          columns={["接收人", "使用模板", "发送内容", "状态", "发送时间", "操作"]}
          empty="暂无发送记录"
          sourceEmpty
          scrollX={1050}
        />
      </Card>
    </div>
  );
}


function ProductTemplatesPage({ hasStore, binding, localData, onRefresh }) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [templateForm] = Form.useForm();
  const [expanded, setExpanded] = useState(false);
  const [filters, setFilters] = useState({});
  const [templateOpen, setTemplateOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const productTemplates = localData?.caches?.productTemplates || [];

  const filteredTemplates = useMemo(() => {
    const values = filters || {};
    const nameFilter = String(values.templateName || "").trim().toLowerCase();
    const defaultFilter = String(values.isDefault || "").trim().toLowerCase();
    const storeFilter = String(values.storeName || "").trim().toLowerCase();
    return productTemplates.filter((item) => {
      const itemName = String(item.templateName || item.name || "").toLowerCase();
      const itemStore = String(item.storeName || item.storeId || "").toLowerCase();
      const defaultText = item.isDefault ? "是 true 1 yes default" : "否 false 0 no";
      if (nameFilter && !itemName.includes(nameFilter)) return false;
      if (defaultFilter && !defaultText.includes(defaultFilter)) return false;
      if (storeFilter && !itemStore.includes(storeFilter)) return false;
      return true;
    });
  }, [filters, productTemplates]);

  const closeTemplateModal = () => {
    setTemplateOpen(false);
    setEditingTemplate(null);
    templateForm.resetFields();
  };

  const openCreateTemplate = () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    setEditingTemplate(null);
    templateForm.setFieldsValue({
      templateName: "",
      storeName: binding?.storeName || "当前店铺",
      isDefault: false,
      content: "",
    });
    setTemplateOpen(true);
  };

  const openEditTemplate = (record) => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    setEditingTemplate(record);
    templateForm.setFieldsValue({
      templateName: record.templateName || record.name || "",
      storeName: record.storeName || binding?.storeName || "当前店铺",
      isDefault: Boolean(record.isDefault),
      content: record.content || "",
    });
    setTemplateOpen(true);
  };

  const saveTemplate = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    const values = await templateForm.validateFields();
    setSaving(true);
    try {
      const isEditing = Boolean(editingTemplate?.id);
      await apiRequest(
        isEditing ? `/ozon/templates/${encodeURIComponent(editingTemplate.id)}` : "/ozon/templates",
        {
          method: isEditing ? "PUT" : "POST",
          body: {
            ...values,
            storeId: binding?.id || "",
            storeName: values.storeName || binding?.storeName || "当前店铺",
          },
        },
      );
      await onRefresh?.();
      closeTemplateModal();
      message.success("模板已保存");
    } catch (error) {
      message.error(`保存失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const applyTemplate = async (record) => {
    try {
      await apiRequest(`/ozon/templates/${encodeURIComponent(record.id)}/apply`, { method: "POST" });
      message.success("模板已应用");
    } catch (error) {
      message.error(`应用失败: ${error.message}`);
    }
  };

  const deleteTemplate = (record) => {
    modal.confirm({
      title: "删除模板",
      icon: null,
      content: "确认删除该模板？",
      okText: "删 除",
      okButtonProps: { danger: true },
      cancelText: "取 消",
      onOk: async () => {
        try {
          await apiRequest(`/ozon/templates/${encodeURIComponent(record.id)}`, { method: "DELETE" });
          await onRefresh?.();
          message.success("模板已删除");
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };

  const importProductTemplateFile = async (file) => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.templates) ? parsed.templates : [parsed];
      const normalizedItems = items
        .map((item, index) => {
          const source = item && typeof item === "object" ? item : {};
          const templateName = String(source.templateName || source.name || source.title || `导入模板 ${index + 1}`).trim();
          const contentSource = source.content ?? source.fields ?? source.schema ?? source;
          const content = typeof contentSource === "string" ? contentSource : JSON.stringify(contentSource, null, 2);
          return {
            templateName,
            storeId: binding?.id || "",
            storeName: source.storeName || binding?.storeName || "当前店铺",
            isDefault: Boolean(source.isDefault || source.default),
            content,
          };
        })
        .filter((item) => item.templateName);
      if (!normalizedItems.length) {
        message.warning("未识别到可导入模板");
        return;
      }
      for (const item of normalizedItems) {
        await apiRequest("/ozon/templates", { method: "POST", body: item });
      }
      await onRefresh?.();
      message.success(`已导入 ${normalizedItems.length} 个模板`);
    } catch (error) {
      message.error(`导入失败: ${error.message}`);
    }
  };

  const rows = filteredTemplates.map((item) => ({
    ...item,
    id: item.id,
    "模板名称": item.templateName || item.name || "—",
    "店铺": item.storeName || binding?.storeName || "当前店铺",
    "默认": item.isDefault ? "是" : "否",
    "创建时间": formatTemplateTime(item.createdAt),
    "更新时间": formatTemplateTime(item.updatedAt || item.createdAt),
  }));

  const columns = [
    "模板名称",
    "店铺",
    "默认",
    "创建时间",
    "更新时间",
    {
      title: "操作",
      dataIndex: "操作",
      key: "操作",
      width: 132,
      ellipsis: false,
      render: (_, record) => (
        <Space size={2}>
          <Tooltip rootClassName="prototype-overlay" title="应用">
            <Button type="text" size="small" icon={<CheckOutlined />} onClick={() => applyTemplate(record)} />
          </Tooltip>
          <Tooltip rootClassName="prototype-overlay" title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditTemplate(record)} />
          </Tooltip>
          <Tooltip rootClassName="prototype-overlay" title="删除">
            <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => deleteTemplate(record)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="source-page hidden-route-page">
      <Card className="panel-card source-card product-template-card">
        <div className="table-action-row">
          <span />
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateTemplate}>新建模板</Button>
            <Upload
              accept=".json,application/json"
              beforeUpload={(file) => {
                void importProductTemplateFile(file);
                return false;
              }}
              showUploadList={false}
            >
              <Button icon={<CloudUploadOutlined />}>导入模板</Button>
            </Upload>
            <Button
              onClick={async () => {
                await onRefresh?.();
                message.success("已刷新");
              }}
            >
              刷新
            </Button>
          </Space>
        </div>
        <div className="template-card-divider" />
        <Form form={form} layout="vertical" className="source-query-grid product-template-query-form">
          <Form.Item label="模板名称" name="templateName">
            <Input placeholder="请输入" allowClear />
          </Form.Item>
          <Form.Item label="默认" name="isDefault">
            <Input placeholder="请输入" allowClear />
          </Form.Item>
          {expanded ? (
            <Form.Item label="店铺" name="storeName">
              <Input placeholder="请输入" allowClear />
            </Form.Item>
          ) : null}
          <Space className="source-query-actions">
            <Button
              onClick={() => {
                form.resetFields();
                setFilters({});
                message.success("已重置");
              }}
            >
              重 置
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setFilters(form.getFieldsValue());
                message.success(`查询完成 · ${rows.length} 条`);
              }}
            >
              查 询
            </Button>
            <Button type="link" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开"}</Button>
          </Space>
        </Form>
        <div className="template-table-tools">
          <Button
            type="text"
            size="small"
            icon={<SyncOutlined />}
            onClick={async () => {
              await onRefresh?.();
              message.success("已刷新");
            }}
          />
          <Button type="text" size="small">T</Button>
          <Button type="text" size="small" icon={<SettingOutlined />} />
        </div>
        <SourceTable
          hasStore={hasStore}
          rowSelection={false}
          columns={columns}
          rows={rows}
          empty="暂无数据"
          sourceEmpty
          scrollX={980}
        />
      </Card>
      <Modal
        rootClassName="prototype-overlay"
        title={editingTemplate ? "编辑模板" : "新建模板"}
        open={templateOpen}
        className="local-template-modal"
        wrapClassName="local-template-modal-wrap"
        okText="保 存"
        cancelText="取 消"
        confirmLoading={saving}
        onOk={saveTemplate}
        onCancel={closeTemplateModal}
        footer={[
          <Button key="cancel" onClick={closeTemplateModal}>
            取 消
          </Button>,
          <Button key="submit" type="primary" loading={saving} onClick={saveTemplate}>
            保 存
          </Button>,
        ]}
        destroyOnHidden
        transitionName=""
        maskTransitionName=""
      >
        <Form form={templateForm} layout="vertical" className="template-preview">
          <Form.Item label="模板名称" name="templateName" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input placeholder="请输入" maxLength={80} />
          </Form.Item>
          <Form.Item label="店铺" name="storeName">
            <Input placeholder="请输入" maxLength={120} />
          </Form.Item>
          <Form.Item label="默认" name="isDefault" valuePropName="checked">
            <Switch checkedChildren="是" unCheckedChildren="否" />
          </Form.Item>
          <Form.Item label="模板内容" name="content">
            <Input.TextArea rows={5} placeholder="请输入" maxLength={3000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function PluginPanel() {
  const [pingState, setPingState] = useState({ status: "checking", version: "", error: "" });
  const runPing = async () => {
    setPingState({ status: "checking", version: "", error: "" });
    try {
      const resp = await requestExtensionPing(1500);
      setPingState(listingBridgeStatusFromPing(resp));
    } catch (error) {
      setPingState({
        status: "error",
        version: "",
        error: error?.message || "本地浏览器插件未响应",
      });
    }
  };
  useEffect(() => {
    runPing();
  }, []);
  const connected = pingState.status === "ok";
  const partial = pingState.status === "partial";
  return (
    <div className="plugin-panel">
      <div className="plugin-hero">
        <img src={PRODUCT_BRAND.logoPrimaryUrl} alt={PRODUCT_BRAND.displayName} style={pluginWordmarkStyle} />
        <div>
          <h2>{PRODUCT_BRAND.displayName} 浏览器插件</h2>
          <p>版本 {EXTENSION_VERSION}</p>
          <Space size={8} wrap>
            <Tag color="green">已复制到本地项目</Tag>
            <Tag color={connected ? "blue" : partial ? "orange" : pingState.status === "checking" ? "processing" : "red"}>
              {connected ? `已连接 ${pingState.version}` : partial ? "兼容模式" : pingState.status === "checking" ? "检测中" : "未连接"}
            </Tag>
          </Space>
        </div>
      </div>
      <Alert
        className="plugin-status"
        type={connected ? "success" : pingState.status === "checking" ? "info" : "warning"}
        showIcon
        message={connected ? "插件桥接已响应" : partial ? "源插件兼容采集模式" : "插件桥接未响应"}
        description={
          connected
            ? "插件负责把 Ozon 源商品采集入库；采集箱上架会读取当前草稿并提交到当前绑定店铺，不会重新采集覆盖数据。"
            : partial
              ? `${pingState.error}。当前可用源插件 prefetch 采集 SKU 入库；后台预检/上架只读取已保存草稿。重载本项目 extension 目录后可使用完整 follow-sell 桥。`
              : pingState.status === "checking"
                ? "正在检测当前 Chrome 是否已加载本项目插件。"
                : `${pingState.error}。请在 Chrome 扩展管理页重新加载下面的本地目录后刷新本页。`
        }
        action={
          <Button size="small" icon={<SyncOutlined />} loading={pingState.status === "checking"} onClick={runPing}>
            重新检测
          </Button>
        }
      />
      <div className="plugin-path">
        <span>加载目录</span>
        <code>/Users/songliang/Documents/sonli ozon3.0/extension</code>
      </div>
      <div className="plugin-checklist">
        {[
          ["1", "打开 Chrome 扩展管理页", "进入 chrome://extensions/ 并开启开发者模式"],
          ["2", "加载或重新加载本地目录", "选择上面的 extension 目录；已加载时点击扩展卡片的刷新按钮"],
          ["3", "回到本页重新检测", `状态应显示 已连接 ${EXTENSION_VERSION}，然后再做上架预检`],
        ].map(([step, title, desc]) => (
          <div key={step}>
            <strong>{step}</strong>
            <span>{title}</span>
            <em>{desc}</em>
          </div>
        ))}
      </div>
      <div className="plugin-actions">
        <a
          className="ant-btn ant-btn-primary ant-btn-color-primary ant-btn-variant-solid plugin-download"
          href={EXTENSION_DOWNLOAD_PATH}
          download
        >
          <DownloadOutlined />
          <span>插件下载</span>
        </a>
        <Button icon={<EyeOutlined />} href={EXTENSION_POPUP_PREVIEW_PATH} target="_blank">
          弹窗预览
        </Button>
      </div>
      <div className="plugin-package-status">
        <CheckOutlined />
        <span>下载包 sonli-extension-{EXTENSION_VERSION}.zip 已与本地 extension 目录逐文件校验一致</span>
      </div>
      <div className="plugin-capabilities">
        {EXTENSION_CAPABILITIES.map(([title, file]) => (
          <div key={title}>
            <ChromeOutlined />
            <span>{title}</span>
            <code>{file}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  return (
    <AntApp>
      <AppShell />
    </AntApp>
  );
}
