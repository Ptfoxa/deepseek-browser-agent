# DeepSeek Browser Agent

DeepSeek Browser Agent is a Chrome Manifest V3 side-panel assistant that reads the page you explicitly select, asks the DeepSeek API for a structured plan, and executes only allow-listed page changes after you approve the exact preview. It never executes model-generated JavaScript, HTML, selectors or remote code.

DeepSeek Browser Agent 是一个由 DeepSeek API 驱动的 Chrome 侧边栏网页助手。它读取你当前指定的网页，生成结构化操作计划，在本地区块链式校验风险后展示修改预览；只有你批准后，扩展才会执行允许列表内的 DOM 操作，并在执行后校验结果。模型输出没有直接执行权限。

> 当前版本为 MVP。所有修改只作用于当前页面 DOM，**不会自动保存到网站服务器**，也不会替你提交表单、发送消息、发布内容、删除数据或完成支付。

## 功能

- Chrome Side Panel 多轮聊天，支持加载、成功、失败、超时、取消和页面失效状态。
- 读取当前活动标签页的标题、地址、可见正文（最多 6000 字符）、标题层级、链接路径和可交互元素摘要。
- 为可操作元素生成临时 ID（如 `el_001`），模型只能引用这些 ID。
- DeepSeek API 配置、连接测试、超时、取消、1.2 秒请求间隔和 429/5xx 指数退避重试。
- 严格 Zod Schema 校验的结构化操作协议。
- 支持 `replace_text`、`fill_input`、`set_checkbox`、`select_option`、`click_element`。
- 每次修改展示目标、修改前后内容、风险提示，并要求用户逐次批准。
- 单次授权绑定当前计划哈希、标签页、页面指纹和过期时间；页面跳转、重新加载或元素内容变化后旧授权失效。
- 执行后逐项校验；失败时停止后续动作。
- 对可逆的文本、输入框、复选框和下拉选择提供撤销，并在撤销前检查页面是否又被用户修改。
- 密码、邮箱、电话、支付字段等敏感表单值不读取；正文中的邮箱、手机号、疑似卡号和证件号会先脱敏。
- API Key 不进入 Content Script、日志、源码、构建产物或 Git。

## 技术架构

| 模块 | 职责 |
| --- | --- |
| `src/sidepanel` | React 侧边栏：聊天、设置、页面摘要、操作预览、授权、撤销和状态展示 |
| `src/background` | Service Worker：消息路由、任务状态、标签页协调、API 请求、授权上下文和执行编排 |
| `src/content` | 按需注入的 Content Script：DOM 读取、元素登记、允许列表执行、结果校验和撤销 |
| `src/lib/deepseek` | DeepSeek Chat Completions 客户端、超时、取消、限流与错误映射 |
| `src/lib/planner` | 提示词、JSON 解析、结构化计划构建与本地目标校验 |
| `src/lib/security` | 风险分级、计划哈希、单次授权、错误与 PII 脱敏 |
| `src/lib/page` | 页面字段白名单、元素 ID、页面指纹、执行器与撤销器 |
| `src/lib/storage` | `chrome.storage.local` 设置与 `chrome.storage.session` 短期会话 |

Service Worker 不假设常驻。聊天记录、待确认计划预览、授权和撤销记录保存在 `chrome.storage.session`；页面正文上下文只保存在 Service Worker 内存中，不落盘。Service Worker 被回收后需要重新分析网页，尚未确认的修改不会自动续做。

## Windows 环境要求

- Windows 10/11。
- Node.js 22 或 24（本机实测 Node 24.19.0）。
- pnpm 11（本机使用 11.25.0）。
- Git 2.40+。
- Chrome 114+（Side Panel API 要求）。手动加载未打包扩展仍可在 Chrome 开发者模式中使用。

## 安装与本地加载

```powershell
pnpm install
pnpm build
```

1. 打开 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目的 `dist` 目录。
5. 固定扩展图标；点击图标会打开侧边栏。

