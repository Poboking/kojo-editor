/**
 * KW-36 P0：`editor.setCursor()` 的参数形状与**自证读数**（2026-11-03）。
 *
 * 现场（组长 2026-11-03 撞的，KW-14 验收因此扣住不推）：照 `{lineNumber, column}` 传参
 * ⇒ 页内求值抛错 / 光标没动，于是没法把光标放进某个函数体内去触发 `workbench.jumpToState`。
 *
 * 读实现得出的根因（不是猜的）：`install-debug.ts` 的 `setCursor(line, column)` 收的是**位置参数**，
 * 实现体直接 `ed.setPosition({ lineNumber: line, column })`。传对象时
 * `lineNumber` 拿到的是那个对象本身、`column` 是 `undefined` —— Monaco 那边要么抛要么静默夹到别处，
 * 而调试面**一律不抛**这条纪律只管得住 `editor.*At()` 那一族（1029 批新写的），
 * 既有的 `setCursor` 是裸的：脏值一路捅进 Monaco，报错形态是页内求值抛错，用户读不出"形状不对"。
 * 文档侧（`docs/DEBUG-MODE.md` §三）那一行只写了「定光标」，两个形状都没写 ⇒ 两套命名
 * （本族的 `line` 与 Monaco 的 `lineNumber`）夹出来的一次必然手滑。
 *
 * 钉三件事：
 * ① `normalizeCursorTarget` 纯函数：位置形态与对象形态**同义**，脏值 ⇒ `null`（不抛、不猜）；
 * ② 源形状：`setCursor` 必须先过归一再进 `setPosition`，且归一失败/没编辑器都如实 `false`
 *    （**绝不**把没归一的脏值喂进 Monaco——"看起来动了、实际停在隔壁"是这一族最难查的假绿）；
 * ③ 自证通道在场：`info()` 交回 `cursor:{line,column}`，判「有没有真落进去」读它
 *    （真机那条 readback 断言在 `tools/debug-web-smoke.mjs`，浏览器里跑）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeCursorTarget } from '../src/debug/install-debug';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const src = readFileSync(path.join(repoRoot, 'packages/app/src/debug/install-debug.ts'), 'utf8');

/** 抠出 `setCursor(line, column) { … }` 的实现体（从签名到下一个同级方法名） */
function setCursorImplBody(): string {
  const start = src.indexOf('      setCursor(line, column) {');
  expect(start, '实现体签名（setCursor(line, column)）应当在 install-debug.ts 里').toBeGreaterThan(-1);
  const rest = src.slice(start + 6);
  const end = rest.indexOf('\n      },');
  expect(end, 'setCursor 实现体应当有收尾').toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe('P0 · normalizeCursorTarget（两种形状 + 脏值一律归一）', () => {
  it('① 位置形态 (line, column) 与旧行为逐字相同', () => {
    expect(normalizeCursorTarget(7, 3)).toEqual({ line: 7, column: 3 });
    // column 缺席落 1（行首）——这不是放宽，是把"只想跳到第 7 行"这种常见写法说清
    expect(normalizeCursorTarget(7)).toEqual({ line: 7, column: 1 });
  });

  it('② 对象形态 {line, column} 与 {lineNumber, column} 同义（组长那次传的就是后者）', () => {
    expect(normalizeCursorTarget({ line: 12, column: 5 })).toEqual({ line: 12, column: 5 });
    expect(normalizeCursorTarget({ lineNumber: 12, column: 5 })).toEqual({ line: 12, column: 5 });
    // 两者都在时 line 优先（对象里 lineNumber 是 Monaco 写法，line 是本族写法）
    expect(normalizeCursorTarget({ line: 4, lineNumber: 99, column: 2 })).toEqual({ line: 4, column: 2 });
    expect(normalizeCursorTarget({ lineNumber: 9 })).toEqual({ line: 9, column: 1 });
  });

  it('③ 越界/脏值 ⇒ null（1 基、整数、>=1；NaN/Infinity/字符串/数组都不算目标）', () => {
    for (const bad of [
      undefined,
      null,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '12',
      [],
      {},
      { lineNumber: 0 },
      { lineNumber: -3, column: 1 },
      { line: 3, column: 0 },
      { line: 3, column: 'x' },
      { line: 3, column: Number.NaN },
    ]) {
      expect(normalizeCursorTarget(bad as never), `脏值应当归成 null：${JSON.stringify(bad) ?? String(bad)}`).toBeNull();
    }
    // 位置形态的 column 脏值同样整枚作废（不许"行收下、列悄悄落 1"）
    expect(normalizeCursorTarget(3, 0)).toBeNull();
    expect(normalizeCursorTarget(3, 'x' as unknown as number)).toBeNull();
  });

  it('④ 永不抛（这一族的口径：读不到就说读不到，不把异常糊到调试会话上）', () => {
    for (const weird of [Symbol('x') as unknown as number, () => 1, new Map()]) {
      expect(() => normalizeCursorTarget(weird as never)).not.toThrow();
      expect(normalizeCursorTarget(weird as never)).toBeNull();
    }
  });
});

describe('P0 · 源形状钉子（setCursor 真的过归一，readback 通道在场）', () => {
  it('① 实现先归一、脏值即 false，绝不把未归一的入参喂进 setPosition', () => {
    const body = setCursorImplBody();
    expect(body).toContain('normalizeCursorTarget(');
    expect(body).toContain('if (target === null) return false;');
    // 进 Monaco 的只能是归一后的那两枚数
    expect(body).toContain('ed.setPosition({ lineNumber: target.line, column: target.column })');
    expect(body).not.toContain('{ lineNumber: line, column }');
    // setPosition 自己抛（越界/内部形状）也如实 false，不假装光标过去了
    expect(body).toContain('catch');
  });

  it('② 契约签名两种形态都收（additive：位置参数的既有语义逐字不变）', () => {
    expect(src).toContain('setCursor(line: number | DebugCursorInput, column?: number): boolean;');
    // 契约里旧的"必须两个位置参数"已撤——留着就是文档与实现再次打架
    expect(src).not.toContain('setCursor(line: number, column: number): boolean;');
  });

  it('③ 自证读数通道：info() 交回 cursor:{line,column}（真机断言读它，不读"没抛错"）', () => {
    expect(src).toContain('cursor: { line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 }');
    expect(src).toContain('readonly cursor: { readonly line: number; readonly column: number };');
  });
});
