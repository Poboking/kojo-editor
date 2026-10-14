import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ERB_BODY_EXTENSIONS,
  ERB_DECLARATION_EXTENSIONS,
  ERB_DIALECT_EXTENSIONS,
  ERB_ENGINE_RESERVED_EXTENSIONS,
  erbMonacoExtensions,
  isErbBodyPath,
  isErbDeclarationPath,
  isErbDialectPath,
} from '../src/erb-ext';

/**
 * 「ERB 方言扩展名」单一真源自证（FT-2 收口，2026-10-14）。
 *
 * 两组断言，缺一不可：
 * 1. **形态**：谓词在真实文件名形态上判得对（大小写、多点名、无扩展名、点文件、
 *    目录名里带 `.erb` 的坑、两种分隔符）——这是"口径别判错"那一半；
 * 2. **收口**：全仓生产源码里**不许再有第二份**扩展名口径的字面副本
 *    （正则字符类 / 尾锚定正则 / 带引号的整扩展名）——这是"口径别漂移"那一半。
 *    历史教训：这条口径曾有四份副本分处三个包，靠注释"与 ERB_EXT 同口径"人肉对齐；
 *    漂移的症状是「索引里有、面上开不了」或反过来。
 */

/* ------------------------------ 1. 形态 ------------------------------ */

describe('ERB 方言谓词 · 形态', () => {
  it('清单形状：方言全集 = 正文 + 声明，且声明里含 .erh', () => {
    expect(ERB_BODY_EXTENSIONS).toEqual(['.erb', '.erm']);
    expect(ERB_DECLARATION_EXTENSIONS).toEqual(['.erh']);
    expect(ERB_DIALECT_EXTENSIONS).toEqual(['.erb', '.erm', '.erh']);
    // 分区不重叠：一个扩展名不能既算正文又算声明（判据会自相矛盾）
    for (const e of ERB_DECLARATION_EXTENSIONS) expect(ERB_BODY_EXTENSIONS).not.toContain(e);
  });

  it('.ERD 留位未接线：在预留清单里，但不被任何谓词认作方言', () => {
    expect(ERB_ENGINE_RESERVED_EXTENSIONS).toEqual(['.erd']);
    for (const e of ERB_ENGINE_RESERVED_EXTENSIONS) {
      expect(ERB_DIALECT_EXTENSIONS).not.toContain(e);
      expect(isErbDialectPath(`C:\\game\\ERB\\COLUMNDIV@2${e}`)).toBe(false);
      expect(isErbBodyPath(`x${e}`)).toBe(false);
      expect(isErbDeclarationPath(`x${e}`)).toBe(false);
    }
  });

  it('大小写不敏感（盘上真实写法是 `.ERH` / `.ERB` 大写）', () => {
    for (const p of ['C:\\game\\ERB\\DIM.ERH', 'C:\\game\\ERB\\dim.erh', 'C:\\game\\ERB\\dim.ErH']) {
      expect(isErbDialectPath(p), p).toBe(true);
    }
    expect(isErbDeclarationPath('MARKS_OF_SUIKA.ERH')).toBe(true);
    expect(isErbBodyPath('M_KOJO_K49_指令.ERB')).toBe(true);
    expect(isErbBodyPath('K53_自動喘ぎ用DIM.ERH')).toBe(false);
    expect(isErbDeclarationPath('M_KOJO_K31_DIM定義.ERB')).toBe(false);
  });

  it('多点名取最后一段；非方言结尾判否', () => {
    expect(isErbDialectPath('C:\\x\\M_KOJO_K11_TR.ERH')).toBe(true);
    expect(isErbDialectPath('C:\\x\\a.b.ERB')).toBe(true);
    expect(isErbDialectPath('C:\\x\\事件.ERB.txt')).toBe(false); // 最后一段才是扩展名
    expect(isErbDialectPath('C:\\x\\notes.md')).toBe(false);
    expect(isErbDialectPath('C:\\x\\save.sav')).toBe(false);
  });

  it('无扩展名 / 点文件判否（与 drag-drop、paths.extname 既有口径一致）', () => {
    expect(isErbDialectPath('C:\\x\\无扩展名')).toBe(false);
    expect(isErbDialectPath('.erb')).toBe(false); // 整名以点开头的"点文件"不是口上文件
    expect(isErbDialectPath('')).toBe(false);
  });

  it('目录段里带 `.erb` 不牵连后面的文件；两种分隔符与 UNC 都判得到', () => {
    expect(isErbDialectPath('C:\\game\\dir.erb\\说明.txt')).toBe(false);
    expect(isErbDialectPath('C:\\game\\dir.ERH\\事件.ERB')).toBe(true);
    expect(isErbDialectPath('/home/u/K36.ERH')).toBe(true);
    expect(isErbDialectPath('\\\\server\\share\\ERB\\DIM.ERH')).toBe(true);
    expect(isErbDialectPath('C:\\game\\ERB\\カラム機能')).toBe(false); // 目录路径本身（无点）
  });

  it('erbMonacoExtensions：一份清单派生两种大小写，供 Monaco 字面量匹配', () => {
    const got = erbMonacoExtensions();
    expect(got).toEqual(['.erb', '.ERB', '.erm', '.ERM', '.erh', '.ERH']);
    expect(new Set(got).size).toBe(got.length); // 无重复
    // 只此一处派生，不吃第二个参数时清单就是方言全集
    expect(got.filter((e) => e.toLowerCase() === '.erh')).toHaveLength(2);
    expect(erbMonacoExtensions(['.kojo'])).toEqual(['.kojo', '.KOJO']);
  });
});

