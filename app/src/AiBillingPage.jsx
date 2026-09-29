import React from "react";
import { Alert } from "antd";
import AiBillingPanel from "./AiBillingPanel.jsx";

export default function AiBillingPage({ account }) {
  if (account?.role !== "admin") return <Alert type="error" title="仅管理员可查看费用账单" />;
  return <div className="source-page">
    <div className="ai-listing-page-head"><div><span className="workspace-eyebrow">OZON SELLER WORKSPACE</span>
      <h1>费用账单</h1><p>查看账户余额、收费记录与生图成本。</p></div></div>
    <AiBillingPanel />
  </div>;
}
