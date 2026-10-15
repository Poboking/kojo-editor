/**
 * 批 B1 · 双色台词（`自机色:` + 行首 `你：`）。
 *
 * 判据（见 task）：
 *   ① 连续多行 `你：` 只发**一次** `SETCOLOR`，run 收尾发一次复原；
 *   ② `你：` / `「」`（角色台词）/ 旁白 三态混排的换色与复原；
 *   ③ `旁白色: 默认` 与 `旁白色: 作者色` 两口径（旁白变 D/非 D；`你：` **恒**非 D）；
 *   ④ 正文中间的「你」不误伤（只认**行首前缀**）；
 *   ⑤ `自机色:` 缺省：adapter 有缺省自机色 → 兜底上色、零诊断；两者皆缺 → `face-table-missing` + 退化旁白；
 *   ⑥ `着色` 块内自机台词 run 收尾须复原到**块色**（不是默认色）。
 *
 * 游戏知识只出现在测试里：缺省自机色取自 eraTW adapter 真表（`stubFaceTable()`）。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const t = (src: string, faceTable: KojoFaceTable = stubFaceTable()) =>
  createSugarTranspileService({ dictionary: stubDict, faceTable }).transpile(src);

const codesOf = (src: string, faceTable?: KojoFaceTable): string[] =>
  t(src, faceTable).diagnostics.map((d) => d.code);

/** 取正文函数 `@M_KOJO_MESSAGE_COM_K12_310_1` 内 `IF LOCAL`…`ENDIF` 的逐行（trim；跳过空行） */
function fnBody(src: string, faceTable: KojoFaceTable = stubFaceTable()): string[] {
  const ls = t(src, faceTable).erb.replace(/\r\n/g, '\n').split('\n');
  const fn = ls.findIndex((l) => l.trim() === '@M_KOJO_MESSAGE_COM_K12_310_1');
  const start = ls.findIndex((l, i) => i > fn && l.trim() === 'IF LOCAL');
  if (fn < 0 || start < 0) throw new Error(`找不到正文信封：\n${ls.join('\n')}`);
  const out: string[] = [];
  let depth = 0;
  for (let i = start + 1; i < ls.length; i++) {
    const s = ls[i]!.trim();
    if (s === 'ENDIF') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (/^IF\b/.test(s)) {
      depth++;
      continue;
    }
    if (depth === 0 && s.length > 0) out.push(s);
  }
  return out;
}

/** 去掉缺省自机色的 adapter 表（模拟"该适配器不支持自机色"） */
function faceTableNoPlayer(): KojoFaceTable {
  const { playerColor: _drop, ...rest } = stubFaceTable();
  void _drop;
  return rest as KojoFaceTable;
}

