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
];

/** 组合根豁免：app 的 bootstrap/UI 可以引用具体插件（那是宿主的接线职责） */
const EXEMPT_FILES = new Set(['packages/app/src/bootstrap.ts']);

/** 插件目录（B/C 项检查对象） */
const PLUGIN_ROOTS = ['packages/plugins'];

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
    const text = await fs.readFile(f, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // B: 不得 import @kojo/kernel
      if (/from\s+['"]@kojo\/kernel['"]|import\(['"]@kojo\/kernel['"]\)/.test(line)) {
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
    }
  }
}

/* ------------------------------ 报告 ------------------------------ */
console.log('=== 「一切皆插件」解耦审计 ===\n');
if (violations.length === 0) {
  console.log('✅ 全部通过：');
  console.log('   A. 内核 / plugin-api / Rust 宿主：零游戏名词');
  console.log(`   B. 插件（${PLUGIN_NAMES.size} 个）：未依赖 @kojo/kernel`);
  console.log('   C. 插件之间：无交叉 import');
  process.exit(0);
} else {
  console.log(`❌ 发现 ${violations.length} 处违规：\n`);
  for (const v of violations) {
    console.log(`[${v.rule}] ${v.file}:${v.line}`);
    console.log(`    ${v.text}\n`);
  }
  process.exit(1);
}
