import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Card,
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
  BarChartOutlined,
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
  LineChartOutlined,
  LoginOutlined,
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

const { Header, Sider, Content } = Layout;

const STORAGE_KEY = "qh-local-binding-v1";
const SETTINGS_KEY = "qh-local-settings-v1";
const LOCAL_API_BASE = "http://127.0.0.1:3001";

const emptyLocalData = {
  currentStoreId: "",
  stores: [],
  summary: {
    products: 0,
    postings: 0,
    postingsTotal: 0,
    totalGmv: 0,
    todayPostings: 0,
    todayGmv: 0,
    weekPostings: 0,
    weekGmv: 0,
    awaitingPackaging: 0,
    awaitingDeliver: 0,
    pendingPostings: 0,
    statusCounts: {},
    warehouses: 0,
    collectBox: 0,
    favorites: 0,
    promotions: 0,
    returns: 0,
    refunds: 0,
    messageTemplates: 0,
    messageHistory: 0,
    productTemplates: 0,
    watermarkTemplates: 0,
    lastSyncAt: null,
  },
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    collectBox: [],
    favorites: [],
    promotions: [],
    returns: [],
    refunds: [],
    messageTemplates: [],
    messageHistory: [],
    productTemplates: [],
    watermarkTemplates: [],
  },
  jobs: {},
};

const pageTitles = {
  "/ozon/dashboard": "仪表盘",
  "/ozon/products/list": "商品列表",
  "/ozon/products/collect": "采集箱",
  "/ozon/products/collect/edit": "商品编辑",
  "/ozon/products/import-history": "上架记录",
  "/ozon/products/stocks": "库存管理",
  "/ozon/products/reshelf": "下架重上",
  "/ozon/selection/category": "类目分析",
  "/ozon/selection/top-list": "榜单选品",
  "/ozon/selection/china": "中国专区",
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
  "/ozon/tools/watermark": "水印管理",
  "/extension": "浏览器插件",
  "/ozon/messaging/templates": "消息模板",
  "/ozon/messaging/history": "发送记录",
  "/ozon/templates": "商品模板",
  "/ozon/settings/stores": "我的 Ozon 门店",
  "/404": "404",
};

const routeAliases = {
  "/ozon/products": "/ozon/products/list",
  "/ozon/products/batch-upload": "/ozon/products/import-history",
  "/ozon/selection/market": "/ozon/selection/top-list",
  "/ozon/selection/rank": "/ozon/selection/top-list",
  "/ozon/selection/profit": "/ozon/postings/profit-trend",
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

const readJson = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const apiRequest = async (path, options = {}) => {
  const token = localStorage.getItem("token");
  const response = await fetch(`${LOCAL_API_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
  }
  return data;
};

const postMessageRequest = (message, responseKey, timeoutMs = 1200) =>
  new Promise((resolve, reject) => {
    const id = message.id || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("浏览器插件未响应"));
    }, timeoutMs);
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data[responseKey] !== 1 || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.ok === false) reject(new Error(data.error || "插件返回失败"));
      else resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ ...message, id }, window.location.origin);
  });

const syncAuthToExtension = async ({ token, storeId }) => {
  if (!token || !storeId) return false;
  try {
    await postMessageRequest(
      {
        __jzcExt: 1,
        action: "syncAuthFromWeb",
        payload: { token, storeId },
      },
      "__jzcExtResp",
      900,
    );
    return true;
  } catch {
    return false;
  }
};

const logoutExtension = async () => {
  try {
    await postMessageRequest(
      {
        __jzcExt: 1,
        action: "logout",
        payload: {},
      },
      "__jzcExtResp",
      900,
    );
    return true;
  } catch {
    return false;
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

const requestExtensionSync = async ({ storeId, syncType }) => {
  const reqId = `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("插件同步桥未响应"));
    }, 1800);
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.__jz !== "v1" || data.kind !== "sync.response" || data.reqId !== reqId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (!data.ok) reject(new Error(data.error || "插件同步启动失败"));
      else resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      { __jz: "v1", kind: "sync.request", reqId, storeId, syncType },
      window.location.origin,
    );
  });
  return response;
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

const requestExtensionFollowSell = async ({ storeId, sku, price, currencyCode, dryRun = false }) => {
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
      { __jz: "v1", kind: "follow-sell.request", reqId, storeId, sku, price, currencyCode, dryRun },
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
    key: "selection",
    icon: <AreaChartOutlined />,
    label: "选品",
    children: [
      { key: "/ozon/selection/category", label: "类目分析" },
      { key: "/ozon/selection/top-list", label: "榜单选品" },
      { key: "/ozon/selection/china", label: "中国专区" },
    ],
  },
  {
    key: "ai",
    icon: <ThunderboltOutlined />,
    label: (
      <span className="menu-label-with-tag">
        AI 工具 <Tag color="blue">推荐</Tag>
      </span>
    ),
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
      { key: "/ozon/tools/watermark", label: "水印管理" },
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
  "/ozon/selection/category": "selection",
  "/ozon/selection/top-list": "selection",
  "/ozon/selection/china": "selection",
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
  "/ozon/tools/watermark": "tools",
  "/extension": "tools",
  "/ozon/messaging/templates": "messages",
  "/ozon/messaging/history": "messages",
};

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

const dashboardMoney = (value) => `¥${moneyFormatter.format(Number(value) || 0)}`;

const dashboardMetricList = (summary = emptyLocalData.summary) => [
  { label: "今日订单", value: String(summary.todayPostings || 0), note: "— 持平", sub: "vs 昨日" },
  { label: "今日 GMV", value: dashboardMoney(summary.todayGmv), note: "— 持平", sub: "vs 昨日" },
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
  { icon: <BarChartOutlined />, label: "类目分析", path: "/ozon/selection/category" },
  { icon: <LineChartOutlined />, label: "榜单选品", path: "/ozon/selection/top-list" },
  { icon: <AreaChartOutlined />, label: "利润趋势", path: "/ozon/postings/profit-trend" },
  { icon: <PictureOutlined />, label: "AI 大模型改图", path: "/ozon/tools/ai-poster-records", tag: "NEW" },
  { icon: <PictureOutlined />, label: "水印管理", path: "/ozon/tools/watermark" },
  { icon: <DeploymentUnitOutlined />, label: "17track", path: "/ozon/postings/list" },
  { icon: <GiftOutlined />, label: "营销活动", path: "/ozon/promotions/campaigns" },
];

const requiredSteps = [
  "绑定店铺",
  "安装浏览器插件",
  "同步商品数据",
  "处理首个订单",
];

