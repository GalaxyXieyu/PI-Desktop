# 交互式 Plan 元数据 — 主机契约（协议 12，架构 22）

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/interactive-plan-metadata) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

本附加主机契约保持不可变 Markdown 工件不变。不带元数据的提交拥有与
之前完全相同的 proposal/execution 线材形状和工件字节。结构化元数据仅存于
SQLite，绝不追加进工件。Goal 提交不支持元数据。

决策记录：[ADR interactive-plan-structured-revision](/adr/interactive-plan-structured-revision)。

## 提交与读取

`plans.submit` 接受可选的 `steps` 和 `design`。JSON null 等同于缺省。
`kind: "goal"` 携带非 null 元数据时以 `PLAN_METADATA_UNSUPPORTED` 失败。
校验发生在工件发布或审批行插入之前。校验错误形如
`<CODE> <path>: <reason>`，代码为 `PLAN_STEPS_INVALID` 或
`PLAN_DESIGN_INVALID`；环会附带环路径。

- 步骤是最多 24 个对象的数组。空数组表示没有元数据。
- 每个步骤有 `id`、`title`、可选的 `detail` 和 `dependsOn`（缺省为
  `[]`）。未知键会被拒绝。
- id 会被修剪（trim）、唯一且区分大小写，为 1–64 个 ASCII 字符，匹配
  `[A-Za-z0-9][A-Za-z0-9._-]*`。
- title 会被修剪，为 1–200 个 Unicode 字符，不含 U+0000–001F 或 U+007F。
- detail 会被修剪，最多 2000 个 Unicode 字符，不含 NUL。允许换行；空
  detail 会被省略。
- 依赖会被修剪，引用最多 24 个已存在的其他 id，不允许重复、自引用或环。
- 规范化后的序列化步骤限制为 64 KiB 的 UTF-8 JSON。

Design 只接受 `framework`、`componentLibrary`、`styleKeywords`、
`fontSystem` 和 `colorSystem`；嵌套的未知键同样被拒绝。

- framework/library 会被修剪并小写；空值省略。非空值最多 40 个字符，
  匹配 `[a-z0-9][a-z0-9.+/_-]*`。
- 样式关键词最多 12 个修剪后的字符串，各 1–40 个 Unicode 字符，不含
  控制字符且不区分大小写地不重复。
- 字体系统要求修剪后 1–120 个 Unicode 字符、不含控制字符的
  `fontFamily`。可选的 heading/subheading/body 层级要求匹配
  `\d{1,2}px` 且处于 10–72px 的 `size`，以及 100 到 900 之间、为 100 的
  整数倍的整数 `weight`。
- 颜色系统接受 primary/background/text/functional 分组，每组最多八个
  精确的 `#RRGGBB` 字符串，规范化为大写。无效颜色报告 `use #RRGGBB`。
- 空的 keyword/color 分组被省略；空的颜色系统被省略。所有字段都缺省的
  design 变为 `{}`。规范化后的 design JSON 限制为 16 KiB。

`plans.get { sessionId, proposalId }` 先让待批准过期，再为任意状态返回
`{ proposal }`。缺失的 proposal 或会话不匹配都返回 `PLAN_NOT_FOUND`。
`plans.pending` 继续返回带可选元数据的待批准 proposal。提交审计只增加
`stepCount` 和 `hasDesign`，不含结构化文本。

## 存储与执行投影

架构 22 为 `plan_approvals` 增加可空 TEXT 列 `steps_json`、`design_json`、
`resolved_steps_json` 和 `resolved_design_json`。提交的 `[]` 和 `{}`
存为 NULL。proposal 序列化省略 NULL 字段（`steps`、`design`、
`resolvedSteps`、`resolvedDesign`）。损坏的元数据在读取时被省略并给出
不暴露计划文本的警告。

执行的 `steps` 和 `design` 在 resolved 元数据非 NULL 时使用它，否则使用
提交的元数据。有效的空值被省略。

## 审批修订与清单播种