Chrome 137+ 已移除用于自动加载扩展的 `--load-extension` 命令行参数，因此自动化浏览器测试使用 Playwright Chromium；这不影响在 `chrome://extensions/` 中手动加载。

## DeepSeek API 配置

开发时（2026-10-17）核对的 DeepSeek 官方文档：

- Base URL：`https://api.deepseek.com`
- Chat Completions：`POST /chat/completions`
- 默认模型：`deepseek-flash`
- JSON Output：`response_format: { "type": "json_object" }`
- 官方文档要求 JSON 模式提示词中出现 `json` 字样，并建议设置足够的 `max_tokens`

在扩展侧边栏的“设置”中填写 API Key。默认地址与模型已预填，可直接使用；也可以修改 Base URL 和模型名称。保存自定义 Base URL 时，扩展会请求该具体 origin 的可选站点权限，不授予权限则不会保存。

`.env.example` 仅用于记录可选本地变量，扩展构建和运行不读取 `.env`，**不要在其中写入真实 Key**。

## 本地构建

```powershell
pnpm build
```

构建脚本会：

1. 清理并重建 `dist/`。
2. 用 Vite 构建 React 侧边栏。
3. 用 esbuild 构建 Service Worker（ESM）和 Content Script（IIFE）。
4. 复制 Manifest 与图标。
5. 校验构建产物齐全且 Manifest 为 MV3。

生成目录：`F:\dsb\deepseek-browser-agent\dist`（以当前工作区为例）。

## 测试

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm secret-scan
pnpm test:e2e
```

说明：

- 单元测试使用 Vitest + jsdom。
- 集成测试使用内存版标签页、内容脚本、存储和 DeepSeek 客户端，验证授权、拒绝、过期、页面变化、非法模型输出和撤销流程。
- 端到端测试启动本机 Chrome 持久上下文，通过 Chrome DevTools Protocol 的 `Extensions.loadUnpacked` 加载测试构建，验证侧边栏、真实消息通信、页面读取、敏感字段过滤、设置存储和不支持页面处理。Chrome 137+ 已移除 `--load-extension` 命令行参数，因此测试显式使用 `--enable-unsafe-extension-debugging` 并移除 Playwright 默认的 `--disable-extensions` 参数。
- 若本机没有 Chrome，可安装 Playwright Chromium 后将测试的 `channel` 改为 `chromium`。
- 自动化测试不调用真实 DeepSeek API，不需要真实 API Key。真实连接测试需要你在扩展设置中自行配置 Key。

本次实测环境与结果记录见 [docs/test-report.md](docs/test-report.md)。

## 权限用途

| 权限 | 用途 | 边界 |
| --- | --- | --- |
| `activeTab` | 用户点击“分析当前网页”后读取当前标签页 | 不会后台扫描其他标签页 |
| `scripting` | 按需注入 `content.js` | 仅注入当前标签页；不加载远程脚本 |
| `storage` | 保存设置与短期会话 | API Key 位于 `chrome.storage.local`，非专业密钥保险箱 |
| `sidePanel` | 打开 Chrome 侧边栏 | 无额外数据访问 |
| `tabs` | 识别目标标签页标题/地址，并在跳转或重载时使旧授权失效 | 仅用于标签页协调，不读取页面正文 |
| `host_permissions` | 访问 `https://api.deepseek.com/*` | 仅默认 DeepSeek API 域名 |
| `optional_host_permissions` | 允许用户配置自定义 API 地址 | 保存时只请求用户输入的具体 origin |

扩展不申请 `<all_urls>` 的永久站点访问权，不读取 `chrome://`、Chrome 应用商店或其他受限页面。

## 数据隐私

生成计划时发送给 DeepSeek 的内容：

- 当前页面标题与地址。
- 最多 6000 字符的可见正文（先脱敏）。
- 标题层级、去除查询参数和锚点后的链接路径。
- 可交互元素摘要：临时 ID、元素类型、标签、非敏感输入当前值、复选框状态、下拉选项。
- 你对 AI 的指令和最近对话。

不会读取或发送：

