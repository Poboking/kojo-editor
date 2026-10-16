/**
 * 「一切皆插件」解耦审计（可复跑；CI 级检查）。
 *
 * 检查项（对应 docs/ARCHITECTURE.md 的铁律与 DSH 解耦哲学）：
 *   A. 内核/契约/Rust 宿主源码中**不得出现任何具体游戏名词**
 *      （内核零游戏知识 = 多游戏扩展的结构性前提）
 *   B. 插件源码**不得 import @kojo/kernel**（插件只能依赖 @kojo/plugin-api；
 *      这是"插件可独立分发"的硬约束——对应 DSH 教训：插件目录无 node_modules 不能
 *      import 第一方常量）
 *   C. 插件之间的交叉 import（正文里出现其它插件包名）
 *   D. **通用插件**源码中不得出现具体游戏知识字面量（游戏名 / 口上函数名前缀 /
 *      引擎特有旗标）——游戏知识只准住 adapter。A 项只覆盖内核层，D 项补上
 *      插件层：否则"分野模板硬编码进通用插件"这类泄漏没有任何门禁能拦住
 *      （v0.3 S2 审阅发现，见 docs/archive/REVIEW-SUGAR-DECOUPLING-2026-10-11.md）。
 *
 * 用法：node tools/audit-decoupling.mjs   （或 pnpm audit:decoupling）
 * 退出码：0 = 通过；1 = 违规。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 游戏名词黑名单（对内核/宿主层生效）——只查**代码行**（注释行跳过：注释里的
 * "内核不了解 CHARA CSV" 之类元描述是设计文档的一部分，不算知识泄漏）。
 *
 * 判定口径：
 * - 硬禁：具体游戏名（eratw / eraK / …）与游戏特有前缀（M_KOJO）、日文路径（個人口上）；
 * - `口上` / `kojo` / `chara`：era 生态通用术语（架构文档 §5.7 钦定于契约字段
 *   `kojoPaths`/`charaIndex`），不在黑名单；
 * - 行尾 `// audit-allow: <理由>` 显式豁免。
 */
const GAME_WORDS = /\b(eratw|eraK|eraSQN|eraNAS)\b|M_KOJO|個人口上|\bsav\b/i;

/** 是否需要跳过该行（注释/文档行） */
function isCommentLine(line) {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('///') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith(';') ||
    t.startsWith('//!')
  );
}

/** 需要保持"零游戏知识"的目录（相对仓库根） */
const NEUTRAL_DIRS = [
  'packages/kernel/src',
  'packages/plugin-api/src',
  'packages/app/src-tauri/src',
  'packages/app/src/bridge',
  'packages/app/src/bootstrap.ts', // 例外说明：bootstrap 是宿主组合根，见下方豁免
  'packages/app/src/ui', // 2026-10-11 解耦批：宿主 UI 层收编进 A 项（此前 eraTW 文案绑死游戏无门禁可拦）
  'packages/app/src/monaco', // 同上：Monaco 语言层（引擎级词汇可，具体游戏约定不可）
];

/** 组合根豁免：app 的 bootstrap/UI 可以引用具体插件（那是宿主的接线职责） */
const EXEMPT_FILES = new Set(['packages/app/src/bootstrap.ts']);

/** 插件目录（B/C 项检查对象） */
const PLUGIN_ROOTS = ['packages/plugins'];

/**
 * 适配器插件**豁免名单**（D 项）：这些包**就是**游戏知识的家，允许出现游戏字面量。
 * 以目录名为准（`packages/plugins/<dir>`）。新增 adapter 时在此登记。
 */
const ADAPTER_PLUGIN_DIRS = new Set(['eratw-adapter']);

/**
 * D 项的游戏知识字面量黑名单（通用插件禁用）。比 A 项更严——除游戏名/口上前缀外，
 * 还含**具体游戏约定的旗标**（eraTW 位协议 `TFLAG:192` 等）。
 * 仅查**代码行**（注释行跳过：文档性引用规范 §3.2 的示例是设计说明的一部分）。
 *
 * 注意：`sav` **不在**此列——它是 emuera 引擎的通用存档容器扩展名（`sav-parser`
 * 是跨游戏一致的引擎级插件），误列会伤及正牌的通用插件。
 */
