/**
 * `@kojo/erb-vocab` 的**分层守卫 + 共享事实黄金对拍**（2026-10-31 ERB 分层债复核批）。
 *
 * 本包立起来的唯一理由是把"库与插件都要读的语言事实"放到**非插件层**：`@kojo/erb-lang`
 * （语言面库）与插件 `@kojo/plugin-erb-parser` 是**并列读者**，谁也不引谁。2026-10-30 之前
 * 这张表住在插件里、库包反过来 import 插件包——**分层倒置**（上一波验收记下的债）。
 *
 * 债务清掉之后，危险的不是"今天错了"，而是"下次又长回来"，而且长回来时**没有任何一处会红**：
 * 库包引插件包在单测里照样能跑（别名表两条都通），只在分层意义上错。故这里钉三个判据：
 *
 * 1. **零外部依赖**（比"不许引插件"更强的形式）：src 的每条 import 都是本包内相对路径，
 *    因此不可能指向任何插件；顺带保住"裸 node 类型擦除档能直接吃"这条（构建期投影脚本
 *    `erb-syntax-tree/tools/gen-erb-structure.mjs` 就靠它）；清单 `dependencies` 也必须是空的；
 * 2. **零 Monaco / React / DOM / IO / 游戏名词**（与本仓其余纯库守卫同口径）；
 * 3. **共享事实黄金**：配对表、`#DIM` 族两枚正则、导出面逐字钉住——库包与插件的行为
 *    "逐字不变"由这里兜底，任何一枚漂了（含"有人另抄一份再让库读插件那份"）当场红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as controlFlow from '@kojo/erb-vocab/control-flow';
import {
  DIM_MODIFIERS,
  DIM_RE,
  ERB_CONTROL_STATEMENTS,
  classifyControlFlow,
  closerNameForPair,
} from '@kojo/erb-vocab/control-flow';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const PKG = fileURLToPath(new URL('../package.json', import.meta.url));

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(name)) out.push(abs);
    }
  };
  walk(SRC);
  return out.sort();
}

/** 一条 import/export-from 语句里的模块 specifier（含 `import type` / 裸 import / re-export） */
const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const BARE_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function specifiersOf(src: string): string[] {
  return [
    ...[...src.matchAll(SPEC_RE)].map((m) => m[1] as string),
    ...[...src.matchAll(BARE_RE)].map((m) => m[1] as string),
  ];
}

