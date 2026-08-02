# 扩展登录代次边界修复设计

## 背景与根因

当前 Web 端会在登录账号首次出现、退出后重新登录或切换账号时重新发布 `collector.auth.ready`。但扩展内容脚本只使用页面级布尔值 `passiveReadyConsumed` 记录“是否处理过 ready”。这个布尔值在页面不刷新的情况下永远不会复位，因此第一次登录之后，后续合法的新登录会被误判为重复事件。

结果是：同一 Web 页面内退出再登录或从账号 A 切换到账号 B 时，扩展可能不主动建立新账号会话；如果新票据交换失败，还可能暂时保留旧账号 A 的 Collector 会话。这既影响登录体验，也不满足多账号数据边界必须明确的规则。

## 业务目标

用一个不含账号资料的随机“登录代次号”区分不同登录过程：同一次登录的重复通知只处理一次；真正退出、重新登录、切换账号或重新加载 Web 页面后，扩展能识别为新的一次登录并完成会话交接。旧代次的迟到响应不得覆盖新代次，也不得继续使用旧账号会话。

## 验收标准

1. 同一账号、同一页面、同一次登录期间，15 秒本地状态刷新和 React effect 重装不会触发重复票据交换。
2. 同一页面退出后重新登录，即使仍是原账号，也会生成新代次并重新建立扩展会话。
3. 同一页面从账号 A 切换到账号 B 时，扩展先使 A 的旧会话失效，再建立 B 的会话。
4. 新代次到达时，如果旧代次票据正在兑换，旧兑换结果即使稍后成功也不能写回并覆盖新状态。
5. Web 明确退出后，扩展中的 Collector 会话立即清除；迟到的旧退出消息不能清除已经建立的新会话。
6. 页面刷新后可生成新代次并重新交接；不要求用户刷新 Seller 页面，也不新增永久轮询。
7. “重新检查”仍可在当前代次内恢复过期或缺失的扩展会话，并继续使用现有受限重试次数。
8. 代次号、ready 和 logout 消息不包含账号 ID、店铺 ID、Web Token、Collector Token、密码或票据；response 只允许携带现有的一次性票据，不得携带 Web Token 或 Collector Token。

## 方案比较与选择

### 方案 A：按时间复位原布尔值

例如每隔一段时间把 `passiveReadyConsumed` 改回 `false`。实现改动小，但会重新引入周期性认证和重复兑换，无法准确判断用户是否真的重新登录，也不能阻止旧异步结果覆盖新账号。

### 方案 B：只增加退出通知

收到退出时复位布尔值。它能覆盖标准的退出再登录，但页面消息可能因加载时序而错过，而且账号 A 直接切换到 B、旧票据兑换迟到等情况仍没有可靠边界。

### 方案 C：随机代次号加后台代次栅栏（采用）

Web 为每次真实登录生成一个随机、不透明的代次号；扩展按代次号去重。扩展后台同时保存当前代次，并在写入 Collector 会话前再次核对。新代次会立即清除旧会话，旧代次的迟到兑换会被拒绝。这一方案没有永久定时器，能同时解决重复通知、退出重登、换账号和并发覆盖问题。

## 组件与职责

### 1. Web 登录代次控制器

`app/src/collector-auth-bridge.js` 增加一个单一职责的登录代次控制器。它只根据 Web 账号状态变化维护内存状态：

- 未登录变为已登录：生成新的 `generationId`；
- 账号 ID 从 A 变为 B：生成新的 `generationId`；
- 已登录变为未登录：返回上一代次的退出事件并清空内存状态；
- 同一账号对象被 15 秒刷新替换：保持原 `generationId`；
- 同一代次内重复安装 effect：不重复发布 ready。

代次号使用 Web Crypto 生成，保存在当前 Web 页面内存中，不写数据库、localStorage、日志或 URL。页面重新加载后生成新代次是允许且预期的行为。

### 2. Web 认证桥 contract