`plans.resolve` 接受可选的 `revisedSteps` 和 `revisedDesign`；JSON null
等同于缺省。reject 携带任一非 null 修订时以 `PLAN_INVALID_ARGUMENT`
失败；存储的 Goal proposal 携带修订时以 `PLAN_METADATA_UNSUPPORTED`
失败。主机在打开审批事务之前使用提交校验器规范化修订。省略的修订保留
提交的元数据；显式的 `[]` / `{}` 清空按规范化 JSON 原样存储而不是 NULL。

重放只有在动作、权限模式和两个规范化修订都与已存储的决议一致时才会
无写入地成功。省略等同于 NULL，而不是显式清空。任何不匹配都返回
`PLAN_APPROVAL_CONFLICT`。

工件校验仍先于审批。同一个事务记录状态、执行队列身份与修订、把会话
切到 Agent，并在有效步骤非空时播种清单。播种递增 `todo_revision`、
打上 `todo_updated_at`、按步骤顺序替换行，内容为 title、状态为
`pending`、优先级为 `medium`、并带步骤 id。它不需要正在运行的 turn。
有效步骤为空时保留既有行和 revision。任何播种失败都会回滚整个审批。
审批审计只增加 `revisedSteps` / `revisedDesign` 布尔值和 `seededTodos`
计数，绝不包含元数据文本。

批准还可以携带 `revisedMarkdown`，即编辑后的正文字符串（ADR
plan-body-approval-revision）。reject 携带它、空白或非字符串值、或存储的
Goal 与其他修订一样失败；超长正文以 `PLAN_MARKDOWN_TOO_LARGE` 失败；
与提交逐字节相同的正文不算修订。工件校验之后，主机把正文发布为新工件，
审批事务把该行的正文与工件指向它并记录写入。事务失败会删除新文件；
提交的文件绝不被改写。审计增加 `revisedMarkdown` 布尔值和提交工件的
身份，绝不包含文本。执行使用该行的正文与工件。

Plan 或 Goal 的批准可以携带 `targetModel: { providerId, modelId }`（ADR
plan-body-approval-revision）。审批事务在切换到 Agent 模式和目标权限模式的
同时设置会话的 `provider_id` / `model_id`，因此执行以该模型启动，会话此后
保留它。reject 携带它、或 id 非字符串/空白，以 `PLAN_INVALID_ARGUMENT`
失败且不做任何更改。审计增加 `executionModel`（id 或 null）。审批行不存储
该字段，重放忽略它。

提交之后，`plans.resolve` 发出既有的 `plans.changed` 通知，并且仅当本次
调用播种了行时，才发出带确切 TodoWrite 负载形状的 `todos.changed` 已提交
快照。幂等重放绝不重新播种或重新发出 `todos.changed`。JSON 结果中不添加
内部播种标记。

## TodoWrite 步骤身份

Todo 项接受可选的 `stepId`：修剪后的字符串，使用与计划步骤相同的 id
语法和长度上限。非字符串、畸形或重复的 id 会让校验失败，错误指名
`todos[i].stepId`。省略的 id 在线材上保持缺省。读取和写入都持久化
`session_todo.step_id`。

替换行之前，TodoWrite 在同一事务内读取先前的清单。省略 `stepId` 的项
只有在恰好一个先前的项拥有相同的规范化内容、且没有其他新项认领该 id
时才继承它。显式的新 id 无论位置如何都优先；继承绝不把同一个 id 赋给
两次。变化或有歧义的内容不继承身份。既有的 Agent 模式与运行中 turn 的
授权保持不变。

架构 22 还增加可空的 `session_todo.step_id`，非 NULL 时受 1–64 字符的
长度约束。全新数据库直接包含它；带备份的、事务性的 v21→v22 迁移在添加
之前探测列并保留既有行。v20→v21→v22 链仍然受支持。

## 渲染器文档审阅

