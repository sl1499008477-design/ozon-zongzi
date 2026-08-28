# Prototype Instructions

Run the local server yourself and open the preview in the in-app browser. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## ozon 粽子品牌与插件原型决定

- 用户可见品牌统一为「ozon 粽子」。
- 插件数据面板和设置弹窗以指定 `#/plugin` 原型为视觉基准。
- 只还原视觉和布局，继续使用当前真实字段、数据来源与持久化 contract。
- 不得把原型中的模拟 35 项字段复制到生产逻辑。
- 自动上架的“使用采集品牌”滑动按钮默认关闭；关闭时仅使用 Ozon 当前类目字典唯一确认的 `Нет бренда`，开启时才优先保留采集品牌。
- 自动上架的“类目策略”开关位于“上传方式”右侧并默认开启；开启时使用精确类目策略，关闭时保留商品类目和属性等 Ozon 必要校验，但使用商品自身资料驱动的通用图片与内容规划，不因缺少精确类目策略阻断任务。
- V6 主图采用商品主导的高密度电商表达：商品保持第一视觉焦点，最多展示 4 个来自可信商品事实的高价值卖点，并优先使用“简洁图标＋短文字”；类目图片策略决定配色、字体和视觉风格，但不得把 V6 主图降为无文案。
- V6 产品实拍图统一使用纯白背景；有可信尺寸时使用连接商品边界的尺寸标线，有可信配件时只展示已确认配件，资料不足时只清晰展示商品。
