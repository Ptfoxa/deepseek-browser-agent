# DeepSeek Browser Agent v0.2.0

这是一个 Chrome Manifest V3 侧边栏网页助手。它读取用户当前指定的网页，通过 DeepSeek API 生成结构化计划，在本机完成 Schema 与风险校验，并要求用户逐次批准后才执行允许列表内的 DOM 操作。

## 本版重点

- 修复首次分析网站时 activeTab 可能失效的问题：点击“分析当前网页”会请求当前网站的具体访问权限，不默认申请全局 `<all_urls>`。
- 新增小/标准/大三档字体大小。
- 新增日间、夜间和跟随系统主题。
- 底部新增 DeepSeek Prompt Cache 会话缓存命中率栏，显示命中/未命中 tokens。
- 新增当前标签页截图：支持框选区域、附加到聊天框，并通过 `image_url` 传给 `deepseek-flash` 视觉输入。
- 截图仅随当前消息发送，不写入会话存储；界面提示避免截取敏感信息。
- 页面快照增加结构化表单摘要和逐动作预期结果字段。

## 验证

- 34 项单元/集成测试全部通过。
- 8 项真实 Chrome 端到端测试通过。
- 生产构建通过。
- 密钥扫描与远程独立克隆扫描通过。
- GitHub Actions `CI` 通过。

## 安装

1. 下载本 Release 的 `deepseek-browser-agent-0.2.0.zip` 并解压。
2. 打开 `chrome://extensions/`，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录。
4. 点击扩展图标打开侧边栏，在设置中填入 DeepSeek API Key。

## 已知边界

- 操作只修改当前页面 DOM，不代表网站服务器已保存。
- MVP 不支持多标签页分析、跨页面工作流和长期记忆。
- 高风险提交、发送、发布、删除和支付操作不会自动执行。
- 截图需要 activeTab 临时权限；内部页面不支持读取或截图。
- 真实 DeepSeek API 请求需要用户自己的 Key。

完整说明与安全审计见仓库 README 和 `docs/`。