const PLUGIN_GAME_WORDS = /\b(eratw|eraK|eraSQN|eraNAS)\b|M_KOJO|個人口上|DIARY\{|TFLAG:192/i;

const violations = [];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'target') continue;
      out.push(...(await walk(p)));
    } else if (/\.(ts|tsx|rs|mjs)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

/* ---------------- A. 内核/宿主层零游戏名词 ---------------- */
for (const dirRel of NEUTRAL_DIRS) {
  const dirAbs = path.join(ROOT, dirRel);
  const files = dirRel.endsWith('.ts') ? [dirAbs] : await walk(dirAbs);
  for (const f of files) {
    const r = rel(f);
    if (EXEMPT_FILES.has(r)) continue;
    const text = await fs.readFile(f, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (/audit-allow:/.test(line)) continue;
      if (GAME_WORDS.test(line)) {
        violations.push({ rule: 'A(内核零游戏知识)', file: r, line: i + 1, text: line.trim().slice(0, 120) });
      }
    }
  }
}

/* ---------------- B/C. 插件依赖纪律 ---------------- */
const PLUGIN_NAMES = new Set();
for (const proot of PLUGIN_ROOTS) {
  const dirAbs = path.join(ROOT, proot);
  let entries = [];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const e of entries) {
    if (e.isDirectory()) PLUGIN_NAMES.add(`@kojo/plugin-${e.name}`);
  }
}

for (const proot of PLUGIN_ROOTS) {
  const files = await walk(path.join(ROOT, proot));
  for (const f of files) {
    const r = rel(f);
    const isTest = /\/tests?\//.test(r);
    // D 项豁免：测试（夹具允许含游戏知识）+ adapter 插件（游戏知识的家）
    const pluginDir = r.split('/')[2] ?? '';
    const isAdapter = ADAPTER_PLUGIN_DIRS.has(pluginDir);
    const text = await fs.readFile(f, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // B: 不得 import @kojo/kernel——三种形态全拦：命名导入（from）、副作用导入
      //（`import '@kojo/kernel'`，2026-10-16 修复批补上：无 from 无调用，插件可零引用
      // 拉起内核而静默过闸）、动态导入。引号只认 ' 与 "，注释里的反引号提及不误伤。
      if (
        /from\s+['"]@kojo\/kernel['"]|import\s+['"]@kojo\/kernel['"]|import\(['"]@kojo\/kernel['"]\)/.test(
          line,
        )
      ) {
        violations.push({ rule: 'B(插件禁依赖内核)', file: r, line: i + 1, text: line.trim().slice(0, 120) });
      }
      // C: 不得 import 其它插件包（测试除外——集成测试属宿主层面）
      if (!isTest) {
        for (const pkg of PLUGIN_NAMES) {
          const selfPkg = `@kojo/plugin-${path.basename(path.dirname(path.dirname(f)))}`;
          if (pkg === selfPkg) continue;
          if (line.includes(`'${pkg}'`) || line.includes(`"${pkg}"`)) {
            violations.push({ rule: 'C(插件禁交叉import)', file: r, line: i + 1, text: line.trim().slice(0, 120) });
          }
        }
      }
      // D: 通用插件不得含游戏知识字面量（adapter 与测试豁免）
      if (!isTest && !isAdapter && !isCommentLine(line) && !/audit-allow:/.test(line)) {
        if (PLUGIN_GAME_WORDS.test(line)) {
          violations.push({ rule: 'D(通用插件零游戏知识)', file: r, line: i + 1, text: line.trim().slice(0, 120) });
        }
      }
    }
  }
}

/* ------------------------------ 报告 ------------------------------ */
console.log('=== 「一切皆插件」解耦审计 ===\n');
if (violations.length === 0) {
  console.log('✅ 全部通过：');
  console.log('   A. 内核 / plugin-api / Rust 宿主 / 宿主 UI·Monaco 层：零游戏名词');
  console.log(`   B. 插件（${PLUGIN_NAMES.size} 个）：未依赖 @kojo/kernel`);
  console.log('   C. 插件之间：无交叉 import');
  console.log('   D. 通用插件（adapter 除外）：零游戏知识字面量');
  process.exit(0);
} else {
  console.log(`❌ 发现 ${violations.length} 处违规：\n`);
  for (const v of violations) {
    console.log(`[${v.rule}] ${v.file}:${v.line}`);
    console.log(`    ${v.text}\n`);
  }
  process.exit(1);
}
