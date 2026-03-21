# Session Selector 设计方案

## 需求

页面可以选择已有的 session 继续聊天，或者新建 session。

## 方案

在 agent 选择器旁边新增一个 session 选择下拉框。

### 下拉框内容

- 顶部固定项：`+ 新建 session`
- 已有 session：`sessionKey — lastMessagePreview`（sessionKey 截取后缀部分）
- 无 session 时：只显示 `+ 新建 session`

> 注意：`sessionKey` 完整形如 `agent:voice:web-sticky-xxx`，展示时取后缀（如 `web-sticky-xxx`）或完整 key 均可，以可读为准。

### 交互逻辑

| 操作 | 行为 |
|------|------|
| 切换 agent | 清空当前 session，下拉框刷新为新 agent 的 session 列表，等待手动选择 |
| 选择已有 session | 加载该 session 历史消息，清空聊天区后显示历史 |
| 选择"新建 session" | 创建新 session，清空聊天区 |
| 无 session 时 | 只显示"+ 新建 session" |

### API

- `GET /api/sessions?agentId={agentId}` 返回 session 列表
- 关键字段：`key`（即 sessionKey）、`lastMessagePreview`

### 文件结构

- 新建 `src/app/ui-sessions.js` — session 选择下拉框 UI 组件
- 修改 `src/app/main.js` — 在 agent selector 旁边渲染 session selector

### 验收标准

- 切换 agent 后，下拉框显示该 agent 拥有的 session
- 选择已有 session，聊天区清空并加载历史消息
- 选择新建，生成新 session，清空聊天区
- 网络失败时显示"加载失败"提示，不崩溃
- 无 session 时只显示新建项
