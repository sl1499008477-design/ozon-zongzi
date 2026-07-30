import React, { useState } from "react";
import {
  Button,
  Segmented,
  Space,
  Tag,
} from "antd";
import {
  dashboardMinorMoney,
  dashboardMoneyGroups,
  dashboardSummaryMoney,
} from "./dashboard-money.js";
import { PRODUCT_BRAND } from "./brand.js";
import { dataScreenModel } from "./order-analytics.js";

const statusLabelMap = {
  awaiting_packaging: "等待备货",
  awaiting_deliver: "等待发运",
  delivering: "运输中",
  delivered: "已签收",
  cancelled: "已取消",
  arbitration: "有争议",
  dispute: "有争议",
};

export default function DataScreenPage({ navigate, localData, hasStore }) {
  const [range, setRange] = useState("30天");
  const summary = localData?.summary || {};
  const postings = localData?.caches?.postings || [];
  const screenModel = dataScreenModel(postings, range);
  const statusCounts = summary.statusCounts || {};
  const totalPostings = summary.postingsTotal || summary.postings || 0;
  const hasOrderData = totalPostings > 0;
  const selectedRangeDays = Number.parseInt(range, 10) || 30;
  const rangePostings = screenModel.days.reduce((sum, day) => sum + day.count, 0);
  const chartLabels = screenModel.days
    .filter((_, index) =>
      index % Math.max(1, Math.floor(screenModel.days.length / 8)) === 0
      || index === screenModel.days.length - 1
    )
    .slice(0, 9);
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
  const dateText = `${dateMap.year}-${dateMap.month}-${dateMap.day} ${dateMap.weekday || ""}`;
  const metrics = [
    ["今日订单", String(summary.todayPostings || 0), "— 持平", "", "cyan"],
    ["今日销售额", dashboardSummaryMoney(summary, "today"), "— 持平", "", "blue"],
    ["今日预估利润", "—", "需成本数据", "", "green"],
    ["近 7 天订单", String(summary.weekPostings || 0), "— 持平", "vs 前 7 天", "indigo"],
    ["近 30 天销售额", dashboardSummaryMoney(summary, "total"), `${totalPostings} 单`, "", "amber"],
    ["近 30 天退货率", "0.0%", "— 持平", "退货 0 单", "rose"],
  ];

  return (
    <div className="datascreen-page prototype-datascreen">
      <div className="datascreen-shell">
        <div className="datascreen-head">
          <div className="datascreen-brandline">
            <img src={PRODUCT_BRAND.logoPrimaryUrl} alt={PRODUCT_BRAND.displayName} />
            <div>
              <h2>{PRODUCT_BRAND.displayName} · 订单数据中心</h2>
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
              <Button ghost onClick={() => document.documentElement.requestFullscreen?.()}>
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
                <strong>{dashboardSummaryMoney(summary, "today")}</strong>
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
              <em>
                区间销售额 {dashboardMoneyGroups(screenModel.rangeMoney)}
                {screenModel.moneyComparable ? " · 利润 —" : " · 多币种金额不合并"}
              </em>
            </div>
            <div className="screen-chart">
              <div className="chart-axis">
                <span>{Math.ceil(screenModel.maxCount)}</span>
                <span>{Math.ceil(screenModel.maxCount / 2)}</span>
                <span>
                  {screenModel.moneyComparable
                    ? dashboardMinorMoney(screenModel.maxAmountMinor, screenModel.currencyCode)
                    : "多币种"}
                </span>
                <span>
                  {screenModel.moneyComparable
                    ? dashboardMinorMoney(Math.round(screenModel.maxAmountMinor / 2), screenModel.currencyCode)
                    : "不合并"}
                </span>
              </div>
              <div className="chart-legend-axis">
                <span>单量</span>
                <span>{screenModel.moneyComparable ? `销售额 ${screenModel.currencyCode || ""}` : "销售额（分币种）"}</span>
              </div>
              <div
                className="datascreen-trend-bars"
                style={{ gridTemplateColumns: `repeat(${screenModel.days.length}, minmax(3px, 1fr))` }}
              >
                {screenModel.days.map((day) => (
                  <div
                    className="trend-day"
                    key={day.key}
                    title={`${day.label} · ${day.count} 单 · ${dashboardMoneyGroups(day.amountByCurrency)}`}
                  >
                    <span
                      className="trend-amount"
                      style={{
                        height: screenModel.moneyComparable
                          ? `${Math.max(3, (day.amountMinor / screenModel.maxAmountMinor) * 100)}%`
                          : "3%",
                      }}
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
                {chartLabels.map((day) => <span key={day.key}>{day.label}</span>)}
              </div>
              <p>{hasOrderData ? `已同步 ${totalPostings} 单 · 趋势来自本地只读缓存` : "暂无订单数据 — 请先在「订单」页同步"}</p>
            </div>
          </section>
          <section className="screen-panel hours-panel">
            <div className="screen-panel-head"><span>今日时段分布</span></div>
            <div className="screen-hours">
              {screenModel.hourBuckets.map((hour) => (
                <span
                  key={hour.label}
                  style={{ backgroundSize: `100% ${Math.max(0, (hour.count / screenModel.maxHour) * 100)}%` }}
                >
                  <b>{hour.count}</b>
                  {hour.label}
                </span>
              ))}
            </div>
          </section>
          <section className="screen-panel channel-panel">
            <div className="screen-panel-head"><span>配送渠道 TOP</span></div>
            {hasOrderData ? (
              <div className="screen-top-list">
                {screenModel.channelRows.map((row, index) => (
                  <div key={row.label}>
                    <span>{index + 1}. {row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            ) : <p>暂无数据</p>}
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
                    <strong>{dashboardMoneyGroups(order.amountByCurrency)}</strong>
                  </div>
                ))}
              </div>
            ) : <p>暂无订单 — 等待同步</p>}
          </section>
          <section className="screen-panel hot-panel">
            <div className="screen-panel-head"><span>今日热销 TOP</span></div>
            {screenModel.hotProducts.length ? (
              <div className="screen-top-list">
                {screenModel.hotProducts.map((row, index) => (
                  <div key={row.label}>
                    <span>{index + 1}. {row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            ) : <p>今日暂无成交商品</p>}
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
            数据来源:本地同步缓存(状态为近 30 天口径) · 多币种分别统计，不做汇率折算 · {hasStore ? "已绑定店铺" : "等待绑定店铺"}
          </footer>
        </div>
      </div>
    </div>
  );
}
