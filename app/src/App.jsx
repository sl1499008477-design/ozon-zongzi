import { stockEntries, productStatus, PRODUCT_STATUS_BUCKETS, productStatusMeta, productStatusFilterOptions, productSearchText, productMatchesQuery, stockNumber, productKnownStockValue, productMatchesStockFilter } from "../../shared/product-catalog.mjs";
import DashboardPage from "./DashboardPage.jsx";
import OrderManagementPage from "./OrderManagementPage.jsx";
import QualityInspectionPage, { QualityInspectionBell } from "./QualityInspectionPage.jsx";
import { useQualityInspection } from "./use-quality-inspection.js";
import StockEditor from "./StockEditor.jsx";
import BatchStockEditor from "./BatchStockEditor.jsx";
import {useProductCosts,ProductCostField,ProductCostSwitch} from "./ProductCostControls.jsx";
import "./catalog-management.css";
import ProductRestrictionsPage from "./ProductRestrictionsPage.jsx";
import AiRechargePage from "./AiRechargePage.jsx";
import AiBillingPage from "./AiBillingPage.jsx";
import AiUserChannelsPage from "./AiUserChannelsPage.jsx";
import AiRuntimeSettingsPage from "./AiRuntimeSettingsPage.jsx";
import SoftwareDownloadsPage from "./SoftwareDownloadsPage.jsx";
import OzonRouteSwitch from "./OzonRouteSwitch.jsx";
import WebCollectionCard from "./WebCollectionCard.jsx";
import { webCollectionJobView } from "./web-collection-jobs.js";
import "./web-collection.css";
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
  Image,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popover,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Upload,
} from "antd";
import Table from "./PagedTable.jsx";
import { ApartmentOutlined, ApiOutlined, AppstoreOutlined, BellOutlined, CheckOutlined, DownloadOutlined, CloudUploadOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, EyeOutlined, FileSearchOutlined, HomeOutlined, InboxOutlined, LinkOutlined, LoginOutlined, MenuOutlined, PictureOutlined, PlusOutlined, SettingOutlined, ShoppingCartOutlined, SyncOutlined, ThunderboltOutlined, UserOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import {
  CATEGORY_DATA_ERROR_MESSAGE,
  accountSharedCategoryResolution,
  listingCategoryFields,
  categoryConfirmationRequest,
  categoryConfirmationResponse,
  categoryItemScopeIsCurrent,
  categoryReadiness,
  requireCategoryReadiness,
  sourceCategoryEvidenceOf,
} from "./category-readiness.js";
import { useCategoryTreeReadiness } from "./use-category-tree-readiness.js";
import {
  dictionaryRowsOfResponse,
  useCategoryDictionaryReadiness,
} from "./use-category-dictionary-readiness.js";
import PricingSettingsPage from "./PricingSettingsPage.jsx";
import AccountSettingsPage from "./AccountSettingsPage.jsx";
import StoresSettingsPage from "./StoresSettingsPage.jsx";
import AiListingPage, { AiListingCompletedRecords } from "./AiListingPage.jsx";
import PromptManagementPage from "./PromptManagementPage.jsx";
import SalePricingPage,{CompetitorPricingPage} from "./SalePricingPage.jsx";
import MessageManagementPage from "./MessageManagementPage.jsx";
import PromotionManagementPage from "./PromotionManagementPage.jsx";
import { ozonPromotionTitle } from "./ozon-promotion-labels.mjs";
import { buildAutoListingCollectPush } from "./auto-listing-collect-push.js";
import { createStoreSwitchGate } from "./store-switch-gate.js";
import SourceTable, { SourceSectionTitle } from "./SourceTable.jsx";
import {
  dateInputValue,
  localDayKey,
  todayDateOnly,
} from "./store-date.js";
import {
  adaptiveTextColumnWidth,
  renderSourceTextCell,
  safeExternalHttpUrl,
  sourceCellText,
} from "./table-text.jsx";
import { apiRequest } from "./client-transport.js";
import { createAppAccountLoginHandler } from "./account-login-bootstrap.js";
import { PRODUCT_BRAND } from "./brand.js";
import { buildPrepareListingBody, listingPreparationModel, listingSubmissionErrorIsDefinitive, listingSubmissionIntent, settleListingSubmissionIntent, targetStoreSelection } from "./collect-box-target-store.js";
import {
  collectEditDictionaryIdsOf,
  resolveCollectEditDictionaryValue,
  shouldApplyCollectEditDictionaryDefault,
} from "./collect-edit-dictionary-match.js";
import { collectPriceCurrencyCode, formatCollectSourcePrice, normalizeCollectEditVariantRow } from "./collect-edit-variant-row.js";
import {
  collectEditEnrichmentBackfill,
  collectEditSourceCategorySnapshot,
  collectEditSourceCategoryVariant,
  collectEnrichmentEffectiveSummary,
  collectEnrichmentErrorSummary,
  collectEnrichmentPollingIds,
  refreshCollectEnrichmentProgress,
  mergeCollectEnrichmentProgress,
  collectEnrichmentNeedsPolling,
  collectEnrichmentSuccessMessage,
  collectEnrichmentView,
  collectWorkflowStatus,
  runCollectEnrichmentRetry,
  startCollectEnrichmentPolling,
} from "./collect-enrichment-view.js";
import { categoryResolutionView } from "./collect-category-resolution-view.js";
import { STORE_SYNC_TYPES, runBackendStoreSync } from "./store-sync-coordinator.js";
import {
  createCollectorAuthGenerationController,
  installCollectorAuthBridge,
  postCollectorAuthLogout,
  startCollectorAuthBridgeLifecycle,
} from "./collector-auth-bridge.js";
import {
  emptyLocalRuntimeData,
  localRuntimeStateFromApi,
  localStatePathForPage,
  pageStateNeedsLoading,
} from "./local-runtime-state.js";
import { createLatestLocalStateRefresh } from "./latest-request-gate.js";

const { Header, Sider, Content } = Layout;

const STORAGE_KEY = "qh-local-binding-v1";
const SETTINGS_KEY = "qh-local-settings-v1";
const collectEnrichmentTagColors = Object.freeze({
  default: "default",
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
  "/ozon/dashboard": "首页",
  "/ozon/downloads": "软件下载",
  "/ozon/products/list": "商品管理",
  "/ozon/orders": "订单列表",
  "/ozon/orders/quality": "质检单",
  "/ozon/products/collect": "采集箱",
  "/ozon/products/collect/edit": "商品编辑",
  "/ozon/products/import-history": "上架记录",
  "/ozon/tools/ai-listing": "AI 上架",
  "/ozon/tools/prompts": "提示词管理",
  "/ozon/tools/sale-pricing": "售价配置",
  "/ozon/messages": "消息管理",
  "/ozon/promotions": "活动管理",
  "/ozon/tools/auto-listing/ai-settings": "AI 模型配置",
  "/ozon/templates": "商品模板",
  "/ozon/settings/stores": "经营店铺",
  "/ozon/settings/accounts": "账号管理",
  "/ozon/settings/pricing": "算价配置",
  "/ozon/settings/competitor-pricing": "竞品真实售价计算",
  "/ozon/settings/ai-user-channels": "AI 通道配置",
  "/ozon/settings/ai-runtime-settings": "AI 并发设置",
  "/ozon/settings/product-restrictions": "禁售类目配置",
  "/ozon/settings/recharge": "充值管理",
  "/ozon/settings/ai-billing": "费用账单",
  "/404": "404",
};

const routeAliases = {
  "/ozon/products": "/ozon/products/list",
  "/ozon/products/batch-upload": "/ozon/products/import-history",
  "/ozon/tools/stores": "/ozon/products/list",
  "/ozon/products/stocks": "/ozon/products/list",
  "/ozon/settings": "/ozon/settings/stores",
  "/login": "/ozon/dashboard",
};

const normalizePath = (value) => {
  const path = String(value || "/ozon/dashboard").split("?")[0].replace(/\/+$/, "");
  if (path === "" || path === "/") return "/ozon/dashboard";
  const aliased = path === "/ozon/tools/auto-listing/ai-settings" ? "/ozon/settings/ai-user-channels" : routeAliases[path] || path;
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


const regularMenuItems = [
  { key: "/ozon/products/list", icon: <ShoppingCartOutlined />, label: "商品管理" },
  { key: "orders", icon: <InboxOutlined />, label: "订单管理", children: [
    { key: "/ozon/orders", label: "订单列表" },
  ] },
  {
    key: "ai",
    icon: <CloudUploadOutlined />,
    label: "产品上架",
    children: [
      { key: "/ozon/products/collect", label: "采集箱" },
      { key: "/ozon/tools/ai-listing", label: "AI 上架" },
      { key: "/ozon/tools/prompts", label: "提示词管理" },
      { key: "/ozon/tools/sale-pricing", label: "售价配置" },
      { key: "/ozon/products/import-history", label: "上架记录" },
    ],
  },
  { key: "/ozon/messages", icon: <BellOutlined />, label: "消息管理" },
  { key: "/ozon/promotions", icon: <ThunderboltOutlined />, label: "活动管理" },
];

const adminMenuItem = {
  key: "admin",
  icon: <SettingOutlined />,
  label: "管理员配置",
  className: "qh-admin-menu",
  children: [
    { key: "/ozon/settings/pricing", label: "算价配置" },
    { key: "/ozon/settings/competitor-pricing", label: "竞品真实售价计算" },
    { key: "/ozon/settings/ai-user-channels", label: "AI 通道配置" },
    { key: "/ozon/settings/ai-runtime-settings", label: "AI 并发设置" },
    { key: "/ozon/settings/product-restrictions", label: "禁售类目配置" },
    { key: "/ozon/settings/recharge", label: "充值管理" },
    { key: "/ozon/settings/ai-billing", label: "费用账单" },
  ],
};

const routeParent = {
  "/ozon/orders": "orders",
  "/ozon/products/collect": "ai",
  "/ozon/products/collect/edit": "ai",
  "/ozon/products/import-history": "ai",
  "/ozon/tools/ai-listing": "ai",
  "/ozon/tools/prompts": "ai",
  "/ozon/tools/sale-pricing": "ai",
  "/ozon/tools/auto-listing/ai-settings": "admin",
  "/ozon/settings/pricing": "admin",
  "/ozon/settings/competitor-pricing": "admin",
  "/ozon/settings/ai-user-channels": "admin",
  "/ozon/settings/ai-runtime-settings": "admin",
  "/ozon/settings/product-restrictions": "admin",
  "/ozon/settings/recharge": "admin",
  "/ozon/settings/ai-billing": "admin",
};


function AdminNavigation({ route, onNavigate }) {
  const [open, setOpen] = useState(false);
  const selected = adminMenuItem.children.some(item => item.key === route);
  return <Dropdown
    trigger={["click"]}
    placement="topLeft"
    open={open}
    onOpenChange={setOpen}
    overlayClassName="prototype-overlay qh-admin-popup"
    menu={{ items: adminMenuItem.children, selectedKeys: [route], onClick: ({ key }) => {
      setOpen(false); onNavigate(key);
    } }}
  >
    <button type="button" className={`qh-admin-trigger${open || selected ? " is-active" : ""}`}
      aria-label="管理员配置" aria-haspopup="menu" aria-expanded={open}>
      <SettingOutlined /><span>管理员配置</span><span className={`qh-admin-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
    </button>
  </Dropdown>;
}

export function AppShell({ initialState = null }) {
  const { message, modal } = AntApp.useApp();
  const [route, setRoute] = useState(() => initialState?.route || normalizePath(window.location.pathname));
  const [locationSearch, setLocationSearch] = useState(() => window.location.search);
  const [account, setAccount] = useState(() => initialState?.account || null);
  const [accounts, setAccounts] = useState([]);
  const [authChecked, setAuthChecked] = useState(() => initialState?.authChecked === true);
  const [loggingIn, setLoggingIn] = useState(false);
  const inspection = useQualityInspection({ accountId: authChecked ? account?.id : "" });
  const menuItems = [
    { key: "/ozon/dashboard", icon: <HomeOutlined />, label: "首页" },
    {
      key: "/ozon/orders/quality",
      icon: <FileSearchOutlined />,
      className: "quality-menu-entry",
      label: <><span>质检单</span><Badge
        className="quality-menu-badge"
        count={inspection.summary?.unreadCount || 0}
        overflowCount={99}
        title={`全店未读质检单：${inspection.summary?.unreadCount || 0} 条`}
      /></>,
    },
    { type: "divider", key: "quality-divider", className: "quality-menu-divider" },
    ...regularMenuItems,
  ];
  const [binding, setBinding] = useState(() => {
    const stored = readJson(STORAGE_KEY, null);
    return stored ? { ...stored, storeName: visibleStoreName(stored.storeName, stored.clientId) } : null;
  });
  const [settings, setSettings] = useState(() =>
    readJson(SETTINGS_KEY, { pluginInstalled: true, lastSync: null }),
  );
  const [localData, setLocalData] = useState(() => initialState?.localData || emptyLocalData);
  const [loadedStateView,setLoadedStateView]=useState(initialState?.localData?"/local/state":"");
  const [stateReadError,setStateReadError]=useState("");
  const lastPageRequestRef=useRef("");
  const [syncing, setSyncing] = useState(false);
  const [switchingStoreId, setSwitchingStoreId] = useState("");
  const [bindOpen, setBindOpen] = useState(false);
  const [savingBinding, setSavingBinding] = useState(false);
  const [syncingNewStore, setSyncingNewStore] = useState(false);
  const savingBindingRef = useRef(false);
  const [bindingSaveError, setBindingSaveError] = useState("");
  const [editingBindingStore, setEditingBindingStore] = useState(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openKeys, setOpenKeys] = useState(() => {
    const parent = routeParent[normalizePath(window.location.pathname)];
    return parent ? [parent] : [];
  });
  const handleMenuOpenChange = (keys) => {
    const opened = keys.find((key) => !openKeys.includes(key));
    setOpenKeys(opened ? [opened] : keys.slice(-1));
  };
  const [form] = Form.useForm();
  const applyLocalStateRef = useRef(null);
  const localStateRefreshRef = useRef(null);
  const localStateReadRef = useRef({generation:0, pending:0});
  const collectProgressScopeRef = useRef(null);
  collectProgressScopeRef.current = {
    accountId:account?.id || "", page:`${route}${locationSearch}`,
    items:localData?.caches?.collectBox,
  };
  const collectorAuthGenerationRef = useRef(null);
  const storeSwitchGateRef = useRef(null);
  const messageRef = useRef(message);
  if (!storeSwitchGateRef.current) storeSwitchGateRef.current = createStoreSwitchGate();
  messageRef.current = message;
  if (!collectorAuthGenerationRef.current) {
    collectorAuthGenerationRef.current = createCollectorAuthGenerationController();
  }

  const hasStore = Boolean(binding?.storeName);
  const isEditingBindingStore = Boolean(editingBindingStore?.id || editingBindingStore?.storeId);

  const applyLocalState = async (state) => {
    localStateReadRef.current.generation += 1;
    if(state?.__webStatePath)setLoadedStateView(state.__webStatePath);
    setStateReadError("");
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
      readState: async () => {
        const pagePath=normalizePath(window.location.pathname);
        const readPath=localStatePathForPage(pagePath,window.location.search);
        lastPageRequestRef.current=`${pagePath}${window.location.search}`;
        const state=await apiRequest(readPath);
        return {...state,__webStatePath:readPath};
      },
      applyState: (state) => applyLocalStateRef.current(state),
    });
  }

  const refreshLocalState = React.useCallback(async ({ silent = true, source = "manual-refresh" } = {}) => {
    localStateReadRef.current.generation += 1;
    localStateReadRef.current.pending += 1;
    try {
      const result = await localStateRefreshRef.current({ source });
      return result.status === "applied" ? result.state : null;
    } catch (error) {
      setStateReadError(error.message||"页面资料读取失败");
      if (!silent) messageRef.current.error(`本地 API 未启动: ${error.message}`);
      setAuthChecked(true);
      return null;
    } finally {
      localStateReadRef.current.pending -= 1;
    }
  }, []);

  const refreshCollectProgress = React.useCallback(async ({ids, signal}) => {
    const scope = collectProgressScopeRef.current;
    const generation = localStateReadRef.current.generation;
    const isCurrent = () => !signal?.aborted && !localStateReadRef.current.pending
      && generation === localStateReadRef.current.generation
      && scope.accountId === collectProgressScopeRef.current.accountId
      && scope.page === collectProgressScopeRef.current.page
      && scope.items === collectProgressScopeRef.current.items;
    if (!scope.accountId || !isCurrent()) return null;
    return refreshCollectEnrichmentProgress({
      ids, signal, request:apiRequest, isCurrent,
      apply:progress => setLocalData(current => isCurrent()
        ? mergeCollectEnrichmentProgress(current, progress, scope.items) : current),
    });
  }, []);

  useEffect(()=>{
    const key=`${route}${locationSearch}`;
    if(account?.id&&lastPageRequestRef.current!==key)void refreshLocalState({source:"page-navigation"});
  },[route,locationSearch,account?.id,refreshLocalState]);
  const requiredStateView=localStatePathForPage(route,locationSearch);
  const pageNeedsFullState=pageStateNeedsLoading(requiredStateView,loadedStateView);

  const collectorAuthAccountId = String(account?.id || "").trim();
  useEffect(() => {
    return startCollectorAuthBridgeLifecycle({
      accountId: authChecked ? collectorAuthAccountId : "",
      controller: collectorAuthGenerationRef.current,
      postLogout: (generationId) => postCollectorAuthLogout({ generationId }),
      installBridge: (transition) => installCollectorAuthBridge({
        accountId: collectorAuthAccountId,
        generationId: transition.generationId,
        isLoggedIn: () => true,
        requestTicket: ({ signal }) => apiRequest("/extension/collector-auth/ticket", {
          method: "POST",
          signal,
          timeoutMs: 28_000,
        }),
        announceReady: transition.announceReady,
      }),
    });
  }, [authChecked, collectorAuthAccountId]);

  useEffect(() => {
    const onPop = () => {
      const normalized = normalizePath(window.location.pathname);
      setRoute(normalized);
      setLocationSearch(window.location.search);
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
    document.title = PRODUCT_BRAND.displayName;
  }, [route]);

  useEffect(() => {
    const parent = routeParent[route];
    setOpenKeys(parent ? [parent] : []);
  }, [route]);

  useEffect(() => {
    const mobileMediaQuery = window.matchMedia("(max-width: 1180px)");
    const handleMobileViewportChange = (event) => {
      if (!event.matches) setMobileNavOpen(false);
    };
    mobileMediaQuery.addEventListener("change", handleMobileViewportChange);
    return () => mobileMediaQuery.removeEventListener("change", handleMobileViewportChange);
  }, []);

  useEffect(() => {
    refreshLocalState({ source: "initial-load" });
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
    const rawRoute = String(nextRoute || "");
    let nextSearch = "";
    try {
      nextSearch = new URL(rawRoute, window.location.origin).search;
    } catch {
      nextSearch = rawRoute.includes("?") ? rawRoute.slice(rawRoute.indexOf("?")) : "";
    }
    const normalized = normalizePath(nextRoute);
    setRoute(normalized);
    setLocationSearch(nextSearch);
    const parent = routeParent[normalized];
    setOpenKeys(parent ? [parent] : []);
    window.history.pushState({}, "", `${normalized}/${nextSearch}`);
  };

  const openBindModal = (store = null) => {
    const selectedStore = store && (store.id || store.storeId) ? store : null;
    setBindingSaveError("");
    setEditingBindingStore(selectedStore);
    setBindOpen(true);
  };

  const closeBindModal = () => {
    setBindOpen(false);
    setEditingBindingStore(null);
    form.resetFields();
  };

  const handleAccountLogin = createAppAccountLoginHandler({
    isLoggingIn: () => loggingIn,
    setLoggingIn,
    request: apiRequest,
    applyLocalState,
    refreshLocalState,
    showSuccess: text => message.success(text),
    showError: text => message.error(text),
    currentRoute: () => route,
    navigate,
  });

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
    setSyncing(true);
    const nextSettings = { ...settings, lastSync: new Date().toISOString() };
    setSettings(nextSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
    const storeId = localData?.currentStoreId || binding?.id || localStorage.getItem("currentOzonStoreId");
    try {
      const labels = {
        WAREHOUSES: "仓库",
        PRODUCTS: "商品",
      };
      const states = await runBackendStoreSync({
        storeId,
        types: requestedTypes,
        request: apiRequest,
        onState: (nextStates) => {
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
          content: `${failedTypes.map((type) => labels[type]).join(" / ")}同步失败，请再次同步；其他成功结果已保留`,
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

  useEffect(() => {
    if (!bindOpen) return;
    form.setFieldsValue({
      clientId: editingBindingStore?.clientId || "",
      apiKey: "",
      label: editingBindingStore?.label || editingBindingStore?.companyName || "",
      apiKeyCreatedAt: dateInputValue(editingBindingStore?.apiKeyCreatedAt),
    });
  }, [bindOpen, editingBindingStore, form]);

  const saveBinding = async (values) => {
    if (savingBindingRef.current) return;
    savingBindingRef.current = true;
    setSavingBinding(true);
    setBindingSaveError("");
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
            apiKeyCreatedAt: values.apiKeyCreatedAt || "",
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
      setSyncingNewStore(true);
      let syncError = "";
      try {
        const synced = await apiRequest("/local/sync/WAREHOUSES", { method: "POST", body: { storeId: store.id } });
        if (synced.job?.status && synced.job.status !== "SUCCESS") throw new Error("同步未完成");
      } catch (error) {
        syncError = error.message || "连接失败";
      }
      closeBindModal();
      try { await refreshLocalState({ source: "store-bind" }); }
      catch { syncError = syncError || "页面资料刷新失败"; }
      if (syncError) message.warning(`店铺已新增，但资料同步未完成：${syncError}。请在店铺配置点击“同步仓库”重试，无需重复新增。`, 10);
      else message.success("店铺已新增，店铺资料和仓库已同步");
    } catch (error) {
      setBindingSaveError(`保存失败: ${error.message}`);
      message.error(`保存失败: ${error.message}`);
    } finally {
      savingBindingRef.current = false;
      setSavingBinding(false);
      setSyncingNewStore(false);
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
    const targetStoreId = String(target.id || target.storeId || "");
    if (!storeSwitchGateRef.current.begin(targetStoreId)) return;
    setSwitchingStoreId(targetStoreId);
    const targetStoreName = visibleStoreName(target.label || target.companyName, target.clientId);
    try {
      message.loading({
        content: `正在切换到 ${targetStoreName}，并同步门店资料…`,
        key: "store-switch",
        duration: 0,
      });
      const response = await apiRequest("/local/current-store", {
        method: "POST",
        body: { storeId: targetStoreId },
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
      message.success({ content: `已切换到 ${nextBinding.storeName}`, key: "store-switch" });
    } catch (error) {
      message.error({ content: `切换失败: ${error.message}`, key: "store-switch", duration: 6 });
    } finally {
      storeSwitchGateRef.current.finish(targetStoreId);
      setSwitchingStoreId("");
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

  const themeConfig = {
    token: {
      colorPrimary: "#005af8",
      colorPrimaryHover: "#004fe0",
      colorText: "#071737",
      colorTextSecondary: "#65718a",
      colorBorder: "#dce8f7",
      colorBgLayout: "#f6fafe",
      colorBgContainer: "#ffffff",
      controlHeight: 44,
      controlHeightLG: 52,
      controlHeightSM: 32,
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
        borderRadiusLG: 26,
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
        <span>{PRODUCT_BRAND.displayName} · v{PRODUCT_BRAND.version}</span>
      </div>
      {[
        ...(account?.role === "admin" ? [["账号管理", () => navigate("/ozon/settings/accounts")]] : []),
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


  return (
    <ConfigProvider
      autoInsertSpaceInButton={false}
      locale={zhCN}
      theme={themeConfig}
    >
      <Layout className="qh-shell prototype-shell">
        <Header className="qh-topbar">
          <a className="qh-brand" aria-label="返回首页" href="/ozon/dashboard" onClick={(event) => { event.preventDefault(); navigate("/ozon/dashboard"); }}>
            <img loading="lazy" decoding="async" src={PRODUCT_BRAND.logoPrimaryUrl} alt={PRODUCT_BRAND.displayName} />
          </a>
          <Button
            aria-label="打开导航"
            className="prototype-mobile-menu-trigger"
            icon={<MenuOutlined />}
            onClick={() => setMobileNavOpen(true)}
            type="text"
          />
          <OzonRouteSwitch key={account.id} accountId={account.id} />
          <div className="qh-top-actions">
            <a className="qh-header-action tone-blue" href="/ozon/downloads" aria-label="软件下载" title="软件下载" onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault(); navigate("/ozon/downloads");
            }}>
              <span><DownloadOutlined /></span>
              <div><strong>软件下载</strong><em>扩展与采集助手</em></div>
            </a>
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
            <QualityInspectionBell key={account.id} reminders={inspection} navigate={navigate} />
            <Popover content={userPopover} trigger="click" placement="bottomRight" overlayClassName="topbar-overlay user-topbar-overlay prototype-overlay">
              <button className="qh-user" aria-label="账户菜单" type="button">
                <UserOutlined />
                <div>
                  <span>当前用户</span>
                  <strong>已登录</strong>
                </div>
              </button>
            </Popover>
          </div>
        </Header>
        <Layout>
          <Sider
            width={244}
            className="qh-sider"
          >
            <Menu
              mode="inline"
              selectedKeys={[route]}
              openKeys={openKeys}
              onOpenChange={handleMenuOpenChange}
              items={menuItems}
              onClick={({ key }) => navigate(key)}
            />
            {account?.role === "admin" ? <AdminNavigation route={route} onNavigate={navigate} /> : null}
          </Sider>
          <Content className="qh-content">
            {pageNeedsFullState ? (stateReadError ? <Alert type="error" message="页面资料读取失败" description={stateReadError} action={<Button onClick={()=>refreshLocalState({silent:false,source:"page-retry"})}>重试</Button>}/> : <div role="status">正在读取页面资料…</div>) : <GenericPage
              route={route}
              locationSearch={locationSearch}
              binding={binding}
              hasStore={hasStore}
              localData={localData}
              onBind={openBindModal}
              onSync={handleSync}
              onClear={clearBinding}
              onSwitchStore={switchCurrentStore}
              switchingStoreId={switchingStoreId}
              onRefresh={refreshLocalState}
              onCollectProgress={refreshCollectProgress}
              account={account}
              accounts={accounts}
              inspection={inspection}
              navigate={navigate}
            />}
          </Content>
        </Layout>
      </Layout>

      <Modal
        title={isEditingBindingStore ? "修改 API 授权门店" : "新增 API 授权门店"}
        rootClassName="prototype-overlay"
        open={bindOpen}
        onCancel={() => { if (!savingBinding) closeBindModal(); }}
        closable={!savingBinding}
        maskClosable={!savingBinding}
        keyboard={!savingBinding}
        footer={null}
        width={520}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          autoComplete="off"
          disabled={savingBinding}
          onFinish={saveBinding}
          initialValues={{
            clientId: "",
            apiKey: "",
            label: "",
            apiKeyCreatedAt: "",
          }}
        >
          <Form.Item
            label="Client-Id"
            name="clientId"
            rules={[{ required: true, message: "请输入 Client-Id" }]}
          >
            <Input
              prefix={<ApiOutlined />}
              placeholder="Ozon Client-Id"
              autoComplete="off"
              disabled={isEditingBindingStore}
            />
          </Form.Item>
          <Form.Item
            label="Api-Key"
            name="apiKey"
            extra={isEditingBindingStore ? "留空则不修改当前保存的 Api-Key。" : ""}
            rules={[{ required: !isEditingBindingStore, message: "请输入 Api-Key" }]}
          >
            <Input.Password
              prefix={<DatabaseOutlined className="bind-field-icon" />}
              placeholder="Ozon Api-Key"
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item label="标签" name="label">
            <Input placeholder="可选，例如：主店" />
          </Form.Item>
          <Form.Item
            label="API Key 创建日期"
            name="apiKeyCreatedAt"
            extra="创建日期仅作记录；有效期以 Ozon 返回的到期时间为准，未提供时显示未知。"
          >
            <Input
              className="bind-date-input"
              type="date"
              placeholder="选择 API Key 创建日期"
              onClick={openNativeDatePicker}
            />
          </Form.Item>
          {bindingSaveError ? <Alert type="error" showIcon message={bindingSaveError} style={{marginBottom:16}}/> : null}
          <div className="bind-actions">
            <Space>
              <Button disabled={savingBinding} onClick={closeBindModal}>取 消</Button>
              <Button type="primary" htmlType="submit" loading={savingBinding}>
                {savingBinding ? (syncingNewStore ? "正在同步资料和仓库…" : isEditingBindingStore ? "正在保存…" : "正在新增…") : (isEditingBindingStore ? "保 存" : "新 增")}
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>


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
          onOpenChange={handleMenuOpenChange}
          items={menuItems}
          onClick={({ key }) => {
            setMobileNavOpen(false);
            navigate(key);
          }}
        />
        {account?.role === "admin" ? <AdminNavigation route={route} onNavigate={(key) => {
          setMobileNavOpen(false); navigate(key);
        }} /> : null}
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
          <img loading="lazy" decoding="async" src={PRODUCT_BRAND.logoPrimaryUrl} alt={PRODUCT_BRAND.displayName} />
          <div>
            <span>{PRODUCT_BRAND.displayName} · v{PRODUCT_BRAND.version}</span>
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

function GenericPage({ route, locationSearch, binding, hasStore, localData, onBind, onSync, onClear, onSwitchStore, switchingStoreId, onRefresh, onCollectProgress, navigate, account, accounts, inspection }) {

  const pageProps = { route, locationSearch, binding, hasStore, localData, onBind, onSync, onClear, onSwitchStore, switchingStoreId, onRefresh, onCollectProgress, navigate, account, accounts };
  if (route === "/ozon/dashboard") return <DashboardPage key={account?.id} {...pageProps} localData={{...localData, account}} />;
  if (route === "/ozon/downloads") return <SoftwareDownloadsPage />;
  if (route === "/ozon/orders/quality") return <QualityInspectionPage key={account?.id} {...pageProps} reminders={inspection} />;
  if (route === "/ozon/orders") return <OrderManagementPage key={`orders:${account?.id || ""}:${binding?.id || ""}`} {...pageProps} />;
  if (route === "/ozon/products/list") return <ProductListPage key={`products:${account?.id || ""}:${binding?.id || ""}`} {...pageProps} />;
  if (route.startsWith("/ozon/products/collect/edit")) return <CollectEditPage {...pageProps} />;
  if (route === "/ozon/products/collect") return <CollectPage {...pageProps} />;
  if (route === "/ozon/products/import-history") return <ImportHistoryPage {...pageProps} />;
  if (route === "/ozon/tools/sale-pricing") return <SalePricingPage key={account?.id} {...pageProps} />;
  if (route === "/ozon/settings/competitor-pricing") return <CompetitorPricingPage key={account?.id} {...pageProps} />;
  if (route === "/ozon/tools/prompts") return <PromptManagementPage key={account?.id} {...pageProps} />;
  if (route === "/ozon/messages") return <MessageManagementPage key={`messages:${account?.id || ""}:${binding?.id || ""}`} {...pageProps} request={apiRequest} />;
  if (route === "/ozon/promotions") return <PromotionManagementPage key={`promotions:${account?.id || ""}:${binding?.id || ""}`} {...pageProps} request={apiRequest} />;
  if (route === "/ozon/tools/ai-listing") return <AiListingPage
    key={`ai-listing:${account?.id || ""}:${locationSearch}`} {...pageProps} request={apiRequest} />;
  if (route === "/ozon/tools/auto-listing/ai-settings") return <AiUserChannelsPage {...pageProps} />;
  if (route === "/ozon/templates") return <ProductTemplatesPage {...pageProps} />;
  if (route === "/ozon/settings/stores") return <StoresSettingsPage {...pageProps} />;
  if (route === "/ozon/settings/product-restrictions") return <ProductRestrictionsPage key={account?.id} {...pageProps} />;
  if (route === "/ozon/settings/ai-billing") return <AiBillingPage key={account?.id} {...pageProps} />;
  if (route === "/ozon/settings/recharge") return <AiRechargePage key={account?.id} {...pageProps} />;
  if (route === "/ozon/settings/ai-user-channels") return <AiUserChannelsPage {...pageProps} />;
  if (route === "/ozon/settings/ai-runtime-settings") return <AiRuntimeSettingsPage key={account?.id} {...pageProps} />;
  if (route === "/ozon/settings/accounts") return <AccountSettingsPage {...pageProps} />;
  if (route === "/ozon/settings/pricing") return <PricingSettingsPage {...pageProps} />;

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

const stockTotal = (item = {}) => productKnownStockValue(item) ?? "—";

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
      title: ozonPromotionTitle(action),
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

function ProductListPage({ binding, hasStore, localData, onRefresh, locationSearch = "" }) {
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState("");
  const [activeStatus, setActiveStatus] = useState("销售中");
  const homeStockFilter = () => { const value = new URLSearchParams(locationSearch).get("stock"); return ["缺货", "低库存", "attention"].includes(value) ? value : "全部"; };
  const [stockFilter,setStockFilter] = useState(homeStockFilter);
  useEffect(() => { setStockFilter(homeStockFilter()); setActiveStatus("销售中"); }, [locationSearch]);
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(5),[catalog,setCatalog]=useState(null),[catalogError,setCatalogError]=useState(""),[catalogLoading,setCatalogLoading]=useState(false),[catalogRevision,setCatalogRevision]=useState(0);
  const selectionRows=useRef(new Map());
  const [priceDetail, setPriceDetail] = useState(null);
  const [productDetail,setProductDetail] = useState(null);
  const [stockEditor,setStockEditor] = useState(null);
  const [selectedKeys,setSelectedKeys] = useState([]);
  const [batchRows,setBatchRows] = useState(null);
  useEffect(()=>{setPage(1);setSelectedKeys([]);selectionRows.current.clear();},[activeStatus,stockFilter,query]);
  const [syncing,setSyncing] = useState(false);
  const storeId = localData?.currentStoreId || binding?.id;
  const costs = useProductCosts(storeId,hasStore);
  const warehouses = scopedWarehousesForCurrentStore(localData?.caches?.warehouses || [], binding, localData);
  const catalogQuery = new URLSearchParams({view:'page',storeId:storeId||'',page:String(page),pageSize:String(pageSize),status:activeStatus,stock:stockFilter,q:query}).toString();
  useEffect(()=>{
    const controller=new AbortController();setCatalogLoading(true);setCatalogError('');
    if(!hasStore){setCatalog(null);setCatalogLoading(false);return;}
    const timer=setTimeout(()=>{void apiRequest(`/ozon/products/cache?${catalogQuery}`,{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted){setCatalog({...result,query:catalogQuery});if(result.page!==page)setPage(result.page);}
    }).catch(error=>{if(!controller.signal.aborted)setCatalogError(error.message);}).finally(()=>{if(!controller.signal.aborted)setCatalogLoading(false);});},150);
    return()=>{clearTimeout(timer);controller.abort();};
  },[hasStore,catalogQuery,catalogRevision]);
  const rows=productRows(catalog?.query===catalogQuery?catalog.items:[],warehouses);
  const total=catalog?.total||0;
  const statusOptions=catalog?.statusOptions||productStatusFilterOptions([]);
  const stockCounts=catalog?.stockCounts||{};
  async function openBatchStock(){
    if(selectedKeys.length>100){message.warning("每次最多修改 100 个商品，请减少勾选数量");return;}
    if(selectedKeys.length){setBatchRows(selectedKeys.map(id=>selectionRows.current.get(id)).filter(Boolean));return;}
    if(total>100){message.warning("每次最多修改 100 个商品，请先筛选或勾选商品");return;}
    try{
      const params=new URLSearchParams(catalogQuery);params.set('pageSize','50');params.set('page','1');
      const first=await apiRequest(`/ozon/products/cache?${params}`);
      if(first.total>100){message.warning("每次最多修改 100 个商品，请先筛选或勾选商品");return;}
      let items=first.items;
      if(first.total>50){params.set('page','2');items=items.concat((await apiRequest(`/ozon/products/cache?${params}`)).items);}
      setBatchRows(productRows(items,warehouses));
    }catch(error){message.error(error.message);}
  }
  const productId = row=>String(row._raw.product_id||row._raw.id||"");
  async function refreshProducts(){
    if(!hasStore||syncing)return;setSyncing(true);
    try{
      await apiRequest("/local/sync/WAREHOUSES",{method:"POST",body:{storeId}});
      await apiRequest("/local/sync/PRODUCTS",{method:"POST",body:{storeId}});
      await onRefresh?.();setCatalogRevision(value=>value+1);message.success("商品与库存已同步");
    }catch(e){message.error(`同步失败：${e.message}`);}finally{setSyncing(false);}
  }
  const priceColumns = [
    {title:"活动",dataIndex:"title",ellipsis:true},
    {title:"活动价",dataIndex:"value",width:110,render:value=>formatProductPrice(value)},
    {title:"开始时间",dataIndex:"date_from",width:150,render:value=>value?new Date(value).toLocaleString():"—"},
    {title:"结束时间",dataIndex:"date_to",width:150,render:value=>value?new Date(value).toLocaleString():"—"},
  ];
  const columns = [
    {title:"商品信息",dataIndex:"商品信息",width:300,ellipsis:false,render:(value,row)=><div className="catalog-product-cell">
      {row._image?<img className="product-thumb" src={row._image} alt="" loading="lazy"/>:<span className="product-thumb product-thumb-empty">—</span>}
      <div className="product-info-cell"><span className="catalog-product-name" title={row._title}>{row._title||value}</span>
        {row._sku?<span className="product-sku-row"><span className="product-sku-text" title={row._sku}>SKU：{row._sku}</span><SkuCopyButton message={message} sku={row._sku}/></span>:null}
        {row._offerId?<span className="product-sku-text" title={row._offerId}>货号：{row._offerId}</span>:null}
      </div></div>},
    {title:"状态",dataIndex:"状态",width:100,render:(value,row)=><span className={`product-status-tag status-${row._statusMeta?.tone||"default"}`} title={row._statusMeta?.raw}>{row._statusMeta?.label||value}</span>},
    {title:"售价",dataIndex:"价格",width:112,render:(value,row)=><Button className="product-price-link" type="link" size="small" onClick={()=>setPriceDetail(row)}>{value}</Button>},
    {title:"采购成本",width:126,ellipsis:false,render:(_,row)=><ProductCostField productId={productId(row)} name={row._title} cost={costs.items[productId(row)]} onSave={costs.save} disabled={costs.loading||Boolean(costs.error)||costs.busy[productId(row)]}/>},
    {title:"自动应用",width:92,render:(_,row)=><ProductCostSwitch productId={productId(row)} cost={costs.items[productId(row)]} onSave={costs.save} disabled={costs.loading||Boolean(costs.error)} loading={costs.busy[productId(row)]}/>},
    {title:"库存",dataIndex:"库存",width:158,ellipsis:false,render:(value,row)=><div className="catalog-stock-cell"><Button onClick={()=>setStockEditor(row)} className="catalog-stock-button" aria-label={`修改 SKU ${row._sku} 库存`}>{value}</Button><span title={row["仓库分布"]}>{row["仓库分布"]||"点击查看仓库"}</span></div>},
    {title:"操作",width:92,render:(_,row)=><Button type="link" icon={<EyeOutlined/>} onClick={()=>setProductDetail(row)} aria-label={`查看 SKU ${row._sku} 商品详情`}>详情</Button>},
  ];
  return <div className="source-page products-page catalog-management-page">
    <SourceSectionTitle title="商品管理" subtitle="统一管理当前店铺的商品成本、售价与仓库库存" actions={[
      <Button icon={<DatabaseOutlined/>} disabled={!hasStore||catalogLoading||!rows.length} key="batch" onClick={openBatchStock}>批量修改库存</Button>,
      <Button type="primary" icon={<SyncOutlined/>} onClick={refreshProducts} loading={syncing} disabled={!hasStore} key="sync">同步商品与库存</Button>,
    ]}/>
    <Card className="panel-card source-card">
      <div className="product-store-context"><span className="product-store-icon"><ApartmentOutlined/></span><div><span>当前店铺</span><strong>{hasStore?visibleStoreName(binding?.storeName,binding?.clientId):"尚未绑定店铺"}</strong></div><span className="product-store-note">{hasStore?"点击库存数量，按仓库修改可售库存":"绑定店铺后显示真实商品"}</span></div>
      {costs.error?<Alert showIcon type="warning" message={`采购成本暂时无法读取：${costs.error}`} action={<Button onClick={costs.reload}>重试</Button>}/>:null}
      <div className="product-status-filters" aria-label="商品状态筛选">
        {statusOptions.map(item=><button className={`product-status-filter status-${item.tone}${activeStatus===item.label?" active":""}`} type="button" aria-pressed={activeStatus===item.label} key={item.label} onClick={()=>setActiveStatus(item.label)}><span>{item.label}</span><em>{item.count}</em></button>)}
      </div>
      <div className="catalog-filter-row">
        <div className="catalog-stock-filters"><PromotionStatusButtons active={stockFilter === "attention" ? "库存关注" : stockFilter} onChange={value=>setStockFilter(value === "库存关注" ? "attention" : value)} items={[
          {label:"全部",count:stockCounts["全部"]||0,tone:"primary"},
          {label:"缺货",count:stockCounts["缺货"]||0,tone:"primary"},
          {label:"低库存",count:stockCounts["低库存"]||0,tone:"primary"},
          ...(stockFilter==="attention"?[{label:"库存关注",value:"attention",count:(stockCounts["缺货"]||0)+(stockCounts["低库存"]||0),tone:"primary"}]:[]),
        ]}/><span className="catalog-filter-note">低库存：1～10 件</span></div>
        <Input.Search className="toolbar-search" placeholder="搜索商品名称 / SKU / 货号" allowClear value={query} onChange={e=>setQuery(e.target.value)} />
      </div>
      {catalogError&&<Alert showIcon type="error" title={catalogError} action={<Button onClick={()=>setCatalogRevision(value=>value+1)}>重试</Button>}/>}
      <div className="table-result-title">共 {total} 项 · 已选择 {selectedKeys.length} 项</div>
      <SourceTable hasStore={hasStore} rows={rows} columns={columns} selectedRowKeys={selectedKeys} preserveSelectedRowKeys onSelectionChange={keys=>{setSelectedKeys(keys);for(const row of rows)if(keys.includes(row.id))selectionRows.current.set(row.id,row);for(const id of selectionRows.current.keys())if(!keys.includes(id))selectionRows.current.delete(id);}} loading={catalogLoading} pagination={{current:page,pageSize,total,onChange:(next,size)=>{setPage(next);setPageSize(size);}}} scrollX={1080} empty="暂无商品" sourceEmpty/>
    </Card>
    <Modal rootClassName="prototype-overlay" title="商品活动价格" open={Boolean(priceDetail)} footer={null} onCancel={()=>setPriceDetail(null)} width={760}>
      {priceDetail?<div className="product-price-modal"><div className="product-price-modal-head"><strong>{priceDetail._title}</strong><span>SKU：{priceDetail._sku||"—"}</span><span>货号：{priceDetail._offerId||"—"}</span><span>当前展示价：{priceDetail["价格"]}</span></div><Table columns={priceColumns} dataSource={priceDetail._priceActions||[]}  rowKey="key" size="small"/></div>:null}
    </Modal>
    <Modal rootClassName="prototype-overlay" title="商品详情" open={Boolean(productDetail)} onCancel={()=>setProductDetail(null)} footer={null} width={720}>
      {productDetail?<div className="catalog-detail"><div className="catalog-detail-head">{productDetail._image?<img loading="lazy" decoding="async" src={productDetail._image} alt={productDetail._title}/>:null}<div><strong>{productDetail._title}</strong><p>SKU：{productDetail._sku}</p><p>货号：{productDetail._offerId}</p><Tag>{productDetail._statusMeta?.label}</Tag></div></div><p>售价：{productDetail["价格"]}</p><p>库存合计：{productDetail["库存"]}</p><p className="catalog-warehouse-detail">{productDetail["仓库分布"]}</p><Space><Button onClick={()=>{setProductDetail(null);setStockEditor(productDetail);}}>修改库存</Button><Button type="primary" href={`https://www.ozon.ru/product/${encodeURIComponent(productDetail._sku)}/`} target="_blank" rel="noopener noreferrer">打开平台商品</Button></Space></div>:null}
    </Modal>
    {batchRows?<BatchStockEditor storeId={storeId} rows={batchRows} onClose={()=>setBatchRows(null)} onChanged={refreshProducts} onInspect={row=>{setBatchRows(null);setStockEditor(row);}}/>:null}
    {stockEditor?<StockEditor key={`${storeId}:${productId(stockEditor)}`} storeId={storeId} productId={productId(stockEditor)} row={stockEditor} onClose={()=>setStockEditor(null)} onChanged={refreshProducts}/>:null}
  </div>;
}

function CollectPage(props) {
  return <CollectPageForAccount key={props.account?.id || "anonymous"} {...props} />;
}

function CollectPageForAccount({ hasStore, localData, onBind, onRefresh: refreshBase, onCollectProgress, navigate, account }) {
  const { message } = AntApp.useApp();
  const [pageSizeChoice, setPageSizeChoice] = useState("5");
  const [expandedRowKeys, setExpandedRowKeys] = useState([]);
  const [activeStatus, setActiveStatus] = useState("全部");
  const [sourceFilter, setSourceFilter] = useState();
  const [variantFilter, setVariantFilter] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [variantSelections, setVariantSelections] = useState({});
  const [retryingEnrichmentId, setRetryingEnrichmentId] = useState("");
  const [changingWebJobId, setChangingWebJobId] = useState("");
  const [retryEnrichmentOverrides, setRetryEnrichmentOverrides] = useState({});
  const [page,setPage]=useState(1),[list,setList]=useState(null),[listError,setListError]=useState(''),[listLoading,setListLoading]=useState(false);
  const listReadRef=useRef(0),selectionItemsRef=useRef(new Map());
  const loadPage=React.useCallback(async ({signal}={})=>{
    const generation=++listReadRef.current;
    const query=new URLSearchParams({limit:pageSizeChoice,offset:String((page-1)*Number(pageSizeChoice)),status:activeStatus,source:sourceFilter||'',variant:variantFilter});
    try {
      let result;
      try{result=await apiRequest(`/ozon/collect-box/summary?${query}`,{signal,timeoutMs:30000});}
      catch(error){
        if(error.status!==404)throw error;
        const legacy=await apiRequest('/local/state',{signal});result={items:legacy.caches?.collectBox||[],legacy:true};
      }
      if(!signal?.aborted&&generation===listReadRef.current){setList(result);setListError('');
        if(!result.legacy&&page>1&&(page-1)*Number(pageSizeChoice)>=result.total)setPage(Math.max(1,Math.ceil(result.total/Number(pageSizeChoice))));}
      return result;
    }catch(error){if(!signal?.aborted&&generation===listReadRef.current)setListError(error.message||'采集箱读取失败');throw error;}
  },[account?.id,page,pageSizeChoice,activeStatus,sourceFilter,variantFilter]);
  useEffect(()=>{const controller=new AbortController();setListLoading(true);void loadPage({signal:controller.signal}).catch(()=>{}).finally(()=>{if(!controller.signal.aborted)setListLoading(false);});return()=>controller.abort();},[loadPage]);
  useEffect(()=>{setPage(1);setSelectedRowKeys([]);setExpandedRowKeys([]);selectionItemsRef.current.clear();},[account?.id,activeStatus,sourceFilter,variantFilter,pageSizeChoice]);
  const onRefresh=loadPage;
  const collectItems = list?.items || [];
  const rows = collectItems.map((item, index) => {
    const id = item.id || "collect-" + index;
    const enrichment = collectEnrichmentEffectiveSummary(item, retryEnrichmentOverrides[id]);
    const enrichmentView = collectEnrichmentView(enrichment);
    const categoryResolutionViewState = categoryResolutionView(item.categoryResolution);
    return {
      id,
      _webCollectionJob: item.webCollectionJob,
      _selectable: item.selectable !== false && !item.webCollectionJob && item.status !== '已上架',
      _variants: collectEditVariantSourceRows(item).map((variant, variantIndex) => {
        const display = normalizeCollectEditVariantRow({ variant, index: variantIndex });
        return {
          key: display.sku || `variant-${variantIndex}`,
          sku: display.sku,
          name: display.name,
          image: collectEditFirst(variant.image, variant.coverImage, variant.images?.[0]?.url, typeof variant.images?.[0] === "string" ? variant.images[0] : ""),
          aspects: Object.values(variant.aspectValues || {}).map(collectEditText).filter(Boolean).join(" · "),
          price: formatCollectSourcePrice(variant, item),
        };
      }),
      _image: item.image || item.primaryImage || (item.images || [])[0] || "",
      _title: item.name || item.title || item.productUrl || "—",
      _enrichment: enrichment,
      _enrichmentView: enrichmentView,
      _categoryResolutionView: categoryResolutionViewState,
      sku: item.sku || item.id || "",
      "商品信息": item.name || item.title || item.productUrl || "—",
      "采集价格": formatCollectSourcePrice(item),
      "卖家 / 来源": item.source || item.seller || item.sellerName || "—",
      "品牌": item.brand || "—",
      "下单链接": item.productUrl || item.url || "—",
      "采集时间": item.createdAt ? new Date(item.createdAt).toLocaleString() : "—",
      "状态": item.webCollectionJob || item.status === '已上架' ? item.status : collectWorkflowStatus(item),
      "操作": "查看",
    };
  });
  const sourceOptions = (list?.sources || [...new Set(rows.map(row=>row["卖家 / 来源"]).filter(value=>value&&value!=="—"))]).map(value=>({value,label:value}));
  const visibleRows = rows.filter((row) => {
    const statusMatched = activeStatus === "全部" || row["状态"] === activeStatus;
    const sourceMatched = !sourceFilter || row["卖家 / 来源"] === sourceFilter;
    const variantMatched = !variantFilter || (row._webCollectionJob ? variantFilter === '单 SKU' && row._webCollectionJob.scope === 'CURRENT' : variantFilter === "多变体" ? row._variants.length > 1 : row._variants.length <= 1);
    return statusMatched && sourceMatched && variantMatched;
  });
  const visibleRowIdSignature = visibleRows.map((row) => row.id).join("|");
  const pollingIds = collectEnrichmentPollingIds(visibleRows.map(row => ({id:row.id, enrichment:row._enrichment})));
  const visibleEnrichmentPollKey = JSON.stringify(pollingIds);
  const countByStatus = (status) => list?.counts?.[status] ?? rows.filter((row) => row["状态"] === status).length;
  useEffect(() => {
    const unavailable = new Set(rows.filter(row => !row._selectable).map(row => row.id));
    setSelectedRowKeys(keys => keys.some(id => unavailable.has(id)) ? keys.filter(id => !unavailable.has(id)) : keys);
    for (const id of unavailable) selectionItemsRef.current.delete(id);
  }, [list]);
  const changeWebJob = async (job, action) => {
    if (changingWebJobId) return;
    setChangingWebJobId(job.id);
    try {
      await apiRequest(`/ozon/collect-box/web-jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', body: {}, timeoutMs: 15000 });
      message.success(action === 'cancel' ? '任务已取消' : '已重新排队，等待扩展领取');
      await loadPage();
    } catch (error) { message.error(error.message); }
    finally { setChangingWebJobId(''); }
  };
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
      !pollingIds.length && !list?.hasActiveWebJobs
    ) return undefined;
    return startCollectEnrichmentPolling({
      refresh: ({signal}) => document.hidden ? Promise.resolve() : loadPage({signal}),
      setIntervalFn: window.setInterval.bind(window),
      clearIntervalFn: window.clearInterval.bind(window),
    });
  }, [visibleEnrichmentPollKey, list?.hasActiveWebJobs, account?.id, loadPage]);
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
  const pushToAiListing = () => {
    try {
      const target = buildAutoListingCollectPush({
        selectedIds: selectedRowKeys,
        visibleItems: [...selectionItemsRef.current.values()],
        accountId: account?.id,
        destination: "ai-listing",
      });
      const variants = Object.fromEntries(selectedRowKeys.filter(id=>variantSelections[id]).map(id=>[id,variantSelections[id]]));
      navigate(target.path + "&variants=" + encodeURIComponent(JSON.stringify(variants)));
    } catch (error) {
      message.warning(error?.code === "AUTO_LISTING_COLLECT_SELECTION_EMPTY"
        ? "请先选择要推送的采集商品"
        : "选中的商品已不可用，请刷新采集箱后重试");
    }
  };
  return (
    <div className="source-page collect-page">
      <SourceSectionTitle title="采集箱" subtitle="管理已采集商品，选择商品后推送到上架流程" />
      <WebCollectionCard key={account?.id || "anonymous"} onRefresh={async () => {
        setPage(1); setActiveStatus('全部'); setSourceFilter(undefined); setVariantFilter('');
        await loadPage();
      }} navigate={navigate} />
      <div className="collect-filter-row">
        <div className="collect-filter-chips">
        <StatusChips
          active={activeStatus}
          onChange={setActiveStatus}
          items={[
            { label: "全部", count: list?.counts?.["全部"] ?? rows.length },
            { label: "待处理", count: countByStatus("待处理") },
            { label: "已上架", count: countByStatus("已上架") },
            { label: "已跳过", count: countByStatus("已跳过") },
            { label: "失败", count: countByStatus("失败") },
          ]}
        />
        <div className="source-chip-row collect-variant-filters" role="group" aria-label="SKU 类型筛选">
          {["多变体", "单 SKU"].map((label) => (
            <button key={label} type="button" className={variantFilter === label ? "active" : ""}
              aria-pressed={variantFilter === label}
              onClick={() => setVariantFilter((current) => current === label ? "" : label)}>
              {label}
            </button>
          ))}
        </div>
        </div>
        <div className="collect-filter-actions">
          <Button icon={<SyncOutlined />} loading={listLoading} onClick={() => void loadPage().catch(() => {})}>刷新</Button>
          <Button
            type="primary"
            disabled={!selectedRowKeys.length}
            icon={<ThunderboltOutlined />}
            onClick={pushToAiListing}
          >
            推送到 AI 上架
          </Button>
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
      {listError&&<Alert type="error" showIcon message={listError} action={<Button onClick={()=>void loadPage().catch(()=>{})}>重试读取</Button>}/>}
      <div className="collect-table-panel">
        <SourceTable
          hasStore={hasStore}
          rows={visibleRows}
          loading={listLoading}
          preserveSelectedRowKeys
          pagination={list&&!list.legacy?{current:page,pageSize:Number(pageSizeChoice),total:list.total,onChange:(next,size)=>{setPage(next);setPageSizeChoice(String(size));},showTotal:total=>`共 ${total} 件商品`}:undefined}
          selectedRowKeys={selectedRowKeys}
          rowSelection={{ getCheckboxProps: row => ({ disabled: !row._selectable }) }}
          onSelectionChange={(keys)=>{setSelectedRowKeys(keys);
            for(const row of visibleRows)if(keys.includes(row.id))selectionItemsRef.current.set(row.id,row);
            for(const id of selectionItemsRef.current.keys())if(!keys.includes(id))selectionItemsRef.current.delete(id);
            setVariantSelections(current=>Object.fromEntries(Object.entries(current).filter(([id])=>keys.includes(id)&&selectedRowKeys.includes(id))));}}
          expandable={{
            expandedRowKeys,
            showExpandColumn: false,
            rowExpandable: (row) => row._variants.length > 1,
            expandedRowRender: (row) => (
              <div className="collect-variant-list" aria-label={`${row._title}的变体`}>
                <div className="collect-variant-list-head"><span>变体商品 / 规格</span><span>SKU</span><span>采集价格</span></div>
                {row._variants.map((variant) => (
                  <div className="collect-variant-row" key={variant.key}>
                    <div className="collect-variant-product">
                      <Checkbox aria-label={`推送 SKU ${variant.sku}`} disabled={!row._selectable} checked={selectedRowKeys.includes(row.id) && (!variantSelections[row.id] || variantSelections[row.id].includes(variant.sku))} onChange={e=>{
                        const current=selectedRowKeys.includes(row.id)?(variantSelections[row.id] || row._variants.map(v=>v.sku)):[];
                        const next=e.target.checked?[...new Set([...current,variant.sku])]:current.filter(sku=>sku!==variant.sku);
                        if(next.length)selectionItemsRef.current.set(row.id,row);else selectionItemsRef.current.delete(row.id);
                        setVariantSelections(values=>({...values,[row.id]:next}));
                        setSelectedRowKeys(keys=>next.length?[...new Set([...keys,row.id])]:keys.filter(id=>id!==row.id));
                      }}/>

                      {variant.image ? <img src={variant.image} alt="" loading="lazy" /> : null}
                      <div><strong title={variant.name}>{variant.aspects || variant.name || "未提供规格"}</strong>{variant.aspects && variant.name ? <span title={variant.name}>{variant.name}</span> : null}</div>
                    </div>
                    <span className="collect-variant-sku">{variant.sku || "未提供"}</span>
                    <span>{variant.price}</span>
                  </div>
                ))}
              </div>
            ),
          }}
          columns={[
            { title: "商品信息", dataIndex: "商品信息", width: "32%",
              onCell: row => row._variants.length > 1 ? {
                style: { cursor: 'pointer' },
                onClick: () => setExpandedRowKeys(keys => keys.includes(row.id) ? keys.filter(key => key !== row.id) : [...keys, row.id]),
              } : {}, render: (value, row) => (
              <div className="collect-product-group">
                {row._variants.length > 1 ? (
                  <button
                    type="button"
                    className="collect-variant-toggle"
                    aria-label={`${expandedRowKeys.includes(row.id) ? "收起" : "展开"}${value}变体`}
                    aria-expanded={expandedRowKeys.includes(row.id)}
                    onClick={(event) => { event.stopPropagation(); setExpandedRowKeys((keys) => keys.includes(row.id) ? keys.filter((key) => key !== row.id) : [...keys, row.id]); }}
                  ><span aria-hidden="true">›</span></button>
                ) : <span className="collect-variant-toggle-spacer" />}
                {row._image ? <img loading="lazy" decoding="async" src={row._image} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} /> : null}
                <div style={{ display: "grid", minWidth: 0, gap: 2 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>{value}</span>
                  {row._webCollectionJob ? <span className="product-sku-text">{row._webCollectionJob.scope === 'ALL' ? '整组变体 · 采集完成后显示数量' : '仅当前 SKU'}</span> : row._variants.length > 1
                    ? <span className="collect-variant-count">多变体 · {row._variants.length} 个 SKU</span>
                    : <span className="product-sku-text" title={row.sku || ""}>单 SKU · {row.sku || "未提供"}</span>}
                </div>
              </div>
            ) },
            { title: "采集价格", dataIndex: "采集价格", width: "7%", render: renderSourceTextCell },

            {
              title: "下单链接",
              dataIndex: "下单链接",
              width: "9%",
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
            { title: "采集时间", dataIndex: "采集时间", width: "12%", render: value => <span>{String(value).split(" ").map((part,i)=><React.Fragment key={i}>{i>0?<br/>:null}{part}</React.Fragment>)}</span> },
            {
              title: "状态",
              dataIndex: "状态",
              width: "24%",
              ellipsis: false,
              render: (value, row) => {
                if (row._webCollectionJob) {
                  const job = row._webCollectionJob, view = webCollectionJobView(job);
                  return <div className="collect-enrichment-cell"><Tag color={view.color}>{view.label}</Tag><span className="collect-enrichment-detail">{job.message}</span>{job.errorCode && <span className="collect-enrichment-detail">错误代码：{job.errorCode}</span>}</div>;
                }
                if (value === '已上架') return <Tag color="green">已上架</Tag>;
                const views=row._enrichment?.status === "COLLECTION_FAILED"
                  ? [row._enrichmentView] : [row._enrichmentView,row._categoryResolutionView];
                const pending=views.filter(view=>view?.tone!=="success");
                return <div className="collect-enrichment-cell">{pending.length ? pending.map((view,i)=><div key={i}><Tag color={collectEnrichmentTagColors[view?.tone]}>{view?.label || "资料状态待确认"}</Tag>{view?.detail?<span className="collect-enrichment-detail" title={view.detail}>{view.detail}</span>:null}</div>) : <Tag color="green">类目与包装已补全</Tag>}</div>;
              },
            },
            { title: "操作", dataIndex: "操作", width: "12%", ellipsis: false, render: (value, row) => row._webCollectionJob ? (() => {
              const job = row._webCollectionJob, view = webCollectionJobView(job);
              return <Space size={4} wrap>
                {view.canRetry && <Button type="link" size="small" loading={changingWebJobId === job.id} disabled={Boolean(changingWebJobId && changingWebJobId !== job.id)} onClick={() => changeWebJob(job, 'retry')}>{view.retryLabel}</Button>}
                {view.canCancel && <Button type="link" danger size="small" disabled={Boolean(changingWebJobId)} onClick={() => changeWebJob(job, 'cancel')}>取消</Button>}
                {job.status === 'COMPLETED' && job.alreadyListed && <Button type="link" size="small" onClick={() => navigate('/ozon/products/import-history/')}>查看上架记录</Button>}
              </Space>;
            })() : row['状态'] === '已上架' ? <Button type="link" size="small" onClick={() => navigate('/ozon/products/import-history/')}>查看上架记录</Button> : (
              <Space size={4} wrap>
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
          scrollX={980}
        />
      </div>
    </div>
  );
}

export { CollectPage, ProductListPage };

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
  const targetResolution = collectEditEffectiveCategoryResolution({
    item,
    itemId: collectEditFirst(item?.id, item?.collectItemId),
    targetStoreId,
    taxonomyScope,
  });
  const targetFields = listingCategoryFields(targetResolution, { taxonomyScope });
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
  add(variantReady, 5, "SKU、名称和售价完整");
  add(packageReady, 5, "物流重量和尺寸完整");

  return {
    score: Math.max(0, Math.min(100, score)),
    missing,
    sanitizedTagCount: safeTags.length,
    alertType: score >= 85 ? "success" : score >= 60 ? "warning" : "info",
  };
};

export const collectEditContentNotes = (row = {}) => [
  ["description", "简介", row.description], ["richContent", "富内容", row.richContent],
  ["color_image", "颜色样本", row.color_image], ["videoCoverUrl", "封面视频", row.videoCoverUrl],
].map(([key, label, value]) => {
  const evidence = row.contentDiagnostics?.[key];
  const status = value ? "已保存" : evidence?.status === "read_failed" ? `读取失败：${evidence.message || "请重试或编辑"}`
    : evidence?.status === "not_provided" ? "源未提供" : evidence?.status === "provided" ? "当前未填写" : "待核实";
  return `${label}：${status}`;
}).concat((row.contentDiagnostics?.issues || []).map(issue => `读取记录：${issue.message}`)).join("；");

export const collectEditVariantRows = ({
  item = {},
  sourceItem = item,
  sku = "",
  title = "",
  price = "",
  images = [],
  offerPrefix = "jz-",
  targetStoreId = "",
  taxonomyScope = "OZON:DEFAULT",
  targetCurrencyCode,
}) => {
  const sourceRows = Array.isArray(item.listingDraft?.variants) && item.listingDraft.variants.length
    ? item.listingDraft.variants : collectEditVariantSourceRows(item);
  const rows = sourceRows.length ? sourceRows : [item];
  const originalRows = collectEditVariantSourceRows(sourceItem);
  const savedDraft = sourceItem.listingDraft || {};
  const savedRows = Array.isArray(savedDraft.variants) ? savedDraft.variants : [];
  const priceSku = (row) => collectEditFirst(row.sku, row.variant_id, row.product_id, row.productId);
  return rows.map((variant, index) => {
    const aspectName = collectEditAspectName(variant);
    const rowPriceSku = priceSku(variant) || sku;
    const sourcePriceRow = originalRows.find((row) => priceSku(row) === rowPriceSku)
      || (rowPriceSku === sku ? sourceItem : {});
    const savedPriceRow = savedRows.find((row) => priceSku(row) === rowPriceSku)
      || (rowPriceSku === collectEditFirst(savedDraft.sku, sku) ? savedDraft : {});
    const commercialFields = normalizeCollectEditVariantRow({
      variant,
      index,
      rowCount: rows.length,
      fallbackSku: sku,
      fallbackTitle: title,
      fallbackPrice: price,
      offerPrefix,
      aspectName,
      targetCurrencyCode,
      sourceVariant: sourcePriceRow,
      sourceCurrencyCode: collectPriceCurrencyCode(sourceItem),
      draftVariant: savedPriceRow,
      draftCurrencyCode: collectPriceCurrencyCode(savedDraft),
    });
    const rowSku = commercialFields.sku;
    const capturedVariant = collectEditVariantSourceSnapshot(item, variant, rowSku);
    const sourceVariant = !Object.keys(capturedVariant).length && Array.isArray(variant.sourceCategory?.attributes)
      ? { ...variant, attributes: variant.sourceCategory.attributes }
      : capturedVariant;
    const variantLogistics = variant.logistics || sourceVariant.logistics || {};
    const rowImages = Array.isArray(variant.images)
      ? [...new Set(variant.images.map(collectEditText).filter(Boolean))]
      : collectEditImages({ ...sourceVariant, ...variant }, rowSku === sku ? images[0] || "" : "");
    const targetResolution = collectEditEffectiveCategoryResolution({
      item,
      itemId: collectEditFirst(item?.id, item?.collectItemId),
      targetStoreId,
      taxonomyScope,
    });
    const targetFields = listingCategoryFields(targetResolution, { taxonomyScope });
    return {
      key: variant.key || `${rowSku || sku || "sku"}-${index}`,
      index: index + 1,
      image: rowImages[0] || "",
      images: rowImages,
      cover: collectEditFirst(variant.videoCover, sourceVariant.videoCover, variant.videos?.[0]?.coverUrl, sourceVariant.videos?.[0]?.coverUrl),
      videoCover: collectEditFirst(variant.videoCover, sourceVariant.videoCover, variant.videos?.[0]?.coverUrl, sourceVariant.videos?.[0]?.coverUrl),
      videos: structuredClone(variant.videos ?? sourceVariant.videos ?? []),
      color_image: variant.color_image ?? sourceVariant.color_image ?? "",
      videoCoverUrl: variant.videoCoverUrl ?? sourceVariant.videoCoverUrl ?? "",
      contentDiagnostics: structuredClone(variant.contentDiagnostics ?? sourceVariant.contentDiagnostics ?? {}),
      video: collectEditFirst(variant.video, variant.videoUrl, variant.video_url),
      sku: commercialFields.sku,
      offerId: commercialFields.offerId,
      name: commercialFields.name,
      specification: variant.specification ?? aspectName,
      purchasePrice: collectEditFirst(variant.purchasePrice, variant.purchase_price, variant.cost_price),
      sellPrice: commercialFields.sellPrice,
      oldPrice: commercialFields.oldPrice,
      ...(targetCurrencyCode !== undefined ? {
        currencyCode: targetCurrencyCode,
        sourcePriceDisplay: formatCollectSourcePrice(sourcePriceRow, sourceItem),
      } : {}),
      stock: commercialFields.stock,
      sourceVariant,
      description: variant.description != null ? collectEditText(variant.description)
        : collectEditFirst(sourceVariant.description, sourceVariantText(sourceVariant, 4191)),
      richContent: variant.richContent ?? collectEditFirst(variant.rich_content, sourceVariant.richContent, sourceVariantText(sourceVariant, 11254)),
      barcode: variant.barcode ?? collectEditFirst(sourceVariant.barcode, sourceVariantText(sourceVariant, 7822)),
      sourceCategory: sourceCategoryEvidenceOf({ sourceCategory: variant.sourceCategory, _sourceVariant: sourceVariant }),
      ...(targetResolution ? { categoryResolution: targetResolution } : {}),
      descriptionCategoryId: targetFields.descriptionCategoryId || "",
      typeId: targetFields.typeId || "",
      categoryAttributes: Array.isArray(variant.categoryAttributes) ? variant.categoryAttributes : undefined,
      logistics: structuredClone(variantLogistics),
      packageEditedFields: Array.isArray(variant.packageEditedFields) ? variant.packageEditedFields : [],
      packageWeight: variant.packageWeight ?? collectEditFirst(variant.weight, variantLogistics.weightG, sourceVariantText(sourceVariant, 4497)),
      packageLength: variant.packageLength ?? collectEditFirst(variant.depth, variantLogistics.lengthMm, sourceVariantText(sourceVariant, 9454)),
      packageWidth: variant.packageWidth ?? collectEditFirst(variant.width, variantLogistics.widthMm, sourceVariantText(sourceVariant, 9455)),
      packageHeight: variant.packageHeight ?? collectEditFirst(variant.height, variantLogistics.heightMm, sourceVariantText(sourceVariant, 9456)),
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
  const categoryResolution = collectEditEffectiveCategoryResolution({
    item,
    itemId: collectEditFirst(item?.id, item?.collectItemId),
    targetStoreId,
    taxonomyScope,
  });
  const categoryFields = listingCategoryFields(categoryResolution, { taxonomyScope });
  return {
    categoryResolution,
    descriptionCategoryId: categoryFields.descriptionCategoryId || "",
    typeId: categoryFields.typeId || "",
  };
};

export const collectEditEffectiveCategoryResolution = ({
  item = {},
  taxonomyScope = "OZON:DEFAULT",
  interactivePreview = null,
  manualOverride = null,
  fallbackResolution = null,
} = {}) => {
  for (const candidate of [
    manualOverride?.resolution,
    interactivePreview?.resolution,
    item?.categoryResolution,
    fallbackResolution,
  ]) {
    const shared = accountSharedCategoryResolution(candidate, { taxonomyScope });
    if (shared) return shared;
  }
  return null;
};

export const collectCategoryConfirmationIntent = ({
  item = {},
  descriptionCategoryId,
  typeId,
  taxonomyScope = "OZON:DEFAULT",
  idempotencyKey,
  correlationId,
} = {}) => {
  const draftVersion = Number(item?.draftVersion);
  if (!Number.isSafeInteger(draftVersion) || draftVersion < 1) {
    const error = new Error("ZONGZI_CATEGORY_CONFIRMATION_INVALID");
    error.code = "ZONGZI_CATEGORY_CONFIRMATION_INVALID";
    throw error;
  }
  return categoryConfirmationRequest({
    collectItemId: String(item?.id || item?.collectItemId || ""),
    expectedSourceVersion: `draft:${draftVersion}`,
    descriptionCategoryId: Number(descriptionCategoryId),
    typeId: Number(typeId),
    taxonomyScope,
    idempotencyKey,
    correlationId,
  });
};

export const collectEditDraftVariantCategory = ({
  item = {},
  itemId = "",
  row = {},
  targetStoreId = "",
  taxonomyScope = "OZON:DEFAULT",
  fallbackResolution = null,
  manualOverride = null,
  interactivePreview = null,
} = {}) => {
  const categoryResolution = collectEditEffectiveCategoryResolution({
    item,
    itemId,
    targetStoreId,
    taxonomyScope,
    interactivePreview,
    manualOverride,
    legacyResolution: row.categoryResolution || item.listingDraft?.categoryResolution,
    fallbackResolution,
  });
  const targetFields = listingCategoryFields(categoryResolution, { taxonomyScope });
  return {
    categoryResolution,
    descriptionCategoryId: targetFields.descriptionCategoryId || "",
    typeId: targetFields.typeId || "",
  };
};

function CollectEditSkuMedia({ row, onChange }) {
  const { message } = AntApp.useApp();
  const [imageUrl, setImageUrl] = useState("");
  const images = row.images || [];
  const changeImages = (next) => onChange({ images: next, image: next[0] || "" });
  const addImage = () => {
    const url = safeExternalHttpUrl(imageUrl);
    if (!url) { message.warning("请填写完整的 http 或 https 图片链接"); return; }
    if (!images.includes(url)) changeImages([...images, url]);
    setImageUrl("");
  };
  return (
    <div className="collect-edit-sku-media">
      <div className="collect-edit-gallery-label">SKU {row.sku || "待填写"} 图库 · {images.length} 张<span>第一张为主图，点击图片可放大</span></div>
      <Image.PreviewGroup>
        <div className="collect-edit-gallery">
          {images.map((url, index) => (
            <div className="collect-edit-gallery-item" key={url}>
              <Image src={url} alt={`SKU ${row.sku} 第 ${index + 1} 张商品图片`} />
              <div className="collect-edit-gallery-actions">
                {index === 0 ? <span>主图</span> : <Button type="link" size="small" onClick={() => changeImages([url, ...images.filter((image) => image !== url)])}>设为主图</Button>}
              </div>
            </div>
          ))}
          {!images.length && <div className="collect-edit-empty-note">请添加商品图片</div>}
        </div>
      </Image.PreviewGroup>
      <div className="collect-edit-gallery-add">
        <Input aria-label={`SKU ${row.sku} 新图片链接`} value={imageUrl} placeholder="添加图片链接" onChange={(event) => setImageUrl(event.target.value)} onPressEnter={addImage} />
        <Button onClick={addImage}>添加图片</Button>
      </div>
    </div>
  );
}

function CollectEditPage({ binding, hasStore, localData, onBind, onRefresh, onCollectProgress, navigate, account }) {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [listingResult, setListingResult] = useState(null);
  const [sku, setSku] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [currencyCode, setCurrencyCode] = useState("");
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
  const [expandedVariantKeys, setExpandedVariantKeys] = useState([]);
  const [variantSearch, setVariantSearch] = useState("");
  const [variantFilter, setVariantFilter] = useState("all");
  const [variantPage, setVariantPage] = useState(1), [variantPageSize, setVariantPageSize] = useState(5);
  const [batchPrice, setBatchPrice] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const editRevisionRef = useRef(0);
  const markDraftEdited = () => { editRevisionRef.current += 1; setDraftDirty(true); };
  const editValue = (setter, value) => { markDraftEdited(); setter(value); };
  const [previewItem, setPreviewItem] = useState(null);
  const [categoryAutoError, setCategoryAutoError] = useState("");
  const [categorySchema, setCategorySchema] = useState([]);
  const [categorySchemaLoading, setCategorySchemaLoading] = useState(false);
  const [categorySchemaError, setCategorySchemaError] = useState("");
  const [categoryAttributeValues, setCategoryAttributeValues] = useState({});
  const [enrichmentRetrying, setEnrichmentRetrying] = useState(false);
  const [enrichmentRetryOverride, setEnrichmentRetryOverride] = useState(null);
  const collectEditInitScopeRef = useRef("");
  const collectEditDimensionDirtyRef = useRef(new Set());
  const collectEditActiveItemIdRef = useRef("");
  const collectEditEnrichmentGenerationRef = useRef(0);
  const listingSubmissionIntentRef = useRef(null);
  const categoryConfirmationIntentRef = useRef(null);
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
  const categoryTaxonomyScope = String(
    item?.categoryResolution?.taxonomyScope || "OZON:DEFAULT",
  ).trim() || "OZON:DEFAULT";
  const effectiveEnrichment = collectEnrichmentEffectiveSummary(item, enrichmentRetryOverride);
  const enrichmentView = collectEnrichmentView(effectiveEnrichment);
  const enrichmentShouldPoll = Boolean(collectCandidate) && collectEnrichmentNeedsPolling(effectiveEnrichment);
  React.useEffect(function() {
    if (enrichmentRetryOverride && enrichmentRetryOverride.baseItem !== item) {
      setEnrichmentRetryOverride(null);
    }
  }, [item, enrichmentRetryOverride]);
  React.useEffect(function() {
    if (
      typeof onCollectProgress !== "function"
      || !enrichmentShouldPoll
    ) return undefined;
    return startCollectEnrichmentPolling({
      refresh: ({signal}) => onCollectProgress({ids:[collectCandidate.id], signal}),
      setIntervalFn: window.setInterval.bind(window),
      clearIntervalFn: window.clearInterval.bind(window),
    });
  }, [collectCandidate?.id, account?.id, enrichmentShouldPoll, onCollectProgress]);
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
    editValue(setTargetStoreId, next);
  };
  const storeCurrencyCode = collectPriceCurrencyCode({ currencyCode: preparationModel.currencyCode });
  const readCategoryTree = React.useCallback((language) => apiRequest(`/ozon/categories/tree?language=${encodeURIComponent(language)}`, {
    headers: { "x-ozon-store-id": categoryStoreId },
  }), [categoryStoreId]);
  const categoryTree = useCategoryTreeReadiness({ hasStore: Boolean(categoryStoreId), currentStoreId: categoryStoreId, itemId, readTree: readCategoryTree });
  const { scopedTrees, categoryTreeLoading, categoryDataError, categoryTreeReady, loadCategoryTrees,
    categoryAutoLoading } = categoryTree;
  const listingWarehouseOptions = preparationModel.warehouses
    .map((warehouse) => {
      const id = warehouse.warehouse_id || warehouse.warehouseId;
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
        storeCurrencyCode,
        itemId,
        collectEditFirst(item.id, item.sku, item.product_id, item.offer_id),
      ].join("|");
      if (collectEditInitScopeRef.current === itemScope) return;
      collectEditInitScopeRef.current = itemScope;
      collectEditDimensionDirtyRef.current = new Set();
      const categorySeed = collectEditCategoryPreviewSeed({
        item,
        targetStoreId: categoryStoreId,
        taxonomyScope: categoryTaxonomyScope,
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
      const nextSku = String(draft.sku || item.sku || item.product_id || item.offer_id || item.id || "");
      const nextTitle = collectEditFirst(draft.title, item.name, item.title, item.offer_id);
      const nextCurrency = storeCurrencyCode;
      const nextPrice = normalizeCollectEditVariantRow({
        variant: item, draftVariant: draft, targetCurrencyCode: nextCurrency,
      }).sellPrice;
      const nextImages = collectEditImages({ ...item, images: draft.images || item.images }, draft.image || "");
      const nextOfferPrefix = draft.offerPrefix || "jz-";
      const draftVariants = Array.isArray(draft.variants) ? draft.variants : [];
      const variantSourceItem = draftVariants.length
        ? { ...item, variants: draftVariants }
        : item;
      const nextVariantRows = collectEditVariantRows({
        item: variantSourceItem, sourceItem: item, sku: nextSku, title: nextTitle,
        price: nextPrice, images: nextImages, offerPrefix: nextOfferPrefix,
        targetStoreId: categoryStoreId, taxonomyScope: categoryTaxonomyScope,
        targetCurrencyCode: nextCurrency,
      });
      setSku(nextSku);
      setTitle(nextTitle);
      setPrice(nextVariantRows[0]?.sellPrice ?? nextPrice);
      setCurrencyCode(nextCurrency);
      setImage(nextImages[0] || "");
      setBrand(collectEditFirst(draft.brand, item.brand) || "Нет бренда");
      setModelName(collectEditFirst(draft.modelName, item.modelName, item.model_name, item.offer_id, nextSku));
      setOfferPrefix(nextOfferPrefix);
      setDescription(draft.description ?? collectEditFirst(item.description, item.desc, item.subtitle, nextVariantRows.find(row => row.sku === nextSku)?.description));
      setDescriptionMode("编辑");
      setTags(Array.isArray(draft.tags) && draft.tags.length ? draft.tags : collectEditTags(item, nextTitle));
      setRichContent(draft.richContent ?? collectEditFirst(item.richContent, nextVariantRows.find(row => row.sku === nextSku)?.richContent));
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
      setVariantRows(nextVariantRows);
      setSelectedVariantKeys([]);
      setExpandedVariantKeys([]);
      setVariantSearch("");
      setVariantFilter("all");
      setVariantPage(1);
      setDraftDirty(false);
    } else {
      setPreviewItem(null);
      setCategoryAutoError("");
      setCategorySchema([]);
      setCategorySchemaError("");
      setCategoryAttributeValues({});
    }
  }, [itemId, item, itemScopeCurrent, storeCurrencyCode, categoryStoreId, categoryTaxonomyScope, listingWarehouseOptionKey]);

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
    if (listingResult?.submitted) {
      message.info("该草稿已提交，请到上架记录查看结果");
      return;
    }
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
    if (variantPackageMissingRows.length) {
      setExpandedVariantKeys([variantPackageMissingRows[0].key]);
      message.warning(`请填写 SKU ${variantPackageMissingRows[0].sku} 的有效包装重量和尺寸，再进行上架预检`);
      document.getElementById("SKU 与图片")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    if (!storeCurrencyCode || currencyCode !== storeCurrencyCode) {
      message.warning("请先确认目标店铺的上架币种");
      return;
    }
    if (!variantRows.length || variantRows.some((row) => !(numberFromMoney(row.sellPrice) > 0))) {
      message.warning(`请为每个 SKU 填写有效的 ${storeCurrencyCode} 售价，来源价格不会自动换汇`);
      return;
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
      detail: dryRun ? "正在保存当前修改并检查上架资料。" : `正在保存当前修改并提交到「${targetStoreOptions.find((option) => option.value === categoryStoreId)?.label || categoryStoreId}」。`,
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
      const warnings = result?.warnings || [];
      if (dryRun && result?.ok) {
        const preview = result || {};
        const first = Array.isArray(preview.items) ? preview.items[0] : null;
        if (first) setPreviewItem(first);
        const summary = first
          ? `类目 ${first.description_category_id || "—"} / 类型 ${first.type_id || "—"} / 属性 ${first.attributeCount || 0} / 图片 ${first.imageCount || 0}`
          : `共 ${preview.itemCount || 0} 个商品`;
        setListingResult({
          status: warnings.length ? "warning" : "success",
          title: warnings.length ? "预检通过，部分资料需补充" : "预检通过",
          detail: summary,
          warnings,
        });
        message[warnings.length ? "warning" : "success"]({ content: warnings.length ? "预检通过，请查看下方资料提示" : `预检通过：${summary}`, key: "edit-submit", duration: 5 });
        return;
      }
      if (result?.ok) {
        await onRefresh?.();
        const taskId = result.task_id || result.result?.task_id || result.job?.taskId || "";
        setListingResult({
          status: warnings.length ? "warning" : "pending",
          title: result.queued ? "已进入正式上架队列" : "Ozon 已受理，等待最终结果",
          warnings,
          submitted: true,
          detail: taskId
            ? `任务 ID ${taskId}；当前商品资料已保存，请在上架记录中查看平台处理结果。`
            : "上架任务已创建，请在上架记录中查看平台处理结果。",
        });
        message.info({ content: result.queued ? "已进入上架队列，最终结果请以上架记录为准" : "Ozon 已受理，最终结果请以上架记录为准", key: "edit-submit" });
        if (!warnings.length) setTimeout(function() { navigate("/ozon/products/import-history"); }, 800);
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

  const anchorVariant = variantRows.find((row) => String(row.sku || "") === String(sku || ""));
  const productImageList = anchorVariant?.images ?? (Array.isArray(item?.listingDraft?.images)
    ? item.listingDraft.images : collectEditImages(item || {}, image));
  const isSingleSku = variantRows.length <= 1;
  const isCollectItem = Boolean(itemScopeCurrent && item?.id && collectItems.some(function(i) { return String(i.id) === String(item.id); }));
  const handleCategoryPreview = function() {
    if (account?.role !== "admin") {
      message.warning("只有管理员可以确认商品类目");
      return;
    }
    message.info("请在类目树中选择最末级商品类型并完成管理员确认");
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
    const anchorIndex = variantRows.findIndex((row) => String(row.sku || "") === anchorSku);
    const draftVariants = variantRows.map((row, index) => {
      const {
        sourcePriceDisplay: _sourcePriceDisplay,
        descriptionCategoryId: _historicalDescriptionCategoryId,
        description_category_id: _historicalDescriptionCategoryIdSnake,
        typeId: _historicalTypeId,
        type_id: _historicalTypeIdSnake,
        ...rowWithoutCategoryRoots
      } = row;
      const rowCategory = collectEditDraftVariantCategory({
        item,
        itemId: collectEditFirst(item?.id, item?.collectItemId, itemId),
        row,
        targetStoreId: categoryStoreId,
        taxonomyScope: categoryTaxonomyScope,
        fallbackResolution: categoryResolution,
        manualOverride: scopedPreviewItem?.categoryManualOverride,
        interactivePreview: scopedPreviewItem?.categoryPreviewOverride,
      });
      const rowResolution = rowCategory.categoryResolution;
      const rowTarget = rowCategory;
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
        contentDiagnostics: {
          ...row.contentDiagnostics,
          description: description.trim() === String(row.description || "").trim() ? row.contentDiagnostics?.description
            : { status: description.trim() ? "provided" : "not_provided", source: "manual" },
          richContent: richContent.trim() === String(row.richContent || "").trim() ? row.contentDiagnostics?.richContent
            : { status: richContent.trim() ? "provided" : "not_provided", source: "manual" },
        },
        description,
        richContent,
        brand,
        tags,
        packageWeight,
        packageLength,
        packageWidth,
        packageHeight,
        logistics: { ...row.logistics, weightG: packageWeight, lengthMm: packageLength, widthMm: packageWidth, heightMm: packageHeight },
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
      logistics: { weightG: packageWeight, lengthMm: packageLength, widthMm: packageWidth, heightMm: packageHeight },
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
      contentDiagnostics: draftVariants[anchorIndex]?.contentDiagnostics,
      savedAt: new Date().toISOString(),
    };
  };

  const saveListingDraft = async function({ silent = false, onlyIfChanged = false } = {}) {
    if (!itemScopeCurrent || !item?.id || !isCollectItem) {
      const detail = "当前商品店铺数据未就绪，暂不能写回草稿";
      if (!silent) message.warning(detail);
      throw new Error(detail);
    }
    const savedRevision = editRevisionRef.current;
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
      if (editRevisionRef.current === savedRevision) setDraftDirty(false);
      if (!silent) message.success("草稿已保存");
      return { draft, saved, unchanged: false };
    } catch (error) {
      if (!silent) message.error("草稿保存失败: " + (error?.message || error));
      throw error;
    }
  };

  const handleSaveDraft = async function() {
    if (savingDraft || loading) return;
    setSavingDraft(true);
    try { await saveListingDraft({ silent: false }); } catch { /* The save error is already displayed. */ }
    finally { setSavingDraft(false); }
  };
  const currentDraft = item?.listingDraft || {};
  const categoryResolution = collectEditEffectiveCategoryResolution({
    item,
    itemId: collectEditFirst(item?.id, item?.collectItemId, itemId),
    targetStoreId: categoryStoreId,
    taxonomyScope: categoryTaxonomyScope,
    interactivePreview: scopedPreviewItem?.categoryPreviewOverride,
    manualOverride: scopedPreviewItem?.categoryManualOverride,
    legacyResolution: scopedPreviewItem?.categoryResolution || currentDraft.categoryResolution,
  });
  const categoryResolutionViewState = categoryResolution
    ? categoryResolutionView(categoryResolution)
    : null;
  const categoryNeedsManualSelection = categoryResolutionViewState?.action === "ADMIN_CONFIRM";
  const categoryTargetFields = listingCategoryFields(categoryResolution, {
    taxonomyScope: categoryTaxonomyScope,
  });
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
  ) || (categoryMatched ? "已保存上架类目，名称待加载" : "等待确认上架类目");
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
  const handleCategoryChange = async function(_, selectedOptions = []) {
    if (account?.role !== "admin") {
      message.warning("只有管理员可以确认商品类目");
      return;
    }
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
    const selectionKey = `${item?.id || item?.collectItemId || ""}:${item?.draftVersion || ""}:${nextDescriptionId}:${nextTypeId}:${categoryTaxonomyScope}`;
    let confirmation = categoryConfirmationIntentRef.current;
    if (!confirmation || confirmation.selectionKey !== selectionKey) {
      const identity = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        confirmation = {
          selectionKey,
          body: collectCategoryConfirmationIntent({
            item,
            descriptionCategoryId: nextDescriptionId,
            typeId: nextTypeId,
            taxonomyScope: categoryTaxonomyScope,
            idempotencyKey: `category-confirmation-${identity}`,
            correlationId: `category-confirmation-${identity}`,
          }),
        };
      } catch {
        setCategoryAutoError("无法确认商品类目，请人工选择");
        message.error("当前商品版本无效，请刷新后重新选择类目");
        return;
      }
      categoryConfirmationIntentRef.current = confirmation;
    }
    message.loading({ content: "正在提交管理员类目确认…", key: "collect-category-confirmation", duration: 0 });
    try {
      const result = await apiRequest("/ozon/category-confirmations", {
        method: "POST",
        body: confirmation.body,
      });
      const confirmationResult = categoryConfirmationResponse(result?.data, confirmation.body);
      const confirmed = confirmationResult?.categoryResolution;
      if (!confirmed) {
        throw new Error("ZONGZI_CATEGORY_CONFIRMATION_RESPONSE_INVALID");
      }
      categoryConfirmationIntentRef.current = null;
      setPreviewItem((prev) => ({
        ...(prev || {}),
        description_category_id: nextDescriptionId,
        type_id: nextTypeId,
        categoryPath: nextZhPath,
        categoryPathZh: nextZhPath,
        categoryPathRu: nextRuPath,
        category_name: nextZhPath,
        type_name: collectEditText(leaf?.label),
        categoryResolution: confirmed,
        categoryManualOverride: {
          itemId: confirmation.body.collectItemId,
          taxonomyScope: categoryTaxonomyScope,
          resolution: confirmed,
        },
      }));
      setCategoryAutoError("");
      message.success({ content: "管理员类目确认已保存", key: "collect-category-confirmation" });
      try {
        await onRefresh?.({ silent: true, source: "category-confirmation" });
      } catch {
        message.info("类目已保存，列表刷新失败，请稍后手动刷新");
      }
    } catch {
      setCategoryAutoError("无法确认商品类目，请人工选择");
      message.error({ content: "类目确认失败，请重试或联系管理员", key: "collect-category-confirmation" });
    }
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

  const hasPackageDimensions = [packageWeight, packageLength, packageWidth, packageHeight]
    .every((value) => numberFromMoney(value) > 0);
  const variantPackageMissingRows = variantRows.filter((row) => row.sku !== sku
    && (row.packageEditedFields || []).some((field) => !(numberFromMoney(row[field]) > 0)));
  const activeCurrencyCode = storeCurrencyCode;
  const listingStockNumber = numberFromMoney(listingStock);
  const listingStockReady = collectEditText(listingStock) !== "" && listingStockNumber !== null && listingStockNumber >= 0;
  const listingWarehouseReady = listingWarehouseOptions.some((option) => option.value === String(listingWarehouseId));
  const requiredCategoryAttributeRows = categoryAttributeInputRows.filter((row) => row.required);
  const missingRequiredCategoryAttributes = requiredCategoryAttributeRows
    .filter((row) => !collectEditRequiredValueFilled(categoryAttributeValues[row.key] ?? row.value, row))
    .map((row) => row.label || row.key);
  const editorCategoryStatus = categoryMatched
    ? (missingRequiredCategoryAttributes.length ? `类目已匹配，待填写：${missingRequiredCategoryAttributes.join("、")}` : "类目已匹配")
    : categoryResolutionViewState?.label || "商品类目状态暂时无法确认，请联系管理员";
  const variantRequiredReady = Boolean(variantRows.length) && variantRows.every((row) => {
    const rowPrice = row.sellPrice;
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
    numberFromMoney(price) <= 0 ? "售价" : "",
    !productImageList.length ? "商品图片" : "",
    !collectEditRequiredValueFilled(brand) ? "品牌" : "",
    !collectEditRequiredValueFilled(activeCurrencyCode) || currencyCode !== activeCurrencyCode ? "上架货币" : "",
    !listingWarehouseReady ? "上架仓库" : "",
    !listingStockReady ? "上架库存" : "",
    !hasPackageDimensions ? "包装重量和尺寸" : "",
    ...variantPackageMissingRows.map((row) => `SKU ${row.sku} 包装重量和尺寸`),
    !categoryMatched ? "产品类目" : "",
    !categoryReadinessState.ready ? "真实类目数据可用" : "",
    categorySchemaLoading ? "类目属性加载完成" : "",
    categorySchemaError ? "类目属性重新加载" : "",
    !variantRequiredReady ? "SKU 货号、名称和售价" : "",
    ...missingRequiredCategoryAttributes.map((label) => `类目属性「${label}」`),
  ].filter(Boolean);
  const listingMissingRequiredText = enrichmentListingBlockedText || (listingRequiredMissingFields.length
    ? `请先完善必填项：${listingRequiredMissingFields.slice(0, 6).join("、")}${listingRequiredMissingFields.length > 6 ? `等 ${listingRequiredMissingFields.length} 项` : ""}`
    : "");
  const listingSubmitDisabledReason = listingResult?.submitted ? "该草稿已提交，请到上架记录查看结果" : listingMissingRequiredText || categoryReadinessState.message;
  const listingSubmitDisabled = loading || Boolean(listingResult?.submitted) || Boolean(listingRequiredMissingFields.length) || !categoryReadinessState.ready;
  const readyChecks = [
    !preparationModel.listingBlocked,
    Boolean(targetStoreId),
    collectEditRequiredValueFilled(sku),
    collectEditRequiredValueFilled(title),
    numberFromMoney(price) > 0,
    Boolean(productImageList.length),
    collectEditRequiredValueFilled(brand),
    hasPackageDimensions && !variantPackageMissingRows.length,
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
    { title: "店铺与基础", note: targetStoreId ? "已选择店铺" : "待选择" },
    { title: "SKU 与图片", note: isSingleSku ? "单 SKU 商品" : `${variantRows.length} 个可编辑 SKU` },
    { title: "产品类目", note: editorCategoryStatus },
    { title: "标题与文案", note: title ? "已填写" : "待填写" },
    { title: "物流尺寸", note: packageWeight && packageLength && packageWidth && packageHeight ? "已填写" : "待填写" },
    { title: "类目属性", note: categoryAttributeInputRows.length ? `${categoryAttributeInputRows.length} 项` : categorySchemaLoading ? "加载中" : "待匹配" },
    { title: "货源信息", note: sourceLink ? "已填写" : "可选" },
  ];
  const reindexVariantRows = (rows) => rows.map((row, index) => ({ ...row, index: index + 1 }));
  const updateVariantRow = (key, patch) => {
    const row = variantRows.find((row) => row.key === key);
    if (!row) return;
    markDraftEdited();
    const packageFields = { packageWeight: "weightG", packageLength: "lengthMm", packageWidth: "widthMm", packageHeight: "heightMm" };
    const logisticsPatch = Object.fromEntries(Object.entries(packageFields).filter(([field]) => Object.hasOwn(patch, field)).map(([field, target]) => [target, patch[field]]));
    const mediaEdits = Object.fromEntries(['color_image', 'videoCoverUrl'].filter(field => Object.hasOwn(patch, field))
      .map(field => [field, { status: String(patch[field] || '').trim() ? 'provided' : 'not_provided', source: 'manual' }]));
    setVariantRows((rows) => rows.map((row) => row.key === key ? { ...row, ...patch,
      ...(Object.keys(mediaEdits).length ? { contentDiagnostics: { ...row.contentDiagnostics, ...patch.contentDiagnostics, ...mediaEdits } } : {}),
      ...(Object.keys(logisticsPatch).length ? {
        logistics: { ...row.logistics, ...logisticsPatch },
        packageEditedFields: [...new Set([...(row.packageEditedFields || []), ...Object.keys(packageFields).filter((field) => Object.hasOwn(patch, field))])],
      } : {}),
    } : row));
    if (key === variantRows[0]?.key && Object.hasOwn(patch, "sellPrice")) setPrice(patch.sellPrice);
    if (variantRows.length === 1 && Object.hasOwn(patch, "stock")) setListingStock(String(patch.stock));
    if (row.sku === sku) {
      if (Object.hasOwn(patch, "name")) setTitle(patch.name);
      if (Object.hasOwn(patch, "image")) setImage(patch.image);
    }
  };
  const deleteVariantRow = (key) => {
    if (variantRows.length <= 1) {
      message.warning("至少保留 1 个 SKU");
      return;
    }
    if (!variantRows.some((row) => row.key === key)) {
      message.warning("未找到要删除的 SKU");
      return;
    }
    markDraftEdited();
    const nextRows = reindexVariantRows(variantRows.filter((row) => row.key !== key));
    setVariantRows(nextRows);
    setPrice(nextRows[0]?.sellPrice || "");
    setSelectedVariantKeys((keys) => keys.filter((value) => value !== key));
    setExpandedVariantKeys((keys) => keys.filter((value) => value !== key));
    message.success("已从草稿移除 SKU，保存后生效");
  };
  const deleteSelectedVariants = () => {
    if (!selectedVariantKeys.length) return;
    const selectedSet = new Set(selectedVariantKeys);
    const nextRows = variantRows.filter((row) => !selectedSet.has(row.key));
    if (!nextRows.length) {
      message.warning("至少保留 1 个 SKU");
      return;
    }
    markDraftEdited();
    setVariantRows(reindexVariantRows(nextRows));
    setPrice(nextRows[0]?.sellPrice || "");
    setSelectedVariantKeys([]);
    setExpandedVariantKeys((keys) => keys.filter((value) => !selectedSet.has(value)));
    message.success(`已从草稿移除 ${variantRows.length - nextRows.length} 个 SKU，保存后生效`);
  };
  const applySelectedVariantValues = () => {
    const patch = batchPrice !== "" ? { sellPrice: batchPrice } : {};
    if (!selectedVariantKeys.length || !Object.keys(patch).length) return;
    markDraftEdited();
    const selected = new Set(selectedVariantKeys);
    setVariantRows((rows) => rows.map((row) => selected.has(row.key) ? { ...row, ...patch } : row));
    if (selected.has(variantRows[0]?.key) && Object.hasOwn(patch, "sellPrice")) setPrice(patch.sellPrice);
  };
  const skuMissingFields = (row) => [
    !collectEditText(row.offerId) ? "货号" : "",
    !collectEditText(row.name) ? "名称" : "",
    !(numberFromMoney(row.sellPrice) > 0) ? "售价" : "",
    !listingStockReady ? "上架库存" : "",
    !row.images?.length ? "图片" : "",
    variantPackageMissingRows.some((missingRow) => missingRow.key === row.key) ? "包装重量和尺寸" : "",
  ].filter(Boolean);
  const filteredVariantRows = variantRows.filter((row) => {
    const matchesSearch = [row.sku, row.offerId, row.name, row.specification].some((value) => String(value || "").toLocaleLowerCase().includes(variantSearch.trim().toLocaleLowerCase()));
    return matchesSearch && (variantFilter !== "missing" || skuMissingFields(row).length > 0);
  });
  const renderSkuAdvanced = (row) => (
    <div className="collect-edit-sku-details">
      {!isSingleSku && <CollectEditSkuMedia row={row} onChange={(patch) => updateVariantRow(row.key, patch)} />}
      <Form layout="vertical" className="collect-edit-grid">
        <Form.Item label="来源 SKU"><Input aria-label={`来源 SKU ${row.sku}`} value={row.sku} readOnly /></Form.Item>
        <Form.Item label="SKU 货号"><Input aria-label={`SKU ${row.sku} 货号`} value={row.offerId} onChange={(event) => updateVariantRow(row.key, { offerId: event.target.value })} /></Form.Item>
        <Form.Item label="采集规格"><Input aria-label={`SKU ${row.sku} 采集规格`} value={row.specification} placeholder="未记录规格说明" readOnly /></Form.Item>
        <Form.Item label={`划线价 ${currencyCode}`}><Input aria-label={`SKU ${row.sku} 划线价`} value={row.oldPrice} inputMode="decimal" onChange={(event) => updateVariantRow(row.key, { oldPrice: event.target.value })} /></Form.Item>
        {row.purchasePrice && <Form.Item label="采购原记录（币种未记录）"><Input aria-label={`SKU ${row.sku} 采购原记录`} value={row.purchasePrice} readOnly /></Form.Item>}
        <Form.Item label="采集条形码"><Input aria-label={`SKU ${row.sku} 采集条形码`} value={row.barcode} readOnly /></Form.Item>
      </Form>
      <Form layout="vertical">
        <Form.Item label="SKU 名称"><Input aria-label={`SKU ${row.sku} 名称`} value={row.name} onChange={(event) => updateVariantRow(row.key, { name: event.target.value })} /></Form.Item>
      </Form>
      {row.sku === sku ? <p className="collect-edit-scope-note">此 SKU 的文案、包装与类目属性在下方主商品资料中编辑。</p> : <>
        <Form layout="vertical" className="collect-edit-size-grid">
          {[["packageWeight", "包装重量", "克"], ["packageLength", "包装长", "毫米"], ["packageWidth", "包装宽", "毫米"], ["packageHeight", "包装高", "毫米"]].map(([field, label, unit]) => {
            const invalidEdit = row.packageEditedFields?.includes(field) && !(numberFromMoney(row[field]) > 0);
            return <Form.Item key={field} label={label} required validateStatus={invalidEdit ? "error" : undefined} help={invalidEdit ? "上架前请填写大于 0 的数值" : undefined}><Input aria-label={`SKU ${row.sku} ${label}`} value={row[field]} suffix={unit} onChange={(event) => updateVariantRow(row.key, { [field]: event.target.value })} /></Form.Item>;
          })}
        </Form>
        <Form layout="vertical">
          <Form.Item label="SKU 专属简介"><Input.TextArea aria-label={`SKU ${row.sku} 简介`} value={row.description} rows={4} onChange={(event) => updateVariantRow(row.key, { description: event.target.value, contentDiagnostics: { ...row.contentDiagnostics, description: { status: event.target.value.trim() ? "provided" : "not_provided", source: "manual" } } })} /></Form.Item>
          <Form.Item label="SKU 原采集富内容 JSON"><Input.TextArea aria-label={`SKU ${row.sku} 原采集富内容`} value={row.richContent} rows={3} readOnly /></Form.Item>
        </Form>
      </>}
      <details className="collect-edit-details">
        <summary>视频、颜色样本与资料来源</summary>
        <Form layout="vertical" className="collect-edit-grid">
          <Form.Item label="采集视频链接"><Input aria-label={`SKU ${row.sku} 采集视频链接`} value={row.video} readOnly /></Form.Item>
          <Form.Item label="独立颜色样本"><Input aria-label={`SKU ${row.sku} 独立颜色样本`} value={row.color_image} onChange={(event) => updateVariantRow(row.key, { color_image: event.target.value })} /></Form.Item>
          <Form.Item label="封面视频"><Input aria-label={`SKU ${row.sku} 封面视频`} value={row.videoCoverUrl} placeholder="MP4 / MOV（选填）" onChange={(event) => updateVariantRow(row.key, { videoCoverUrl: event.target.value })} /></Form.Item>
        </Form>
        {!!row.videos?.length && <div className="collect-edit-video-list">{row.videos.map((video, index) => <a key={index} href={safeExternalHttpUrl(typeof video === "string" ? video : video.url || video.videoUrl)} target="_blank" rel="noreferrer">{video.coverUrl && <img loading="lazy" decoding="async" src={video.coverUrl} alt="" />}原采集视频 {index + 1}</a>)}</div>}
        <p className="collect-edit-scope-note">{collectEditContentNotes(row)}</p>
        <div className="collect-edit-attribute-list">{collectEditAttributeRows({ attributes: row.categoryAttributes || row.sourceVariant?.attributes || [] }).map((attribute, index) => <div className="collect-edit-attribute-row" key={index}><span>{attribute.label || attribute.name || attribute.key}</span><strong>{attribute.value || "—"}</strong></div>)}</div>
      </details>
      {!isSingleSku && <div className="collect-edit-sku-detail-actions"><Button size="small" danger onClick={() => deleteVariantRow(row.key)}>从草稿移除</Button></div>}
    </div>
  );
  const variantColumns = [
    { title: "规格 / SKU", key: "sku", render: (_, row) => <div className="collect-edit-sku-identity">{row.image ? <Image width={44} height={44} className="collect-edit-table-image" src={row.image} alt="" /> : <PictureOutlined />}<div><strong title={row.specification || row.name}>{row.specification || row.name || "未填写名称"}</strong><span>SKU {row.sku || "待填写"}</span><span>货号 {row.offerId || "待填写"}</span></div></div> },
    { title: `售价 ${currencyCode}`, dataIndex: "sellPrice", width: 132, render: (value, row) => <div className="collect-edit-sku-price"><Input size="small" aria-label={`SKU ${row.sku} 售价`} inputMode="decimal" value={value} onChange={(event) => updateVariantRow(row.key, { sellPrice: event.target.value })} /><span>采集 {row.sourcePriceDisplay || "—"}</span></div> },
    { title: "上架库存", key: "listingStock", width: 86, render: () => <span title="使用本组统一上架库存">{listingStock || "待填写"}</span> },
    { title: "图片", key: "images", width: 66, render: (_, row) => <span>{row.images?.length || 0} 张</span> },
    { title: "基础资料", key: "status", width: 100, render: (_, row) => <Tooltip rootClassName="prototype-overlay" title={skuMissingFields(row).join("、") || "货号、名称、售价、库存与图片已填写；提交结果以预检为准"}><Tag color={skuMissingFields(row).length ? "orange" : "green"}>{skuMissingFields(row).length ? "待填写" : "已填写"}</Tag></Tooltip> },
    { title: "操作", key: "actions", width: 78, render: (_, row) => <Button size="small" type="link" aria-label={`编辑 SKU ${row.sku}`} aria-expanded={expandedVariantKeys.includes(row.key)} onClick={() => setExpandedVariantKeys(expandedVariantKeys.includes(row.key) ? [] : [row.key])}>{expandedVariantKeys.includes(row.key) ? "收起" : "编辑"}</Button> },
  ];

  if (!itemId || !item) {
    return (
      <div className="source-page">
        <Card>
          <Empty
            description="当前没有可编辑的待上架商品。若已完成上架，请在上架记录中查看。"
          >
            <Space wrap>
              <Button onClick={() => navigate("/ozon/products/collect")}>返回采集箱</Button>
              <Button type="primary" onClick={() => navigate("/ozon/products/import-history")}>查看上架记录</Button>
            </Space>
          </Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="source-page collect-edit-page">
      <div className="collect-edit-header">
        <div className="collect-edit-product">
          <div className="collect-edit-cover">
            {productImageList[0] ? <img loading="lazy" decoding="async" src={productImageList[0]} alt="" /> : <PictureOutlined />}
          </div>
          <div className="collect-edit-title-block">
            <h1>{title || "商品信息编辑"}</h1>
            <div className="collect-edit-meta">
              <span>SKU {sku || "—"}</span>
              <span>{isSingleSku ? "单 SKU 商品" : `${variantRows.length} 个可编辑 SKU`}</span>
              <span>{isSingleSku ? "商品图库" : "主商品图库"} {productImageList.length} 张</span>
            </div>
          </div>
        </div>
        <div className="collect-edit-head-actions">
          <Button onClick={function() { navigate("/ozon/products/collect"); }}>返回列表</Button>
          <div className="collect-edit-ready">
            <span>基础资料完整度</span>
            <strong>{readyCount}/{readyChecks.length} 项</strong>
            <div><i style={{ width: `${readyPercent}%` }} /></div>
          </div>
        </div>
      </div>

      <div className="collect-edit-status-bar">
        <div className="collect-edit-status-summary">
          {enrichmentView.label && <Tag color={collectEnrichmentTagColors[enrichmentView.tone] || "default"}>{enrichmentView.label}</Tag>}
          {Number(effectiveEnrichment?.totalSkus) > 0 && <span>原采集补全 {Number(effectiveEnrichment.completedSkus) || 0}/{Number(effectiveEnrichment.totalSkus)} 个 SKU{Number(effectiveEnrichment.totalSkus) > variantRows.length ? "（含已上架 SKU）" : ""}</span>}
          <span>{listingResult?.submitted ? "已提交，等待平台结果" : draftDirty ? "有未保存修改" : "正在编辑草稿"}</span>
        </div>
        <details className="collect-edit-status-details">
          <summary>{listingRequiredMissingFields.length ? `${listingRequiredMissingFields.length} 项资料待完善` : "基础资料已填写"} · {contentRating.missing.length} 项优化建议</summary>
          <p>完整度只表示基础字段填写情况。预检及平台处理结果会单独显示。</p>
          {!!listingRequiredMissingFields.length && <ul>{listingRequiredMissingFields.map((field) => <li key={field}><a href={`#${field.includes("类目") ? "产品类目" : field.includes("包装") ? "物流尺寸" : field.includes("标题") ? "标题与文案" : field.includes("SKU") || field.includes("售价") || field.includes("图片") ? "SKU 与图片" : "店铺与基础"}`}>{field}</a></li>)}</ul>}
          {!!contentRating.missing.length && <p>本地内容优化建议：{contentRating.missing.join("；")}。这些建议不是 Ozon 的审核评分。</p>}
        </details>
      </div>
      {enrichmentView.label && (enrichmentView.listingBlocked || enrichmentView.retryable) ? (
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
      {listingResult ? (
        <Alert
          className="collect-listing-result"
          type={listingResult.status === "success" ? "success" : listingResult.status === "pending" ? "info" : listingResult.status === "warning" ? "warning" : "error"}
          showIcon
          message={listingResult.title}
          description={<>
            <div>{listingResult.detail}</div>
            {!!listingResult.warnings?.length && <ul>{listingResult.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            {listingResult.submitted && <Button type="link" onClick={() => navigate("/ozon/products/import-history")}>查看上架记录</Button>}
          </>}
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
                <p>{isSingleSku ? "选择本商品的上架店铺与仓库" : "公共上架设置；SKU 专属内容在列表中编辑"}</p>
              </div>
              <Space>
                <Button size="small" onClick={onBind}>店铺管理 →</Button>
              </Space>
            </div>
            <Form layout="vertical" className="collect-edit-grid">
              <Form.Item label="上架店铺">
                <Select showSearch value={targetStoreId || undefined} options={targetStoreOptions} placeholder="明确选择目标经营店铺" notFoundContent="没有启用且已保存凭据的经营店铺" optionFilterProp="label" onChange={selectListingTarget} />
              </Form.Item>
              <Form.Item label="品牌">
                <Input value={brand} onChange={(event) => editValue(setBrand, event.target.value)} placeholder="Нет бренда" />
              </Form.Item>
              <Form.Item label="上架货币">
                <Select
                  value={storeCurrencyCode || undefined}
                  disabled
                  placeholder="请先同步目标店铺币种"
                  options={[
                    { value: "CNY", label: "[¥] 人民币" },
                    { value: "RUB", label: "[₽] 卢布" },
                    { value: "USD", label: "[$] 美元" },
                    { value: "EUR", label: "[€] 欧元" },
                  ]}
                />
                <div className="collect-edit-field-note">
                  来源采集价：{formatCollectSourcePrice(item || {})}。
                  {storeCurrencyCode ? `请按 ${storeCurrencyCode} 为每个 SKU 填写上架售价；不同币种不会自动换汇。` : "目标店铺币种确认后才能填写上架售价。"}
                </div>
              </Form.Item>
              <Form.Item label="上架仓库">
                <Select
                  showSearch
                  value={listingWarehouseId || undefined}
                  options={listingWarehouseOptions}
                  placeholder="选择上架库存仓库"
                  notFoundContent="当前店铺暂无可用 FBS / RFBS 仓库，请到店铺管理同步仓库"
                  optionFilterProp="label"
                  onChange={(value) => editValue(setListingWarehouseId, value || "")}
                />
              </Form.Item>
            </Form>
            <details className="collect-edit-details">
              <summary>商品标识与货号规则</summary>
              <Form layout="vertical" className="collect-edit-grid">
                <Form.Item label={isSingleSku ? "商品型号" : "合并变体型号"}><Input value={modelName} onChange={(event) => editValue(setModelName, event.target.value)} placeholder="输入型号" /></Form.Item>
                <Form.Item label="新增货号前缀"><Input value={offerPrefix} onChange={(event) => editValue(setOfferPrefix, event.target.value)} placeholder="jz-" /></Form.Item>
                <Form.Item label="主商品来源 SKU"><Input aria-label="主商品来源 SKU" value={sku} readOnly /></Form.Item>
              </Form>
            </details>
          </section>

          <section className="collect-edit-section" id="SKU 与图片">
            <div className="collect-edit-section-head">
              <div>
                <h2>{isSingleSku ? "售价、库存与图片" : "SKU 列表"}</h2>
                <p>{isSingleSku ? "单 SKU 商品，直接编辑并保存" : `${variantRows.length} 个可编辑 SKU；售价与图库独立编辑，上架库存统一设置`}</p>
              </div>
            </div>
            {isSingleSku ? variantRows[0] && <>
              <Form layout="vertical" className="collect-edit-grid collect-edit-single-commerce">
                <Form.Item label={`上架售价 ${currencyCode || "（待确认币种）"}`} required>
                  <Input aria-label={`SKU ${variantRows[0].sku} 售价`} value={variantRows[0].sellPrice} inputMode="decimal" onChange={(event) => updateVariantRow(variantRows[0].key, { sellPrice: event.target.value })} />
                  <span className="collect-edit-inline-note">采集价 {variantRows[0].sourcePriceDisplay || formatCollectSourcePrice(item)}</span>
                </Form.Item>
                <Form.Item label="上架库存" required><Input aria-label={`SKU ${variantRows[0].sku} 上架库存`} value={listingStock} inputMode="numeric" onChange={(event) => updateVariantRow(variantRows[0].key, { stock: event.target.value })} /></Form.Item>
                <Form.Item label="SKU 货号" required><Input aria-label={`SKU ${variantRows[0].sku} 货号`} value={variantRows[0].offerId} onChange={(event) => updateVariantRow(variantRows[0].key, { offerId: event.target.value })} /></Form.Item>
              </Form>
              <CollectEditSkuMedia row={variantRows[0]} onChange={(patch) => updateVariantRow(variantRows[0].key, patch)} />
              <details className="collect-edit-details"><summary>更多 SKU 信息（规格、划线价、视频等）</summary>{renderSkuAdvanced(variantRows[0])}</details>
            </> : <>
              <div className="collect-edit-group-stock">
                <label htmlFor="collect-edit-listing-stock">每个 SKU 上架库存</label>
                <Input id="collect-edit-listing-stock" aria-label="每个 SKU 上架库存" value={listingStock} inputMode="numeric" onChange={(event) => editValue(setListingStock, event.target.value)} />
                <span>本组 {variantRows.length} 个 SKU 上架时，每个 SKU 均使用此数量。</span>
              </div>
              <div className="collect-edit-sku-toolbar">
                <Input.Search aria-label="搜索规格或 SKU" allowClear value={variantSearch} placeholder="搜索规格 / SKU / 货号" onChange={(event) => { setVariantSearch(event.target.value); setVariantPage(1); }} />
                <Select aria-label="SKU 资料筛选" value={variantFilter} onChange={(value) => { setVariantFilter(value); setVariantPage(1); }} options={[{ value: "all", label: "全部 SKU" }, { value: "missing", label: "基础资料待填写" }]} />
                <span>找到 {filteredVariantRows.length} 个 SKU</span>
              </div>
              {!!selectedVariantKeys.length && <div className="collect-edit-sku-batch">
                <strong>已选 {selectedVariantKeys.length} 个 SKU</strong>
                <Input aria-label="批量售价" value={batchPrice} inputMode="decimal" placeholder={`售价 ${currencyCode}`} onChange={(event) => setBatchPrice(event.target.value)} />
                <Button disabled={batchPrice === ""} onClick={applySelectedVariantValues}>应用售价到已选</Button>
                <Button danger onClick={deleteSelectedVariants}>移除已选</Button>
                <Button type="text" onClick={() => setSelectedVariantKeys([])}>取消选择</Button>
              </div>}
              <Table
              className="collect-edit-variant-table"
              size="small"
              rowKey="key"
              columns={variantColumns}
              dataSource={filteredVariantRows}
              pagination={{ current: Math.min(variantPage, Math.max(1, Math.ceil(filteredVariantRows.length / variantPageSize))), pageSize: variantPageSize, onChange: (page, size) => { setVariantPage(page); setVariantPageSize(size); }, showTotal: (total) => `共 ${total} 个 SKU` }}
              scroll={{ x: 740 }}
              expandable={{ expandedRowKeys: expandedVariantKeys, showExpandColumn: false, expandedRowRender: renderSkuAdvanced }}
              rowSelection={{
                columnWidth: 36,
                preserveSelectedRowKeys: true,
                selectedRowKeys: selectedVariantKeys,
                onChange: setSelectedVariantKeys,
              }}
            />
            </>}
          </section>

          <section className="collect-edit-section" id="产品类目">
            <div className="collect-edit-section-head">
              <div>
                <h2>产品类目</h2>
                <p>{editorCategoryStatus}</p>
              </div>
              <Space size={8}>
                {account?.role === "admin" && <Button
                  size="small"
                  loading={categoryAutoLoading}
                  disabled={categoryAutoLoading}
                  aria-label="管理员确认类目"
                  onClick={handleCategoryPreview}
                >
                  管理员确认类目
                </Button>}
                <Tooltip rootClassName="prototype-overlay" title={editorCategoryStatus}>
                  <Tag color={categoryMatched ? "green" : collectEnrichmentTagColors[categoryResolutionViewState?.tone || (categoryAutoLoading ? "processing" : "default")]}>{editorCategoryStatus}</Tag>
                </Tooltip>
              </Space>
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
                disabled={!categoryTreeReady || account?.role !== "admin"}
                displayRender={(labels) => labels.length ? labels.join(" / ") : categoryLabel}
                expandTrigger="click"
                notFoundContent={categoryTreeLoading ? "正在加载类目..." : "暂无类目"}
                onChange={handleCategoryChange}
                options={categoryTreeOptionsZh}
                placeholder={categoryLabel}
                showSearch={{
                  filter: (inputValue, path) => path.some((option) =>
                    collectEditText(option.label).toLowerCase().includes(String(inputValue || "").toLowerCase()),
                  ),
                }}
                suffixIcon={categoryTreeLoading || categoryAutoLoading ? <SyncOutlined spin /> : undefined}
                value={categoryCascaderValue}
              />
            </div>
            <details className="collect-edit-details">
              <summary>查看类目来源与编号</summary>
            <div className="collect-edit-attr-strip">
              <span title={`来源 description_category_id: ${sourceCategory.descriptionCategoryId || "—"} / 候选 type_id: ${sourceCategory.typeIdCandidate || "—"}`}>
                采集来源：{sourceCategoryLabel}
              </span>
            </div>
            <div className="collect-edit-attr-strip">
              <span title={`description_category_id: ${categoryDescriptionId || "—"} / type_id: ${categoryTypeId || "—"}`}>
                账号共享类目：{categoryMatched ? `${categoryRussianLabel}（${categoryDescriptionId} / ${categoryTypeId}）` : categoryNeedsManualSelection ? "无法确认商品类目，请人工选择" : categoryResolutionViewState?.label || "商品类目状态暂时无法确认，请联系管理员"}
              </span>
            </div>
            </details>
            {categoryAutoError || categoryNeedsManualSelection ? <div className="collect-edit-empty-note">账号共享类目待处理：{categoryAutoError || "请由管理员选择类目并确认，确认成功后会继续使用同一共享类目。"}</div> : null}
          </section>

          <section className="collect-edit-section" id="标题与文案">
            <div className="collect-edit-section-head">
              <div>
                <h2>标题与文案</h2>
                <p>{isSingleSku ? (title ? "已填写" : "待填写") : `主商品 SKU ${sku} 的资料；其他 SKU 的专属内容在列表中编辑`}</p>
              </div>
            </div>
            <Form layout="vertical">
              <Form.Item label="俄语标题">
                <Input value={title} onChange={(event) => { if (anchorVariant) updateVariantRow(anchorVariant.key, { name: event.target.value }); else editValue(setTitle, event.target.value); }} placeholder="输入俄语标题" />
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
                    onChange={(event) => editValue(setDescription, event.target.value)}
                    placeholder="商品描述（支持 HTML 格式）"
                  />
                ) : (
                  <div className="collect-edit-preview">{description || "暂无商品描述"}</div>
                )}
              </Form.Item>
              <details className="collect-edit-details">
                <summary>主题标签与富内容</summary>
              <Form.Item label={`主题标签 ${tags.length}/30`}>
                <div className="collect-edit-tag-row">
                  {tags.length ? tags.map((tag) => <Tag key={tag}>#{tag}</Tag>) : <span>暂无标签</span>}
                </div>
              </Form.Item>
              <Form.Item label="JSON 富内容">
                <Input.TextArea
                  value={richContent}
                  rows={6}
                  onChange={(event) => editValue(setRichContent, event.target.value)}
                  placeholder="Ozon 富内容 JSON"
                />
              </Form.Item>
              </details>
            </Form>
          </section>

          <section className="collect-edit-section" id="物流尺寸">
            <div className="collect-edit-section-head">
              <div>
                <h2>物流尺寸</h2>
                <p>{hasPackageDimensions ? "已填写" : "待填写"}{!isSingleSku && ` · 主商品 SKU ${sku}；其他 SKU 的包装数据在列表中编辑`}</p>
              </div>
            </div>
            <Form layout="vertical" className="collect-edit-size-grid">
              <Form.Item label="包装重量">
                <Input value={packageWeight} suffix="克" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageWeight");
                  editValue(setPackageWeight, event.target.value);
                }} />
              </Form.Item>
              <Form.Item label="包装长">
                <Input value={packageLength} suffix="毫米" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageLength");
                  editValue(setPackageLength, event.target.value);
                }} />
              </Form.Item>
              <Form.Item label="包装宽">
                <Input value={packageWidth} suffix="毫米" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageWidth");
                  editValue(setPackageWidth, event.target.value);
                }} />
              </Form.Item>
              <Form.Item label="包装高">
                <Input value={packageHeight} suffix="毫米" onChange={(event) => {
                  collectEditDimensionDirtyRef.current.add("packageHeight");
                  editValue(setPackageHeight, event.target.value);
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
            <details className="collect-edit-details">
              <summary>采集参考信息</summary>
            <div className="collect-edit-attribute-grid">
              <div><span>品牌</span><strong>{brand || "Нет бренда"}</strong></div>
              <div><span>评分</span><strong>{item?.rating ? `${item.rating}★` : "—"}</strong></div>
              <div><span>评价数</span><strong>{item?.reviewCount || "—"}</strong></div>
              <div><span>卖家</span><strong>{item?.sellerName || item?.seller || "—"}</strong></div>
              <div><span>类目 ID</span><strong>{categoryDescriptionId || "—"}</strong></div>
              <div><span>类型 ID</span><strong>{categoryTypeId || "—"}</strong></div>
            </div>
            </details>
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
                        onChange={(value) => { markDraftEdited(); setCategoryAttributeValues((prev) => ({
                          ...prev,
                          [row.key]: collectEditSelectControlValue(value, row),
                        })); }}
                      />
                    ) : String(categoryAttributeValues[row.key] ?? row.value ?? "").length > 90 ? (
                      <Input.TextArea
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        value={categoryAttributeValues[row.key] ?? row.value ?? ""}
                        onChange={(event) => { markDraftEdited(); setCategoryAttributeValues((prev) => ({ ...prev, [row.key]: event.target.value })); }}
                        placeholder={row.required ? "必填属性" : "可选属性"}
                      />
                    ) : (
                      <Input
                        value={categoryAttributeValues[row.key] ?? row.value ?? ""}
                        onChange={(event) => { markDraftEdited(); setCategoryAttributeValues((prev) => ({ ...prev, [row.key]: event.target.value })); }}
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

          <section className="collect-edit-section" id="货源信息">
            <div className="collect-edit-section-head">
              <div>
                <h2>货源信息</h2>
                <p>可选</p>
              </div>
            </div>
            <Form layout="vertical">
              <Form.Item label="货源链接">
                <Input value={sourceLink} onChange={(event) => editValue(setSourceLink, event.target.value)} placeholder="Ozon 商品链接" />
              </Form.Item>
              <Form.Item label="备注">
                <Input.TextArea value={note} rows={3} onChange={(event) => editValue(setNote, event.target.value)} placeholder="备注" />
              </Form.Item>
            </Form>
          </section>

          <div className="collect-edit-footer-actions">
            <div className="collect-edit-save-state"><strong>{savingDraft ? "正在保存…" : draftDirty ? "有未保存修改" : "草稿修改后请保存"}</strong>{listingSubmitDisabledReason ? <span className="collect-edit-submit-reason">{listingSubmitDisabledReason}</span> : <span>预检会先保存当前修改</span>}</div>
            <Button loading={savingDraft} disabled={loading} onClick={handleSaveDraft}>保存草稿</Button>
            <Button loading={loading && !listingResult?.submitted} disabled={savingDraft || Boolean(listingResult?.submitted) || preparationModel.listingBlocked || !categoryReadinessState.ready} aria-label="上架预检" onClick={handlePreview} icon={<EyeOutlined />}>上架预检</Button>
            <Tooltip rootClassName="prototype-overlay" title={listingSubmitDisabledReason || ""}>
              <span className="collect-edit-submit-wrapper">
                <Button type="primary" loading={loading} disabled={savingDraft || listingSubmitDisabled} aria-label="提交上架到 Ozon" onClick={handleSubmit} icon={<CloudUploadOutlined />}>上架到 Ozon</Button>
              </span>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

export { CollectEditPage };

function ImportHistoryPage({ binding, hasStore, localData, onRefresh, account }) {
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
  const todayKey = localDayKey(new Date());
  const todayCount = tasks.filter((task) => {
    const date = new Date(task.createdAt || "");
    return !Number.isNaN(date.getTime()) && localDayKey(date) === todayKey;
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
      <AiListingCompletedRecords isAdmin={account?.role === "admin"} accountId={account?.id} storeId={currentStoreId} stores={localData?.stores||[]}/>
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


function ProductTemplatesPage({ hasStore, binding, localData, onRefresh }) {
  const formatTemplateTime = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  };
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


export function App() {
  return (
    <AntApp>
      <AppShell />
    </AntApp>
  );
}