/* ------------------------------ 2. 收口 ------------------------------ */

/**
 * 收口边界（**明确写出扫什么、不扫什么**）：
 *
 * 在范围内（生产源码，`.ts` / `.tsx`）：
 * - `packages/kernel/src`、`packages/plugin-api/src`、`packages/app/src`（含 `ui/` 与 `monaco/`）
 * - `packages/plugins` 下每个插件的 `src`
 *
 * 不在范围内（各自的理由）：
 * - 各包的 `tests` 目录与 `fixtures` 目录：夹具与语料自证要**写死**判据才有回归意义，
 *   引用被测口径等于自我循环；
 * - `tools` 目录：离线脚本 / CLI 探针（语料发现、引擎校验、DOM 冒烟），不属于运行口径；
 * - `packages/app/src-tauri`：Rust 层零"方言白名单"概念（只做 IO 原语），
 *   其中 `.erb` 字面量只出现在 `#[cfg(test)]` 写盘夹具里；
 * - `docs` 目录：文档提"哪些文件算 ERB"是叙述，不是口径。
 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCAN_DIRS = ['packages/kernel/src', 'packages/plugin-api/src', 'packages/app/src', 'packages/plugins'];
/** 单一真源本体允许写清单；另外两个名字是它的导出形状 */
const SINGLE_SOURCE_FILE = 'packages/plugin-api/src/erb-ext.ts';
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'target', 'src-tauri', 'tests', 'fixtures', '__fixtures__']);

