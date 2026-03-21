# Session Selector 设计方案

## 需求

页面可以选择已有的 session 继续聊天，或者新建 session。

## 方案

在 agent 选择器旁边新增一个 session 选择下拉框。

### 下拉框内容

- 顶部固定项：`+ 新建 session`
- 已有 session：`sessionKey — lastMessagePreview`
- 无 session 时：只显示 `+ 新建 session`

### 交互逻辑

| 操作 | 行为 |
|------|------|
| 切换 agent | 清空当前 session，重新选择 |
| 选择已有 session | 加载该 session 历史消息，清空聊天区后显示历史 |
| 选择"新建 session" | 创建新 session，清空聊天区 |
| 无 session 时 | 只显示"新建 session" |

### 实现位置

- UI 组件：`src/app/ui-sessions.js`（新建）
- 接入入口：在 `main.js` agent selector 旁边渲染

### API 调用

- `GET /api/sessions?agentId=xxx` 获取 session 列表
- session 对象字段：`key`（sessionKey）、`lastMessagePreview`

### 设计确认

- 交互方案 A（固定"新建 session"选项 + 下拉框结构）
- 显示内容：session key + " — " + lastMessagePreview（B 方案）
- 选择已有 session 时加载历史记录
- 无 session 时只显示新建项