审批条为 Plan 和 Goal proposal 都提供次要的文档入口。带结构化元数据的
Plan 显示任务/设计摘要 chips 并使用审阅并编辑的标签。该入口打开一个
会话作用域的 `plan:<id>` 工作面板标签页；既有的工件打开器与审批控件
不变。标签页的清理、重排、去重和会话切换像其他工作面板资源一样保留
该资源。

SubmitPlan 计划历史卡片——为 SubmitPlan 工具结果渲染的只读转录卡片——
在其结果负载包含带字符串 `id` 和 `title` 的 proposal 时也提供 View plan
按钮。该按钮打开 proposal 的会话作用域标签页（当结果没有字符串会话
ID 时回落到活动会话），不切换卡片的展开。该入口在 Build 和转录重载
后仍然可用；SubmitGoal 卡片、Read 行、拓扑行以及没有有效 proposal 的
结果不会获得它。

只读文档显示标题、状态、概述、不可变 Markdown 和非空的 design/tasks
分区。Design 包含关键词 chips、字体预览、带十六进制标签的色板、
framework 和组件库；在宽面板上 design 面板是紧凑的双列网格。依赖显示
被引用任务的序号和标题。已批准的文档在存在 resolved 元数据（包括显式
的空修订）时使用它。旧 proposal 不添加空的 Design 或 Tasks 分区。

匹配的会话检查点/待批准优先于一次回退的 `plans.get` 读取。身份变化使
进行中的结果失效。远程会话只渲染 store 数据并带只读说明，绝不发起
`plans.get`。加载和不可用状态均已本地化。

独立的渲染器草稿 store 按 `sessionId:proposalId:version` 保留待定的
结构化编辑，独立于标签页生命周期。它的纯 reducer 阻止依赖环并移除已
删除的依赖引用。修订投影通过共享校验器规范化并只发送变化的部分；
显式清空保持 `[]` / `{}`。决议丢弃草稿。计划标签页的编辑器与修订提交
UI、共享的 Build/Reject 控件和编辑交互都构建在该模型之上；实时
Electron 覆盖为 `E2E-PLAN-interactive-tab-edit-build-progress`。

## 渲染器进度与依赖图

Tasks 分区默认为 List，并在待定和已批准视图中提供共享的 List/Graph
分段控件。两种列表形态都显示依赖 chips，带被引用步骤的序号和标题。
Graph 把当前待定草稿或决议后的有效步骤渲染为只读 SVG DAG：稳定的
拓扑列、圆角节点、有向贝塞尔边、水平溢出，以及无障碍的任务/阶段摘要
加有序列表回退。图随工作面板缩放：当面板窄于水平布局所需宽度时，自动
切换为垂直单列布局，并提供 Horizontal/Vertical 切换以及缩小 / 适应 /
放大控件。长标签在视觉上截断；完整标题仍然可得。

已批准的步骤从会话清单推导实时进度：先匹配显式步骤 id，再用精确的
修剪后标题匹配不带 id 的 todo，每个 todo 至多消耗一次。未匹配的步骤
显示为 pending。只有已完成的步骤计入 `n / m done`；已取消的步骤保留
在总数中。计数与执行徽章（queued/running/completed/interrupted）在
两个视图中都保持可见。状态圆圈和图节点不写清单状态；用户勾选被有意
地不提供，以避免与 TodoWrite 的整表替换竞争。没有有效步骤的 Plan 不
增加进度或图分区。

## 验证

Rust 测试覆盖校验/规范化、既有审批与清单行的迁移、
submit→pending→approve/reject→get、会话不匹配、文件系统写入前的校验、
精确的旧行为/工件字节、损坏列恢复，以及有效元数据的优先级。修订测试
覆盖 approve→seed→queue/claim、显式清空、规范化的重放冲突、校验拒绝、
工件校验与不变的字节/哈希、注入 INSERT 失败时的原子回滚、TodoWrite
身份继承，以及已提交的 RPC 通知。实时 UI 编辑由
`E2E-PLAN-interactive-tab-edit-build-progress` 覆盖。