/** 口径副本的三种历史形态（每种都有真实出处，见各条注释） */
const COPY_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  /** 正则字符类副本：erb-parser 的 `const ERB_EXT = /\.er[bm]$/i`、ui-sugar-lift 的 `isErbFile` */
  { name: '正则字符类（er[bm] 这类）', re: /er\[[bhm]{1,3}\]/ },
  /** 尾锚定正则副本：`/\.erb$/i` / `/\.ERH$/i` */
  { name: '尾锚定扩展名正则', re: /\\?\.(?:erb|erm|erh|erd)\s*\$\s*\//i },
  /** 引号整扩展名字面量：`OPENABLE_EXT = ['.erb', '.erm']`、`p.endsWith('.ERH')`。
   *  只认单双引号——反引号在本仓是"文档强调 / 模板串"写法，UI 文案里的 `` `.ERB` `` 一视同仁
   *  就会误伤（散文提扩展名不是口径副本）；清单与比较的真实写法从来是 `'…'` / `"…"`。 */
  { name: '带引号的整扩展名', re: /['"]\.(?:erb|erm|erh|erd)['"]/i },
];

/** 声明形状（不是"副本"，而是"有没有第二个真源"）：清单与谓词各自只许一处定义 */
const DEFINITION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: '方言清单定义', re: /const ERB_DIALECT_EXTENSIONS\s*[:=]/ },
  { name: '方言谓词定义', re: /function isErbDialectPath\s*\(/ },
];

/**
 * 粗粒度剥注释：块注释整段去、`//` 到行尾去（前面是 `:` 的跳过，免得把 `https://` 当注释）。
 * 代价是可能少扫一行——换来的是"文档性提到 .ERB"不算副本。方向选**宁可少报**：
 * 真出现第二份清单时，上面的定义形状那组断言先兜住。
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

function collectSources(dirRel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(join(REPO_ROOT, dirRel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = `${dirRel}/${e.name}`;
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      collectSources(childRel, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(childRel);
    }
  }
}

function scanFiles(): string[] {
  const out: string[] = [];
  for (const d of SCAN_DIRS) collectSources(d, out);
  return out.sort();
}

/** 找出某段源码里的口径副本（按上面三种历史形态） */
function copiesIn(text: string): string[] {
  const code = codeOnly(text);
  const hits: string[] = [];
  for (const { name, re } of COPY_PATTERNS) {
    const m = re.exec(code);
    if (m) hits.push(`${name} → ${JSON.stringify(m[0])}`);
  }
  return hits;
}

describe('ERB 方言口径 · 全仓收口', () => {
  it('扫描确实在工作：范围内生产源码数量级对得上', () => {
    const files = scanFiles();
    expect(files.length, '生产源码文件数').toBeGreaterThan(150);
    expect(files).toContain(SINGLE_SOURCE_FILE);
  });

  it('三种历史副本形态各能抓到一段合成副本（守门不是空转）', () => {
    const synthetic = [
      'const ERB_EXT = /\\.er[bm]$/i;',
      "export function isErbLike(path: string): boolean { return /\\.erb$/i.test(path); }",
      "export const OPENABLE_EXT: readonly string[] = ['.kojo', '.erb', '.erm', '.md', '.txt'];",
      "if (name.endsWith('.ERH')) return true;",
    ];
    for (const s of synthetic) expect(copiesIn(s), s).not.toEqual([]);
    // 反面：指向单一真源的写法不该被判成副本
    expect(copiesIn('if (!isErbDialectPath(path)) return [];')).toEqual([]);
    expect(copiesIn('import { ERB_DIALECT_EXTENSIONS } from \'@kojo/plugin-api\';')).toEqual([]);
    // 注释里提"`.ERB`"不算副本（剥注释那一步在起作用）
    expect(copiesIn('/** 游戏里谁在什么场合说什么话，都存在 .ERB 文件里 */\nconst x = 1;')).toEqual([]);
  });

  it('除单一真源外，生产源码里零字面副本（发现即列出文件名与命中片段）', () => {
    const offenders: string[] = [];
    for (const rel of scanFiles()) {
      if (rel === SINGLE_SOURCE_FILE) continue;
      const hits = copiesIn(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(' | ')}`);
    }
    expect(offenders, `口径副本清单（应为空）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('真源只有一处：清单与谓词各自全仓只许定义一次', () => {
    const found: Record<string, string[]> = {};
    for (const rel of scanFiles()) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const { name, re } of DEFINITION_PATTERNS) {
        if (re.test(text)) (found[name] ??= []).push(rel);
      }
    }
    expect(Object.keys(found).sort()).toEqual(DEFINITION_PATTERNS.map((p) => p.name).sort());
    for (const { name } of DEFINITION_PATTERNS) {
      expect(found[name], `${name} 的定义处`).toEqual([SINGLE_SOURCE_FILE]);
    }
  });

  it('契约层只写引擎级词汇：本模块代码行不出现任何具体游戏约定', () => {
    // 与 tools/audit-decoupling.mjs 的 A 项**同一口径**：只查代码行，注释里的设计说明
    // （比如"黑名单是哪些词"本身）算元描述、不算泄漏——比审计更严会把文档逼成含糊话。
    const code = codeOnly(readFileSync(join(REPO_ROOT, SINGLE_SOURCE_FILE), 'utf8'));
    for (const word of ['eratw', 'eraK', 'eraSQN', 'eraNAS', 'M_KOJO', '個人口上']) {
      expect(code.toLowerCase(), `单一真源的代码里不该出现 ${word}`).not.toContain(word.toLowerCase());
    }
    expect(/[\w/]sav[\w]/i.test(code), '单一真源的代码里不该出现存档扩展名').toBe(false);
  });
});
