/**
 * **语料钉数守卫**（2026-11-06 指纹批）——判据写成会拦住后来者的测试。
 *
 * 拦什么：一枚「真实语料活闸」把命中数写成**字面量**（`toBe(N)` / `toHaveLength(N)` /
 * `toEqual({ x: N })`），却没有登记它锚定的是**哪份语料盘的内容指纹**。
 * 这类闸的红有两种完全不同的原因（代码坏了 / 盘不对），不登记指纹就分不清——
 * 那正是 2026-11-06 四枚闸集体红在盘上的实证。
 *
 * 口径（唯一真源 = 本文件，不做整类豁免）：
 * - 受检文件 = 名字以 `.corpus.test.ts` 结尾的 ∪ 任何读了 `process.env.KOJO_SMOKE*` / `KOJO_CORPUS_DIR` 的 `.test.ts`；
 * - 「已登记」= import `tools/corpus-fingerprint.mjs` **且**真的调用 `resolvePinnedRow` 查表；
 * - 「豁免」= `EXEMPT` 清单逐条列出，带**枚数上限**与理由：枚数变多即红（豁免不许悄悄长）；
 * - 只数**判定值**：`expect(...)` 引出的 `toBe/toHaveLength(数字)` 与 `toEqual({...)} / toMatchObject({...})`
 *   成员；夹具构造（`{ timeout: 900_000 }` / `{ mtimeMs: ... }` / `{ line: 3 }`）由 `NOISE_KEYS` 与"必须由 expect 引出"挡掉。
 *   棘轮形（`toBeLessThanOrEqual(CONST)`）是常量不是字面量，文本面判不了——见交付读数的"口子"清单。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  corpusFingerprint,
  formatFingerprint,
  matchesFingerprint,
  resolvePinnedRow,
  savCandidatesReadout,
  unknownPinFields,
} from '../corpus-fingerprint.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 扫描时整棵跳过的目录（依赖 / 产物 / 版本库内部） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', 'target', '.turbo', '.qoder']);

interface ScannedFile {
  rel: string;
  src: string;
}

/** 受检文件清单（相对路径、码点序；同一输入永远同一输出） */
function corpusGates(root: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(abs, relPath);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.test.ts')) continue;
      const isCorpusName = ent.name.endsWith('.corpus.test.ts');
      let src = '';
      try {
        src = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const readsEnv = /process\.env\.KOJO_SMOKE|process\.env\.KOJO_CORPUS_DIR|env\[['"]KOJO_SMOKE/.test(src);
      if (!isCorpusName && !readsEnv) continue;
      out.push({ rel: relPath.replaceAll('\\', '/'), src });
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

export interface LiteralPin {
  line: number;
  text: string;
}

/**
 * 断言侧的字面量判据（**只数判定值，不数夹具数据**）：
 * ① 同一行 `expect(...)` 上跟 `.toBe(N)` / `.toHaveLength(N)`；
 * ② `expect(...).toEqual({ ... })` / `.toMatchObject({ ... })` 里的 `key: N`（同行或跨行块）；
 * ③ 整行注释与行内注释不参与取值——历史读数写在注释里不是闸。
 */
const NOISE_KEYS = new Set([
  'timeout', 'line', 'column', 'row', 'depth', 'index', 'size', 'bytes', 'mtimeMs', 'durationMs',
  'limit', 'offset', 'runs', 'events', 'version', 'pages', 'maxChars', 'port', 'delayMs', 'chara',
]);

/** 一枚字面量是否算"钉死命中数"：≥2 的整数（0/1 是恒等/单例，不构成基线） */
function isPinnedValue(raw: string): boolean {
  const n = Number(raw.replace(/_/g, ''));
  return Number.isSafeInteger(n) && n >= 2;
}

const DIRECT_PIN_RE = /\.(?:toBe|toHaveLength)\(\s*(\d[\d_]*)\s*\)/;
const BRACED_PIN_RE = /\.(?:toEqual|toMatchObject)\(\s*\{([^{}]*)\}/;
const MEMBER_RE = /[{,]\s*['"]?([\w.\-\u4e00-\u9fff]+)['"]?\s*:\s*(\d[\d_]*)/;
const OBJECT_START_PIN_RE = /expect\([^\n]*?\.(?:toEqual|toMatchObject)\(\s*\{/;

function braceBalance(line: string): number {
  let d = 0;
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
    else if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
  }
  return d;
}

function literalPins(src: string): LiteralPin[] {
  const lines = src.split(/\r?\n/);
  const pins: LiteralPin[] = [];
  let blockDepth = 0;
  let inExpectBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const commented = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    const code = commented ? '' : trimmed.split('//')[0]!.trimEnd();
    if (code.length > 0) {
      if (inExpectBlock) {
        const m = MEMBER_RE.exec(`{${code}`);
        if (m && !NOISE_KEYS.has(m[1]!) && isPinnedValue(m[2]!)) pins.push({ line: i + 1, text: code.slice(0, 120) });
      } else if (/expect\(/.test(code)) {
        let counted = false;
        const direct = DIRECT_PIN_RE.exec(code);
        if (direct && isPinnedValue(direct[1]!)) {
          pins.push({ line: i + 1, text: code.slice(0, 120) });
          counted = true;
        }
        if (!counted) {
          const braced = BRACED_PIN_RE.exec(code);
          const member = braced ? MEMBER_RE.exec(`{${braced[1]}`) : null;
          if (member && !NOISE_KEYS.has(member[1]!) && isPinnedValue(member[2]!)) {
            pins.push({ line: i + 1, text: code.slice(0, 120) });
            counted = true;
          }
        }
        if (!counted && OBJECT_START_PIN_RE.test(code) && braceBalance(code) > 0) {
          inExpectBlock = true;
          blockDepth = braceBalance(code);
        }
      }
    }
    if (inExpectBlock) {
      blockDepth += braceBalance(code);
      if (blockDepth <= 0) {
        inExpectBlock = false;
        blockDepth = 0;
      }
    }
  }
  return pins;
}

/** 「已登记」的判据：既 import 了指纹模块，又真的走了查表（只 import 不查表 = 假登记） */
function registration(src: string): { registered: boolean; why: string } {
  const imports = src.includes('tools/corpus-fingerprint.mjs');
  const looksUp = /\bresolvePinnedRow\(/.test(src);
  if (imports && looksUp) return { registered: true, why: 'import + resolvePinnedRow 查表' };
  if (imports) return { registered: false, why: '只 import 指纹模块，没有 resolvePinnedRow 查表' };
  return { registered: false, why: '没有指纹登记（未 import tools/corpus-fingerprint.mjs）' };
}

/**
 * 豁免清单（逐条：文件 + 枚数上限 + 理由）——**不许整类豁免**。
 * `maxPins` = 2026-11-07 本轮扫到的枚数；新增字面量钉数会顶破上限 ⇒ 红。
 * 这里的"豁免"不等于"合规"：这些闸**仍然按盘钉着数**，只是本轮预算内没逐枚复测登记。
 * 每枚的今日红/绿状态与归属车道写在理由里，交付读数同一份。
 */
const EXEMPT: readonly { rel: string; maxPins: number; reason: string }[] = [
  {
    rel: 'packages/kernel/tests/integration-plugins.test.ts',
    maxPins: 15,
    reason: '15 枚含与 call-slot 闸同源的 `36`（本轮只登记了 call-slot 那一枚）与 `scan.entries 6` 等回放基线；integration 冒烟归组长栈，登记留给下一批',
  },
  {
    rel: 'packages/plugins/erb-parser/tests/arity.corpus.test.ts',
    maxPins: 1,
    reason: '`counts.extra 111` 是按盘钉数；arity 车道在飞（src/arity.ts 正被改），测试文件不越界代登',
  },
  {
    rel: 'packages/plugins/eratw-adapter/tests/name-table-source.test.ts',
    maxPins: 18,
    reason: '名字表索引值（`MAXBASE=15` 一类）取自真盘 CSV/ERH；属 names 车道，本轮未复测登记',
  },
  {
    rel: 'packages/plugins/eratw-adapter/tests/variable-schema.als.corpus.test.ts',
    maxPins: 4,
    reason: '.als 侧索引值（`TCVAR 泥酔=145`）按盘钉数；names/scan 车道在飞，不越界代登',
  },
  {
    rel: 'packages/app/tests/erb-directive-words.test.ts',
    maxPins: 4,
    reason: '4 枚是三层取证闸（主盘→他盘→引擎串面）的清单规模钉数，真盘侧只有分层命中判据；app/{monaco,ui} 线在飞，未代登',
  },
  {
    rel: 'packages/app/tests/erb-ts-facets-query.test.ts',
    maxPins: 1,
    reason: '1 枚（`startPosition.row 2`）随树形夹具，未逐枚复测；sugar/查询表车道在飞，不越界代登',
  },
  {
    rel: 'packages/app/tests/mcp-pagination-completeness.test.ts',
    maxPins: 17,
    reason: '17 枚多为合成夹具规模（分页 1,200 一类）；MCP 线在飞，本轮只登记不越界',
  },
  {
    rel: 'packages/plugins/erb-parser/tests/erh.test.ts',
    maxPins: 2,
    reason: '2 枚（夹具 3 条 / 合成 200 份）不是真盘钉数；erb-parser 三枚 src 在飞，测试面一并留给该车道',
  },
  {
    rel: 'packages/plugins/kojo-sugar/tests/native-display-control.test.ts',
    maxPins: 2,
    reason: '1 枚（开块档 11）是仓内清单钉数、1 枚（取满 40 份 `.ERB`）是真盘规模下限；kojo-sugar 线在飞，未代登',
  },
  {
    rel: 'packages/plugins/ui-convention-report/tests/lint-run.test.ts',
    maxPins: 1,
    reason: '1 枚（`durationMs 5_123`）是合成计时夹具，非按盘钉数；留上限防升级',
  },
  {
    rel: 'tools/tests/erb-paint-coverage.test.ts',
    maxPins: 5,
    reason: '5 枚是工具合成样本的着色分因计数；audit-language 邻近车道在飞，未代登',
  },
];

describe('语料钉数守卫（按盘钉数必须登记指纹）', () => {
  const files = corpusGates(REPO_ROOT);

  it('受检面不为空：本仓确实有一批 `.corpus.test.ts` / 读 KOJO_SMOKE 的活闸', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('每一枚字面量钉数的语料闸都登记了指纹（点名未登记者；豁免逐条带上限）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const pins = literalPins(f.src);
      if (pins.length === 0) continue;
      if (registration(f.src).registered) continue;
      const e = EXEMPT.find((x) => x.rel === f.rel);
      if (e) {
        if (pins.length > e.maxPins) {
          offenders.push(
            `${f.rel}：豁免上限 ${e.maxPins} 枚，实测 ${pins.length} 枚（理由「${e.reason}」不覆盖新增）` +
              ` ⇒ 新增处 ${pins.slice(0, 3).map((p) => `L${p.line}: ${p.text}`).join(' ｜ ')}`,
          );
        }
        continue;
      }
      offenders.push(
        `${f.rel}：${pins.length} 枚字面量钉数且${registration(f.src).why}` +
          ` ⇒ 前 3 处 ${pins.slice(0, 3).map((p) => `L${p.line}: ${p.text}`).join(' ｜ ')}`,
      );
    }
    expect(offenders, `未登记指纹的按盘钉数闸（逐个点名）：\n${offenders.map((s) => `  - ${s}`).join('\n') || '  （无）'}`).toEqual([]);
  });

  it('登记表不是空壳：本轮改造的四枚闸都在登记面上', () => {
    const registered = files
      .filter((f) => f.rel !== 'tools/tests/corpus-pin-guard.test.ts') // 守卫自身不算闸（它 import 指纹模块只是为了自测）
      .filter((f) => registration(f.src).registered)
      .map((f) => f.rel)
      .sort();
    expect(registered).toEqual([
      'packages/kernel/tests/sugar-projection.corpus.test.ts',
      'packages/plugins/eratw-adapter/tests/call-slot-coverage.corpus.test.ts',
      'packages/plugins/erb-parser/tests/preproc-dead-range.test.ts',
      'packages/plugins/sav-parser/tests/golden-roundtrip.test.ts',
    ]);
  });

  it('读了语料环境变量的受检文件都必须带 skip/run 闸门（没盘时不许崩、也不许假绿）', () => {
    const unguarded = files
      .filter((f) => /process\.env\.KOJO_SMOKE|process\.env\.KOJO_CORPUS_DIR/.test(f.src))
      // `*.perf.test.ts` 不在本判据面：它只由 `vitest.perf.config.ts` 拉起跑，口径是"缺盘直接报错退出"，
      // 与单元面的 skip 语义不同（本轮禁跑 perf 面，见交付读数的口子清单）。
      .filter((f) => !f.rel.endsWith('.perf.test.ts'))
      .filter((f) => !/skipIf|runIf|testIf|it\.skip|describe\.skip/.test(f.src))
      .map((f) => f.rel);
    expect(unguarded).toEqual([]);
  });
});

describe('分析器反向对照（守卫自己必须真的会红）', () => {
  const SYNTHETIC = [
    "import { describe, expect, it } from 'vitest';",
    "const SMOKE = process.env.KOJO_SMOKE_PROJECT;",
    "describe.skipIf(!SMOKE)('合成闸', () => {",
    "  it('命中数', () => {",
    '    expect(issues).toHaveLength(37);',
    '    expect({ ranges: 41, deadLines: 399 }).toEqual({ ranges: 41, deadLines: 399 });',
    '    expect(stable).toEqual({',
    '      hits: 12,',
    '      timeout: 900_000,',
    '    });',
    '  });',
    '});',
  ].join('\n');

  it('字面量钉数逐枚点出（toHaveLength + 同行 toEqual + 跨行 toEqual 成员），夹具键不算', () => {
    const pins = literalPins(SYNTHETIC);
    expect(pins.map((p) => p.line)).toEqual([5, 6, 8]);
    expect(pins.map((p) => p.text).join('\n')).toContain('toHaveLength(37)');
  });

  it('同一枚合成源码 ⇒ 未登记（守卫的红判据成立）；登记形态才算过闸', () => {
    expect(registration(SYNTHETIC).registered).toBe(false);
    const withReg = `${SYNTHETIC}\nimport { resolvePinnedRow } from '../../../../tools/corpus-fingerprint.mjs';\nconst g = resolvePinnedRow('x', [], { erb: 1 });`;
    expect(registration(withReg).registered).toBe(true);
  });

  it('0/1、注释里的历史读数、纯夹具数字都不算钉数', () => {
    expect(
      literalPins('expect(a).toBe(0);\nexpect(b).toBe(1);\n// expect(c).toHaveLength(36)\nconst t = { timeout: 900_000, bytes: 865_900 };\n'),
    ).toHaveLength(0);
  });
});

describe('指纹模块自身的判据（不依赖语料盘）', () => {
  it('matchesFingerprint 只认字段；字段名拼错由 unknownPinFields 点名，且错行不得放行', () => {
    const fp = { erb: 10, erh: 2, digest: 'aa' };
    expect(matchesFingerprint(fp as never, { erb: 10, digest: 'aa' })).toBe(true);
    expect(matchesFingerprint(fp as never, { erhb: 2 })).toBe(false);
    expect(unknownPinFields({ erhb: 2, erb: 1 })).toEqual(['erhb']);
    expect(unknownPinFields({ erb: 1, digest: 'aa' })).toEqual([]);
    const current = blankFingerprint({ erb: 10, digest: 'aa' });
    const res = resolvePinnedRow('合成闸', [{ label: '登记行', fp: { erhb: 2 }, expect: { hits: 1 } }], current, { hits: 1 });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('字段名 erhb 不在指纹字段表里');
  });

  it('未知盘 ⇒ 红消息同时带 期望指纹 / 当前盘指纹 / 当前盘实测读数', () => {
    const rows = [{ label: '已知盘 A', fp: { erb: 1, digest: 'aaaa' }, expect: { hits: 36 } }];
    const current = blankFingerprint({ erb: 9, digest: 'bbbb' });
    const res = resolvePinnedRow('合成闸', rows, current, { hits: 40 }, []);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('【语料盘指纹不符】合成闸');
    expect(res.message).toContain(formatFingerprint(current));
    expect(res.message).toContain('当前盘实测读数：{"hits":40}');
    expect(res.message).toContain('digest:aaaa');
    expect(res.message).toContain('这不是 skip 条件');
  });

  it('命中已知盘 ⇒ 直接取该盘期望，且不产生任何文案', () => {
    const rows = [{ label: '已知盘 A', fp: { erb: 9, digest: 'bbbb' }, expect: { hits: 40 } }];
    const res = resolvePinnedRow('合成闸', rows, blankFingerprint({ erb: 9, digest: 'bbbb' }), { hits: 40 });
    expect(res.ok).toBe(true);
    expect(res.row?.expect).toEqual({ hits: 40 });
    expect(res.message).toBe('');
  });

  it('sav 候选读数把每份盘的档名列清楚（金样本定位失败时用它）', () => {
    const readout = savCandidatesReadout([
      { dir: 'D:/one', erbCount: 1, savCount: 2, fp: { savFiles: 2, savNames: ['global.sav', 'save1000.sav'] } },
    ] as never);
    expect(readout).toContain('global.sav/save1000.sav');
    expect(savCandidatesReadout([] as never)).toContain('没有符合内容条件');
  });

  it('真盘复算：同一目录两次调用给出同一指纹（判据必须可复跑）', () => {
    const dir = process.env.KOJO_SMOKE_PROJECT || process.env.KOJO_CORPUS_DIR;
    if (!dir) return;
    const a = corpusFingerprint(dir);
    const b = corpusFingerprint(dir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.erb).toBeGreaterThan(100);
    expect(a.digest).toHaveLength(12);
  }, 300_000);
});

/** 造一枚最小可用的指纹对象（字段表与 `tools/corpus-fingerprint.mjs` 同步） */
function blankFingerprint(over: Record<string, string | number>) {
  return {
    v: 'fp1',
    erb: 0,
    erh: 0,
    als: 0,
    kojo: 0,
    kojo2: 0,
    srcBytes: 0,
    digest: '',
    savFiles: 0,
    savBytes: 0,
    savNames: [],
    savDigest: '',
    ...over,
  };
}
