# 安全审计记录

审计日期：2026-10-17

范围：`src/`、`tests/`、`scripts/`、`manifest.json`、依赖锁文件、`dist/` 构建产物、Git 暂存内容。

## 1. 信任边界

- 本地扩展代码是可执行策略的唯一可信来源。
- 用户指令只授权当前任务，不授予扩展新权限。
- DeepSeek 输出是不可信数据，必须通过 Zod 严格 Schema、元素 ID 白名单、类型匹配和风险分类。
- 网页正文、页面脚本生成文本、网站响应均为不可信数据；提示词将页面内容包裹在 `UNTRUSTED_PAGE_DATA` 标记中，并明确其不得改变规则。
- Content Script 不接收 API Key，不接收任意脚本、选择器或 HTML。

## 2. 任意代码执行

- 未发现 `eval`、`new Function`、动态 `script` 注入或远程代码下载。
- 模型输出只被解析为预定义 JSON 操作；`.strict()` Schema 拒绝额外字段（如 `selector`、`script`）。
- 实际 DOM 操作全部由 `src/lib/page/execute.ts` 中的允许列表实现。
- Manifest CSP 仅允许扩展自身脚本。

## 3. 操作授权

- 每个计划包含 `taskId`、`tabId`、`pageUrl`、`pageFingerprint`、动作列表、风险等级、创建与过期时间。
- SHA-256 计划哈希绑定授权；授权记录包含标签页与页面指纹，默认 10 分钟过期，执行前标记为已消费。
- 页面跳转/重载由 `chrome.tabs.onUpdated` 使待确认计划失效。
- 首次分析当前网站时通过 `chrome.permissions.request` 请求具体站点权限，不默认申请全局 `<all_urls>`；权限可在扩展详情中按网站撤销。
- Content Script 执行前再次校验 URL、结构指纹、目标存在性、目标类型、禁用/只读状态和元素当前内容。
- 任一动作失败则停止后续动作；部分成功的可逆动作仍可撤销。
- 高风险文字、表单内按钮、提交/重置按钮、链接均被拒绝点击。

## 4. 敏感数据

- `password`、`hidden`、`file`、`email`、`tel` 输入不进入元素白名单。
- `autocomplete` 中的 `cc-*`、`one-time-code`、`current-password`、`new-password` 被识别为敏感。
- 字段名/标签/占位符中的密码、验证码、卡号、身份证、邮箱、电话等提示会触发跳过。
- 页面链接只保留 origin + pathname，丢弃 query 与 fragment。
- 正文与标签使用邮箱、手机号、疑似卡号、证件号脱敏规则。
- 不读取 Cookie、localStorage、其他标签页内容。
- 截图只在用户点击相机按钮并主动框选后生成；截图数据仅随当前聊天消息发送，不写入会话存储。
- 截图界面提示用户避免框选密码、支付等敏感信息；附件限制为 PNG/JPEG/WebP data URL，并限制尺寸与大小。

## 5. API Key

- API Key 仅保存在 `chrome.storage.local`，由 Service Worker 发起请求。
- Key 不进入 UI 状态、Content Script、消息日志、错误信息、源码、`.env.example` 或构建产物。
- 错误文本经过秘密模式脱敏；测试覆盖 API 错误回显密钥的脱敏行为。
- 自定义 Base URL 仅允许 HTTPS，或 localhost 的 HTTP 调试地址；拒绝 URL 内嵌凭据、查询参数和锚点。
- 本地存储不是专业秘密管理方案，README 已明确说明。

## 6. 提示注入

- 页面数据带明确不可信标记，系统提示优先级明确。
- 模型无法提供选择器或代码，任何额外字段会使整个响应被拒绝。
- 目标必须存在于当前读取快照；模型不能引用其他标签页或自行扩大权限。
- 高风险动作在模型返回后被本地分类器拦截。
- 单测覆盖“模型返回带 `selector` 的点击计划”必须被拒绝且不调用执行器。

## 7. 竞态与页面变化

- 页面指纹由 URL、标题、关键节点结构和 body 子节点数量组成。
- 每个登记元素保存读取时的原始基线；执行前与当前值比较。
- 用户在执行前修改目标内容时，扩展拒绝覆盖。
- 撤销前检查当前值是否等于扩展写入值；不相等时拒绝撤销。
- JSDOM 测试覆盖结构变化、内容变化和撤销冲突。

## 8. 密钥与仓库扫描

`pnpm secret-scan` 扫描 `src/`、`tests/`、`scripts/`、`dist/`、README、Manifest 和 `.env.example`，规则覆盖：

- DeepSeek 风格 `sk-` 密钥；
- GitHub Token；
- AWS Access Key；
- 私钥块；
- Bearer Token；
- 常见 `api_key` / `secret` / `token` / `password` 赋值。

扫描只输出文件路径与规则名，不输出匹配值。测试中的假密钥通过运行时拼接构造，避免扫描器误报与真实密钥混入。

## 9. 依赖与构建

- `pnpm-lock.yaml` 固定依赖版本。
- 构建产物不包含 source map、`.env`、测试数据或本地配置。
- Content Script 以 IIFE 构建，不依赖远程模块。
- Service Worker 以 ESM 构建，Manifest 明确 `type: module`。

## 10. 审计结论

未发现会把模型输出直接转为代码执行、绕过用户授权、读取密码值、将 API Key 发送给页面或第三方、或自动执行高风险外部影响动作的实现。

仍需注意的残余风险：

- DOM 修改与站点内部状态不同步的风险；
- 动态页面的结构指纹可能无法覆盖所有内容变化；
- PII 脱敏为启发式规则；
- 浏览器本地存储不是硬件密钥库；
- 真实 DeepSeek API 的连通性需要用户 Key 才能验证。

以上限制已在 README“已知限制”中记录，不构成阻断 MVP 发布的关键安全缺陷。
