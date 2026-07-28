import React from "react";
import {
  Card,
  Empty,
  Space,
  Table,
} from "antd";

export function SourceMetricStrip({ items, className = "" }) {
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

export function SourceSectionTitle({ title, subtitle, actions }) {
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

const emptyText = (hasStore, text = "暂无数据") =>
  hasStore ? text : "绑定门店后显示真实数据";

export default function SourceTable({
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
