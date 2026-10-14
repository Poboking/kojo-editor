# 新会话交接 Prompt（直接粘贴给实施会话）

> 用法：新开 Kimi 会话后全文粘贴本文件内「—— PROMPT 起点 ——」到「—— PROMPT 终点 ——」之间的内容。

—— PROMPT 起点 ——

任务：实施 kojo-editor 的 UI/UX 重设计（VSCode 式五区布局），仓库 `<工作树>`（私仓 github.com/Poboking/kojo-editor）。

【必读（按序，读完再动手）】

1. `docs/UI-REDESIGN-2026-10-11.md` —— 需求定稿 v1.0（唯一权威需求；含布局图、additive 槽位契约草案、10 面板迁移表、多标签/全禅/写权限闭环细化设计、拍板记录）。
2. `docs/UI-REDESIGN-HANDOFF-2026-10-11.md` —— 实施交接（工程上下文、纪律、P0–P4 任务卡与验收）。
3. `docs/HANDOFF.md` —— §二状态、§七安全模型、§八环境坑（直调 node/git-push.mjs/双跑 typecheck）、§九踩坑、§十一版本纪律。
4. `packages/plugin-api/src/slots.ts` + `packages/app/src/ui/*` + `packages/app/src/styles.css` + `packages/app/src/bootstrap.ts`。

【实施范围与顺序】按交接文档 §五 任务卡执行：P0 写权限闭环 → P1 壳层骨架 → P2 命令与工具栏 → P3 编辑器深化（多标签+💡升糖）→ P4 拖拽停靠+全禅。每期一个批次，批次名用「日期+简称」（不用 vX.Y 第N批）。

【硬约束】

- 契约变更全部 additive（新字段 optional、缺省=现状），任何中间态可运行；宿主壳零业务词（只有容器/动作语义），业务知识只住插件；布局状态走壳层 localStorage，不动内核存储域。
- 每批验收：`pnpm test` 全绿（基线 958 项/16 插件）+ `pnpm typecheck`（root 与 packages/app 双跑）+ `pnpm audit:decoupling` ✅；桌面壳深度冒烟沙箱不可跑，需要我（用户）在正常终端勾验的部分列成手工清单给我。
- 每批：全绿 → Conventional Commits 提交 → `node tools/git-push.mjs` 推送 → 记 `docs/IMPLEMENTATION-LOG.md`。

【开工第一步】`pnpm install` → 三项基线验证跑绿 → 从 P0 开始，先做「kernel applyApprovedWritable 不一致时经事件通知宿主重弹授权 + 状态栏写权限徽章 + 通知中心」。做完 P0 停下来汇报，等我确认再继续 P1。

—— PROMPT 终点 ——