- `password`、`email`、`tel`、`hidden`、`file` 等敏感输入的值。
- Cookie、localStorage、会话令牌、认证凭据。
- 其他标签页的私人内容。
- API Key 到 Content Script 或网页。

默认不保存完整网页正文，也不把页面内容写入调试日志。链接查询参数会被移除；正文中的邮箱、手机号、疑似卡号和证件号会使用启发式规则脱敏。启发式脱敏不能保证覆盖所有格式，涉及敏感数据时请谨慎使用。

## 安全设计

信任边界：

1. 本地扩展代码：可信执行策略来源。
2. 用户明确指令：当前任务授权意图。
3. DeepSeek 输出：非可信计划，必须经过本地 Schema 和目标校验。
4. 网页正文与页面脚本生成文本：非可信数据，不能改变权限规则。
5. 网站和第三方响应：非可信数据。

关键约束：

- 不使用 `eval`、`new Function`，不把模型生成的 JavaScript/HTML/脚本注入页面。
- 模型不能提供 CSS 选择器、XPath、URL 或任意代码；严格 Schema 会拒绝额外字段。
- 模型只能使用读取阶段生成的临时元素 ID。
- 高风险语义（提交、发送、发布、删除、支付、购买、登录、注销等）会被本地风险分类器阻止；MVP 不自动执行。
- 点击仅允许表单外的普通按钮；链接、提交按钮、表单内按钮和危险文字按钮均被拒绝。
- 用户批准后生成单次使用的计划授权，绑定计划哈希、标签页、页面指纹和 10 分钟有效期。
- Content Script 在执行前再次校验计划 Schema、页面 URL、页面结构指纹、目标元素是否仍存在、内容是否被用户改动，并逐项验证执行结果。
- 授权在执行前标记为已消费；Service Worker 重启后不会自动续做。
- 撤销前检查当前值是否仍等于扩展写入后的值；若用户已再次修改则拒绝覆盖。

更完整的审计范围与结果见 [docs/security-audit.md](docs/security-audit.md)。

## 已知限制

- 操作只修改当前页面 DOM，不代表数据已保存到网站服务器。
- 不支持多标签页分析、跨页面工作流、会话长期记忆或自动化策略。
- 不支持提交表单、发送、发布、删除、购买支付等高风险动作；需要用户手动完成。
- 点击操作无法可靠撤销；链接和表单按钮不在 MVP 支持范围。
- 页面结构指纹用于检测跳转、重载和结构性变化。动态页面可能因 DOM 变化而要求重新分析。
- React 等受控组件可能在下一次渲染时覆盖直接 DOM 值；扩展会报告 DOM 校验成功，但无法保证站点内部状态同步。
- Service Worker 被回收后页面上下文丢失，需要重新点击“分析当前网页”。
- 撤销仅覆盖最近一批成功执行的修改，不提供历史撤销栈。
- 文本提取和 PII 脱敏均为启发式，不能替代站点级数据分类。
- API Key 保存在扩展本地存储，不是操作系统密钥库；建议使用专用、可撤销的 Key。
- 自动化端到端测试使用 Playwright Chromium；Chrome 155 不再支持通过命令行加载扩展。
- 真实 DeepSeek 连通性需要用户提供自己的 API Key 才能最终验证。

## 目录结构

```text
deepseek-browser-agent/
├── public/                    # 预留静态资源目录
├── src/
│   ├── sidepanel/             # React 侧边栏
│   ├── background/            # Service Worker 与控制器
│   ├── content/               # 按需注入的页面脚本
│   ├── lib/
│   │   ├── deepseek/
│   │   ├── planner/
│   │   ├── security/
│   │   ├── page/
│   │   └── storage/
│   └── types/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── scripts/                   # 构建、图标、密钥扫描
├── docs/
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts
├── LICENSE
└── README.md
```

## License

GNU General Public License v3.0 only. See [LICENSE](LICENSE).

本项目按 GPL-3.0 发布；分发修改版本时请保留许可证与相应源码。
