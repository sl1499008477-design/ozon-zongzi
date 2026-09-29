import React, { useState } from "react";
import {
  App as AntApp,
  Button,
  Card,
  Modal,
  Space,
  Tag,
  Tooltip,
} from "antd";
import { apiRequest } from "./client-transport.js";
import { storeSwitchActionState } from "./store-switch-gate.js";
import { operatingStoreSettingsModel } from "./stores-settings-model.js";
import SourceTable, { SourceSectionTitle } from "./SourceTable.jsx";
import { displayApiKeyDeadline } from "./store-date.js";
import {
  adaptiveTextColumnWidth,
  renderSourceTextCell,
} from "./table-text.jsx";

export default function StoresSettingsPage({ hasStore, binding, localData, onBind, onSync, onClear, onSwitchStore, switchingStoreId, onRefresh }) {
  const { message } = AntApp.useApp();
  const [refreshingStores, setRefreshingStores] = useState(false);
  const [syncingWarehouses, setSyncingWarehouses] = useState(false);
  const {
    stores,
    currentStoreId: activeStoreId,
    warehouses,
    warehouseCountsByStoreId,
    currentWarehouseCount,
    summary,
  } = operatingStoreSettingsModel({ localData, binding });
  const visibleStores = stores.filter((store) => !["disabled", "stopped", "inactive"].includes(String(store.status || "").toLowerCase()));
  const storeRows = visibleStores.map((store) => {
    const isActive = String(store.id || "") === String(activeStoreId || "");
    const switchState = storeSwitchActionState({ storeId: store.id, switchingStoreId });
    const statusLabel = store.status
      ? (["disabled", "stopped", "inactive"].includes(String(store.status).toLowerCase()) ? "已停用" : "已启用")
      : "已保存";
    return {
      id: store.id,
      "标签": store.label || store.companyName || "—",
      "公司": store.companyName || store.shopName || store.name || store.legalName || store.label || "—",
      "货币": store.currency || store.currencyCode || "—",
      "Premium": store.isPremium === true ? "已开通" : "未开通",
      "状态": statusLabel,
      "本地仓库": warehouseCountsByStoreId[String(store.id || "")] || 0,
      "API Key 期限": displayApiKeyDeadline(store),
      "操作": isActive ? "当前门店" : "已保存",
      isActive,
      switchState,
      rawStore: store,
    };
  });
  const storeLabelColumnWidth = adaptiveTextColumnWidth(storeRows, "标签", { min: 110, max: 220 });
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
          await apiRequest(`/local/stores/${encodeURIComponent(storeId)}`, { method: "DELETE" });
          await onRefresh?.({ silent: true, source: "store-delete" });
          message.success("门店已删除");
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };

  return (
    <div className="source-page hidden-route-page stores-settings-page">
      <SourceSectionTitle title="店铺配置" subtitle="管理授权店铺、当前门店与仓库同步" />
      <Card className="panel-card source-card stores-settings-card">
        <div className="card-title-row stores-title-row">
          <span>经营店铺 <em>{storeRows.length}/999</em></span>
          <Space wrap>
            <Button loading={syncingWarehouses} onClick={syncWarehouses}>同步仓库</Button>
            <Button loading={refreshingStores} onClick={refreshStores}>刷 新</Button>
            <Button type="primary" onClick={onBind}>新增</Button>
          </Space>
        </div>
        <div className="store-current-line">
          <span>当前选择门店： {binding?.storeName || binding?.id || "—"}</span>
          <em>商品 {summary.products || 0} · 仓库 {currentWarehouseCount}</em>
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
            {
              title: "标签",
              dataIndex: "标签",
              width: storeLabelColumnWidth,
              render: renderSourceTextCell,
            },
            "公司",
            "货币",
            {
              title: "Premium",
              dataIndex: "Premium",
              width: 108,
              render: (value) => <Tag color={value === "已开通" ? "blue" : "default"}>{value}</Tag>,
            },
            {
              title: "状态",
              dataIndex: "状态",
              width: 118,
              render: (value, record) => <Tag color={record.isActive ? "blue" : "default"}>{record.isActive ? "当前门店" : value}</Tag>,
            },
            "本地仓库",
            {
              title: (
                <Tooltip rootClassName="prototype-overlay" title="API Key 有效期按创建日期自动顺延 180 天；未填写创建日期时，默认采用新增店铺当天计算。">
                  <span>API Key 期限</span>
                </Tooltip>
              ),
              dataIndex: "API Key 期限",
              key: "API Key 期限",
              width: 270,
              render: renderSourceTextCell,
            },
            {
              title: "操作",
              dataIndex: "操作",
              width: 190,
              render: (value, record) => (
                <Space size={6}>
                  <Button size="small" onClick={() => onBind?.(record.rawStore || record)}>修改</Button>
                  {record.isActive ? null : (
                    <Button
                      size="small"
                      disabled={record.switchState.disabled}
                      loading={record.switchState.loading}
                      onClick={() => onSwitchStore?.(record.rawStore?.id || record.id)}
                    >
                      {record.switchState.label}
                    </Button>
                  )}
                  <Button danger size="small" onClick={() => deleteStore(record)}>删除</Button>
                </Space>
              ),
            },
          ]}
          empty="暂无数据"
          sourceEmpty
          scrollX={900}
        />
      </Card>
    </div>
  );
}