页面消息继续沿用 `SONLI_COLLECTOR_AUTH` 协议，并使用严格字段白名单：

```text
ready    = { protocol, action: "collector.auth.ready", generationId }
logout   = { protocol, action: "collector.auth.logout", generationId }
request  = { protocol, action: "collector.auth.request", requestId }
response = { protocol, action: "collector.auth.response", requestId, generationId, ticket, expiresAt }
```

`generationId` 是 16 到 128 个 ASCII 字母、数字、下划线或短横线组成的不透明随机值。它不是认证凭据，也不能由账号 ID、用户名、店铺 ID 或时间戳拼接产生。

保留不带代次号的 request，是为了让后注入的内容脚本能够发现已经登录的 Web 页面。Web 只在当前确实登录时响应，并把当前代次号放入 response。内容脚本收到 response 后必须先激活该代次，再把票据交给后台兑换。

所有页面消息仍必须同时满足同一 `window`、同一 origin、精确协议、精确动作和精确字段集合；多余字段、缺失字段或非法代次号全部拒绝。

### 3. 扩展内容脚本

`extension/content/sync-auth.js` 用 `lastHandledGenerationId` 和 `pendingGenerationId` 代替永久布尔值：

- 相同代次的重复 ready：忽略，不重置受限请求周期；
- 新代次 ready：立即通知后台激活新代次，再开始一次受限票据请求周期；
- 已知代次发出的 request：记录 request ID 与代次的对应关系，只接受同一代次的 response；
- 页面刚注入、尚不知道代次时发出的 discovery request：仅当 response 返回时仍未接收任何 ready，才允许用 response 中的代次建立当前代次；如果期间已经接收新 ready，则丢弃 discovery 的迟到 response；
- 与当前请求、当前代次不匹配的旧 response：丢弃；
- 兑换进行中又收到更新代次：只保留最新代次，禁止并发兑换；当前兑换结束后处理最新代次；
- logout：只有它匹配内容脚本当前代次时，才停止当前定时器、清除待处理请求并重置本地状态；无论是否匹配都可通知后台按代次清除，后台会再次核对，迟到的旧 logout 不影响新代次；
- 后台显式 `collector.auth.request`：仍是权威恢复入口，可在当前代次内重新请求票据，不受“ready 已处理”限制。

现有脚本重复注入保护、最多 10 次页面请求、最多 2 次票据兑换和 1 秒短时重试保持不变。

### 4. 扩展后台代次栅栏

`extension/lib/collector-session.js` 在 `chrome.storage.session` 中维护当前登录代次，并把代次切换和 Collector 会话写入放在现有串行会话变更队列中：

- `activateCollectorGeneration(generationId)`：若代次变化，先清除旧 Collector 会话，再记录新代次；相同代次重复调用幂等；
- `clearCollectorGeneration(generationId)`：只有参数等于当前代次时才清除会话和当前代次；迟到的旧 logout 为无操作；
- `exchangeCollectorTicket(..., generationId)`：网络请求完成后，在写入会话的同一个串行临界区内再次确认代次仍为当前值；不一致则返回稳定错误 `COLLECTOR_AUTH_GENERATION_CHANGED`，绝不写入旧会话。

`extension/lib/portal-bridge-policy.js` 只允许受信 Web 页面发送三个精确动作：`collector.auth.begin`、`collector.auth.exchange` 和 `collector.auth.logout`。begin/logout 只携带合法代次号；exchange 在现有字段基础上增加合法代次号。service worker 只负责路由这些严格 contract，不自行推断账号或店铺。

## 状态流转

