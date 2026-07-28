import React, { useState } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Space,
  Tag,
  Tooltip,
} from "antd";
import { apiRequest, postMessageRequest } from "./client-transport.js";
import SourceTable from "./SourceTable.jsx";
import { displayApiKeyDeadline } from "./store-date.js";
import {
  adaptiveTextColumnWidth,
  renderSourceTextCell,
} from "./table-text.jsx";

export default function StoresSettingsPage({ hasStore, binding, localData, onBind, onSync, onClear, onSwitchStore, onRefresh }) {
  const { message } = AntApp.useApp();
  const [collectionForm] = Form.useForm();
  const [refreshingStores, setRefreshingStores] = useState(false);
  const [syncingWarehouses, setSyncingWarehouses] = useState(false);
  const [collectionModalOpen, setCollectionModalOpen] = useState(false);
  const [savingCollectionStore, setSavingCollectionStore] = useState(false);
  const [detectingCollectionLogin, setDetectingCollectionLogin] = useState(false);
  const stores = localData?.stores || [];
  const dataCollectionStores = localData?.dataCollectionStores || [];
  const currentDataCollectionStoreId = localData?.currentDataCollectionStoreId || localData?.dataCollectionStore?.id || "";
  const currentDataCollectionStore = dataCollectionStores.find((store) =>
    String(store.id || "") === String(currentDataCollectionStoreId || "")
  ) || localData?.dataCollectionStore || null;
  const warehouses = localData?.caches?.warehouses || [];
  const summary = localData?.summary || {};
  const activeStoreId = binding?.id || stores[0]?.id;
  const visibleStores = stores.filter((store) => !["disabled", "stopped", "inactive"].includes(String(store.status || "").toLowerCase()));
  const storeRows = visibleStores.map((store) => {
    const isActive = String(store.id || "") === String(activeStoreId || "");
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
      "本地仓库": isActive ? warehouses.length : "—",
      "API Key 期限": displayApiKeyDeadline(store),
      "操作": isActive ? "当前门店" : "已保存",
      isActive,
      rawStore: store,
    };
  });
  const storeLabelColumnWidth = adaptiveTextColumnWidth(storeRows, "标签", { min: 110, max: 220 });
  const normalizeCollectionCompanyId = (value) => String(value || "").trim().replace(/\D/g, "");
  const dataCollectionRows = dataCollectionStores.map((store) => {
    const isActive = String(store.id || "") === String(currentDataCollectionStoreId || "");
    return {
      id: store.id,
      "店铺名称": store.label || "数据采集店铺",
      "Ozon 登录标识": store.sellerCompanyId || "—",
      "状态": isActive ? "当前采集店铺" : (store.status === "disabled" ? "已停用" : "已保存"),
      isActive,
      rawStore: store,
    };
  });
  const dataCollectionNameColumnWidth = adaptiveTextColumnWidth(dataCollectionRows, "店铺名称", { min: 150, max: 260 });

  const readCollectionLoginState = async () => {
    setDetectingCollectionLogin(true);
    try {
      const response = await postMessageRequest(
        { __jzcExt: 1, action: "getOzonSellerLoginState" },
        "__jzcExtResp",
        3000,
      );
      const sellerCompanyIds = [
        response?.data?.sellerCompanyId,
        response?.sellerCompanyId,
        ...(Array.isArray(response?.data?.sellerCompanyIds) ? response.data.sellerCompanyIds : []),
        ...(Array.isArray(response?.sellerCompanyIds) ? response.sellerCompanyIds : []),
      ].map(normalizeCollectionCompanyId).filter(Boolean);
      const currentSellerCompanyId = normalizeCollectionCompanyId(currentDataCollectionStore?.sellerCompanyId);
      const sellerCompanyId = currentSellerCompanyId && sellerCompanyIds.includes(currentSellerCompanyId)
        ? currentSellerCompanyId
        : sellerCompanyIds[0];
      if (!sellerCompanyId) throw new Error("未读取到 Ozon 登录店铺标识");
      const matched = dataCollectionStores.find((store) =>
        normalizeCollectionCompanyId(store.sellerCompanyId) === sellerCompanyId
      );
      collectionForm.setFieldsValue({
        sellerCompanyId,
        label: matched?.label || collectionForm.getFieldValue("label") || `采集店铺 ${sellerCompanyId}`,
      });
      message.success("已读取当前 Ozon 登录态");
    } catch (error) {
      message.error(`读取失败: ${error.message}`);
    } finally {
      setDetectingCollectionLogin(false);
    }
  };

  const openCollectionStoreModal = () => {
    collectionForm.resetFields();
    setCollectionModalOpen(true);
  };

  const saveCollectionStore = async () => {
    const values = await collectionForm.validateFields();
    const sellerCompanyId = normalizeCollectionCompanyId(values.sellerCompanyId);
    if (!sellerCompanyId) {
      message.warning("请填写 Ozon 登录店铺标识");
      return;
    }
    setSavingCollectionStore(true);
    try {
      const response = await apiRequest("/local/data-collection-stores", {
        method: "POST",
        body: {
          label: values.label,
          sellerCompanyId,
          note: values.note,
        },
      });
      await onRefresh?.({ silent: true }) || response?.state;
      setCollectionModalOpen(false);
      message.success("数据采集店铺已保存");
    } catch (error) {
      message.error(`保存失败: ${error.message}`);
    } finally {
      setSavingCollectionStore(false);
    }
  };

  const switchCollectionStore = async (storeId) => {
    try {
      const response = await apiRequest("/local/current-data-collection-store", {
        method: "POST",
        body: { storeId },
      });
      await onRefresh?.({ silent: true }) || response?.state;
      message.success("当前数据采集店铺已切换");
    } catch (error) {
      message.error(`切换失败: ${error.message}`);
    }
  };

  const deleteCollectionStore = (record) => {
    const store = record?.rawStore || record || {};
    if (!store.id) {
      message.warning("数据采集店铺不存在");
      return;
    }
    Modal.confirm({
      title: "删除数据采集店铺",
      content: `确认删除「${store.label || "数据采集店铺"}」？删除后插件采集将不能使用该登录态校验。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const response = await apiRequest(`/local/data-collection-stores/${encodeURIComponent(store.id)}`, { method: "DELETE" });
          await onRefresh?.({ silent: true }) || response?.state;
          message.success("数据采集店铺已删除");
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };

  const openSellerPortal = async () => {
    try {
      await postMessageRequest(
        { __jzcExt: 1, action: "openSellerPortal" },
        "__jzcExtResp",
        1500,
      );
      message.success("已打开 Ozon 卖家中心");
    } catch (error) {
      message.error(`打开失败: ${error.message}`);
    }
  };

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
            clearStoreStorage();
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
          <span>经营店铺 <em>{storeRows.length}/999</em></span>
          <Space wrap>
            <Button loading={syncingWarehouses} onClick={syncWarehouses}>同步仓库</Button>
            <Button loading={refreshingStores} onClick={refreshStores}>刷 新</Button>
            <Button type="primary" onClick={onBind}>新增</Button>
          </Space>
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
                  {record.isActive ? null : <Button size="small" onClick={() => onSwitchStore?.(record.rawStore?.id || record.id)}>切换</Button>}
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
      <Card className="panel-card source-card data-collection-store-card">
        <div className="card-title-row stores-title-row">
          <span>数据采集店铺 <em>{dataCollectionRows.length}/20</em></span>
          <Space wrap>
            <Button onClick={openSellerPortal}>打开 Ozon 卖家中心</Button>
            <Button type="primary" onClick={openCollectionStoreModal}>新增</Button>
          </Space>
        </div>
        <Alert
          showIcon
          type={currentDataCollectionStore ? "success" : "warning"}
          message={currentDataCollectionStore
            ? `当前数据采集店铺：${currentDataCollectionStore.label || currentDataCollectionStore.sellerCompanyId}`
            : "请先新增并选择数据采集店铺"}
          description="插件采集前会校验 seller.ozon.ru 当前登录店铺；只要该店铺已绑定在当前 sonli 账号下，就会自动切换为当前数据采集店铺并写入采集箱，未绑定时拒绝采集。"
        />
        <SourceTable
          hasStore
          rows={dataCollectionRows}
          rowSelection={false}
          columns={[
            {
              title: "店铺名称",
              dataIndex: "店铺名称",
              width: dataCollectionNameColumnWidth,
              render: renderSourceTextCell,
            },
            "Ozon 登录标识",
            {
              title: "状态",
              dataIndex: "状态",
              width: 120,
              render: (value, record) => <Tag color={record.isActive ? "blue" : "default"}>{value}</Tag>,
            },
            {
              title: "操作",
              dataIndex: "操作",
              width: 150,
              render: (_, record) => (
                <Space size={6}>
                  {record.isActive ? null : <Button size="small" onClick={() => switchCollectionStore(record.id)}>设为当前</Button>}
                  <Button danger size="small" onClick={() => deleteCollectionStore(record)}>删除</Button>
                </Space>
              ),
            },
          ]}
          empty="暂无数据采集店铺"
          sourceEmpty
          scrollX={760}
        />
      </Card>
      <Modal
        rootClassName="prototype-overlay"
        title="新增数据采集店铺"
        open={collectionModalOpen}
        onCancel={() => setCollectionModalOpen(false)}
        onOk={saveCollectionStore}
        okText="保存"
        confirmLoading={savingCollectionStore}
        cancelText="取消"
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space>
            <Button loading={detectingCollectionLogin} onClick={readCollectionLoginState}>读取当前 Ozon 登录态</Button>
            <CancelBtn />
            <OkBtn />
          </Space>
        )}
      >
        <Form form={collectionForm} layout="vertical">
          <Form.Item
            label="店铺名称"
            name="label"
            rules={[{ required: true, message: "请输入店铺名称" }]}
          >
            <Input placeholder="例如 采集店铺 01" maxLength={120} />
          </Form.Item>
          <Form.Item
            label="Client ID"
            name="sellerCompanyId"
            extra="点击“读取当前 Ozon 登录态”可自动读取 seller.ozon.ru 当前登录店铺标识。"
            rules={[{ required: true, message: "请输入 Client ID" }]}
          >
            <Input placeholder="sc_company_id" maxLength={80} />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input.TextArea placeholder="可选" maxLength={240} rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
