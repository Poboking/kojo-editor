/**
 * HANDOFF 更新脚本（S1 批）——三处：头部"本会话完成"行、§二 状态、§十 清单。
 * 全部用**行号 splice**（§九-23 教训）；改完 grep 标题层级验证。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = path.join(ROOT, 'docs/HANDOFF.md');

const lines = (await fs.readFile(F, 'utf8')).split(/\r?\n/);

/* --- 1. 头部：追加一行"本会话完成"（在 v1.1 第十六批那行之后） --- */
const headAnchor = lines.findIndex((l) => l.startsWith('> 本会话完成 **v1.1 第十六批'));
if (headAnchor < 0) throw new Error('head anchor not found');
const s1Line =
  '> 本会话完成 **v0.3 批 S1：语法糖契约 + golden 固化**——新契约 `packages/plugin-api/src/sugar.ts`（SugarDoc / SugarNode 联合 15 型 / AliasValue 四右值[变量可读写、角色·数值·字符串只读] / SugarDiagnostic 23 码闭集 / 行级 SugarSourceMapEntry / SugarTranspileService；每节点带 1 基行列源位置）+ 服务键 `sugar.transpile`（实现 `kojo-sugar` 插件 S2 建）+ golden fixture（规范 §6.1/§6.2 源与期望产物，**逐字节等于规范原文**、测试按规范行号切片比对；期望产物 `.erb.todo` 暂存 + `describe.skip` 待 S2 转正式）；**不实现转译器**；555 项全绿（IMPLEMENTATION-LOG §5.26）';
lines.splice(headAnchor + 1, 0, s1Line);

/* --- 2. §二 状态区：在测试统计行前插入 v0.3 S1 摘要 --- */
const testAnchor = lines.findIndex((l) => l.startsWith('- 测试：**') && l.includes('项全绿'));
if (testAnchor < 0) throw new Error('test summary anchor not found');
const statusBullets = [
  '- **v0.3 批 S1 完成**（本会话）：**语法糖契约 + golden 固化**（IMPLEMENTATION-LOG §5.26 为权威记录）。',
  '  1. **契约** `plugin-api/sugar.ts`：`SugarDoc`（front-matter + 时机列表）/ `SugarNode` 联合（TextLine·HeartLine·IfBlock·IfExpr·WhenBlock·WhenExpr·RandomBlock·RandomInline·ChoiceBlock·ColorBlock·RawLine·RawFunctionBlock·AliasDecl·TimingBlock·Interpolation）/ **`AliasValue` 四右值**（变量引用可读写；角色引用·数值·字符串字面量只读）/ `SugarDiagnostic` + 23 码闭集 / **行级** `SugarSourceMapEntry` / `SugarTranspileService`（parse / transpile / sourceOf）。',
  '  2. **源映射地基**：每节点携 `loc{start,end}`（1 基行列，UTF-16 码元）；行级粒度为本批明确决策（列级留 S6，规范 §9 待实测第 3 条）；纯生成行 `sourceLine: null` 不伪造。',
  '  3. **15 个显式类型守卫**（`isVariableAlias`/`isReadonlyAlias`/…）替代判别式 narrow（TS7 教训）；**只读性单一真源** = `isReadonlyAlias`。',
  '  4. **golden fixture**：`kojo-sugar/tests/goldens/` 收录规范 §6.1/§6.2 源 + 期望产物（`.erb.todo`），**逐字节等于规范原文**（测试按规范行号切片，fixture 误改即红）；S2 转正式断言。',
  '  5. **边界**：只碰 plugin-api + goldens；未碰 erb-parser/condition-extractor/state-replay；规范文档只读；无新插件（S2 建 `kojo-sugar`）。',
  '  6. **并行线**：adapter 线（TRAE）WIP 使其 `ruleCount` 断言暂红（5→6 属其维护域）；stash 归位复跑确认本批无回归（回放基线逐字不变）。',
];
lines.splice(testAnchor, 0, ...statusBullets);

/* --- 3. §十 清单第 4 条：S1 已完成，指向 S2 --- */
const listAnchor = lines.findIndex((l) => l.startsWith('4. **下一批候选**'));
if (listAnchor < 0) throw new Error('checklist anchor not found');
lines[listAnchor] = lines[listAnchor].replace(
  '，首批评 = sugar 契约 + golden 固化（§6.1/§6.2））',
  '，**S1 契约 + golden 固化 ✅ 已完成**（IMPLEMENTATION-LOG §5.26），下一批 = **S2 转译内核**（`kojo-sugar` 插件：行式词法→AST→codegen，golden §6.1/§6.2 逐字节转正））',
);

/* --- 4. §八 环境坑：补一条"沙箱执行期间并行线 WIP 干扰集成断言"的应对 --- */
const envAnchor = lines.findIndex((l) => l.startsWith('| tauri dev 首轮冷启动'));
if (envAnchor < 0) throw new Error('env anchor not found');
lines.splice(
  envAnchor + 1,
  0,
  '| **同工作区并行线 WIP 会让集成冒烟断言误红**（如 adapter 新增规则使 `ruleCount` 5→6） | 先 `node tools/audit-decoupling.mjs` 粗判；再 `git stash push -- <并行线文件>` 复跑确认本批无回归，`git stash pop` 还原；**只提交自己边界内的文件**，并在 IMPLEMENTATION-LOG 记待办 |',
);

/* --- 5. §五 验证矩阵：补 sugar 契约测试的定向命令 --- */
const matrixAnchor = lines.findIndex((l) => l.startsWith('pnpm audit:decoupling   # 必须 ✅'));
if (matrixAnchor < 0) throw new Error('matrix anchor not found');
lines.splice(
  matrixAnchor + 1,
  0,
  "node node_modules/vitest/vitest.mjs run packages/plugin-api/tests/sugar.test.ts   # v0.3 S1：语法糖契约（类型守卫 / 别名只读性 / 源映射 / golden 逐字节）",
);

await fs.writeFile(F, lines.join('\n'), 'utf8');
console.log('[doc] HANDOFF updated: ' + lines.length + ' lines');
