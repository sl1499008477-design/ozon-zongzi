import React, { useEffect, useState } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { apiRequest } from "./client-transport.js";

const accountDateText = (value) => {
  if (!value) return "长期有效";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const accountLastLoginText = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const toDatetimeLocalValue = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const fromDatetimeLocalValue = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

export default function AccountSettingsPage({ account, accounts = [], onRefresh }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState(accounts || []);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    setRows(accounts || []);
  }, [accounts]);

  const reloadAccounts = async () => {
    setLoading(true);
    try {
      const response = await apiRequest("/local/accounts");
      setRows(response.accounts || []);
      await onRefresh?.({ silent: true });
    } catch (error) {
      message.error(`加载失败: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingAccount(null);
    form.resetFields();
    form.setFieldsValue({ role: "user", status: "active", expiresAt: "" });
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditingAccount(record);
    form.resetFields();
    form.setFieldsValue({
      username: record.username,
      displayName: record.displayName,
      role: record.role || "user",
      status: record.status || "active",
      expiresAt: toDatetimeLocalValue(record.expiresAt),
      password: "",
    });
    setModalOpen(true);
  };

  const saveAccount = async (values) => {
    setSaving(true);
    try {
      const body = {
        username: String(values.username || "").trim(),
        displayName: String(values.displayName || "").trim(),
        role: values.role || "user",
        status: values.status || "active",
        expiresAt: fromDatetimeLocalValue(values.expiresAt),
        password: values.password || "",
      };
      if (!body.password) delete body.password;
      const response = editingAccount
        ? await apiRequest(`/local/accounts/${encodeURIComponent(editingAccount.id)}`, { method: "PATCH", body })
        : await apiRequest("/local/accounts", { method: "POST", body });
      setRows(response.accounts || []);
      setModalOpen(false);
      await onRefresh?.({ silent: true });
      message.success(editingAccount ? "账号已更新" : "账号已新增");
    } catch (error) {
      message.error(`保存失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteAccount = (record) => {
    Modal.confirm({
      title: "删除账号",
      content: `确认删除「${record.displayName || record.username}」？删除后该账号无法继续登录。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const response = await apiRequest(`/local/accounts/${encodeURIComponent(record.id)}`, { method: "DELETE" });
          setRows(response.accounts || []);
          await onRefresh?.({ silent: true });
          message.success("账号已删除");
        } catch (error) {
          message.error(`删除失败: ${error.message}`);
        }
      },
    });
  };

  if (account?.role !== "admin") {
    return (
      <div className="source-page hidden-route-page">
        <Card className="panel-card source-card">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="仅管理员可管理账号" />
        </Card>
      </div>
    );
  }

  return (
    <div className="source-page hidden-route-page account-settings-page">
      <Card className="panel-card source-card">
        <div className="card-title-row">
          <span>账号管理 <em>{rows.length}/999</em></span>
          <Space wrap>
            <Button onClick={reloadAccounts} loading={loading}>刷 新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增账号</Button>
          </Space>
        </div>
        <Table
          rowKey="id"
          className="source-table account-table"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 920 }}
          tableLayout="fixed"
          columns={[
            {
              title: "账号",
              dataIndex: "username",
              width: 150,
              render: (value, record) => (
                <div className="account-name-cell">
                  <strong>{value}</strong>
                  <span>{record.id === account?.id ? "当前登录账号" : "管理员分配账号"}</span>
                </div>
              ),
            },
            { title: "昵称", dataIndex: "displayName", width: 150 },
            {
              title: "角色",
              dataIndex: "role",
              width: 100,
              render: (value) => <Tag color={value === "admin" ? "blue" : "default"}>{value === "admin" ? "管理员" : "普通账号"}</Tag>,
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 110,
              render: (value, record) => {
                const expired = record.expired;
                if (expired) return <Tag color="red">已过期</Tag>;
                return <Tag color={value === "disabled" ? "default" : "green"}>{value === "disabled" ? "已停用" : "可登录"}</Tag>;
              },
            },
            {
              title: "登录期限",
              dataIndex: "expiresAt",
              width: 180,
              render: accountDateText,
            },
            {
              title: "最后登录",
              dataIndex: "lastLoginAt",
              width: 180,
              render: accountLastLoginText,
            },
            {
              title: "操作",
              width: 150,
              fixed: "right",
              render: (_, record) => (
                <Space size={6}>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
                  <Button
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    disabled={record.id === account?.id}
                    onClick={() => deleteAccount(record)}
                  >
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账号" /> }}
        />
      </Card>

      <Modal
        rootClassName="prototype-overlay"
        title={editingAccount ? "编辑账号" : "新增账号"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText={editingAccount ? "保存" : "新增"}
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={saveAccount} requiredMark={false}>
          <Form.Item
            label="账号"
            name="username"
            rules={[{ required: !editingAccount, message: "请输入账号" }]}
          >
            <Input disabled={Boolean(editingAccount)} placeholder="例如 user01" autoComplete="off" />
          </Form.Item>
          <Form.Item label="昵称" name="displayName">
            <Input placeholder="展示名称" maxLength={40} />
          </Form.Item>
          <Form.Item
            label={editingAccount ? "新密码" : "初始密码"}
            name="password"
            rules={[{ required: !editingAccount, message: "请输入初始密码" }]}
          >
            <Input.Password placeholder={editingAccount ? "留空则不修改" : "请输入初始密码"} autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="角色" name="role">
            <Select
              options={[
                { value: "user", label: "普通账号" },
                { value: "admin", label: "管理员" },
              ]}
            />
          </Form.Item>
          <Form.Item label="状态" name="status">
            <Select
              options={[
                { value: "active", label: "可登录" },
                { value: "disabled", label: "停用" },
              ]}
            />
          </Form.Item>
          <Form.Item label="登录期限" name="expiresAt">
            <Input type="datetime-local" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="不设置登录期限表示长期有效；超过期限后该账号不能再登录后台或插件。"
          />
        </Form>
      </Modal>
    </div>
  );
}
