# Tampermonkey Scripts Library

个人油猴脚本仓库（`油猴脚本库`）。

用途：
- 存放每个独立脚本文件（一个文件一个功能）
- 按版本持续更新
- 记录每次改动的行为变化点

## Scripts

- `scripts/linuxdo-auto-expand-nested.user.js`
  - 功能：LINUX DO 干净主题加载和普通帖子点击切换嵌套阅读视图，保留通知/回复的具体楼层、查询参数和锚点链接给原站路由处理，支持 Cmd/Ctrl/中键新标签页打开，并自动展开可见楼中楼回复

- `scripts/idcflare-auto-expand-nested.user.js`
  - 功能：IDC Flare 帖子自动切换嵌套阅读视图，支持 Cmd/Ctrl/中键新标签页打开，并自动展开可见楼中楼回复

- `scripts/nodeseek-auto-nested-replies.user.js`
  - 功能：NodeSeek 自动签到提醒、Linux.do 风格楼中楼局部父子连接、用户等级/加入天数/签名展示、评论自动翻页并隐藏原分页控件

- `scripts/视频快捷键精简版-Enter-ShiftEnter-ZXC.user.js`
  - 功能：`Enter` 全屏自动播放、`Shift+Enter` 网页全屏、`Z/X/C` 倍速控制

- `scripts/YouTube-四列极简布局.user.js`
  - 功能：YouTube 视频网格每行 4 列（极简版）

## Maintenance Notes

每次改动建议记录以下内容（按你的规则）：

- `新增`
- `删除`
- `修改`
- `关键改动点`（哪一段逻辑改变了行为、为什么必须这么改）

## Versioning

- 修复问题：`0.1.0 -> 0.1.1`
- 小功能调整：`0.1.x -> 0.2.0`
- 大改/不兼容变更：`0.x -> 1.0.0`
