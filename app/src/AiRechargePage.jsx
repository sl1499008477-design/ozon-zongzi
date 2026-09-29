import React from 'react';
import {Alert} from 'antd';
import AiBillingPanel from './AiBillingPanel.jsx';

export default function AiRechargePage({account}) {
  if(account?.role!=='admin')return <Alert type="error" title="仅管理员可管理充值与定价"/>;
  return <div className="source-page">
    <div className="ai-listing-page-head">
      <div><span className="workspace-eyebrow">OZON SELLER WORKSPACE</span><h1>充值管理</h1><p>管理用户生图单价、充值余额与收费记录。</p></div>
    </div>
    <AiBillingPanel management/>
  </div>;
}
