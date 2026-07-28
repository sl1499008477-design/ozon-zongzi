import React, { useState } from "react";
import {
  Button,
  Card,
  Select,
} from "antd";
import {
  averageMinor,
  dashboardMinorMoney,
  dashboardMoneyGroups,
} from "./dashboard-money.js";
import {
  dayLabel,
  profitDateRange,
  profitTrendModel,
} from "./order-analytics.js";
import SourceTable, {
  SourceMetricStrip,
  SourceSectionTitle,
} from "./SourceTable.jsx";

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

export default function ProfitTrendPage({ binding, hasStore, localData }) {
  const [range, setRange] = useState("30 天");
  const [view, setView] = useState("利润视图");
  const { days, label } = profitDateRange(range);
  const postings = localData?.caches?.postings || [];
  const model = profitTrendModel(postings, range);
  const tableRows = model.rows.map((row) => ({
    ...row,
    "日期": row.key,
    "订单数": `${row.count}`,
    "订单金额": dashboardMoneyGroups(row.amountByCurrency),
    "OZON 佣金": "—",
    "采购成本": "—",
    "利润": "—",
    "毛利率": "—",
    "客单价": row.count && model.moneyComparable
      ? dashboardMinorMoney(
          averageMinor(row.amountByCurrency[model.currencyCode], row.count),
          model.currencyCode,
        )
      : "—",
  }));
  const metricNote = model.totalOrders && model.moneyComparable
    ? `客单价 ${dashboardMinorMoney(averageMinor(model.totalAmountMinor, model.totalOrders), model.currencyCode)}`
    : model.totalOrders
      ? "多币种客单价不合并"
    : "客单价 —";
  const chartUsesOrders = view === "订单量" || !model.moneyComparable;
  const chartMax = chartUsesOrders ? model.maxCount : model.maxAmountMinor;
  return (
    <div className="source-page">
      <SourceSectionTitle
        title="利润趋势"
        subtitle={`${label} · ${binding?.storeName || "当前店铺"} · 按出单日期和币种分别聚合`}
        actions={[
          <ProfitToggleGroup key="range" options={["7 天", "30 天", "90 天", "180 天"]} active={range} onChange={setRange} />,
          <Select key="store" value="all" options={[{ value: "all", label: "全部店铺" }]} />,
        ]}
      />
      <SourceMetricStrip
        className="profit-stat-strip"
        items={[
          ["订单金额", dashboardMoneyGroups(model.totalByCurrency), `本期汇总 · ${metricNote}`],
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
              const value = chartUsesOrders ? row.count : row.amountMinor;
              return (
                <div className="profit-trend-day" key={row.key} title={`${row.key} · ${row.count} 单`}>
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
              model.bestDay
                ? `${model.bestDay.count} 单 · ${dashboardMoneyGroups(model.bestDay.amountByCurrency)}`
                : model.totalOrders && !model.moneyComparable
                  ? "包含多币种，金额不做横向比较"
                  : "本期还没有可分析订单",
            ],
            ["利润压力", "暂无可判断", "", model.totalOrders ? "待录入采购成本后展示利润压力" : "同步订单后展示利润压力"],
            ["采购成本为 0 的出单日", model.totalOrders ? `${model.activeDays} 天待补成本` : "暂无可判断", "", "有出单数据后展示采购成本录入信号"],
            ["费用结构", model.totalAmountMinor ? "订单金额已同步" : "暂无可判断", "", model.totalAmountMinor ? "佣金、采购成本待补充后计算利润" : "本期暂无订单金额"],
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
          rows={model.totalOrders ? tableRows : []}
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
