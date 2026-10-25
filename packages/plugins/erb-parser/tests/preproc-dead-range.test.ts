/**
 * 预处理条件块 · 被裁支区间（A5 / P0-3 尾巴：分支变灰）。
 *
 * 判据不是"看起来像调试代码"，而是**引擎的裁剪条件**（Emuera
 * `ErbLoader.PPState.AddKeyWord`）：
 * - `[IF X]` / `[ELSEIF X]` ⇒ `GetMacro(X) == null` 即裁；
 * - `[IF_DEBUG]` / `[IF_NDEBUG]` ⇒ `Program.DebugMode`（编辑器不知道用户会怎么起引擎）；
 * - `[ELSE]` ⇒ 前面已有支执行（引擎的 `done`）才裁。
 *
 * 语料侧硬事实（eraTW 4.980 / eraNAS）：两个盘 `[IF …]` 的宏名只有 `DEBUG`（41 处）与
 * `NDEBUG`（1 处），且**没有任何文件 `#DEFINE DEBUG`**——引擎对这两个名字没有特例，
 * 所以它们在任何模式下都被裁（作者的意图多半是 `[IF_DEBUG]`，写法写错了）。
 * 这条读数正是"照引擎判"与"替作者猜"的分水岭，第二条用例把它钉住。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { collectPreprocDeadRanges, preprocMarkerAt } from '../src/structure';

const lines = (...rows: string[]): string => rows.join('\n');
const NONE: ReadonlySet<string> = new Set();
const SET = (...names: string[]): ReadonlySet<string> => new Set(names);

describe('preprocMarkerAt · 角色 + 宏名一次读全', () => {
  it('宏测试给出大写归一的名字；调试位与分支位没有名字', () => {
    expect(preprocMarkerAt('[IF 口上]')).toEqual({ role: 'open', macro: '口上', text: '[IF 口上]' });
    expect(preprocMarkerAt('[IF foo_bar]')).toEqual({ role: 'open', macro: 'FOO_BAR', text: '[IF foo_bar]' });
    expect(preprocMarkerAt('[IF_DEBUG]')).toEqual({ role: 'open', macro: null, text: '[IF_DEBUG]' });
    expect(preprocMarkerAt('[IF_NDEBUG]')).toEqual({ role: 'open', macro: null, text: '[IF_NDEBUG]' });
    expect(preprocMarkerAt('[ELSEIF XXX]')).toEqual({ role: 'branch', macro: 'XXX', text: '[ELSEIF XXX]' });
    expect(preprocMarkerAt('[ELSE]')).toEqual({ role: 'branch', macro: null, text: '[ELSE]' });
    expect(preprocMarkerAt('[ENDIF]')).toEqual({ role: 'close', macro: null, text: '[ENDIF]' });
  });

  it('不是裸宏名的一律不判（带运算符 / 多记号 / 数字开头）', () => {
    for (const s of ['[IF A B]', '[IF A==1]', '[IF !A]', '[IF 2FA]', '[IF A:B]']) {
      expect(preprocMarkerAt(s), s).toMatchObject({ role: 'open', macro: null });
    }
  });
});

describe('collectPreprocDeadRanges · 判据', () => {
  it('宏未定义 ⇒ 该支正文整段被裁（标记行不进区间）', () => {
    const text = lines('@F', '[IF FOO]', 'PRINTL A', 'PRINTL B', '[ENDIF]', 'RETURN');
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([
      { fromLine: 3, toLine: 4, marker: '[IF FOO]', macro: 'FOO' },
    ]);
  });

  it('宏已定义 ⇒ 一支都不压', () => {
    const text = lines('[IF FOO]', 'PRINTL A', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, SET('FOO'))).toEqual([]);
  });

  it('宏命中之后的 `[ELSEIF]` / `[ELSE]` 都被裁（引擎的 done）', () => {
    const text = lines('[IF FOO]', 'A1', '[ELSEIF BAR]', 'B1', '[ELSE]', 'C1', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, SET('FOO', 'BAR'))).toEqual([
      { fromLine: 4, toLine: 4, marker: '[ELSEIF BAR]', macro: 'BAR' },
      { fromLine: 6, toLine: 6, marker: '[ELSE]', macro: '' },
    ]);
  });

  it('前一支未命中、当前 ELSEIF 命中 ⇒ 只压前一支', () => {
    const text = lines('[IF FOO]', 'A1', '[ELSEIF BAR]', 'B1', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, SET('BAR'))).toEqual([
      { fromLine: 2, toLine: 2, marker: '[IF FOO]', macro: 'FOO' },
    ]);
  });

  it('`[IF_DEBUG]` / `[IF_NDEBUG]` 一律不判——含其后的 `[ELSE]`（两边都可能执行）', () => {
    const text = lines('[IF_DEBUG]', 'A1', '[ELSE]', 'B1', '[ENDIF]', '[IF_NDEBUG]', 'C1', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([]);
  });

  it('`[IF DEBUG]`（带空格）照引擎判：没有 `#DEFINE DEBUG` 就是死支', () => {
    // 语料现场：eraTW `UPDATE_VERSIONBASED.ERB` 的调试打印块
    const text = lines('[IF DEBUG]', 'PRINTFORMW See the debugger for output.', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([
      { fromLine: 2, toLine: 2, marker: '[IF DEBUG]', macro: 'DEBUG' },
    ]);
    // 项目里真有 `#DEFINE DEBUG`（自定义宏，与调试模式无关）⇒ 不压
    expect(collectPreprocDeadRanges(text, SET('DEBUG'))).toEqual([]);
  });

  it('没有索引（null / undefined）⇒ 一个都不判；空集照判（项目确实没有宏）', () => {
    const text = lines('[IF FOO]', 'A1', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, null)).toEqual([]);
    expect(collectPreprocDeadRanges(text, undefined)).toEqual([]);
    expect(collectPreprocDeadRanges(text, NONE)).toHaveLength(1);
  });

  it('空支不产区间（标记紧邻收尾）', () => {
    // `[IF FOO]` 未定义但正文为空；`[ELSE]` 被裁但正文也为空
    expect(collectPreprocDeadRanges(lines('[IF FOO]', '[ENDIF]', '[IF BAR]', '[ELSE]', '[ENDIF]'), NONE)).toEqual([]);
    expect(collectPreprocDeadRanges(lines('[IF BAR]', '[ELSE]', '[ENDIF]'), SET('BAR'))).toEqual([]);
    // 同一条 `[ELSE]` 支一旦有正文，就照常压
    expect(collectPreprocDeadRanges(lines('[IF BAR]', '[ELSE]', 'B1', '[ENDIF]'), SET('BAR'))).toEqual([
      { fromLine: 3, toLine: 3, marker: '[ELSE]', macro: '' },
    ]);
  });

  it('嵌套死区合并成一段（外层覆盖内层，不重复出区间）', () => {
    const text = lines('[IF OUTER]', 'A1', '[IF INNER]', 'B1', '[ENDIF]', 'A2', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([
      { fromLine: 2, toLine: 6, marker: '[IF OUTER]', macro: 'OUTER' },
    ]);
  });

  it('嵌套里活外死：内层不单独判（仍被外层覆盖）', () => {
    const text = lines('[IF OUTER]', 'A1', '[IF INNER]', 'B1', '[ENDIF]', 'A2', '[ENDIF]');
    expect(collectPreprocDeadRanges(text, SET('INNER'))).toEqual([
      { fromLine: 2, toLine: 6, marker: '[IF OUTER]', macro: 'OUTER' },
    ]);
  });

  it('未闭合的块：死区延伸到文件末尾（配对错误另由结构体检报）', () => {
    const text = lines('[IF FOO]', 'A1', 'A2');
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([
      { fromLine: 2, toLine: 3, marker: '[IF FOO]', macro: 'FOO' },
    ]);
  });

  it('孤儿 `[ENDIF]` / 孤儿 `[ELSE]` 不判（结构体检负责报，装饰层不替它兜底）', () => {
    expect(collectPreprocDeadRanges(lines('A1', '[ENDIF]', '[ELSE]', 'B1'), NONE)).toEqual([]);
  });

  it('`[SKIPSTART]` 区间里的标记不参与判定（引擎那段不编译）', () => {
    const text = lines('[SKIPSTART]', '[IF FOO]', 'A1', '[ENDIF]', '[SKIPEND]', 'B1');
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([]);
  });

  it('代码前缀 `;!;` / `;#;` 先剥再判（与结构体检同口径）', () => {
    const text = lines(';!;[IF FOO]', 'A1', ';!;[ENDIF]');
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([
      { fromLine: 2, toLine: 2, marker: '[IF FOO]', macro: 'FOO' },
    ]);
  });

  it('CRLF 与大小写：行号不漂、标记大小写不影响判据', () => {
    const text = '@F\r\n[if foo]\r\nA1\r\n[endif]\r\n';
    expect(collectPreprocDeadRanges(text, NONE)).toEqual([
      { fromLine: 3, toLine: 3, marker: '[if foo]', macro: 'FOO' },
    ]);
  });
});

/* ------------------------------ 语料活闸 ------------------------------ */

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

function dialectFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if ((ERB_DIALECT_EXTENSIONS as readonly string[]).includes(path.extname(p).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}

describe('A5 · 被裁支区间 × 真语料', () => {
  it.skipIf(!SMOKE)(
    '定义集走生产扫描路径；压下的每一支都必须真的没有 #DEFINE',
    { timeout: 900_000 },
    () => {
      const files = dialectFiles(path.join(SMOKE!, 'ERB'));
      expect(files.length).toBeGreaterThan(1_000);

      // 宏集走 `parseErbText`（索引里 `ErbFile.dims` 的同一条路），不另写一遍正则
      const defines = new Set<string>();
      const texts = new Map<string, string>();
      for (const p of files) {
        const text = readFileSync(p, 'utf8');
        texts.set(p, text);
        for (const d of parseErbText(text, p).dims) {
          if (d.directive.toUpperCase() === 'DEFINE') defines.add(d.name.toUpperCase());
        }
      }

      let ranges = 0;
      let deadLines = 0;
      let deadFiles = 0;
      const markers = new Map<string, number>();
      for (const [p, text] of texts) {
        const found = collectPreprocDeadRanges(text, defines);
        if (found.length === 0) continue;
        deadFiles += 1;
        for (const r of found) {
          ranges += 1;
          deadLines += r.toLine - r.fromLine + 1;
          markers.set(r.marker, (markers.get(r.marker) ?? 0) + 1);
          // 可解释闸：区间指着的正文行必须真的在那份文件里（行号不越界、不空指）
          expect(r.fromLine).toBeGreaterThanOrEqual(2);
          expect(r.toLine).toBeLessThanOrEqual(text.replace(/\r\n?/g, '\n').split('\n').length);
          // 判据闸：被压下的宏一定不在定义集里（否则就是压错了）
          if (r.macro !== '') expect(defines.has(r.macro)).toBe(false);
        }
      }

      // 规模闸（eraNAS 基线盘实测：`[IF DEBUG]` 1 处 / 1 行 / 1 文件）
      expect(defines.size).toBeGreaterThan(0);
      expect({ ranges, deadLines, deadFiles }).toEqual({ ranges: 1, deadLines: 1, deadFiles: 1 });
      expect([...markers]).toEqual([['[IF DEBUG]', 1]]);
    },
  );
});