describe('@kojo/erb-vocab 是分层上的中立词表包（不可能是倒置的任一端）', () => {
  const files = sources();

  it('扫到的文件数与预期一致（防止走空匹配）', () => {
    // control-flow（共享事实）/ index（桶）。加一枚必须显式改这里。
    expect(files.map((f) => path.basename(f))).toEqual(['control-flow.ts', 'index.ts']);
  });

  it('src 零外部依赖（**强于**"不许引插件"：连任何包名都不许出现）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) continue;
        offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('清单 dependencies / peerDependencies 为空（装不出插件来）', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect({
      dependencies: pkg.dependencies ?? {},
      peerDependencies: pkg.peerDependencies ?? {},
      optionalDependencies: pkg.optionalDependencies ?? {},
    }).toEqual({ dependencies: {}, peerDependencies: {}, optionalDependencies: {} });
  });

  it('零 monaco / 零 react / 零 DOM / 零 node IO', () => {
    const banned = /^(monaco-editor|react|react-dom|@tauri-apps\/.*|node:.*|fs|path|os|crypto)$/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (banned.test(spec)) offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零游戏名词（同 audit:decoupling 的 A 项口径）', () => {
    const gameWords = /eratw|erafl|eraakumamaid|eratoho|キャラ|CFLAG|TFLAG/i;
    const offenders = files.filter((file) => gameWords.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});

describe('共享事实黄金对拍（库与插件"逐字不变"的兜底）', () => {
  it('导出面逐字（加一枚共享值必须显式改这里）', () => {
    expect(Object.keys(controlFlow).sort()).toEqual([
      'DIM_MODIFIERS',
      'DIM_RE',
      'ERB_CONTROL_STATEMENTS',
      'classifyControlFlow',
      'closerNameForPair',
    ]);
  });

  it('引擎语句词表逐字（44 枚，码元序）', () => {
    expect(ERB_CONTROL_STATEMENTS).toEqual([
      'CASE',
      'CASEELSE',
      'CATCH',
      'DATALIST',
      'DO',
      'ELSE',
      'ELSEIF',
      'ENDCATCH',
      'ENDDATA',
      'ENDFUNC',
      'ENDIF',
      'ENDLIST',
      'ENDNOSKIP',
      'ENDSELECT',
      'FOR',
      'IF',
      'LOOP',
      'NEXT',
      'NOSKIP',
      'PRINTDATA',
      'PRINTDATAD',
      'PRINTDATADL',
      'PRINTDATADW',
      'PRINTDATAK',
      'PRINTDATAKL',
      'PRINTDATAKW',
      'PRINTDATAL',
      'PRINTDATAW',
      'REND',
      'REPEAT',
      'SELECTCASE',
      'SIF',
      'STRDATA',
      'TRYCALLLIST',
      'TRYCCALL',
      'TRYCCALLFORM',
      'TRYCGOTO',
      'TRYCGOTOFORM',
      'TRYCJUMP',
      'TRYCJUMPFORM',
      'TRYGOTOLIST',
      'TRYJUMPLIST',
      'WEND',
      'WHILE',
    ]);
  });

  it('角色分类逐字（含 TRY 系三档与单行语句的边界）', () => {
    const words = [
      'IF',
      'ENDIF',
      'ELSEIF',
      'ELSE',
      'CASE',
      'CASEELSE',
      'CATCH',
      'ENDCATCH',
      'SIF',
      'TRYCALL',
      'TRYCALLFORM',
      'TRYCCALL',
      'TRYCALLLIST',
      'PRINTDATA',
      'PRINTDATADW',
      'DIM',
      'FOO',
    ];
    expect(words.map((w) => [w, classifyControlFlow(w)])).toEqual([
      ['IF', { role: 'open', pair: 'if' }],
      ['ENDIF', { role: 'close', pair: 'if' }],
      ['ELSEIF', { role: 'branch', pair: 'if' }],
      ['ELSE', { role: 'branch', pair: 'if' }],
      ['CASE', { role: 'branch', pair: 'select' }],
      ['CASEELSE', { role: 'branch', pair: 'select' }],
      ['CATCH', { role: 'branch', pair: 'try' }],
      ['ENDCATCH', { role: 'close', pair: 'try' }],
      ['SIF', { role: 'leaf', pair: '' }],
      ['TRYCALL', null],
      ['TRYCALLFORM', null],
      ['TRYCCALL', { role: 'open', pair: 'try' }],
      ['TRYCALLLIST', { role: 'open', pair: 'funclist' }],
      ['PRINTDATA', { role: 'open', pair: 'data' }],
      ['PRINTDATADW', { role: 'open', pair: 'data' }],
      ['DIM', null],
      ['FOO', null],
    ]);
  });

  it('配对类别 → 闭合词逐字（反查，不抄第二份表）', () => {
    const pairs = ['if', 'select', 'for', 'while', 'repeat', 'do', 'data', 'list', 'noskip', 'try', 'funclist', 'nope'];
    expect(pairs.map((p) => [p, closerNameForPair(p)])).toEqual([
      ['if', 'ENDIF'],
      ['select', 'ENDSELECT'],
      ['for', 'NEXT'],
      ['while', 'WEND'],
      ['repeat', 'REND'],
      ['do', 'LOOP'],
      ['data', 'ENDDATA'],
      ['list', 'ENDLIST'],
      ['noskip', 'ENDNOSKIP'],
      ['try', 'ENDCATCH'],
      ['funclist', 'ENDFUNC'],
      ['nope', ''],
    ]);
  });

  it('`#DIM` 族正则逐字（交替次序：长的在前）', () => {
    const cases = ['#DIM x, 10', '#DIMF y', '#DIMSTR s, 10', '#DEFINE Z 1', '#DIMX q', '#DIM  R'];
    expect(cases.map((s) => [s, DIM_RE.exec(s)?.slice(1) ?? null])).toEqual([
      ['#DIM x, 10', ['DIM', 'x, 10']],
      ['#DIMF y', ['DIMF', 'y']],
      ['#DIMSTR s, 10', ['DIMSTR', 's, 10']],
      ['#DEFINE Z 1', ['DEFINE', 'Z 1']],
      ['#DIMX q', null],
      ['#DIM  R', ['DIM', 'R']],
    ]);
  });

  it('声明前置修饰词逐字', () => {
    const cases = ['CONST X', 'SAVEDATA Y', 'GLOBAL Z', 'CHARADATA W', 'LOCAL L', 'X Y', 'CONSTX'];
    expect(cases.map((s) => [s, DIM_MODIFIERS.exec(s)?.[1] ?? null])).toEqual([
      ['CONST X', 'CONST'],
      ['SAVEDATA Y', 'SAVEDATA'],
      ['GLOBAL Z', 'GLOBAL'],
      ['CHARADATA W', 'CHARADATA'],
      ['LOCAL L', 'LOCAL'],
      ['X Y', null],
      ['CONSTX', null],
    ]);
  });
});