```text
未登录
  └─ Web 登录成功 → 生成代次 G1 → ready(G1)
       └─ 扩展 begin(G1) → 清除任何旧会话 → 请求票据 → exchange(G1) → 会话 G1

会话 G1
  ├─ 15 秒状态刷新 / 重复 ready(G1) → 忽略
  ├─ 明确重新检查 → 在 G1 内重新申请和兑换
  ├─ Web 退出 → logout(G1) → 清除会话和当前代次
  └─ 切换账号或重新登录 → 生成 G2 → begin(G2) → 立即清除 G1 → exchange(G2)

若 exchange(G1) 晚于 begin(G2) 返回：后台检查发现当前代次为 G2，拒绝 G1 写入。
若 logout(G1) 晚于会话 G2 返回：后台检查发现代次不匹配，不清除 G2。
```

## 错误与恢复

- Web Crypto 无法生成合法随机代次号：认证桥不发布 ready、不申请票据，保持未交接并允许用户使用“重新检查”；不使用账号信息或弱随机数代替。
- begin 失败：不发起该代次票据兑换，扩展保持未登录并显示现有登录失败状态。
- 票据申请或兑换失败：不恢复旧代次会话；当前代次保持激活，用户可通过 ready 的新代次或“重新检查”恢复。
- 收到格式错误、额外字段、跨窗口或跨 origin 消息：静默拒绝，不泄露内部错误或凭据。
- service worker 重启：当前代次和 Collector 会话都在 `chrome.storage.session` 中恢复；二者的匹配关系继续有效。

## 测试与验证

### Web 端单元测试

1. 首次登录生成合法随机代次并只发布一次 ready。
2. 相同账号的 15 秒刷新保持同一代次且不重复 ready。
3. 退出后同账号重登生成不同代次。
4. A 切换到 B 生成不同代次，页面消息不出现账号 ID 或其他敏感字段。
5. request 的 response 带当前代次；旧 bridge 的迟到 response 保留旧代次供扩展拒绝。

### 内容脚本与策略测试

1. 相同代次的重复 ready 不重置周期。
2. 新代次 ready 能重启周期；旧 response 被丢弃。
3. 兑换进行中收到多个新代次时不并发，只处理最后一个。
4. logout 停止旧周期并请求后台按代次清除。
5. 初始 discovery response 能激活代次并兑换。
6. 权威“重新检查”在会话过期后仍可恢复。
7. 非法长度、非法字符、额外字段、错误来源和重复注入均被拒绝。

### 后台与会话测试

1. begin 同代次幂等，新代次原子清除旧会话。
2. logout 仅清除匹配代次，旧 logout 不影响新会话。
3. G1 兑换在 G2 激活后返回时得到 `COLLECTOR_AUTH_GENERATION_CHANGED`，存储中没有 G1 会话。
4. G2 成功后，G1 的任何迟到结果不能覆盖 G2。
5. portal bridge 只接受受信来源和精确三个动作 contract。

### 完整回归

运行 Web bridge、Collector session、portal/web bridge policy、sync-auth runtime、service worker 路由、扩展 readiness、源码/发布物一致性、ZIP 启动和敏感信息扫描；重新构建 Web，并重新生成两个内容一致的扩展 ZIP。真实 Chrome 中至少手工验证：慢登录、同账号退出重登、A→B 切换和连续点击“重新检查”。

## 影响范围

预计只修改 Web 登录桥及其 App 接线、扩展 Web/portal bridge policy、内容脚本、Collector session manager、service worker 路由、对应测试和扩展发布包。不会修改数据库、账号密码规则、店铺配置、Seller 登录、Ozon 采集接口、商品数据结构、权限定义或定时刷新频率。

## 可观测性、回滚与未验证边界

错误只使用稳定错误码和脱敏诊断，不记录 generationId、票据或 Token。generationId 不是业务数据，不进入审计报表。

如上线后出现问题，回滚本边界修复提交并重新打包扩展即可恢复当前 ready 布尔去重逻辑；不需要数据库迁移或数据回填。回滚会恢复已知的“同页二次登录可能不交接”缺陷，因此只能作为临时恢复手段。

本地自动化无法完全替代用户 Chrome 的真实登录状态。最终交付必须明确列出真实浏览器中已验证和未验证的场景，不得把仅自动测试通过描述为真实环境已完全验证。
