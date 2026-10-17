# 测试记录

日期：2026-10-17

## 环境

- Windows 10/11
- Node.js 24.19.0
- pnpm 11.25.0
- Chrome 155.0.8059.80
- TypeScript 5.9.3
- Vitest 3.2.4
- Playwright 1.55.0

## 命令与实际结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过；主程序与 E2E 两套 tsconfig 均无错误 |
| `pnpm lint` | 通过 |
| `pnpm test` | 7 个测试文件，34/34 通过 |
| `pnpm build` | 通过；生成 `dist/` |
| `pnpm secret-scan` | 通过；扫描 46 个文件，无密钥命中 |
| `pnpm test:e2e` | 8/8 通过 |

单元测试覆盖：

- 操作协议严格 Schema、额外字段拒绝、操作数量上限；
- 高风险文字/表单按钮/链接分类；
- 计划哈希、单次授权、过期和页面指纹绑定；
- 敏感字段过滤、链接查询参数移除、正文 PII 脱敏、文本截断；
- 执行器逐项校验、目标类型不匹配、页面变化、点击阻止和撤销冲突；
- DeepSeek 客户端成功响应、无效 Key、429 重试、网络失败重试、非重试 400 响应、超时和用户取消。
- DeepSeek Prompt Cache 用量字段解析、图片 `image_url` 内容块和缓存命中率累计；
- 字号/主题设置持久化；
- 截图附件传递但图片数据不写入会话存储。

集成测试覆盖：

- 未配置 Key 时拒绝请求；
- 保存设置后不向 UI 状态暴露 Key；
- 分析页面 → 生成计划 → 未批准不执行 → 批准执行 → 撤销；
- 模型输出含额外 `selector` 字段时拒绝；
- 高风险点击被阻止；
- 页面跳转和执行时 stale 检查；
- 拒绝计划不执行；
- 自定义 API origin 缺少权限时拒绝保存。

浏览器端到端测试：

1. 通过 CDP `Extensions.loadUnpacked` 加载生产构建，侧边栏页面渲染。
2. 真实 Chrome 消息通信读取本地 fixture 页面，密码和邮箱值不出现在快照中。
3. 侧边栏“分析当前网页”按钮触发站点权限检查并读取当前页。
4. 保存/删除 API Key，UI 状态不包含 Key，字号/主题切换后生效。
5. 当前标签页截图返回 PNG。
6. 框选弹窗选择区域并生成聊天附件。
7. 本地模拟 DeepSeek API：分析 → 生成计划 → 批准 → 实际修改 `<h1>` → 撤销恢复；缓存栏显示 80%。
8. `chrome://` 内部页面返回 `unsupported_page`，不注入脚本。

## GitHub 发布验证

- 仓库：https://github.com/Ptfoxa/deepseek-browser-agent
- 可见性：Public
- 默认分支：main
- 许可证：GPL-3.0
- 发布流程：本地创建提交 → 推送 main → GitHub Actions `CI` 运行
- GitHub Actions 已实际执行并成功通过：安装依赖、类型检查、Lint、单元与集成测试、生产构建、密钥扫描
- 远程仓库克隆后独立执行密钥扫描：通过
- 远程文件树检查：README、LICENSE、Manifest、核心源码、测试与 CI 配置均存在；未上传 `node_modules`、`dist` 或 `.env`

## 未执行项

- 真实 DeepSeek API 请求：需要用户提供自己的 API Key；使用本地模拟 API 验证了完整协议链路。
- 真实人工工具栏点击：自动化直接打开侧边栏页面；建议用户加载扩展后点击扩展图标做一次人工确认。
