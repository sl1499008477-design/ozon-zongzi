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
- 自动上架的“类目策略”开关位于“上传方式”右侧并默认开启；开启时仅在当前商品精确类目策略存在时增强配色、字体和版式，任一商品未命中时该任务整体自动冻结为通用方案；关闭时直接使用通用方案。两种模式都保留商品类目和属性等 Ozon 必要校验，且不得改变商品事实、图片数量或图片顺序。
- 通用图片方案默认固定为 6 张且每种 1 张，顺序为：产品主图、核心卖点图、参数信息图、使用场景图、细节证据图、尺寸包装图；可信事实不足时降低信息密度，不新增阻断校验，也不凭空补事实。
- V6 主图采用自适应“转化冲击型”电商表达：商品保持第一视觉焦点，使用冻结的商品名称作为醒目标题，首要可信卖点用更大字号、加粗或协调强调色突出，其余最多 3 个高价值卖点使用简洁图标＋短文字；布局和强调色依据商品轮廓、现有事实及可用类目风格自适应，不使用固定配色或固定位置模板。
- V6 尺寸包装图统一使用纯白背景；有可信尺寸时使用连接商品边界的尺寸标线，有可信配件时只展示已确认配件，资料不足时只清晰展示商品。
