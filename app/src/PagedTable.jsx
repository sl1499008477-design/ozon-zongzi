import React, { useState } from 'react';
import { Pagination, Table } from 'antd';
import './paged-table.css';

// Lists share one paging control. Remote lists supply current/pageSize/total;
// settings and editor tables page their already-loaded form data locally.
export default function PagedTable({ pagination, className = '', ...props }) {
  const [local, setLocal] = useState({ current: 1, pageSize: 5 });
  const options = pagination || {};
  const pageSize = options.pageSize ?? local.pageSize;
  const current = options.current ?? Math.min(local.current, Math.max(1, Math.ceil((props.dataSource?.length || 0) / pageSize)));
  const total = options.total ?? props.dataSource?.length ?? 0;
  const paging = {
    ...options,
    current,
    pageSize,
    total,
    hideOnSinglePage: false,
    showSizeChanger: { 'aria-label': '每页显示条数', showSearch: false },
    pageSizeOptions: [5, 10, 20, 50],
    onChange: (next, size) => {
      const nextPage = size === pageSize ? next : 1;
      setLocal({ current: nextPage, pageSize: size });
      options.onChange?.(nextPage, size);
    },
  };
  return <>
    <Table {...props} className={`web-paged-table ${className}`.trim()} pagination={paging} />
    {total === 0 && <div className="web-paged-table empty-table-pager"><Pagination {...paging} /></div>}
  </>;
}