const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}`;
const you = (text: string): string => `    你：${text}\n`;

const PLAYER = '0x4682B4';

/* ============================================================================ */

describe('B1-① 连续 `你：` 行只发一次 SETCOLOR', () => {
  it('三连 `你：` → SETCOLOR 一次 + 复原一次；逐行非 D 打印', () => {
    const ls = fnBody(doc(you('第一句。') + you('第二句。') + you('第三句。')));
    expect(ls).toEqual([
      `SETCOLOR ${PLAYER}`,
      'PRINTFORMW 第一句。',
      'PRINTFORMW 第二句。',
      'PRINTFORMW 第三句。',
      'RESETCOLOR',
    ]);
  });

  it('半角 `你:` 前缀等价（前缀只影响输入）', () => {
    expect(fnBody(doc('    你:来了。\n'))).toEqual([`SETCOLOR ${PLAYER}`, 'PRINTFORMW 来了。', 'RESETCOLOR']);
  });

  it('前缀后多出的空格**照原样保留**（不吞作者文本）', () => {
    expect(fnBody(doc('    你： 来了。\n'))).toEqual([`SETCOLOR ${PLAYER}`, 'PRINTFORMW  来了。', 'RESETCOLOR']);
  });

  it('负自证：run 被非自机行打断 → 第二段重新发 SETCOLOR（不是全程一次）', () => {
    const ls = fnBody(doc(you('甲。') + '    旁白一句。\n' + you('乙。')));
    expect(ls).toEqual([
      `SETCOLOR ${PLAYER}`,
      'PRINTFORMW 甲。',
      'RESETCOLOR',
      'PRINTFORMDW 旁白一句。',
      `SETCOLOR ${PLAYER}`,
      'PRINTFORMW 乙。',
      'RESETCOLOR',
    ]);
  });
});

describe('B1-② 三态混排的换色与复原', () => {
  it('`你：` / `「」` / 旁白 混排 → SETCOLOR×2 + 复原×2，次序正确', () => {
    const ls = fnBody(
      doc(you('我先说。') + '    「角色台词」\n' + '    旁白一句。\n' + you('我再说。')),
    );
    expect(ls).toEqual([
      `SETCOLOR ${PLAYER}`,
      'PRINTFORMW 我先说。',
      'RESETCOLOR',
      'PRINTFORMW 「角色台词」', // 角色台词 = 非 D（吃角色色）
      'PRINTFORMDW 旁白一句。', // 旁白默认 → D 系
      `SETCOLOR ${PLAYER}`,
      'PRINTFORMW 我再说。',
      'RESETCOLOR',
    ]);
  });

  it('自机台词**不加引号**、前缀被剥掉（`你：「X」` 的引号随文本保留，不额外包一层）', () => {
    expect(fnBody(doc(you('「引用别人的话」')))).toContain('PRINTFORMW 「引用别人的话」');
  });
});

describe('B1-③ `旁白色:` 两口径', () => {
  it('`旁白色: 默认`：旁白走 D 系；`你：` 恒非 D', () => {
    const src = '角色: 12\n旁白色: 默认\n时机 指令 310：\n    旁白一句。\n' + you('自机一句。');
    const ls = fnBody(src);
    expect(ls).toEqual(['PRINTFORMDW 旁白一句。', `SETCOLOR ${PLAYER}`, 'PRINTFORMW 自机一句。', 'RESETCOLOR']);
  });

  it('`旁白色: 作者色`：旁白也非 D；`你：` 仍走自机色（无视旁白色口径）', () => {
    const src = '角色: 12\n旁白色: 作者色\n时机 指令 310：\n    旁白一句。\n' + you('自机一句。');
    const ls = fnBody(src);
    // 旁白不再带 D；自机台词照旧 SETCOLOR + 非 D
    expect(ls).toEqual(['PRINTFORMW 旁白一句。', `SETCOLOR ${PLAYER}`, 'PRINTFORMW 自机一句。', 'RESETCOLOR']);
  });
});

describe('B1-④ 正文中间的「你」不误伤', () => {
  it('句中「你」/「你：」都不是自机台词行（只认行首前缀）', () => {
    const ls = fnBody(doc('    我喜欢你。\n' + '    就这样，你：好的。\n' + '    你说得对。\n'));
    expect(ls).toEqual(['PRINTFORMDW 我喜欢你。', 'PRINTFORMDW 就这样，你：好的。', 'PRINTFORMDW 你说得对。']);
    // 一句 SETCOLOR 都不许有（没被误当自机台词）
    expect(ls.some((l) => l.startsWith('SETCOLOR'))).toBe(false);
  });
});

describe('B1-⑤ `自机色:` 缺省行为', () => {
  it('未声明 `自机色:` 但 adapter 有缺省自机色 → 兜底上色，**零诊断**（选定的方案②）', () => {
    const src = doc(you('我来了。'));
    expect(codesOf(src)).not.toContain('face-table-missing');
    expect(fnBody(src)).toEqual([`SETCOLOR ${PLAYER}`, 'PRINTFORMW 我来了。', 'RESETCOLOR']);
  });

  it('作者 `自机色:` 优先于 adapter 缺省（显式声明覆盖兜底）', () => {
    const src = '角色: 12\n自机色: 0x102030\n时机 指令 310：\n' + you('我来了。');
    expect(fnBody(src)).toEqual(['SETCOLOR 0x102030', 'PRINTFORMW 我来了。', 'RESETCOLOR']);
  });

  it('两者皆缺省 → `face-table-missing` 告警 + 该行**退化**为普通旁白（去前缀、走 D），不静默', () => {
    const src = doc(you('我来了。'));
    const table = faceTableNoPlayer();
    expect(codesOf(src, table)).toContain('face-table-missing');
    expect(fnBody(src, table)).toEqual(['PRINTFORMDW 我来了。']);
  });
});

describe('B1-⑥ `着色` 块内自机台词 run 复原到**块色**', () => {
  it('块色 → 自机色 → 复原回块色（不是默认色）', () => {
    const src = doc(
      '    着色 0xFF0000：\n' +
        '        「红台词」\n' +
        '        你：自机\n' +
        '        「还是红台词」\n',
    );
    // 取 `着色` 块那一段（着色块不发信封，故直接看整段函数的 IF LOCAL 体）
    const ls = fnBody(src);
    expect(ls).toEqual([
      'SETCOLOR 0xFF0000',
      'PRINTFORMW 「红台词」',
      `SETCOLOR ${PLAYER}`,
      'PRINTFORMW 自机',
      'SETCOLOR 0xFF0000', // 复原到块色（缺此步则后续非 D 行丢色）
      'PRINTFORMW 「还是红台词」',
      'RESETCOLOR',
    ]);
  });

  it('无环境色时 run 收尾仍打 `RESETCOLOR`（顶层不受影响）', () => {
    expect(fnBody(doc(you('甲。') + '    「乙」\n'))).toContain('RESETCOLOR');
  });
});