function AppShell() {
  const { message, modal } = AntApp.useApp();
  const [route, setRoute] = useState(() => normalizePath(window.location.pathname));
  const [binding, setBinding] = useState(() => {
    const stored = readJson(STORAGE_KEY, null);
    return stored ? { ...stored, storeName: visibleStoreName(stored.storeName, stored.clientId) } : null;
  });
  const [settings, setSettings] = useState(() =>
    readJson(SETTINGS_KEY, { pluginInstalled: true, lastSync: null }),
  );
  const [localData, setLocalData] = useState(emptyLocalData);
  const [syncing, setSyncing] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [openKeys, setOpenKeys] = useState(() => {
    const parent = routeParent[normalizePath(window.location.pathname)];
    return parent ? [parent] : [];
  });
  const [form] = Form.useForm();

  const hasStore = Boolean(binding?.storeName);
  const pageTitle = pageTitles[route] || "仪表盘";
  const currentDate = useMemo(() => formatDate(), []);

  const refreshLocalState = async ({ silent = true } = {}) => {
    try {
      const state = await apiRequest("/local/state");
      setLocalData({
        currentStoreId: state.currentStoreId || "",
        stores: state.stores || [],
        summary: state.summary || emptyLocalData.summary,
        caches: state.caches || emptyLocalData.caches,
        jobs: state.jobs || {},
      });
      if (state.binding) {
        const storeName = visibleStoreName(state.binding.label || state.binding.companyName, state.binding.clientId);
        const nextBinding = {
          id: state.binding.id,
          storeName,
          clientId: state.binding.clientId || "",
          apiKeyMasked: state.binding.apiKeyMasked || "",
          currency: state.binding.currency || state.binding.currencyCode || state.binding.companyCurrency || "",
          currencyCode: state.binding.currencyCode || state.binding.currency || state.binding.companyCurrency || "",
          companyCurrency: state.binding.companyCurrency || state.binding.currency || state.binding.currencyCode || "",
          savedAt: state.binding.savedAt,
        };
        setBinding(nextBinding);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBinding));
        const restoredToken = state.token || "";
        const restoredStoreId = state.currentStoreId || nextBinding.id || "";
        if (restoredToken) localStorage.setItem("token", restoredToken);
        if (restoredStoreId) localStorage.setItem("currentOzonStoreId", restoredStoreId);
        if (restoredToken && restoredStoreId) {
          syncAuthToExtension({ token: restoredToken, storeId: restoredStoreId });
        }
      } else {
        setBinding(null);
        if (clearLocalAuthStorage()) logoutExtension();
      }
      if (state.summary?.lastSyncAt) {
        const nextSettings = { ...settings, lastSync: state.summary.lastSyncAt };
        setSettings(nextSettings);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
      }
      return state;
    } catch (error) {
      if (!silent) message.error(`本地 API 未启动: ${error.message}`);
      return null;
    }
  };

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
    document.title = route === "/datascreen" ? "QH · 订单数据大屏" : "QH";
  }, [route]);

  useEffect(() => {
    const parent = routeParent[route];
    setOpenKeys(parent ? [parent] : []);
  }, [route]);

  useEffect(() => {
    refreshLocalState();
    const timer = window.setInterval(() => refreshLocalState(), 15000);
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

  const handleSync = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      setBindOpen(true);
      return;
    }
    if (syncing) return;
    setSyncing(true);
    const nextSettings = { ...settings, lastSync: new Date().toISOString() };
    setSettings(nextSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
    const storeId = binding?.id || localStorage.getItem("currentOzonStoreId");
    const token = localStorage.getItem("token");
    await syncAuthToExtension({ token, storeId });
    try {
      let pluginStarted = false;
      try {
        await Promise.all(
          ["WAREHOUSES", "PRODUCTS", "POSTINGS"].map((syncType) =>
            requestExtensionSync({ storeId, syncType }),
          ),
        );
        pluginStarted = true;
      } catch {}

      if (pluginStarted) {
        message.success("插件同步任务已启动");
      } else {
        message.loading({ content: "插件未响应，改用本地只读同步", key: "local-sync", duration: 0 });
        await apiRequest("/local/sync/WAREHOUSES", { method: "POST", body: { storeId } });
        await apiRequest("/local/sync/PRODUCTS", { method: "POST", body: { storeId } });
        await apiRequest("/local/sync/POSTINGS", { method: "POST", body: { storeId, postingsSinceDays: 30 } });
        await apiRequest("/local/sync/PROMOTIONS", { method: "POST", body: { storeId } });
        message.success({ content: "本地只读同步完成", key: "local-sync" });
      }
      await refreshLocalState();
    } catch (error) {
      message.error(`同步失败: ${error.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const saveBinding = async (values) => {
    try {
      const clientId = values.clientId.trim();
      const label = (values.label || "").trim();
      const response = await apiRequest("/local/binding", {
        method: "POST",
        body: {
          label,
          clientId,
          apiKey: values.apiKey || "",
        },
      });
      const store = response.store;
      const nextBinding = {
        id: store.id,
        storeName: visibleStoreName(store.label || store.companyName, store.clientId),
        clientId: store.clientId,
        apiKeyMasked: store.apiKeyMasked || "已保存",
        currency: store.currency || store.currencyCode || store.companyCurrency || "",
        currencyCode: store.currencyCode || store.currency || store.companyCurrency || "",
        companyCurrency: store.companyCurrency || store.currency || store.currencyCode || "",
        savedAt: store.savedAt,
      };
      setBinding(nextBinding);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBinding));
      localStorage.setItem("token", response.token);
      localStorage.setItem("currentOzonStoreId", store.id);
      await syncAuthToExtension({ token: response.token, storeId: store.id });
      setBindOpen(false);
      form.resetFields();
      await refreshLocalState();
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
        savedAt: store.savedAt || target.savedAt,
      };
      setBinding(nextBinding);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBinding));
      localStorage.setItem("currentOzonStoreId", nextBinding.id);
      const token = localStorage.getItem("token");
      await syncAuthToExtension({ token, storeId: nextBinding.id });
      await refreshLocalState();
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
        clearLocalAuthStorage();
        await logoutExtension();
        message.success("已解除绑定");
      },
    });
  };

  const completeStepCount = [hasStore, settings.pluginInstalled, Boolean(settings.lastSync), false].filter(Boolean).length;
  const themeConfig = {
    token: {
      colorPrimary: "#1677ff",
      borderRadius: 6,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
    },
    components: {
      Layout: {
        headerBg: "#fff",
        siderBg: "#fff",
        triggerBg: "#fff",
      },
      Card: {
        borderRadiusLG: 12,
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
      setBindOpen(true);
      return;
    }
    if (String(key).startsWith("store:")) {
      switchCurrentStore(String(key).slice("store:".length));
    }
  };

  const userPopover = (
    <div className="topbar-popover user-popover">
      <div className="user-popover-head">
        <strong>未设置昵称</strong>
        <span>{hasStore ? visibleStoreName(binding?.storeName, binding?.clientId) : "未登录"}</span>
      </div>
      {[
        ["用户设置", () => navigate("/ozon/settings/stores")],
        ["店铺管理", () => navigate("/ozon/settings/stores")],
        ["AI 助手绑定", () => navigate("/ozon/tools/ai-poster-records")],
        ["AI 执行记录", () => navigate("/ozon/tools/ai-poster-records")],
        ["Browser Agent", () => navigate("/extension")],
        ["修改密码", () => modal.info({
          title: "修改密码",
          icon: null,
          content: "当前账号沿用源站登录态，本地不保存登录密码。",
          okText: "我知道了",
        })],
        ["退出登录", () => (hasStore ? clearBinding() : message.info("当前未登录"))],
      ].map(([label, onClick]) => (
        <button className="user-popover-item" type="button" onClick={onClick} key={label}>
          {label}
        </button>
      ))}
    </div>
  );

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
      <Layout className="qh-shell">
        <Header className="qh-topbar">
          <a className="qh-brand" onClick={() => navigate("/ozon/dashboard")}>
            <img src="/icons/icon48.png" alt="QH" />
            <span>QH</span>
          </a>
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
              overlayClassName="topbar-overlay store-topbar-overlay"
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
            <Popover content={userPopover} trigger="click" placement="bottomRight" overlayClassName="topbar-overlay user-topbar-overlay">
              <div className="qh-user">
                <UserOutlined />
                <div>
                  <span>当前用户</span>
                  <strong>{hasStore ? "已登录" : "未登录"}</strong>
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
                  <h1>{pageTitle}</h1>
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
                onBind={() => setBindOpen(true)}
                onPlugin={() => setPluginOpen(true)}
                onSync={handleSync}
              />
            ) : (
              <GenericPage
                route={route}
                binding={binding}
                hasStore={hasStore}
                localData={localData}
                onBind={() => setBindOpen(true)}
                onPlugin={() => setPluginOpen(true)}
                onSync={handleSync}
                onClear={clearBinding}
                onSwitchStore={switchCurrentStore}
                onRefresh={refreshLocalState}
                navigate={navigate}
              />
            )}
          </Content>
        </Layout>
      </Layout>

      <Modal
        title="新增 API 授权门店"
        open={bindOpen}
        onCancel={() => setBindOpen(false)}
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
          }}
        >
          <Form.Item
            label="Client-Id"
            name="clientId"
            rules={[{ required: true, message: "请输入 Client-Id" }]}
          >
            <Input prefix={<ApiOutlined />} placeholder="Ozon Client-Id" />
          </Form.Item>
          <Form.Item
            label="Api-Key"
            name="apiKey"
            rules={[{ required: !binding, message: "请输入 Api-Key" }]}
          >
            <Input.Password prefix={<DatabaseOutlined />} placeholder="Ozon Api-Key" />
          </Form.Item>
          <Form.Item label="标签" name="label">
            <Input placeholder="可选，例如：主店" />
          </Form.Item>
          <div className="bind-actions">
            <Space>
              <Button onClick={() => setBindOpen(false)}>取 消</Button>
              <Button type="primary" htmlType="submit">
                新 增
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      <Drawer
        title="浏览器插件"
        open={pluginOpen}
        onClose={() => setPluginOpen(false)}
        size={520}
      >
        <PluginPanel />
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

function DashboardPage({
  hasStore,
  binding,
  summary,
  completeStepCount,
  navigate,
  onBind,
  onPlugin,
  onSync,
}) {
  const currentSummary = summary || emptyLocalData.summary;
  const metrics = dashboardMetricList(currentSummary);
  const weeklyMetrics = [
    ["本周 GMV", dashboardMoney(currentSummary.weekGmv)],
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
              <Tag color="blue">QH功能</Tag>
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
                content: "QH助手已安装",
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

function GenericPage({ route, binding, hasStore, localData, onBind, onPlugin, onSync, onClear, onSwitchStore, onRefresh, navigate }) {
  if (route === "/extension") {
    return (
      <Card className="panel-card">
        <PluginPanel />
      </Card>
    );
  }

  const pageProps = { route, binding, hasStore, localData, onBind, onPlugin, onSync, onClear, onSwitchStore, onRefresh, navigate };
  if (route === "/ozon/products/list") return <ProductListPage {...pageProps} />;
  if (route.startsWith("/ozon/products/collect/edit")) return <CollectEditPage {...pageProps} />;
  if (route === "/ozon/products/collect") return <CollectPage {...pageProps} />;
  if (route === "/ozon/products/import-history") return <ImportHistoryPage {...pageProps} />;
  if (route === "/ozon/products/stocks") return <StocksPage {...pageProps} />;
  if (route === "/ozon/products/reshelf") return <ReshelfPage {...pageProps} />;
  if (route === "/ozon/selection/category") return <CategoryPage {...pageProps} />;
  if (route === "/ozon/selection/top-list") return <SelectionListPage {...pageProps} kind="top" />;
  if (route === "/ozon/selection/china") return <SelectionListPage {...pageProps} kind="china" />;
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
  if (route === "/ozon/tools/watermark") return <WatermarkPage {...pageProps} />;
  if (route === "/datascreen") return <DataScreenPage {...pageProps} />;

  return (
    <div className="source-404-page">
      <h2>404</h2>
      <p>This page could not be found.</p>
    </div>
  );
}

const emptyText = (hasStore, text = "暂无数据") =>
  hasStore ? text : "绑定门店后显示真实数据";

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

const warehouseDisplayName = (warehouse = {}) => {
  const item = warehouse || {};
  return item.name ||
  item.warehouse_name ||
  item.warehouseName ||
  item.title ||
  item.id ||
  "";
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
    return {
      key: `${warehouseId || source || "stock"}-${index}`,
      warehouseId: warehouseId ? String(warehouseId) : "",
      label: directName || (source.includes("fbo") ? "Ozon FBO仓" : "FBS 总库存"),
      present: count,
      reserved: Number(row.reserved ?? row.reserved_stock ?? row.reserved_amount ?? 0) || 0,
      source,
      writable: Boolean(warehouseId) && !source.includes("fbo"),
    };
  };

  const detailedEntries = warehouseStockRows(item)
    .map((row, index) => makeEntry(row, index, "fbs"))
    .filter((entry) => entry.present > 0);
  const nestedEntries = stockEntries(item)
    .map((row, index) => makeEntry(row, index, row.source || "stock"))
    .filter((entry) => entry.present > 0)
    .filter((entry) => {
      if (!detailedEntries.length) return true;
      return entry.source.includes("fbo") || (entry.warehouseId && !detailedEntries.some((detail) => detail.warehouseId === entry.warehouseId));
    });
  return [...nestedEntries, ...detailedEntries];
};

const stockWarehouseDistribution = (item = {}, warehouses = []) => {
  const entries = stockWarehouseEntries(item, warehouses).filter((entry) => entry.present > 0);
  return entries
    .map((entry) => `${entry.label} ${entry.present}`)
    .join("\n") || "—";
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
    binding?.id ||
    localData?.currentStoreId ||
    (typeof localStorage !== "undefined" ? localStorage.getItem("currentOzonStoreId") : "") ||
    "";
  const stores = localData?.stores || [];
  const currentStore = stores.find((store) =>
    String(store.id || store.storeId || "") === String(currentStoreId || "")
  );
  const storeNames = new Set(
    [
      binding?.storeName,
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
    clientId: binding?.clientId || currentStore?.clientId || "",
    storeNames,
  };
};

const productHasStoreMarker = (item = {}) =>
  Boolean(
    item.storeId ||
    item.store_id ||
    item.ozonStoreId ||
    item.currentOzonStoreId ||
    item.localStoreId ||
    item.clientId ||
    item.client_id ||
    item.ozonClientId ||
    item.storeName ||
    item.store_name ||
    item.shopName ||
    item.companyName
  );

const productBelongsToCurrentStore = (item = {}, ref = {}) => {
  const storeId = item.storeId || item.store_id || item.ozonStoreId || item.currentOzonStoreId || item.localStoreId;
  if (storeId && ref.storeId && String(storeId) === String(ref.storeId)) return true;
  const clientId = item.clientId || item.client_id || item.ozonClientId;
  if (clientId && ref.clientId && String(clientId) === String(ref.clientId)) return true;
  const storeName = item.storeName || item.store_name || item.shopName || item.companyName;
  return Boolean(storeName && ref.storeNames?.has(String(storeName).trim().toLowerCase()));
};

const scopedProductsForCurrentStore = (products = [], binding = {}, localData = {}) => {
  const list = Array.isArray(products) ? products : [];
  const ref = productStoreRef(binding, localData);
  const scoped = list.filter((item) => productBelongsToCurrentStore(item, ref));
  if (scoped.length || list.some(productHasStoreMarker)) return scoped;
  return list;
};

const warehouseHasStoreMarker = (item = {}) =>
  Boolean(
    item.storeId ||
    item.store_id ||
    item.ozonStoreId ||
    item.currentOzonStoreId ||
    item.localStoreId ||
    item.clientId ||
    item.client_id ||
    item.ozonClientId ||
    item.storeName ||
    item.store_name ||
    item.shopName ||
    item.companyName
  );

const warehouseBelongsToCurrentStore = (item = {}, ref = {}) => {
  const storeId = item.storeId || item.store_id || item.ozonStoreId || item.currentOzonStoreId || item.localStoreId;
  if (storeId && ref.storeId && String(storeId) === String(ref.storeId)) return true;
  const clientId = item.clientId || item.client_id || item.ozonClientId;
  if (clientId && ref.clientId && String(clientId) === String(ref.clientId)) return true;
  const storeName = item.storeName || item.store_name || item.shopName || item.companyName;
  return Boolean(storeName && ref.storeNames?.has(String(storeName).trim().toLowerCase()));
};

const scopedWarehousesForCurrentStore = (warehouses = [], binding = {}, localData = {}) => {
  const list = Array.isArray(warehouses) ? warehouses : [];
  const ref = productStoreRef(binding, localData);
  const scoped = list.filter((item) => warehouseBelongsToCurrentStore(item, ref));
  if (scoped.length || list.some(warehouseHasStoreMarker)) return scoped;
  return list;
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

const productEffectivePriceValue = (item = {}) => {
  const price = item.price && typeof item.price === "object" ? item.price : {};
  const base = productPositivePrice(price.price) || productPositivePrice(productScalarPrice(item));
  const directMarketing =
    productPositivePrice(price.marketing_seller_price) ||
    productPositivePrice(item.marketing_seller_price) ||
    productPositivePrice(price.marketing_price) ||
    productPositivePrice(item.marketing_price);
  if (directMarketing) return formatProductPrice(directMarketing);

  const actionValues = (item.marketing_actions?.actions || item.price_info?.marketing_actions?.actions || [])
    .map((action) => productPositivePrice(action?.value))
    .filter(Boolean)
    .filter((value) => !base || (value <= base && value >= base * 0.1));
  if (actionValues.length) return formatProductPrice(Math.min(...actionValues));

  return formatProductPrice(
    base ||
    productPositivePrice(price.price) ||
    productPositivePrice(productScalarPrice(item)) ||
    productPositivePrice(item.old_price)
  );
};

const productPriceActionRows = (item = {}) => {
  const price = item.price && typeof item.price === "object" ? item.price : {};
  const base = productPositivePrice(price.price) || productPositivePrice(productScalarPrice(item));
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

  pushRow({ title: "前台真实销售价", value: price.marketing_seller_price || item.marketing_seller_price });
  for (const action of item.marketing_actions?.actions || item.price_info?.marketing_actions?.actions || []) {
    pushRow({
      title: localizeOzonMarketingTitle(action.title || "活动价"),
      value: action.value,
      date_from: action.date_from,
      date_to: action.date_to,
      source: "action",
    });
  }
  pushRow({ title: "商品原售价", value: price.price || productScalarPrice(item), source: "base" });
  pushRow({ title: "划线价", value: price.old_price || item.old_price, source: "old" });

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
    return {
      id: item.id || item.product_id || item.offer_id || `product-${index}`,
      "#": index + 1,
      _image: image,
      _sku: sku,
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

const requestSourcePluginListing = async ({ storeId, sku, price, currencyCode, title, dryRun = false }) => {
  const prefetch = await requestExtensionPrefetch({ skus: [String(sku)] });
  const sourceVariant = prefetch?.bySku?.[String(sku)] || prefetch?.bySku?.[sku];
  if (!sourceVariant) {
    const failed = Array.isArray(prefetch?.failed) ? prefetch.failed.find((row) => String(row?.sku) === String(sku)) : null;
    throw new Error(failed?.error || "源插件未采集到可上架的商品数据");
  }
  const item = buildSourceVariantImportItem({ sku, price, currencyCode, sourceVariant, title });
  const endpoint = dryRun ? "/ozon/products/import/preview" : "/ozon/products/import";
  const result = await apiRequest(endpoint, {
    method: "POST",
    body: {
      storeId,
      sku,
      strictTypeMatch: true,
      entry: "SOURCE_PLUGIN_PREFETCH",
      items: [item],
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

const categoryAnalysisRows = (products = []) => {
  const groups = new Map();
  products.forEach((item) => {
    const id = String(productCategoryId(item));
    const group = groups.get(id) || {
      id,
      label: productCategoryLabel(item, id),
      count: 0,
      activeCount: 0,
      stock: 0,
      priceSum: 0,
      priceCount: 0,
    };
    group.count += 1;
    if (!/archived|deleted|error/i.test(productStatus(item))) group.activeCount += 1;
    const stock = Number(stockNumber(item));
    if (Number.isFinite(stock)) group.stock += stock;
    const price = numberFromMoney(productPriceValue(item));
    if (price !== null) {
      group.priceSum += price;
      group.priceCount += 1;
    }
    groups.set(id, group);
  });
  return Array.from(groups.values())
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .map((group, index) => {
      const avgPrice = group.priceCount ? group.priceSum / group.priceCount : null;
      return {
        id: group.id,
        "#": index + 1,
        "类目": `${group.label} · ${group.count} 个商品`,
        "月销量": "—",
        "月销售额": "—",
        "GMV增长": "—",
        "平均价": avgPrice === null ? "—" : moneyText(avgPrice.toFixed(2), "₽"),
        "均价环比": "—",
        "卖家数": "—",
        "品牌数": "—",
        "品牌占比": "—",
        "头部卖家": "—",
        "FBS占比": "—",
        "出库率": group.count ? `${group.activeCount}/${group.count}` : "—",
        "退货率": "—",
        _categoryId: group.id,
        _count: group.count,
        _avgPrice: avgPrice,
      };
    });
};

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

const productCreatedMs = (item = {}) => {
  const time = new Date(item.created_at || item.createdAt || item.syncedAt || "").getTime();
  return Number.isFinite(time) ? time : 0;
};

const productShippingText = (item = {}) => {
  const sources = Array.isArray(item.sources) ? item.sources : [];
  const stockSources = stockEntries(item).map((row) => row.source).filter(Boolean);
  const values = [...sources, ...stockSources]
    .map((value) => String(value || "").toUpperCase())
    .filter(Boolean);
  return values.length ? Array.from(new Set(values)).join(" / ") : "—";
};

const productSelectionSearchText = (item = {}) =>
  [
    productSearchText(item),
    productCategoryLabel(item, productCategoryId(item)),
    productShippingText(item),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const firstNumericValue = (item = {}, keys = []) => {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") {
      const value = numberFromMoney(item[key]);
      if (value !== null) return value;
    }
  }
  return null;
};

const selectionProductId = (item = {}, index = 0) =>
  String(item.id || item.product_id || item.offer_id || `selection-product-${index}`);

const selectionStrategySort = (products = [], activeChip = "") => {
  const rows = [...products];
  if (activeChip.includes("新品")) {
    return rows.sort((left, right) => productCreatedMs(right) - productCreatedMs(left));
  }
  if (activeChip.includes("低价")) {
    return rows.sort((left, right) => (numberFromMoney(productPriceValue(left)) ?? Infinity) - (numberFromMoney(productPriceValue(right)) ?? Infinity));
  }
  if (activeChip.includes("蓝海")) {
    return rows.sort((left, right) => stockNumber(right) - stockNumber(left));
  }
  return rows.sort((left, right) => {
    const rightStock = stockNumber(right);
    const leftStock = stockNumber(left);
    if (rightStock !== leftStock) return rightStock - leftStock;
    return (numberFromMoney(productPriceValue(right)) || 0) - (numberFromMoney(productPriceValue(left)) || 0);
  });
};

const selectionProductRows = (products = []) =>
  products.map((item, index) => ({
    id: selectionProductId(item, index),
    "商品": item.name || item.offer_id || item.product_id || "—",
    "类目": productCategoryLabel(item, productCategoryId(item)),
    "价格": moneyText(productPriceValue(item)),
    "销量": "—",
    "销售额": "—",
    "增长": "—",
    "卖家": "—",
    "品牌": item.brand || item.brand_name || "—",
    "发货": productShippingText(item),
    "库存": stockTotal(item),
    "操作": "一键跟卖",
    _raw: item,
  }));

const importTaskStatusGroups = {
  "已完成": new Set(["SUCCESS", "COMPLETE", "COMPLETED", "DONE"]),
  "部分成功": new Set(["PARTIAL_SUCCESS", "PARTIAL"]),
  "处理中": new Set(["PENDING", "RUNNING", "QUEUED", "IMPORTING", "CHECKING"]),
  "失败": new Set(["FAILED", "ERROR"]),
};

const importTaskStatusLabel = (status) => {
  const normalized = String(status || "").toUpperCase();
  if (importTaskStatusGroups["已完成"].has(normalized)) return "已完成";
  if (importTaskStatusGroups["部分成功"].has(normalized)) return "部分成功";
  if (importTaskStatusGroups["处理中"].has(normalized)) return "处理中";
  if (importTaskStatusGroups["失败"].has(normalized)) return "失败";
  return normalized || "—";
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

const listingImportJobTypes = new Set(["IMPORT_BY_SKU", "PRODUCT_IMPORT", "PUBLIC_IMPORT", "FOLLOW_FROM_PUBLIC"]);

const isListingImportJob = (job = {}) => listingImportJobTypes.has(String(job.type || "").toUpperCase());

const importTaskTypeLabel = (task = {}) => {
  const type = String(task.type || "").toUpperCase();
  return {
    IMPORT_BY_SKU: "SKU 上架",
    PRODUCT_IMPORT: "采集箱上架",
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
    "订单金额": moneyText(item.financial_data?.products?.[0]?.price || item.order_price),
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

const localDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const localHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hour12: false,
});

const localDayKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return localDayFormatter.format(date);
};

const dayLabel = (key) => key ? key.slice(5) : "—";

const postingBusinessDate = (posting = {}) =>
  posting.in_process_at ||
  posting.created_at ||
  posting.shipment_date ||
  posting.delivering_date ||
  posting.syncedAt;

const amountNumber = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "object") return amountNumber(value.amount || value.value);
  return Number(value) || 0;
};

const postingBusinessAmount = (posting = {}) => {
  const products = Array.isArray(posting.financial_data?.products)
    ? posting.financial_data.products
    : [];
  const financialTotal = products.reduce((sum, product) => sum + amountNumber(product.price), 0);
  if (financialTotal) return financialTotal;
  const productTotal = (posting.products || []).reduce(
    (sum, product) => sum + amountNumber(product.price) * (Number(product.quantity) || 1),
    0
  );
  return productTotal || amountNumber(posting.order_price || posting.total_price || posting.price);
};

const incrementMap = (map, key, value = 1) => {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + value);
};

const topEntries = (map, limit = 5) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));

const dataScreenModel = (postings = [], range = "30天") => {
  const rangeDays = Number.parseInt(range, 10) || 30;
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Array.from({ length: rangeDays }, (_, index) => {
    const date = new Date(now.getTime() - (rangeDays - 1 - index) * dayMs);
    const key = localDayKey(date);
    return { key, label: dayLabel(key), count: 0, amount: 0 };
  });
  const dayMap = new Map(days.map((day) => [day.key, day]));
  const today = localDayKey(now);
  const statusMap = new Map();
  const channelMap = new Map();
  const hourBuckets = Array.from({ length: 8 }, (_, index) => ({
    label: `${index * 3}时`,
    count: 0,
  }));
  const hotProductMap = new Map();

  postings.forEach((posting) => {
    const amount = postingBusinessAmount(posting);
    const businessDate = postingBusinessDate(posting);
    const day = localDayKey(businessDate);
    const dayRow = dayMap.get(day);
    if (!dayRow) return;
    dayRow.count += 1;
    dayRow.amount += amount;
    const status = String(posting.status || "unknown").toLowerCase();
    incrementMap(statusMap, status);
    incrementMap(
      channelMap,
      posting.delivery_method?.tpl_provider ||
        posting.delivery_method?.warehouse ||
        posting.delivery_method?.name ||
        "未识别渠道"
    );
    if (day === today) {
      const hour = Number(localHourFormatter.format(new Date(businessDate))) || 0;
      const bucket = Math.min(7, Math.floor(hour / 3));
      hourBuckets[bucket].count += 1;
      (posting.products || []).forEach((product) => {
        incrementMap(
          hotProductMap,
          product.name || product.offer_id || product.sku || "未命名商品",
          Number(product.quantity) || 1
        );
      });
    }
  });

  const latestOrders = [...postings]
    .filter((posting) => dayMap.has(localDayKey(postingBusinessDate(posting))))
    .sort((a, b) => new Date(postingBusinessDate(b)).getTime() - new Date(postingBusinessDate(a)).getTime())
    .slice(0, 5)
    .map((posting) => ({
      id: posting.posting_number || posting.order_id || posting.id,
      status: posting.status || "—",
      amount: postingBusinessAmount(posting),
      time: postingBusinessDate(posting),
    }));

  return {
    days,
    statusRows: topEntries(statusMap, 6),
    channelRows: topEntries(channelMap, 5),
    hourBuckets,
    hotProducts: topEntries(hotProductMap, 5),
    latestOrders,
    maxCount: Math.max(1, ...days.map((day) => day.count)),
    maxAmount: Math.max(1, ...days.map((day) => day.amount)),
    maxHour: Math.max(1, ...hourBuckets.map((hour) => hour.count)),
  };
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

function SourceSectionTitle({ title, subtitle, actions }) {
  return (
    <div className="source-section-title">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <Space>{actions}</Space> : null}
    </div>
  );
}

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

function ProfitToggleGroup({ options, active, onChange }) {
  return (
    <div className="profit-toggle-group">
      {options.map((item) => (
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

function SourceTable({
  columns,
  hasStore,
  rows = [],
  empty = "暂无数据",
  sourceEmpty = false,
  rowSelection = true,
  selectedRowKeys,
  onSelectionChange,
  scrollX = 1100,
  loading = false,
  pageSize = 20,
  paginate = true,
  showPageSizeText = false,
  pageSizeControl = null,
}) {
  const resolvedEmpty = sourceEmpty
    ? (empty === false ? null : empty)
    : emptyText(hasStore, empty);
  const columnWidth = (title) => {
    if (["图片"].includes(title)) return 72;
    if (["商品信息", "商品"].includes(title)) return 240;
    if (["下单链接", "仓库分布", "下架原因"].includes(title)) return 180;
    if (["最后同步", "创建时间", "采集时间", "活动周期", "有效期"].includes(title)) return 160;
    if (["操作", "主图", "#"].includes(title)) return 88;
    return Math.max(108, String(title).length * 30);
  };
  const resolveColumn = (column) => {
    if (typeof column === "string") {
      return {
        title: column,
        dataIndex: column,
        key: column,
        width: columnWidth(column),
        ellipsis: true,
        render: (value) => {
          const text = value === null || value === undefined || value === "" ? "—" : String(value);
          return <span className="source-table-cell-text" title={text}>{text}</span>;
        },
      };
    }
    const title = column.title;
    return {
      ...column,
      title,
      dataIndex: column.dataIndex || title,
      key: column.key || column.dataIndex || title,
      width: column.width || columnWidth(title),
      ellipsis: column.ellipsis ?? true,
    };
  };
  const showPagination = paginate && rows.length > pageSize;
  const showPageSize = showPagination || showPageSizeText || pageSizeControl;
  const wrapClassName = [
    "source-table-wrap",
    showPagination ? "has-pagination" : "",
    showPageSize ? "has-page-size-label" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={wrapClassName}>
      <Table
        rowKey="id"
        className="source-table"
        dataSource={rows}
        rowSelection={rowSelection ? {
          selectedRowKeys,
          onChange: onSelectionChange,
        } : undefined}
        loading={loading}
        columns={columns.map(resolveColumn)}
        pagination={showPagination ? {
          pageSize,
          showSizeChanger: false,
          showQuickJumper: false,
          size: "small",
        } : false}
        scroll={{ x: scrollX }}
        tableLayout="fixed"
        locale={{
          emptyText: resolvedEmpty === null
            ? null
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={resolvedEmpty} />,
        }}
      />
      {pageSizeControl ? <div className="source-table-page-size-control">{pageSizeControl}</div> : null}
      {!pageSizeControl && showPageSize ? <span className="source-table-page-size">{pageSize} 条/页</span> : null}
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
  const copySku = async (sku) => {
    const text = String(sku || "").trim();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.setAttribute("readonly", "readonly");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      message.success("SKU 已复制");
    } catch {
      message.error("SKU 复制失败");
    }
  };
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
        return (
          <div className="product-info-cell">
            <span className="source-table-cell-text product-info-name" title={title}>{title}</span>
            {sku ? (
              <span className="product-sku-row">
                <span className="product-sku-text" title={sku}>SKU：{sku}</span>
                <Tooltip title="复制 SKU">
                  <Button
                    aria-label="复制 SKU"
                    className="product-sku-copy"
                    icon={<CopyOutlined />}
                    onClick={(event) => {
                      event.stopPropagation();
                      copySku(sku);
                    }}
                    size="small"
                    type="text"
                  />
                </Tooltip>
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
      title: "价格",
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
  const collectItems = localData?.caches?.collectBox || [];
  const rows = collectItems.map((item, index) => ({
    id: item.id || "collect-" + index,
    _image: item.image || item.primaryImage || (item.images || [])[0] || "",
    _title: item.name || item.title || item.productUrl || "—",
    sku: item.sku || item.id || "",
    "商品信息": item.name || item.title || item.productUrl || "—",
    "采集价格": item.price || item.priceText || "—",
    "卖家 / 来源": item.source || item.seller || item.sellerName || "—",
    "品牌": item.brand || "—",
    "下单链接": item.productUrl || item.url || "—",
    "采集时间": item.createdAt ? new Date(item.createdAt).toLocaleString() : "—",
    "状态": item.status || "待处理",
    "操作": "查看",
  }));
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
  const countByStatus = (status) => rows.filter((row) => row["状态"] === status).length;
  const handleCollectAdd = async (value) => {
    const input = String(value || "").trim();
    if (!input) {
      message.warning("请输入 Ozon 商品链接或 SKU");
      return;
    }
    if (!hasStore) {
      message.warning("请先绑定门店");
      onBind?.();
      return;
    }
    const token = localStorage.getItem("token");
    if (!token) {
      message.warning("本地登录已过期，请重新绑定门店");
      onBind?.();
      return;
    }
    const isUrl = /^https?:\/\//i.test(input);
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
          message.success({ content: "已抓取商品数据并加入采集箱", key: "collect-scrape" });
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
      await apiRequest("/ozon/collect-box", {
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
      message.success("已加入采集箱");
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
            { label: "失败", count: countByStatus("失败") },
          ]}
        />
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
      <div className="collect-table-panel">
        <SourceTable
          hasStore={hasStore}
          rows={visibleRows}
          columns={[
            { title: "商品信息", dataIndex: "商品信息", render: (value, row) => (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {row._image ? <img src={row._image} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} /> : null}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
              </div>
            ) },
            "采集价格", "卖家 / 来源", "品牌", "下单链接", "采集时间", "状态",
            { title: "操作", dataIndex: "操作", width: 88, render: (value, row) => (
              <Button type="link" size="small" onClick={() => navigate(`/ozon/products/collect/edit/?id=${encodeURIComponent(row.id)}`)}>{value}</Button>
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
  push(item.picture);
  [item.images, item.imageUrls, item.image_urls, item.pictures, item.photos, item.media].forEach((list) => {
    if (Array.isArray(list)) list.forEach(push);
  });
  return images;
};

const collectEditSourceUrl = (item = {}, sku = "") =>
  collectEditFirst(item.sourceUrl, item.source_url, item.productUrl, item.product_url, item.url, item.link, item["下单链接"]) ||
  (sku ? `https://www.ozon.ru/product/${sku}/` : "");

const collectEditDimension = (item = {}, keys = [], fallback = "100") => {
  for (const key of keys) {
    const value = numberFromMoney(item[key]);
    if (value && value > 0) return String(value);
  }
  return fallback;
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
      content: [
        {
          widgetName: "raShowcase",
          type: "roll",
          blocks: images.slice(0, 6).map((url, index) => ({
            img: { src: url },
            title: { content: index === 0 ? title : "" },
          })),
        },
      ],
      version: 0.3,
    },
    null,
    2,
  );
};

const collectEditVariantRows = ({ item = {}, sku = "", title = "", price = "", images = [], offerPrefix = "jz-" }) => {
  const sourceRows = Array.isArray(item.variants) && item.variants.length ? item.variants : [item];
  return sourceRows.map((variant, index) => {
    const rowImages = collectEditImages(variant, images[index] || images[0] || "");
    const rowSku = collectEditFirst(variant.sku, variant.product_id, sku);
    const sellPrice = collectEditFirst(variant.price?.price, variant.price, variant.marketing_price, price);
    const numericSellPrice = numberFromMoney(sellPrice);
    return {
      key: `${rowSku || sku || "sku"}-${index}`,
      index: index + 1,
      image: rowImages[0] || images[0] || "",
      cover: rowImages[1] || rowImages[0] || images[0] || "",
      video: collectEditFirst(variant.video, variant.video_url),
      sku: rowSku || sku,
      offerId: collectEditFirst(variant.offer_id) || `${offerPrefix}${rowSku || sku}${sourceRows.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : ""}`,
      name: collectEditFirst(variant.name, variant.title, title),
      purchasePrice: collectEditFirst(variant.purchase_price, variant.cost_price),
      sellPrice,
      oldPrice: collectEditFirst(variant.old_price, variant.price?.old_price) || (numericSellPrice ? (numericSellPrice * 1.25).toFixed(2) : ""),
      stock: collectEditFirst(variant.stock, variant.quantity, variant.stocks?.present) || "0",
    };
  });
};

function CollectEditPage({ binding, hasStore, localData, onBind, onRefresh, navigate }) {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [pluginStatus, setPluginStatus] = useState({ status: "checking", version: "", error: "" });
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
  const [packageWeight, setPackageWeight] = useState("100");
  const [packageLength, setPackageLength] = useState("100");
  const [packageWidth, setPackageWidth] = useState("100");
  const [packageHeight, setPackageHeight] = useState("100");
  const [sourceLink, setSourceLink] = useState("");
  const [note, setNote] = useState("");
  const [variantRows, setVariantRows] = useState([]);
  const [selectedVariantKeys, setSelectedVariantKeys] = useState([]);

  const params = new URLSearchParams(window.location.search);
  const itemId = params.get("id") || "";

  const collectItems = localData?.caches?.collectBox || [];
  const productItems = localData?.caches?.products || [];
  const item = collectItems.find(function(i) {
    return String(i.id) === String(itemId) || String(i.sku) === String(itemId);
  }) || productItems.find(function(i) {
    return [i.id, i.product_id, i.offer_id, i.sku].some(function(value) {
      return String(value || "") === String(itemId);
    });
  });
  const activeStore = (localData?.stores || []).find(function(store) {
    return String(store.id || store.storeId || "") === String(binding?.id || localData?.currentStoreId || "");
  }) || binding || {};
  const storeCurrencyCode = collectEditFirst(
    activeStore.companyCurrency,
    activeStore.currencyCode,
    activeStore.currency,
    binding?.companyCurrency,
    binding?.currencyCode,
    binding?.currency,
  );

  React.useEffect(function() {
    if (item) {
      const draft = item.listingDraft || {};
      const nextSku = String(draft.sku || item.sku || item.product_id || item.offer_id || item.id || "");
      const nextTitle = collectEditFirst(draft.title, item.name, item.title, item.offer_id);
      const nextPrice = collectEditFirst(draft.price, item.price?.price, item.price, item.priceText, item.marketing_price);
      const nextCurrency = collectEditFirst(storeCurrencyCode, draft.currencyCode, item.price?.currency_code, item.priceCurrency, item.currencyCode, item.currency_code, item.currency) || "CNY";
      const nextImages = collectEditImages({ ...item, images: draft.images || item.images }, draft.image || "");
      const nextOfferPrefix = draft.offerPrefix || "jz-";
      const draftVariants = Array.isArray(draft.variants)
        ? draft.variants.map((row, index) => ({
            ...row,
            key: row.key || `${row.sku || nextSku || "sku"}-${index}`,
            index: index + 1,
          }))
        : [];
      setSku(nextSku);
      setTitle(nextTitle);
      setPrice(nextPrice);
      setCurrencyCode(nextCurrency);
      setImage(nextImages[0] || "");
      setBrand(collectEditFirst(draft.brand, item.brand) || "无品牌");
      setModelName(collectEditFirst(draft.modelName, item.modelName, item.model_name, item.offer_id, nextSku));
      setOfferPrefix(nextOfferPrefix);
      setDescription(collectEditFirst(draft.description, item.description, item.desc, item.subtitle, nextTitle));
      setDescriptionMode("编辑");
      setTags(Array.isArray(draft.tags) && draft.tags.length ? draft.tags : collectEditTags(item, nextTitle));
      setRichContent(collectEditFirst(draft.richContent) || collectEditRichContent(nextTitle, nextImages));
      setPackageWeight(collectEditFirst(draft.packageWeight) || collectEditDimension(item, ["weight", "package_weight", "weight_g"], "100"));
      setPackageLength(collectEditFirst(draft.packageLength) || collectEditDimension(item, ["depth", "package_length", "length", "depth_mm"], "100"));
      setPackageWidth(collectEditFirst(draft.packageWidth) || collectEditDimension(item, ["width", "package_width", "width_mm"], "100"));
      setPackageHeight(collectEditFirst(draft.packageHeight) || collectEditDimension(item, ["height", "package_height", "height_mm"], "100"));
      setSourceLink(collectEditFirst(draft.sourceLink) || collectEditSourceUrl(item, nextSku));
      setNote(collectEditFirst(draft.note, item.note, item.remark));
      setVariantRows(draftVariants.length ? draftVariants : collectEditVariantRows({ item, sku: nextSku, title: nextTitle, price: nextPrice, images: nextImages, offerPrefix: nextOfferPrefix }));
      setSelectedVariantKeys([]);
    }
  }, [itemId, item, storeCurrencyCode]);

  const checkPluginStatus = async function() {
    setPluginStatus({ status: "checking", version: "", error: "" });
    try {
      const resp = await requestExtensionPing(1500);
      setPluginStatus(listingBridgeStatusFromPing(resp));
    } catch (error) {
      setPluginStatus({
        status: "error",
        version: "",
        error: error?.message || "本地浏览器插件未响应",
      });
    }
  };

  React.useEffect(function() {
    checkPluginStatus();
  }, []);

  const runListingRequest = async function({ dryRun = false } = {}) {
    if (!sku) {
      message.warning("请输入 SKU");
      return;
    }
    if (!hasStore) {
      message.warning("请先绑定门店");
      onBind?.();
      return;
    }
    const numericPrice = numberFromMoney(price);
    if (!numericPrice || numericPrice <= 0) {
      message.warning("请输入有效售价");
      return;
    }
    const storeId = localStorage.getItem("currentOzonStoreId") || binding?.id || localData?.currentStoreId || "";
    const token = localStorage.getItem("token");
    if (!storeId) {
      message.warning("未找到当前店铺，请重新绑定门店");
      onBind?.();
      return;
    }
    setLoading(true);
    setListingResult({
      status: "pending",
      title: dryRun ? "正在预检上架数据" : "正在提交上架任务",
      detail: dryRun ? "正在通过插件采集 SKU，并交给本地后端做 Ozon 上架预检。" : "正在通过插件采集 SKU，并提交到当前绑定店铺。",
    });
    message.loading({
      content: dryRun ? "正在通过插件采集并预检上架数据…" : "正在通过插件采集并提交上架…",
      key: "edit-submit",
      duration: 0,
    });
    try {
      await syncAuthToExtension({ token, storeId });
      const ping = await requestExtensionPing(1500);
      const bridgeStatus = listingBridgeStatusFromPing(ping);
      setPluginStatus(bridgeStatus);
      if (bridgeStatus.status !== "ok" && bridgeStatus.status !== "partial") {
        throw new Error(bridgeStatus.error);
      }
      const submitCurrencyCode = storeCurrencyCode || currencyCode;
      const resp = bridgeStatus.status === "ok"
        ? await requestExtensionFollowSell({
            storeId,
            sku,
            price: numericPrice,
            currencyCode: submitCurrencyCode,
            dryRun,
          })
        : await requestSourcePluginListing({
            storeId,
            sku,
            price: numericPrice,
            currencyCode: submitCurrencyCode,
            title,
            dryRun,
          });
      if (dryRun && resp?.ok) {
        const preview = resp.data || {};
        const first = Array.isArray(preview.items) ? preview.items[0] : null;
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
      if (resp?.ok) {
        if (item?.id && collectItems.some(function(i) { return String(i.id) === String(item.id); })) {
          await apiRequest(`/ozon/collect-box/${encodeURIComponent(item.id)}`, {
            method: "PATCH",
            body: { status: "已上架", listingTaskId: resp.taskId || resp.data?.result?.task_id || "" },
          }).catch(function() {});
        }
        await onRefresh?.();
        setListingResult({
          status: "success",
          title: "上架任务已提交",
          detail: resp.taskId || resp.data?.result?.task_id ? `任务 ID ${resp.taskId || resp.data?.result?.task_id}` : "已提交到 Ozon，稍后可在上架记录中查看。",
        });
        message.success({ content: "上架任务已提交到 Ozon", key: "edit-submit" });
        setTimeout(function() { navigate("/ozon/products/import-history"); }, 800);
      } else {
        setListingResult({
          status: "error",
          title: "上架提交失败",
          detail: resp?.error || "未知错误",
        });
        message.error({ content: "上架提交失败: " + (resp?.error || "未知错误"), key: "edit-submit" });
      }
    } catch (error) {
      setListingResult({
        status: "error",
        title: dryRun ? "上架预检失败" : "上架失败",
        detail: error?.message || String(error),
      });
      message.error({ content: "上架失败: " + (error?.message || error), key: "edit-submit" });
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = function() {
    runListingRequest({ dryRun: true });
  };

  const handleSubmit = function() {
    runListingRequest({ dryRun: false });
  };
  const listingPluginUsable = pluginStatus.status === "ok" || pluginStatus.status === "partial";
  const productImageList = collectEditImages(item || {}, image);
  const isCollectItem = Boolean(item?.id && collectItems.some(function(i) { return String(i.id) === String(item.id); }));
  const handleSaveDraft = async function() {
    if (!item?.id || !isCollectItem) {
      message.warning("当前商品不在采集箱中，暂不能写回草稿");
      return;
    }
    const draft = {
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
      sourceLink,
      note,
      variants: variantRows,
      savedAt: new Date().toISOString(),
    };
    try {
      await apiRequest(`/ozon/collect-box/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: {
          name: title,
          title,
          sku,
          price,
          currency_code: currencyCode,
          image: productImageList[0] || image,
          images: productImageList,
          brand,
          productUrl: sourceLink,
          listingDraft: draft,
        },
      });
      await onRefresh?.();
      message.success("草稿已保存");
    } catch (error) {
      message.error("草稿保存失败: " + (error?.message || error));
    }
  };
  const categoryLabel = collectEditFirst(item?.categoryPath, item?.category_path, item?.category, item?.category_name, item?.type_name) || "内容体检后自动匹配";
  const storeName = visibleStoreName(
    binding?.name || binding?.storeName || binding?.shopName || localData?.currentStore?.name,
    binding?.clientId || binding?.client_id || localData?.currentStore?.clientId,
    hasStore ? "当前店铺" : "未绑定门店",
  );
  const readyChecks = [
    hasStore,
    Boolean(sku),
    Boolean(title),
    Boolean(price),
    Boolean(productImageList.length),
    Boolean(brand),
    listingPluginUsable,
  ];
  const readyCount = readyChecks.filter(Boolean).length;
  const readyPercent = Math.round((readyCount / readyChecks.length) * 100);
  const sectionNav = [
    { title: "店铺与基础", note: hasStore ? "已选 1" : "未绑定" },
    { title: "产品类目", note: item?.description_category_id || item?.type_id ? "已匹配" : "AI 自动匹配" },
    { title: "标题与文案", note: title ? "已填写" : "待填写" },
    { title: "物流尺寸", note: packageWeight && packageLength && packageWidth && packageHeight ? "已填写" : "待填写" },
    { title: "类目属性", note: item?.type_id ? "已识别" : "无必填" },
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
    setVariantRows((rows) => reindexVariantRows(rows.filter((row) => row.key !== key)));
    setSelectedVariantKeys((keys) => keys.filter((value) => value !== key));
  };
  const deleteSelectedVariants = () => {
    if (!selectedVariantKeys.length) return;
    setVariantRows((rows) => reindexVariantRows(rows.filter((row) => !selectedVariantKeys.includes(row.key))));
    setSelectedVariantKeys([]);
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
        <Button size="small" type="link" onClick={() => duplicateVariantRow(row)}>复制</Button>
        <Button size="small" type="link" danger disabled={variantRows.length <= 1} onClick={() => deleteVariantRow(row.key)}>删除</Button>
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

      <Alert
        className="collect-listing-status"
        type={pluginStatus.status === "ok" ? "success" : pluginStatus.status === "checking" ? "info" : "warning"}
        showIcon
        message={pluginStatus.status === "ok" ? "本地插件已连接" : pluginStatus.status === "partial" ? "源插件兼容采集模式" : "上架需要本地浏览器插件"}
        description={
          pluginStatus.status === "ok"
            ? `插件桥接已响应${pluginStatus.version ? ` · ${pluginStatus.version}` : ""}，提交时会实时采集 Ozon 源商品属性。`
            : pluginStatus.status === "partial"
              ? `${pluginStatus.error}。当前会使用源插件 prefetch 采集 SKU，再交给本地后端预检/提交。`
            : pluginStatus.status === "checking"
              ? "正在检测浏览器是否已加载本项目插件。"
              : `${pluginStatus.error}。请先在插件页确认本地扩展已重新加载。`
        }
        action={
          <Space>
            <Button size="small" loading={pluginStatus.status === "checking"} onClick={checkPluginStatus}>重新检测</Button>
            <Button size="small" type="primary" onClick={function() { navigate("/extension"); }}>插件页</Button>
          </Space>
        }
      />
      {listingResult ? (
        <Alert
          className="collect-listing-result"
          type={listingResult.status === "success" ? "success" : listingResult.status === "pending" ? "info" : "error"}
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
                <Input value={storeName} disabled />
              </Form.Item>
              <Form.Item label="品牌">
                <Input value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="无品牌" />
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
            </Form>
          </section>

          <section className="collect-edit-section" id="产品类目">
            <div className="collect-edit-section-head">
              <div>
                <h2>产品类目</h2>
                <p>AI 自动匹配</p>
              </div>
              <Tag color={item?.description_category_id || item?.type_id ? "green" : "blue"}>{item?.description_category_id || item?.type_id ? "已匹配" : "待内容体检确认"}</Tag>
            </div>
            <div className="collect-edit-category-row">
              <AppstoreOutlined />
              <Input value={categoryLabel} disabled />
              <Button loading={loading} disabled={!listingPluginUsable} aria-label="上架预检" onClick={handlePreview}>内容体检</Button>
            </div>
            <div className="collect-edit-attr-strip">
              <span>description_category_id：{item?.description_category_id || "—"}</span>
              <span>type_id：{item?.type_id || "—"}</span>
            </div>
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
                <p>已填写</p>
              </div>
              <Button size="small" icon={<ThunderboltOutlined />} onClick={() => message.info("已保留当前采集尺寸")}>AI 优化</Button>
            </div>
            <Form layout="vertical" className="collect-edit-size-grid">
              <Form.Item label="包装重量">
                <Input value={packageWeight} suffix="克" onChange={(event) => setPackageWeight(event.target.value)} />
              </Form.Item>
              <Form.Item label="包装长">
                <Input value={packageLength} suffix="毫米" onChange={(event) => setPackageLength(event.target.value)} />
              </Form.Item>
              <Form.Item label="包装宽">
                <Input value={packageWidth} suffix="毫米" onChange={(event) => setPackageWidth(event.target.value)} />
              </Form.Item>
              <Form.Item label="包装高">
                <Input value={packageHeight} suffix="毫米" onChange={(event) => setPackageHeight(event.target.value)} />
              </Form.Item>
            </Form>
          </section>

          <section className="collect-edit-section" id="类目属性">
            <div className="collect-edit-section-head">
              <div>
                <h2>类目属性</h2>
                <p>{item?.type_id ? "已识别" : "无必填"}</p>
              </div>
              <Tag>内容体检后同步 Ozon 必填属性</Tag>
            </div>
            <div className="collect-edit-attribute-grid">
              <div><span>品牌</span><strong>{brand || "无品牌"}</strong></div>
              <div><span>评分</span><strong>{item?.rating ? `${item.rating}★` : "—"}</strong></div>
              <div><span>评价数</span><strong>{item?.reviewCount || "—"}</strong></div>
              <div><span>卖家</span><strong>{item?.sellerName || item?.seller || "—"}</strong></div>
              <div><span>类目 ID</span><strong>{item?.description_category_id || "—"}</strong></div>
              <div><span>类型 ID</span><strong>{item?.type_id || "—"}</strong></div>
            </div>
          </section>

          <section className="collect-edit-section" id="变体设置">
            <div className="collect-edit-section-head">
              <div>
                <h2>变体设置</h2>
                <p>{variantRows.length || 1} 个变体</p>
              </div>
              <Space>
                <Button size="small" icon={<PlusOutlined />} onClick={() => duplicateVariantRow(variantRows[0] || collectEditVariantRows({ item, sku, title, price, images: productImageList, offerPrefix })[0])}>添加变体</Button>
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
            <Button icon={<ThunderboltOutlined />} onClick={() => message.info("AI 一键生成保留当前采集文案，未写入示例数据")}>AI 一键生成俄文文案</Button>
            <Button loading={loading} disabled={!listingPluginUsable} aria-label="上架预检" onClick={handlePreview} icon={<EyeOutlined />}>内容体检</Button>
            <Button onClick={handleSaveDraft}>保存草稿</Button>
            <Button type="primary" loading={loading} disabled={!listingPluginUsable} aria-label="提交上架到 Ozon" onClick={handleSubmit} icon={<CloudUploadOutlined />}>上架到 Ozon</Button>
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
  const tasks = Object.values(localData?.jobs || {})
    .filter(isListingImportJob)
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
  const refreshableTasks = tasks.filter((task) => {
    const status = String(task.status || "").toUpperCase();
    const taskId = task.ozonTaskId || task.taskId;
    return taskId && ["QUEUED", "RUNNING", "PENDING", "PROCESSING", "CREATED"].includes(status);
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
  const detailStatusItem = selectedDetailTask?.statusResponse?.result?.items?.[0] || selectedDetailTask?.statusResponse?.items?.[0] || null;
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
        <Button type="link" size="small" onClick={() => setDetailTask(row._task || row)}>查看</Button>
      ),
    },
  ];
  const completedCount = tasks.filter((task) => importTaskMatchesStatus(task, "已完成")).length;
  const partialCount = tasks.filter((task) => importTaskMatchesStatus(task, "部分成功")).length;
  const processingCount = tasks.filter((task) => importTaskMatchesStatus(task, "处理中")).length;
  const failedCount = tasks.filter((task) => importTaskMatchesStatus(task, "失败")).length;
  const todayKey = localDayFormatter.format(new Date());
  const todayCount = tasks.filter((task) => {
    const date = new Date(task.createdAt || "");
    return !Number.isNaN(date.getTime()) && localDayFormatter.format(date) === todayKey;
  }).reduce((sum, task) => sum + importTaskCount(task), 0);
  const finishedCount = completedCount + partialCount + failedCount;
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
    const timer = window.setInterval(() => {
      refreshImportStatuses({ silent: true });
    }, 45000);
    return () => window.clearInterval(timer);
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
            <div className="wide">
              <span>错误信息</span>
              <strong>
                {selectedDetailTask.errorMessage ||
                  (Array.isArray(detailStatusItem?.errors) && detailStatusItem.errors.length
                    ? detailStatusItem.errors.map((item) => item.message || item.code || JSON.stringify(item)).join("；")
                    : "—")}
              </strong>
            </div>
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
  const [syncingStocks, setSyncingStocks] = useState(false);
  const [stockEditor, setStockEditor] = useState(null);
  const [stockDrafts, setStockDrafts] = useState({});
  const [manualStockWarehouse, setManualStockWarehouse] = useState("");
  const [manualStockValue, setManualStockValue] = useState(0);
  const [savingStock, setSavingStock] = useState(false);
  const products = scopedProductsForCurrentStore(localData?.caches?.products || [], binding, localData);
  const warehouses = scopedWarehousesForCurrentStore(localData?.caches?.warehouses || [], binding, localData);
  const outOfStockCount = products.filter((item) => productMatchesStockFilter(item, "缺货")).length;
  const lowStockCount = products.filter((item) => productMatchesStockFilter(item, "低库存")).length;
  const filteredProducts = products.filter((item) =>
    productMatchesQuery(item, query) && productMatchesStockFilter(item, activeStock)
  );
  const rows = productRows(filteredProducts, warehouses);
  const copySku = async (sku) => {
    const text = String(sku || "").trim();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.setAttribute("readonly", "readonly");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      message.success("SKU 已复制");
    } catch {
      message.error("SKU 复制失败");
    }
  };
  const openStockEditor = (row) => {
    const product = row?._raw || {};
    const entries = stockWarehouseEntries(product, warehouses);
    setStockEditor({ row, product, entries });
    setStockDrafts(Object.fromEntries(entries.map((entry) => [entry.key, entry.present])));
    setManualStockWarehouse("");
    setManualStockValue(0);
  };
  const closeStockEditor = () => {
    if (savingStock) return;
    setStockEditor(null);
    setStockDrafts({});
    setManualStockWarehouse("");
    setManualStockValue(0);
  };
  const stockEditorEntries = stockEditor?.entries || [];
  const warehouseEditOptions = warehouses
    .map((warehouse) => {
      const id = warehouse.warehouse_id ?? warehouse.warehouseId ?? warehouse.id;
      const label = warehouseDisplayName(warehouse);
      return id ? { value: String(id), label: label || String(id) } : null;
    })
    .filter(Boolean);
  const stockEditorChanges = stockEditorEntries
    .filter((entry) => entry.writable)
    .filter((entry) => Number(stockDrafts[entry.key]) !== Number(entry.present));
  const manualStockExisting = stockEditorEntries.find((entry) => entry.warehouseId === manualStockWarehouse);
  const hasManualStockChange = Boolean(manualStockWarehouse) &&
    Number(manualStockValue) !== Number(manualStockExisting?.present ?? -1);
  const stockEditorChangeCount = stockEditorChanges.length + (hasManualStockChange ? 1 : 0);
  const submitStockEditor = async () => {
    if (!stockEditor || savingStock) return;
    if (!stockEditorChangeCount) {
      message.info("库存没有变化");
      return;
    }
    const product = stockEditor.product || {};
    const offerId = product.offer_id || product.offerId || "";
    const productId = product.product_id || product.productId || product.id || "";
    if (!offerId && !productId) {
      message.error("缺少商品 offer_id / product_id，无法同步库存");
      return;
    }
    const stockChanges = stockEditorChanges
      .filter((entry) => !manualStockWarehouse || entry.warehouseId !== manualStockWarehouse)
      .map((entry) => ({
        warehouseId: entry.warehouseId,
        stock: Number(stockDrafts[entry.key]) || 0,
      }));
    if (hasManualStockChange) {
      stockChanges.push({
        warehouseId: manualStockWarehouse,
        stock: Number(manualStockValue) || 0,
      });
    }
    const stocks = stockChanges.map((entry) => ({
      ...(offerId ? { offer_id: String(offerId) } : {}),
      ...(productId ? { product_id: Number(productId) || String(productId) } : {}),
      stock: entry.stock,
      warehouse_id: Number(entry.warehouseId) || String(entry.warehouseId),
    }));
    setSavingStock(true);
    message.loading({ content: "正在同步库存到 Ozon", key: "stock-editor", duration: 0 });
    try {
      await apiRequest("/ozon/stocks/import", {
        method: "POST",
        body: { storeId: binding?.id, stocks },
      });
      await onRefresh?.();
      message.success({ content: `库存已同步 · ${stocks.length} 个仓库`, key: "stock-editor" });
      setStockEditor(null);
      setStockDrafts({});
      setManualStockWarehouse("");
      setManualStockValue(0);
    } catch (error) {
      message.error({ content: `库存同步失败: ${error.message}`, key: "stock-editor" });
    } finally {
      setSavingStock(false);
    }
  };
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
        return (
          <div className="product-info-cell">
            <span className="source-table-cell-text product-info-name" title={title}>{title}</span>
            {sku ? (
              <span className="product-sku-row">
                <span className="product-sku-text" title={sku}>SKU：{sku}</span>
                <Tooltip title="复制 SKU">
                  <Button
                    aria-label="复制 SKU"
                    className="product-sku-copy"
                    icon={<CopyOutlined />}
                    onClick={(event) => {
                      event.stopPropagation();
                      copySku(sku);
                    }}
                    size="small"
                    type="text"
                  />
                </Tooltip>
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
      const [warehouseReport, productReport] = await Promise.all([
        apiRequest("/local/sync/WAREHOUSES", { method: "POST", body: { storeId: binding?.id } }),
        apiRequest("/local/sync/PRODUCTS", { method: "POST", body: { storeId: binding?.id } }),
      ]);
      await onRefresh?.();
      const productCount = Number(productReport?.fetchedCount) || 0;
      const warehouseCount = Number(warehouseReport?.fetchedCount) || 0;
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
        subtitle="查看各商品库存与仓库分布,批量改库存先暂存、再一键同步到 Ozon"
      />
      <div className="stock-top-grid">
        <Card className="panel-card source-card stock-main-card">
          <div className="card-title-row">
            <span>商品库存</span>
            <Tag>仓库 {warehouses.length}</Tag>
          </div>
          <div className="stock-summary-grid">
            {[
              ["商品总数", String(products.length), "当前店铺缓存商品"],
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
          <span>暂存待提交</span>
          <strong>0</strong>
          <em>暂无待提交改动</em>
        </Card>
      </div>
      <Card className="panel-card source-card">
        <div className="card-title-row">
          <span>库存</span>
          <Space>
            <Button loading={syncingStocks} onClick={refreshStocks}>刷新</Button>
            <Button type="primary" onClick={searchStocks}>查询</Button>
          </Space>
        </div>
        <div className="filter-panel inline">
          <PromotionStatusButtons
            active={activeStock}
            onChange={setActiveStock}
            items={[
              { label: "全部", count: products.length, tone: "primary" },
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
          rows={rows}
          columns={stockColumns}
          empty={false}
          sourceEmpty
        />
      </Card>
      <Modal
        title="修改 SKU 库存"
        open={!!stockEditor}
        onCancel={closeStockEditor}
        onOk={submitStockEditor}
        okText="同步到 Ozon"
        cancelText="取消"
        width={720}
        okButtonProps={{ disabled: !stockEditorChangeCount, loading: savingStock }}
        destroyOnHidden
      >
        <div className="stock-edit-modal">
          <div className="product-price-modal-head">
            <strong title={stockEditor?.row?._title}>{stockEditor?.row?._title || "—"}</strong>
            <span>SKU：{stockEditor?.row?._sku || "—"}</span>
          </div>
          {stockEditorEntries.some((entry) => !entry.writable) ? (
            <Alert
              message="没有仓库 ID 的汇总库存不能直接修改；需要在下方选择一个本店仓库后写入该 SKU 库存。"
              showIcon
              type="warning"
            />
          ) : null}
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
                title: "修改库存",
                dataIndex: "draft",
                width: 140,
                render: (_, entry) => (
                  entry.writable ? (
                    <InputNumber
                      min={0}
                      precision={0}
                      value={stockDrafts[entry.key]}
                      onChange={(value) => setStockDrafts((prev) => ({
                        ...prev,
                        [entry.key]: Number(value) || 0,
                      }))}
                      style={{ width: "100%" }}
                    />
                  ) : (
                    <Tag>不可修改</Tag>
                  )
                ),
              },
            ]}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无库存明细" />,
            }}
          />
          {warehouseEditOptions.length ? (
            <div className="stock-manual-editor">
              <Select
                allowClear
                placeholder="选择要写入库存的仓库"
                value={manualStockWarehouse || undefined}
                options={warehouseEditOptions}
                onChange={(value) => setManualStockWarehouse(value || "")}
              />
              <InputNumber
                min={0}
                precision={0}
                value={manualStockValue}
                onChange={(value) => setManualStockValue(Number(value) || 0)}
              />
            </div>
          ) : null}
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

function CategoryPage({ binding, hasStore, localData, onRefresh }) {
  const { message } = AntApp.useApp();
  const [expanded, setExpanded] = useState(false);
  const [activeCategory, setActiveCategory] = useState("all");
  const [syncingCategories, setSyncingCategories] = useState(false);
  const products = localData?.caches?.products || [];
  const categoryRows = categoryAnalysisRows(products);
  const visibleRows = activeCategory === "all"
    ? categoryRows
    : categoryRows.filter((row) => row._categoryId === activeCategory);
  const visibleProductCount = visibleRows.reduce((sum, row) => sum + (Number(row._count) || 0), 0);
  const visibleAveragePrices = visibleRows
    .map((row) => row._avgPrice)
    .filter((value) => Number.isFinite(value));
  const visibleAveragePrice = visibleAveragePrices.length
    ? visibleAveragePrices.reduce((sum, value) => sum + value, 0) / visibleAveragePrices.length
    : null;
  const categoryOptions = [
    { value: "all", label: "全部" },
    ...categoryRows.map((row) => ({ value: row._categoryId, label: row["类目"] })),
  ];
  const baseRangeFilters = ["月销量", "月销售额 ₽", "平均价 ₽", "GMV增长 %", "退货率 %", "卖家数"];
  const expandedRangeFilters = ["品牌数", "品牌占比 %", "头部卖家 %", "FBS占比 %"];
  const rangeFilters = expanded ? [...baseRangeFilters, ...expandedRangeFilters] : baseRangeFilters;

  const refreshCategoryCache = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      return;
    }
    if (syncingCategories) return;
    setSyncingCategories(true);
    message.loading({ content: "正在只读同步商品类目缓存", key: "category-sync", duration: 0 });
    try {
      const report = await apiRequest("/local/sync/PRODUCTS", {
        method: "POST",
        body: { storeId: binding?.id },
      });
      await onRefresh?.();
      const fetched = Number(report?.fetchedCount) || 0;
      message.success({ content: `类目商品缓存已刷新 · ${fetched} 条`, key: "category-sync" });
    } catch (error) {
      message.error({ content: `刷新失败: ${error.message}`, key: "category-sync" });
    } finally {
      setSyncingCategories(false);
    }
  };

  const resetCategoryFilters = () => {
    setActiveCategory("all");
    setExpanded(false);
    message.success("已重置");
  };

  return (
    <div className="source-page category-page">
      <SourceSectionTitle
        title="类目分析"
        subtitle="按 Ozon 本地快照查看类目规模、增长、退货、品牌集中度与履约结构。"
        actions={[
          <Segmented key="period" options={["7天", "28天", "90天", "365天"]} defaultValue="28天" />,
          <Segmented key="currency" options={["₽", "¥"]} defaultValue="₽" />,
          <Tag key="tag">本地缓存 {categoryRows.length} 类目</Tag>,
          <Button key="refresh" loading={syncingCategories} onClick={refreshCategoryCache}>刷新</Button>,
        ]}
      />
      <div className="category-tabs">
        {[
          ["全部类目", "一级类目开始逐层下钻"],
          ["增长机会", "GMV 环比不低于 30%"],
          ["高退货率", "退货风险不低于 15%"],
          ["品牌集中", "品牌销售占比不低于 30%"],
          ["FBS机会", "FBS 销售占比不低于 50%"],
        ].map(([title, desc], index) => (
          <button className={index === 0 ? "active" : ""} key={title}>
            <strong>{title}</strong>
            <span>{desc}</span>
          </button>
        ))}
      </div>
      <div className="stat-strip">
        {[
          ["匹配类目", String(visibleRows.length), activeCategory === "all" ? "当前视图: 全部类目" : "当前视图: 已筛选"],
          ["当前页商品", String(visibleProductCount), "按当前页汇总"],
          ["当前页均价", visibleAveragePrice === null ? "—" : moneyText(visibleAveragePrice.toFixed(2), "₽"), "来自本地商品价格"],
          ["平均退货率", "-", "当前页均值"],
          ["增长领跑", "-", "暂无增长数据"],
        ].map(([title, value, note]) => (
          <Card className="stat-card" key={title}>
            <span>{title}</span>
            <strong>{value}</strong>
            <em>{note}</em>
          </Card>
        ))}
      </div>
      <Card className="panel-card source-card">
        <div className="category-filter-grid">
          <label>
            一级类目
            <Select value={activeCategory} onChange={setActiveCategory} options={categoryOptions} />
          </label>
          <label>
            路径
            <Select value={activeCategory} onChange={setActiveCategory} options={categoryOptions} />
          </label>
          <div className="category-filter-title">筛选</div>
          {rangeFilters.map((label) => (
            <label key={label}>
              {label}
              <Space.Compact>
                <Input placeholder="最小" />
                <Input placeholder="最大" prefix="至" />
              </Space.Compact>
            </label>
          ))}
          <Space className="category-filter-actions">
            <Button type="primary" onClick={() => message.success(`查询完成 · ${visibleRows.length} 个类目`)}>查询</Button>
            <Button onClick={resetCategoryFilters}>重置</Button>
            <Button onClick={() => setExpanded((value) => !value)}>{expanded ? "收起 ↑" : "更多筛选 ↓"}</Button>
          </Space>
        </div>
        <Alert type="info" showIcon message="当前表格使用本地商品缓存聚合；月销量、GMV、退货率、品牌与 FBS 指标等待真实市场快照后展示。" />
      </Card>
      <Card className="panel-card source-card">
        <div className="table-result-title">一级类目总览 · 共 {visibleRows.length} 类</div>
        <SourceTable
          hasStore={hasStore}
          rowSelection={false}
          rows={visibleRows}
          empty="本周期还没有类目分析快照"
          columns={["#", "类目", "月销量", "月销售额", "GMV增长", "平均价", "均价环比", "卖家数", "品牌数", "品牌占比", "头部卖家", "FBS占比", "出库率", "退货率"]}
          sourceEmpty
          scrollX={1420}
        />
      </Card>
    </div>
  );
}

function SelectionListPage({ kind, hasStore, localData }) {
  const isChina = kind === "china";
  const { message } = AntApp.useApp();
  const [activeChip, setActiveChip] = useState(isChina ? "中国对标" : "热销商品");
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [dateRange, setDateRange] = useState("28天");
  const [currency, setCurrency] = useState("₽");
  const [categoryId, setCategoryId] = useState("all");
  const [productName, setProductName] = useState("");
  const [skuQuery, setSkuQuery] = useState("");
  const [batchSkus, setBatchSkus] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [salesMin, setSalesMin] = useState("");
  const [salesMax, setSalesMax] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [growthMin, setGrowthMin] = useState("");
  const [growthMax, setGrowthMax] = useState("");
  const [shippingMode, setShippingMode] = useState("任意");
  const [includeZeroSales, setIncludeZeroSales] = useState(false);
  const [extraFiltersEnabled, setExtraFiltersEnabled] = useState(false);
  const [selectionDraftIds, setSelectionDraftIds] = useState([]);
  const products = localData?.caches?.products || [];
  const topChips = ["热销商品", "热销新品", "潜力商品", "蓝海商品"];
  const strategyChips = isChina
    ? ["高增长", "低价高销", "高加购", "中国对标"]
    : ["高增长", "低价高销", "高加购", "蓝海量级"];
  const categoryOptions = useMemo(() => {
    const groups = new Map();
    products.forEach((item) => {
      const id = String(productCategoryId(item));
      if (!groups.has(id)) groups.set(id, { value: id, label: productCategoryLabel(item, id), count: 0 });
      groups.get(id).count += 1;
    });
    return [
      { value: "all", label: "全部" },
      ...Array.from(groups.values())
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
        .map((item) => ({ value: item.value, label: `${item.label} (${item.count})` })),
    ];
  }, [products]);
  const batchSkuSet = useMemo(() => new Set(
    batchSkus
      .split(/[\s,，;；]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ), [batchSkus]);
  const filteredProducts = useMemo(() => {
    const min = priceMin === "" ? null : Number(priceMin);
    const max = priceMax === "" ? null : Number(priceMax);
    const monthlySalesMin = salesMin === "" ? null : Number(salesMin);
    const monthlySalesMax = salesMax === "" ? null : Number(salesMax);
    const monthlyAmountMin = amountMin === "" ? null : Number(amountMin);
    const monthlyAmountMax = amountMax === "" ? null : Number(amountMax);
    const monthlyGrowthMin = growthMin === "" ? null : Number(growthMin);
    const monthlyGrowthMax = growthMax === "" ? null : Number(growthMax);
    const name = productName.trim().toLowerCase();
    const sku = skuQuery.trim().toLowerCase();
    const inRange = (value, minValue, maxValue) => {
      if (minValue === null && maxValue === null) return true;
      if (value === null) return false;
      if (Number.isFinite(minValue) && value < minValue) return false;
      if (Number.isFinite(maxValue) && value > maxValue) return false;
      return true;
    };
    const rows = products.filter((item, index) => {
      if (categoryId !== "all" && String(productCategoryId(item)) !== String(categoryId)) return false;
      const search = productSelectionSearchText(item);
      if (name && !search.includes(name)) return false;
      if (sku && !productSearchText(item).includes(sku)) return false;
      if (batchSkuSet.size) {
        const values = [item.id, item.product_id, item.offer_id, item.sku, ...(Array.isArray(item.barcodes) ? item.barcodes : [])]
          .map((value) => String(value || "").toLowerCase())
          .filter(Boolean);
        if (!values.some((value) => batchSkuSet.has(value))) return false;
      }
      const price = numberFromMoney(productPriceValue(item));
      if (min !== null && Number.isFinite(min) && (price === null || price < min)) return false;
      if (max !== null && Number.isFinite(max) && (price === null || price > max)) return false;
      if (extraFiltersEnabled) {
        const monthlySales = firstNumericValue(item, ["monthlySales", "monthSales", "monthly_sales", "sales_30d"]);
        const monthlyAmount = firstNumericValue(item, ["monthlyAmount", "monthAmount", "monthly_amount", "revenue_30d", "gmv_30d"]);
        const monthlyGrowth = firstNumericValue(item, ["monthlyGrowth", "monthGrowth", "monthly_growth", "revenue_growth"]);
        if (!inRange(monthlySales, monthlySalesMin, monthlySalesMax)) return false;
        if (!inRange(monthlyAmount, monthlyAmountMin, monthlyAmountMax)) return false;
        if (!inRange(monthlyGrowth, monthlyGrowthMin, monthlyGrowthMax)) return false;
      }
      if (shippingMode !== "任意") {
        const shipping = productShippingText(item).toUpperCase();
        const target = shippingMode.replace("CB · ", "").toUpperCase();
        if (!shipping.includes(target)) return false;
      }
      if (isChina && !includeZeroSales && stockNumber(item) <= 0) return false;
      return true;
    });
    return selectionStrategySort(rows, activeChip);
  }, [activeChip, amountMax, amountMin, batchSkuSet, categoryId, extraFiltersEnabled, growthMax, growthMin, includeZeroSales, isChina, priceMax, priceMin, productName, products, salesMax, salesMin, shippingMode, skuQuery]);
  const rows = selectionProductRows(filteredProducts).map((row) => ({
    ...row,
    _drafted: selectionDraftIds.includes(String(row.id)),
  }));
  const visibleStart = rows.length ? 1 : 0;
  const visibleEnd = Math.min(20, rows.length);
  const resetFilters = () => {
    setActiveChip(isChina ? "中国对标" : "热销商品");
    setDateRange("28天");
    setCurrency("₽");
    setCategoryId("all");
    setProductName("");
    setSkuQuery("");
    setBatchSkus("");
    setPriceMin("");
    setPriceMax("");
    setSalesMin("");
    setSalesMax("");
    setAmountMin("");
    setAmountMax("");
    setGrowthMin("");
    setGrowthMax("");
    setShippingMode("任意");
    setIncludeZeroSales(false);
    setExtraFiltersEnabled(false);
    setSelectedRowKeys([]);
    message.success("已重置");
  };
  const toggleExtraFilters = () => {
    setExtraFiltersEnabled((current) => {
      const next = !current;
      if (!next) {
        setSalesMin("");
        setSalesMax("");
        setAmountMin("");
        setAmountMax("");
        setGrowthMin("");
        setGrowthMax("");
      }
      return next;
    });
  };
  const addSelectionDrafts = (ids) => {
    const normalized = ids.map(String);
    setSelectionDraftIds((current) => Array.from(new Set([...current, ...normalized])));
    message.success(`已加入本地草稿箱 · ${normalized.length} 件`);
  };
  const openSelectionProduct = (record) => {
    const url = record._raw?.url || record._raw?.product_url || record._raw?.productUrl || record._raw?.link;
    if (!url) {
      message.info("当前本地缓存暂无 Ozon 商品页链接");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const selectionColumns = [
    "商品",
    "类目",
    "价格",
    "销量",
    "销售额",
    "增长",
    "卖家",
    "品牌",
    "发货",
    "库存",
    {
      title: "操作",
      dataIndex: "操作",
      width: 108,
      render: (_value, record) => (
        <Button type="link" size="small" onClick={() => openSelectionProduct(record)}>
          一键跟卖
        </Button>
      ),
    },
  ];
  return (
    <div className="source-page">
      <SourceSectionTitle
        title={isChina ? "中国专区" : "榜单选品"}
        subtitle={isChina ? "/ Ozon 中国卖家热销榜单，跨境跟款对标" : "/ Ozon 全平台 top 1000 实时榜单"}
        actions={[
          <span className="sync-label" key="updated">本地商品缓存 {products.length} · 市场快照 —</span>,
        ]}
      />
      <Card className="panel-card source-card">
        <div className="selection-source-toolbar">
          {!isChina ? (
            <SourceStatusTabs
              items={topChips}
              active={activeChip}
              onChange={setActiveChip}
            />
          ) : null}
          <Segmented options={["7天", "28天"]} value={dateRange} onChange={setDateRange} />
          <div className="selection-control-group">
            <span>金额单位</span>
            <Segmented options={["₽", "¥"]} value={currency} onChange={setCurrency} />
          </div>
          <div className="selection-control-group">
            <span>分区</span>
            <Select className="source-select narrow" value="all" options={[{ value: "all", label: "全部分区" }]} />
          </div>
          {isChina ? (
            <Checkbox checked={includeZeroSales} onChange={(event) => setIncludeZeroSales(event.target.checked)}>含零销量商品 <Tooltip title="当前无市场销量快照，本地用库存为 0 的商品作为候选补录范围">ⓘ</Tooltip></Checkbox>
          ) : null}
        </div>
        <Alert
          type="info"
          closable
          closeIcon={<span>×</span>}
          showIcon={false}
          message={isChina
            ? "中国卖家热销商品，跨境玩法对标。 点击「一键跟卖」跳转 Ozon 商品页,自动唤起模拟手动跟卖。"
            : "销量与销售额双高的爆款，适合切入趋势品类。 点击「一键跟卖」跳转 Ozon 商品页,自动唤起模拟手动跟卖。"}
        />
        {isChina ? (
          <div className="selection-china-note">
            <strong>中国馆对标</strong>
            <span>中国专区来自中国馆/跨境来源标记，默认隐藏当期零销量商品；勾选“含零销量商品”可查看补录 SKU。</span>
          </div>
        ) : null}
        <div className="selection-strategy">
          <strong>选品策略</strong>
          <span>保留当前类目，快速切筛选</span>
          <span className={`selection-extra-state ${extraFiltersEnabled ? "active" : ""}`}>
            {extraFiltersEnabled ? "已启用额外筛选" : "未启用额外筛选"}
          </span>
          <div className="selection-strategy-tags">
            {strategyChips.map((label) => (
              <button className={activeChip === label ? "active" : ""} key={label} onClick={() => setActiveChip(label)}>{label}</button>
            ))}
          </div>
          <Tag>本地候选 {rows.length}</Tag>
        </div>
        <div className="selection-market-filter">
          <label>
            <span>一级类目</span>
            <Select value={categoryId} options={categoryOptions} onChange={setCategoryId} />
          </label>
          <div className="selection-filter-label">筛选</div>
          <label>
            <span>商品名称</span>
            <Input placeholder="商品名称" allowClear value={productName} onChange={(event) => setProductName(event.target.value)} />
          </label>
          <label>
            <span>SKU</span>
            <Input placeholder="sku" allowClear value={skuQuery} onChange={(event) => setSkuQuery(event.target.value)} />
          </label>
          <label className="wide">
            <span>批量 SKUS</span>
            <Input.TextArea rows={1} placeholder="逗号/空格/换行分隔" value={batchSkus} onChange={(event) => setBatchSkus(event.target.value)} />
          </label>
          <label className="range">
            <span>月销量</span>
            <Input placeholder="最小" value={salesMin} onChange={(event) => setSalesMin(event.target.value)} disabled={!extraFiltersEnabled} />
            <em>~</em>
            <Input placeholder="最大" value={salesMax} onChange={(event) => setSalesMax(event.target.value)} disabled={!extraFiltersEnabled} />
          </label>
          <label className="range">
            <span>月销售额 {currency}</span>
            <Input placeholder="最小" value={amountMin} onChange={(event) => setAmountMin(event.target.value)} disabled={!extraFiltersEnabled} />
            <em>~</em>
            <Input placeholder="最大" value={amountMax} onChange={(event) => setAmountMax(event.target.value)} disabled={!extraFiltersEnabled} />
          </label>
          <label className="range">
            <span>平均价 {currency}</span>
            <Input placeholder="最小" value={priceMin} onChange={(event) => setPriceMin(event.target.value)} />
            <em>~</em>
            <Input placeholder="最大" value={priceMax} onChange={(event) => setPriceMax(event.target.value)} />
          </label>
          <label className="range">
            <span>月销售额环比 %</span>
            <Input placeholder="最小" value={growthMin} onChange={(event) => setGrowthMin(event.target.value)} disabled={!extraFiltersEnabled} />
            <em>~</em>
            <Input placeholder="最大" value={growthMax} onChange={(event) => setGrowthMax(event.target.value)} disabled={!extraFiltersEnabled} />
          </label>
          <label className="shipping">
            <span>发货模式</span>
            <Segmented options={["任意", "FBO", "FBS", "RFBS", "CB · 跨境"]} value={shippingMode} onChange={setShippingMode} />
          </label>
        </div>
        <div className="table-action-row">
          <Space>
            <Button type="primary" onClick={() => message.success(`查询完成 · ${rows.length} 件本地候选`)}>查询</Button>
            <Button onClick={resetFilters}>重置</Button>
            <Button aria-pressed={extraFiltersEnabled} onClick={toggleExtraFilters}>
              {extraFiltersEnabled ? "收起筛选 ↑" : "更多筛选 ↓"}
            </Button>
          </Space>
        </div>
        <div className="selection-filter-summary">
          <span>共 {rows.length} 件商品 · 当前展示 {visibleStart}-{visibleEnd}</span>
          <Tag>已选 {selectedRowKeys.length}</Tag>
          <Tag>草稿 {selectionDraftIds.length}</Tag>
        </div>
        <div className="table-action-row selection-bulk-row">
          <span />
          <Space>
            <Button disabled={!selectedRowKeys.length} onClick={() => addSelectionDrafts(selectedRowKeys)}>批量加入草稿箱</Button>
            <Button disabled={!selectedRowKeys.length} onClick={() => setSelectedRowKeys([])}>清空选择</Button>
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rows={rows}
          selectedRowKeys={selectedRowKeys}
          onSelectionChange={setSelectedRowKeys}
          empty="暂无榜单数据"
          columns={selectionColumns}
          sourceEmpty
          scrollX={1320}
        />
        <Alert type="info" showIcon message="当前表格来自本地商品缓存；销量、销售额、增长、卖家等市场指标等待真实榜单快照后展示。" />
        <SourcePager current={1} total={Math.max(1, Math.ceil(rows.length / 20))} pageSize={20} />
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

function SourceMetricStrip({ items, className = "" }) {
  return (
    <div
      className={`stat-strip source-stat-strip ${className}`.trim()}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map(([title, value, note]) => (
        <Card className="stat-card" key={title}>
          <span>{title}</span>
          <strong>{value}</strong>
          <em>{note}</em>
        </Card>
      ))}
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
          ["本周 GMV", dashboardMoney(summary.weekGmv), "当前店铺"],
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

const profitRangeDays = {
  "7 天": 7,
  "30 天": 30,
  "90 天": 90,
  "180 天": 180,
};

const formatIsoDate = (value) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

function profitDateRange(range) {
  const days = profitRangeDays[range] || 30;
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - days + 1);
  return {
    days,
    label: `${formatIsoDate(start)} 至 ${formatIsoDate(end)}`,
    start,
    end,
  };
}

const profitTrendModel = (postings = [], range = "30 天") => {
  const { days } = profitDateRange(range);
  const dayMs = 24 * 60 * 60 * 1000;
  const now = new Date();
  const rows = Array.from({ length: days }, (_, index) => {
    const date = new Date(now.getTime() - (days - 1 - index) * dayMs);
    const key = localDayKey(date);
    return {
      key,
      "日期": key,
      "订单数": "0",
      "订单金额": "¥0",
      "OZON 佣金": "—",
      "采购成本": "—",
      "利润": "—",
      "毛利率": "—",
      "客单价": "—",
      count: 0,
      amount: 0,
    };
  });
  const rowMap = new Map(rows.map((row) => [row.key, row]));

  postings.forEach((posting) => {
    const key = localDayKey(postingBusinessDate(posting));
    const row = rowMap.get(key);
    if (!row) return;
    const amount = postingBusinessAmount(posting);
    row.count += 1;
    row.amount += amount;
  });

  rows.forEach((row) => {
    row["订单数"] = `${row.count}`;
    row["订单金额"] = dashboardMoney(row.amount);
    row["客单价"] = row.count ? dashboardMoney(row.amount / row.count) : "—";
  });

  const activeRows = rows.filter((row) => row.count > 0);
  const totalOrders = activeRows.reduce((sum, row) => sum + row.count, 0);
  const totalAmount = activeRows.reduce((sum, row) => sum + row.amount, 0);
  const bestDay = activeRows.reduce(
    (best, row) => (!best || row.amount > best.amount ? row : best),
    null
  );

  return {
    rows: rows.slice().reverse(),
    chartRows: rows,
    activeDays: activeRows.length,
    blankDays: days - activeRows.length,
    totalOrders,
    totalAmount,
    bestDay,
    maxAmount: Math.max(1, ...rows.map((row) => row.amount)),
    maxCount: Math.max(1, ...rows.map((row) => row.count)),
  };
};

function ProfitTrendPage({ binding, hasStore, localData }) {
  const [range, setRange] = useState("30 天");
  const [view, setView] = useState("利润视图");
  const { days, label } = profitDateRange(range);
  const postings = localData?.caches?.postings || [];
  const model = profitTrendModel(postings, range);
  const metricNote = model.totalOrders
    ? `客单价 ${dashboardMoney(model.totalAmount / model.totalOrders)}`
    : "客单价 —";
  const chartMax = view === "订单量" ? model.maxCount : model.maxAmount;
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="利润趋势"
        subtitle={`${label} · ${binding?.storeName || "当前店铺"} · 按出单日期聚合，金额为人民币口径`}
        actions={[
          <ProfitToggleGroup key="range" options={["7 天", "30 天", "90 天", "180 天"]} active={range} onChange={setRange} />,
          <Select key="store" value="all" options={[{ value: "all", label: "全部店铺" }]} />,
        ]}
      />
      <SourceMetricStrip
        className="profit-stat-strip"
        items={[
          ["订单金额", dashboardMoney(model.totalAmount), `本期汇总 · ${metricNote}`],
          ["利润", model.totalOrders ? "¥—" : "¥0", "需成本数据 · 利润率 —"],
          ["毛利率", "—", "佣金 — · 采购 —"],
          ["订单数", `${model.totalOrders} 单`, `${model.activeDays} 个出单日`],
        ]}
      />
      <section className="profit-main-grid">
        <div className="profit-main-head">
          <div>
            <strong>{model.activeDays} 个出单日 · {model.blankDays} 个空白日</strong>
            <span>日维度趋势</span>
          </div>
          <ProfitToggleGroup options={["利润视图", "成本拆解", "订单量"]} active={view} onChange={setView} />
        </div>
        {model.totalOrders ? (
          <div className="profit-trend-bars" aria-label="日维度趋势图">
            {model.chartRows.map((row) => {
              const value = view === "订单量" ? row.count : row.amount;
              return (
                <div className="profit-trend-day" key={row.key} title={`${row["日期"]} · ${row.count} 单`}>
                  <span
                    style={{ height: `${row.count ? Math.max(6, (value / chartMax) * 100) : 3}%` }}
                  />
                  <em>{dayLabel(row.key)}</em>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="profit-judgement-grid">
          {[
            [
              "经营判断",
              "本期订单金额最高",
              model.bestDay ? dayLabel(model.bestDay.key) : "暂无",
              model.bestDay ? `${model.bestDay.count} 单 · ${dashboardMoney(model.bestDay.amount)}` : "本期还没有可分析订单",
            ],
            ["利润压力", "暂无可判断", "", model.totalOrders ? "待录入采购成本后展示利润压力" : "同步订单后展示利润压力"],
            ["采购成本为 0 的出单日", model.totalOrders ? `${model.activeDays} 天待补成本` : "暂无可判断", "", "有出单数据后展示采购成本录入信号"],
            ["费用结构", model.totalAmount ? "订单金额已同步" : "暂无可判断", "", model.totalAmount ? "佣金、采购成本待补充后计算利润" : "本期暂无订单金额"],
          ].map(([title, primary, secondary, note]) => (
            <div key={title}>
              <span>{title}</span>
              <strong>{primary}</strong>
              {secondary ? <em>{secondary}</em> : null}
              <p>{note}</p>
            </div>
          ))}
        </div>
      </section>
      <Card className="panel-card source-card">
        <div className="table-result-title">日明细 · 共 {days} 天</div>
        <SourceTable
          hasStore={hasStore}
          rows={model.totalOrders ? model.rows : []}
          rowSelection={false}
          columns={["日期", "订单数", "订单金额", "OZON 佣金", "采购成本", "利润", "毛利率", "客单价"]}
          empty="暂无利润明细"
          sourceEmpty
          scrollX={1050}
          pageSize={30}
        />
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
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditTemplate(record)} />
          </Tooltip>
          <Tooltip title="删除">
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

const watermarkTypeOptions = [
  { value: "text", label: "文字水印" },
  { value: "border", label: "边框" },
];

const watermarkFontOptions = [
  { value: "system", label: "系统默认" },
  { value: "serif", label: "衬线字体" },
];

const watermarkPositionOptions = [
  { value: "center", label: "居中" },
  { value: "tile", label: "平铺" },
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

const defaultWatermarkValues = {
  name: "",
  type: "text",
  text: "",
  font: "system",
  fontSize: 28,
  color: "#ffffff",
  opacity: 40,
  rotate: -30,
  margin: 8,
  position: "center",
};

const watermarkTypeLabel = (value) =>
  watermarkTypeOptions.find((item) => item.value === value)?.label || "文字水印";

const watermarkFontFamily = (value) =>
  value === "serif"
    ? "Georgia, 'Times New Roman', serif"
    : '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';

const hexToRgba = (value, opacity = 40) => {
  const hex = String(value || "#ffffff").replace("#", "");
  const normalized = hex.length === 3
    ? hex.split("").map((char) => `${char}${char}`).join("")
    : hex.padEnd(6, "f").slice(0, 6);
  const intValue = Number.parseInt(normalized, 16);
  const r = (intValue >> 16) & 255;
  const g = (intValue >> 8) & 255;
  const b = intValue & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(100, Number(opacity) || 0)) / 100})`;
};

function WatermarkPage({ hasStore, localData, onRefresh }) {
  const { message, modal } = AntApp.useApp();
  const [templateForm] = Form.useForm();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [uploadedImages, setUploadedImages] = useState([]);
  const templates = localData?.caches?.watermarkTemplates || [];
  const selectedTemplate = templates.find((item) => String(item.id) === String(selectedTemplateId)) || null;
  const previewImage = uploadedImages[0] || null;

  useEffect(() => {
    if (!templates.length) {
      if (selectedTemplateId) setSelectedTemplateId("");
      return;
    }
    if (!templates.some((item) => String(item.id) === String(selectedTemplateId))) {
      setSelectedTemplateId(String(templates.find((item) => item.isDefault)?.id || templates[0].id));
    }
  }, [selectedTemplateId, templates]);

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
    templateForm.setFieldsValue(defaultWatermarkValues);
    setTemplateOpen(true);
  };

  const openEditTemplate = (template) => {
    setEditingTemplate(template);
    templateForm.setFieldsValue({
      ...defaultWatermarkValues,
      ...template,
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
      const response = await apiRequest(
        isEditing ? `/ozon/watermark-settings/${encodeURIComponent(editingTemplate.id)}` : "/ozon/watermark-settings",
        {
          method: isEditing ? "PUT" : "POST",
          body: values,
        },
      );
      await onRefresh?.();
      if (response?.item?.id) setSelectedTemplateId(String(response.item.id));
      closeTemplateModal();
      message.success("模板已保存");
    } catch (error) {
      message.error(`保存失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = (template) => {
    modal.confirm({
      title: "删除模板",
      icon: null,
      content: "确认删除该水印/边框模板？",
      okText: "删 除",
      okButtonProps: { danger: true },
      cancelText: "取 消",
      onOk: async () => {
        try {
          await apiRequest(`/ozon/watermark-settings/${encodeURIComponent(template.id)}`, { method: "DELETE" });
          await onRefresh?.();
          message.success("模板已删除");
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };

  const addUploadFile = (file) => {
    const item = {
      id: `${file.uid || file.name}-${Date.now()}`,
      name: file.name,
      file,
      url: URL.createObjectURL(file),
    };
    setUploadedImages((current) => [...current, item].slice(0, 20));
  };

  const drawTemplate = (ctx, canvas, template) => {
    const opacityColor = hexToRgba(template.color, template.opacity);
    const fontSize = Math.max(8, Number(template.fontSize) || 28);
    const margin = Math.max(0, Number(template.margin) || 8) / 100 * Math.min(canvas.width, canvas.height);
    if (template.type === "border") {
      ctx.strokeStyle = opacityColor;
      ctx.lineWidth = Math.max(4, fontSize / 3);
      ctx.strokeRect(margin, margin, canvas.width - margin * 2, canvas.height - margin * 2);
      return;
    }
    const text = String(template.text || template.name || "");
    if (!text) return;
    ctx.fillStyle = opacityColor;
    ctx.font = `700 ${fontSize}px ${watermarkFontFamily(template.font)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (template.position === "tile") {
      const step = Math.max(140, fontSize * 5);
      for (let y = step / 2; y < canvas.height + step; y += step) {
        for (let x = step / 2; x < canvas.width + step; x += step) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate((Number(template.rotate) || 0) * Math.PI / 180);
          ctx.fillText(text, 0, 0);
          ctx.restore();
        }
      }
      return;
    }
    const positions = {
      center: [canvas.width / 2, canvas.height / 2],
      "top-left": [margin + fontSize * 2, margin + fontSize],
      "top-right": [canvas.width - margin - fontSize * 2, margin + fontSize],
      "bottom-left": [margin + fontSize * 2, canvas.height - margin - fontSize],
      "bottom-right": [canvas.width - margin - fontSize * 2, canvas.height - margin - fontSize],
    };
    const [x, y] = positions[template.position] || positions.center;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((Number(template.rotate) || 0) * Math.PI / 180);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };

  const downloadOne = async (imageItem, index = 0) => {
    if (!selectedTemplate || !imageItem) return;
    const image = new Image();
    image.src = imageItem.url;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawTemplate(ctx, canvas, selectedTemplate);
    const link = document.createElement("a");
    const baseName = imageItem.name.replace(/\.[^.]+$/, "") || `watermark-${index + 1}`;
    link.download = `${baseName}-qh-watermark.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const canDownload = Boolean(selectedTemplate && uploadedImages.length);

  return (
    <div className="source-page watermark-page">
      <div className="watermark-head-row">
        <SourceSectionTitle
          title="水印工具"
          subtitle="选模板 → 上传图片 → 实时预览 → 批量下载，覆盖 Ozon 商品主图水印需求"
        />
        <div className="watermark-flow">
          {["选择模板", "上传图片", "预览下载"].map((step, index) => (
            <React.Fragment key={step}>
              <span className="watermark-flow-step">
                <em>{index + 1}</em>
                {step}
              </span>
              {index < 2 ? <i>›</i> : null}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="watermark-stack">
        <Card
          className="panel-card watermark-template-card"
          title={<span className="source-card-title-accent">水印/边框模板 <Tag>{templates.length}</Tag></span>}
          extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreateTemplate}>新建模板</Button>}
        >
          {templates.length ? (
            <div className="watermark-template-list">
              {templates.map((template) => (
                <button
                  type="button"
                  className={String(template.id) === String(selectedTemplateId) ? "active" : ""}
                  key={template.id}
                  onClick={() => setSelectedTemplateId(String(template.id))}
                >
                  <strong>{template.name}</strong>
                  <span>{watermarkTypeLabel(template.type)} · {template.position === "tile" ? "平铺" : "单点"}</span>
                  {template.isDefault ? <Tag color="blue">默认</Tag> : null}
                  <Space size={2} className="watermark-template-actions">
                    <Tooltip title="编辑">
                      <Button type="text" size="small" icon={<EditOutlined />} onClick={(event) => {
                        event.stopPropagation();
                        openEditTemplate(template);
                      }} />
                    </Tooltip>
                    <Tooltip title="删除">
                      <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={(event) => {
                        event.stopPropagation();
                        deleteTemplate(template);
                      }} />
                    </Tooltip>
                  </Space>
                </button>
              ))}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无水印/边框模板，立即创建第一个" />
          )}
        </Card>
        <Card
          className="panel-card watermark-preview-card"
          title={<span className="source-card-title-accent purple">预览与下载 <small>{selectedTemplate ? selectedTemplate.name : "请先选用模板"}</small></span>}
        >
          <div className="watermark-preview-layout">
            <div className="watermark-upload-column">
              <Upload.Dragger
                className="upload-drop"
                multiple
                accept="image/png,image/jpeg"
                showUploadList={false}
                beforeUpload={(file) => {
                  addUploadFile(file);
                  return false;
                }}
              >
                <CloudUploadOutlined />
                <strong>点击或拖拽上传图片</strong>
                <span>支持单张或批量，PNG / JPG</span>
              </Upload.Dragger>
              <Space direction="vertical" className="block-actions">
                <Button type="primary" size="large" block disabled={!canDownload} onClick={() => downloadOne(uploadedImages[0], 0)}>下载当前</Button>
                <Button
                  block
                  disabled={!canDownload}
                  onClick={async () => {
                    for (let index = 0; index < uploadedImages.length; index += 1) {
                      await downloadOne(uploadedImages[index], index);
                    }
                  }}
                >
                  批量下载（{uploadedImages.length}）
                </Button>
              </Space>
              <Alert
                type={selectedTemplate ? "success" : "info"}
                showIcon
                message={selectedTemplate ? `已选用：${selectedTemplate.name}` : "先选择一个水印/边框模板"}
                description={selectedTemplate ? "上传图片后可在右侧预览并下载到本地" : "在上方模板列表中点击卡片即可选用"}
              />
            </div>
            <div className={previewImage ? "watermark-preview-canvas has-image" : "watermark-preview-canvas"}>
              {previewImage ? (
                <div className="watermark-image-frame">
                  <img src={previewImage.url} alt={previewImage.name} />
                  {selectedTemplate?.type === "border" ? <span className="watermark-border-preview" /> : null}
                  {selectedTemplate?.type !== "border" && selectedTemplate ? (
                    <span
                      className={`watermark-text-preview position-${selectedTemplate.position || "center"}`}
                      style={{
                        color: hexToRgba(selectedTemplate.color, selectedTemplate.opacity),
                        fontSize: `${Math.max(12, Math.min(44, Number(selectedTemplate.fontSize) || 28))}px`,
                        fontFamily: watermarkFontFamily(selectedTemplate.font),
                        transform: `rotate(${Number(selectedTemplate.rotate) || 0}deg)`,
                      }}
                    >
                      {selectedTemplate.text || selectedTemplate.name}
                    </span>
                  ) : null}
                </div>
              ) : (
                <PictureOutlined />
              )}
            </div>
          </div>
        </Card>
      </div>
      <Modal
        title="创建水印/边框模板"
        open={templateOpen}
        className="watermark-editor-modal"
        wrapClassName="watermark-editor-modal-wrap"
        onCancel={closeTemplateModal}
        confirmLoading={saving}
        footer={[
          <Button key="reset" onClick={() => templateForm.setFieldsValue(defaultWatermarkValues)}>恢复默认</Button>,
          <Button key="cancel" onClick={closeTemplateModal}>取 消</Button>,
          <Button key="create" type="primary" loading={saving} onClick={saveTemplate}>创 建</Button>,
        ]}
        destroyOnHidden
        transitionName=""
        maskTransitionName=""
      >
        <Form form={templateForm} layout="vertical" className="watermark-template-form">
          <Form.Item label="模板名称" name="name" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input placeholder="例如：店铺主水印" />
          </Form.Item>
          <Form.Item label="水印类型" name="type">
            <Select options={watermarkTypeOptions} />
          </Form.Item>
          <Form.Item label="文字内容" name="text">
            <Input placeholder="例如：OZON STORE" />
          </Form.Item>
          <Form.Item label="字体" name="font">
            <Select options={watermarkFontOptions} />
          </Form.Item>
          <Form.Item label="字体大小" name="fontSize">
            <Input type="number" min={8} max={120} />
          </Form.Item>
          <Form.Item label="字体颜色" name="color">
            <Input />
          </Form.Item>
          <Form.Item label="不透明度" name="opacity">
            <Input type="number" min={0} max={100} />
          </Form.Item>
          <Form.Item label="旋转角度（度）" name="rotate">
            <Input type="number" min={-180} max={180} />
          </Form.Item>
          <Form.Item label="边距（占短边 %）" name="margin">
            <Input type="number" min={0} max={50} />
          </Form.Item>
          <Form.Item label="水印位置" name="position">
            <Select options={watermarkPositionOptions} />
          </Form.Item>
        </Form>
      </Modal>
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
          <Tooltip title="应用">
            <Button type="text" size="small" icon={<CheckOutlined />} onClick={() => applyTemplate(record)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditTemplate(record)} />
          </Tooltip>
          <Tooltip title="删除">
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

function StoresSettingsPage({ hasStore, binding, localData, onBind, onSync, onClear, onSwitchStore, onRefresh }) {
  const { message } = AntApp.useApp();
  const [showDisabledStores, setShowDisabledStores] = useState(false);
  const [refreshingStores, setRefreshingStores] = useState(false);
  const [syncingWarehouses, setSyncingWarehouses] = useState(false);
  const stores = localData?.stores || [];
  const warehouses = localData?.caches?.warehouses || [];
  const summary = localData?.summary || emptyLocalData.summary;
  const lastWarehouseSync = warehouses
    .map((item) => item.syncedAt || item.updatedAt || item.updated_at || item.createdAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const activeStoreId = binding?.id || stores[0]?.id;
  const visibleStores = showDisabledStores
    ? stores
    : stores.filter((store) => !["disabled", "stopped", "inactive"].includes(String(store.status || "").toLowerCase()));
  const storeRows = visibleStores.map((store) => {
    const isActive = String(store.id || "") === String(activeStoreId || "");
    const statusLabel = store.status
      ? (["disabled", "stopped", "inactive"].includes(String(store.status).toLowerCase()) ? "已停用" : "已启用")
      : "已保存";
    return {
      id: store.id,
      "标签": store.label || store.companyName || "—",
      "公司": store.companyName || store.shopName || store.name || store.legalName || store.label || "—",
      "INN": store.inn || store.taxId || "—",
      "货币": store.currency || store.currencyCode || "—",
      "Premium": store.isPremium === true ? "已开通" : "未开通",
      "状态": statusLabel,
      "本地仓库": isActive ? warehouses.length : "—",
      "最后同步": isActive && (summary.lastSyncAt || lastWarehouseSync)
        ? new Date(summary.lastSyncAt || lastWarehouseSync).toLocaleString()
        : "—",
      "操作": isActive ? "当前门店" : "已保存",
      isActive,
      rawStore: store,
    };
  });

  const refreshStores = async () => {
    setRefreshingStores(true);
    try {
      const profileResult = await apiRequest("/local/stores/refresh-profile", { method: "POST", body: {} });
      const state = await onRefresh?.({ silent: false });
      const storeCount = state?.stores?.length ?? profileResult?.state?.stores?.length ?? stores.length;
      const warehouseCount = state?.caches?.warehouses?.length ?? warehouses.length;
      const failedCount = Number(profileResult?.errors?.length) || 0;
      message.success(`已刷新 · 门店 ${storeCount} · 仓库 ${warehouseCount}${failedCount ? ` · ${failedCount} 个资料未更新` : ""}`);
    } catch (error) {
      message.error(`刷新失败: ${error.message}`);
    } finally {
      setRefreshingStores(false);
    }
  };

  const syncWarehouses = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      onBind?.();
      return;
    }
    if (syncingWarehouses) return;
    setSyncingWarehouses(true);
    try {
      const storeId = binding?.id || activeStoreId;
      const response = await apiRequest("/local/sync/WAREHOUSES", { method: "POST", body: { storeId } });
      await onRefresh?.();
      const fetched = Number(response?.job?.fetchedCount ?? response?.fetchedCount) || 0;
      message.success(`仓库已同步 · ${fetched} 条`);
    } catch (error) {
      message.error(`同步失败: ${error.message}`);
    } finally {
      setSyncingWarehouses(false);
    }
  };

  const syncAllStores = async () => {
    if (!hasStore) {
      message.warning("请先绑定门店");
      onBind?.();
      return;
    }
    await onSync?.();
  };

  const deleteStore = (record) => {
    const store = record?.rawStore || record || {};
    const storeId = store.id || record?.id;
    const storeName = store.label || store.companyName || record?.["公司"] || "该门店";
    if (!storeId) {
      message.warning("门店不存在");
      return;
    }
    Modal.confirm({
      title: "删除门店",
      content: `仅删除本地保存的「${storeName}」绑定信息，不会删除 Ozon 后台店铺。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const response = await apiRequest(`/local/stores/${encodeURIComponent(storeId)}`, { method: "DELETE" });
          const state = await onRefresh?.({ silent: true }) || response?.state || {};
          const nextStoreId = state?.currentStoreId || "";
          if (nextStoreId) {
            localStorage.setItem("currentOzonStoreId", nextStoreId);
            const token = localStorage.getItem("token");
            await syncAuthToExtension({ token, storeId: nextStoreId });
          } else {
            clearLocalAuthStorage();
            await logoutExtension();
          }
          message.success("门店已删除");
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };

  return (
    <div className="source-page hidden-route-page stores-settings-page">
      <Card className="panel-card source-card stores-settings-card">
        <div className="card-title-row stores-title-row">
          <span>我的 Ozon 门店 <em>{storeRows.length}/999</em></span>
          <Space wrap>
            <Button loading={syncingWarehouses} onClick={syncWarehouses}>同步仓库</Button>
            <Button loading={refreshingStores} onClick={refreshStores}>刷 新</Button>
            <Button type="primary" onClick={onBind}>新增</Button>
          </Space>
        </div>
        <div className="stores-control-row">
          <Checkbox checked={showDisabledStores} onChange={(event) => setShowDisabledStores(event.target.checked)}>显示已停用店铺</Checkbox>
          <Button onClick={() => {
            setShowDisabledStores(false);
            message.success("已重置");
          }}>
            重 置
          </Button>
        </div>
        <div className="store-current-line">
          <span>当前选择门店： {binding?.storeName || binding?.id || "—"}</span>
          <em>商品 {summary.products || 0} · 订单 {summary.postingsTotal || summary.postings || 0} · 仓库 {warehouses.length}</em>
          <Space>
            <Button danger disabled={!hasStore} onClick={onClear}>清除当前门店</Button>
            <Button onClick={syncAllStores}>同步本帐号所有门店</Button>
          </Space>
        </div>
        <SourceTable
          hasStore={hasStore}
          rows={storeRows}
          rowSelection={false}
          loading={refreshingStores || syncingWarehouses}
          columns={[
            "标签",
            "公司",
            {
              title: (
                <Tooltip title="INN 是俄罗斯纳税人识别号，相当于公司税号。">
                  <span>INN</span>
                </Tooltip>
              ),
              dataIndex: "INN",
              key: "INN",
              width: 110,
              render: (value) => <span className="source-table-cell-text" title={value || "—"}>{value || "—"}</span>,
            },
            "货币",
            "Premium",
            {
              title: "状态",
              dataIndex: "状态",
              width: 96,
              render: (value, record) => <Tag color={record.isActive ? "blue" : "default"}>{record.isActive ? "当前门店" : value}</Tag>,
            },
            "本地仓库",
            "最后同步",
            {
              title: "操作",
              dataIndex: "操作",
              width: 150,
              render: (value, record) => (
                <Space size={6}>
                  {record.isActive ? null : <Button size="small" onClick={() => onSwitchStore?.(record.rawStore?.id || record.id)}>切换</Button>}
                  <Button danger size="small" onClick={() => deleteStore(record)}>删除</Button>
                </Space>
              ),
            },
          ]}
          empty="暂无数据"
          sourceEmpty
          scrollX={980}
        />
      </Card>
    </div>
  );
}

function DataScreenPage({ navigate, localData, hasStore }) {
  const [range, setRange] = useState("30天");
  const summary = localData?.summary || emptyLocalData.summary;
  const postings = localData?.caches?.postings || [];
  const screenModel = dataScreenModel(postings, range);
  const statusCounts = summary.statusCounts || {};
  const totalPostings = summary.postingsTotal || summary.postings || 0;
  const hasOrderData = totalPostings > 0;
  const selectedRangeDays = Number.parseInt(range, 10) || 30;
  const rangePostings = screenModel.days.reduce((sum, day) => sum + day.count, 0);
  const rangeAmount = screenModel.days.reduce((sum, day) => sum + day.amount, 0);
  const chartLabels = screenModel.days
    .filter((_, index) => index % Math.max(1, Math.floor(screenModel.days.length / 8)) === 0 || index === screenModel.days.length - 1)
    .slice(0, 9);
  const statusLabelMap = {
    awaiting_packaging: "等待备货",
    awaiting_deliver: "等待发运",
    delivering: "运输中",
    delivered: "已签收",
    cancelled: "已取消",
    arbitration: "有争议",
    dispute: "有争议",
  };
  const datascreenStatus = [
    ["待备货", summary.awaitingPackaging || statusCounts.awaiting_packaging || 0],
    ["待发运", summary.awaitingDeliver || statusCounts.awaiting_deliver || 0],
    ["运输中", statusCounts.delivering || 0],
    ["有争议", statusCounts.arbitration || statusCounts.dispute || 0],
    ["已取消", statusCounts.cancelled || 0],
  ];
  const now = new Date();
  const timeText = now.toLocaleTimeString("zh-CN", { hour12: false });
  const dateParts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(now);
  const dateMap = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const dateText = `${dateMap.year}-${dateMap.month}-${dateMap.day} ${dateMap.weekday?.replace("星期", "星期") || ""}`;
  const metrics = [
    ["今日订单", String(summary.todayPostings || 0), "— 持平", "", "cyan"],
    ["今日销售额", dashboardMoney(summary.todayGmv), "— 持平", "", "blue"],
    ["今日预估利润", "¥—", "需成本数据", "", "green"],
    ["近 7 天订单", String(summary.weekPostings || 0), "— 持平", "vs 前 7 天", "indigo"],
    ["近 30 天销售额", dashboardMoney(summary.totalGmv), `${totalPostings} 单`, "", "amber"],
    ["近 30 天退货率", "0.0%", "— 持平", "退货 0 单", "rose"],
  ];
  return (
    <div className="datascreen-page">
      <div className="datascreen-shell">
        <div className="datascreen-head">
          <div className="datascreen-brandline">
            <img src="/icons/icon48.png" alt="QH" />
            <div>
              <h2>QH · 订单数据中心</h2>
              <p>ORDER COMMAND CENTER · 全部店铺 · 数据每 60s 自动刷新</p>
            </div>
          </div>
          <div className="datascreen-head-right">
            <Space wrap>
              <Segmented
                options={["7天", "15天", "30天"]}
                value={range}
                onChange={setRange}
              />
              <Button
                ghost
                onClick={() => document.documentElement.requestFullscreen?.()}
              >
                全屏
              </Button>
              <Button ghost onClick={() => navigate?.("/ozon/postings/list")}>
                返回订单
              </Button>
            </Space>
            <div className="datascreen-time">
              <strong>{timeText}</strong>
              <span>{dateText}</span>
            </div>
          </div>
        </div>
        <div className="datascreen-metrics">
          {metrics.map(([label, value, note, subnote, tone]) => (
            <div className={`metric-tone-${tone}`} key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
              <em>{note}</em>
              {subnote ? <em>{subnote}</em> : null}
            </div>
          ))}
        </div>
        <div className="datascreen-main">
          <section className="screen-panel status-panel">
            <div className="screen-panel-head">
              <span>订单状态分布</span>
              <strong>{rangePostings}</strong>
            </div>
            <p>近 {selectedRangeDays} 天订单</p>
            {hasOrderData ? (
              <div className="status-panel-body">
                <div className="screen-status-orbit">
                  <strong>{rangePostings}</strong>
                  <span>近 {selectedRangeDays} 天订单</span>
                </div>
                <div className="screen-status-list">
                  {screenModel.statusRows.map((row) => (
                    <div key={row.label}>
                      <span>{statusLabelMap[row.label] || row.label}</span>
                      <strong>{row.value}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="screen-status-orbit empty">
                <strong>0</strong>
                <span>近 {selectedRangeDays} 天订单</span>
                <em>暂无数据</em>
              </div>
            )}
          </section>
          <section className="screen-panel rank-panel">
            <div className="screen-panel-head">
              <span>店铺战力榜 · 今日</span>
              <strong>{summary.todayPostings || 0} 单</strong>
            </div>
            {summary.todayPostings ? (
              <div className="screen-rank-card">
                <span>当前店铺</span>
                <strong>{dashboardMoney(summary.todayGmv)}</strong>
                <em>{summary.todayPostings} 单</em>
              </div>
            ) : (
              <>
                <p>今日暂无订单</p>
                <div className="screen-empty-line" />
              </>
            )}
          </section>
          <section className="screen-panel trend-panel">
            <div className="screen-panel-head">
              <span>订单量 × 销售额趋势 · 近 {selectedRangeDays} 天</span>
              <em>区间销售额 {dashboardMoney(rangeAmount)} · 利润 ¥—</em>
            </div>
            <div className="screen-chart">
              <div className="chart-axis">
                <span>{Math.ceil(screenModel.maxCount)}</span>
                <span>{Math.ceil(screenModel.maxCount / 2)}</span>
                <span>{dashboardMoney(screenModel.maxAmount)}</span>
                <span>{dashboardMoney(screenModel.maxAmount / 2)}</span>
              </div>
              <div className="chart-legend-axis">
                <span>单量</span>
                <span>销售额¥</span>
              </div>
              <div
                className="datascreen-trend-bars"
                style={{ gridTemplateColumns: `repeat(${screenModel.days.length}, minmax(3px, 1fr))` }}
              >
                {screenModel.days.map((day) => (
                  <div className="trend-day" key={day.key} title={`${day.label} · ${day.count} 单 · ${dashboardMoney(day.amount)}`}>
                    <span
                      className="trend-amount"
                      style={{ height: `${Math.max(3, (day.amount / screenModel.maxAmount) * 100)}%` }}
                    />
                    <span
                      className="trend-count"
                      style={{ height: `${Math.max(3, (day.count / screenModel.maxCount) * 100)}%` }}
                    />
                  </div>
                ))}
              </div>
              <div
                className="chart-grid-lines"
                style={{ gridTemplateColumns: `repeat(${chartLabels.length}, minmax(0, 1fr))` }}
              >
                {chartLabels.map((day) => (
                  <span key={day.key}>{day.label}</span>
                ))}
              </div>
              <p>{hasOrderData ? `已同步 ${totalPostings} 单 · 趋势来自本地只读缓存` : "暂无订单数据 — 请先在「订单」页同步"}</p>
            </div>
          </section>
          <section className="screen-panel hours-panel">
            <div className="screen-panel-head">
              <span>今日时段分布</span>
            </div>
            <div className="screen-hours">
              {screenModel.hourBuckets.map((hour) => (
                <span
                  key={hour.label}
                  style={{
                    backgroundSize: `100% ${Math.max(0, (hour.count / screenModel.maxHour) * 100)}%`,
                  }}
                >
                  <b>{hour.count}</b>
                  {hour.label}
                </span>
              ))}
            </div>
          </section>
          <section className="screen-panel channel-panel">
            <div className="screen-panel-head">
              <span>配送渠道 TOP</span>
            </div>
            {hasOrderData ? (
              <div className="screen-top-list">
                {screenModel.channelRows.map((row, index) => (
                  <div key={row.label}>
                    <span>{index + 1}. {row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p>暂无数据</p>
            )}
          </section>
          <section className="screen-panel flow-panel">
            <div className="screen-panel-head">
              <span>实时订单流</span>
              <Tag color="blue">LIVE</Tag>
            </div>
            {hasOrderData ? (
              <div className="screen-order-flow">
                {screenModel.latestOrders.map((order) => (
                  <div key={order.id}>
                    <span>{order.id}</span>
                    <em>{statusLabelMap[order.status] || order.status}</em>
                    <strong>{dashboardMoney(order.amount)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p>暂无订单 — 等待同步</p>
            )}
          </section>
          <section className="screen-panel hot-panel">
            <div className="screen-panel-head">
              <span>今日热销 TOP</span>
            </div>
            {screenModel.hotProducts.length ? (
              <div className="screen-top-list">
                {screenModel.hotProducts.map((row, index) => (
                  <div key={row.label}>
                    <span>{index + 1}. {row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p>今日暂无成交商品</p>
            )}
          </section>
        </div>
        <div className="datascreen-bottom">
          <div className="datascreen-status-strip">
            {datascreenStatus.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <footer className="datascreen-footer">
            数据来源:本地同步缓存(状态为近 30 天口径) · RUB 按 ≈0.084 折算 CNY · {hasStore ? "已绑定店铺" : "等待绑定店铺"}
          </footer>
        </div>
      </div>
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
        <img src="/icons/icon128.png" alt="QH" />
        <div>
          <h2>QH 浏览器插件</h2>
          <p>版本 0.13.46.1</p>
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
            ? "采集箱上架会通过本地插件实时采集 Ozon 源商品属性并提交到当前绑定店铺。"
            : partial
              ? `${pingState.error}。当前可用源插件 prefetch 采集 SKU 并交给本地后端预检/提交；重载本项目 extension 目录后可使用完整 follow-sell 桥。`
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
          ["3", "回到本页重新检测", "状态应显示 已连接 0.13.46.1，然后再做上架预检"],
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
          href="/qh-extension-0.13.46.1.zip"
          download
        >
          <DownloadOutlined />
          <span>插件下载</span>
        </a>
        <Button icon={<EyeOutlined />} href="/plugin/popup.html" target="_blank">
          弹窗预览
        </Button>
      </div>
      <div className="plugin-package-status">
        <CheckOutlined />
        <span>下载包 qh-extension-0.13.46.1.zip 已与本地 extension 目录逐文件校验一致</span>
      </div>
      <div className="plugin-capabilities">
        {[
          ["Ozon 商品采集", "content/ozon-product.js"],
          ["Ozon 搜索采集", "content/ozon-search.js"],
          ["Seller Cookie 同步", "content/ozon-seller-bridge.js"],
          ["1688 商品采集", "content/alibaba-1688.js"],
          ["批量上架页", "batch-upload/index.html"],
          ["后台同步引擎", "background/service-worker.js"],
        ].map(([title, file]) => (
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
