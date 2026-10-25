import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStructure,
  loadTruth,
  projectControlFlow,
  projectPreproc,
  serializeSkipHeader,
  serializeStructure,
} from '../tools/gen-erb-structure.mjs';

/**
 * 投影单源守卫：`src/structure.json` / `src/skip-marker.h` 只能来自
 * `packages/plugins/erb-parser/src/scanner.ts` 的活模块 + 源码等值判据，
 * 而 `preproc` 段只能来自 `packages/plugin-api/src/erb.ts` 的 `ERB_PREPROC_PATTERNS`。
 *
 * 三道闸：
 * (a) 字节闸——committed 产物与重新生成逐字节一致（走生成器 CLI 的 --check 码路 + 纯函数复核）；
 * (b) 语义闸——控制词的角色/配对与 scanner.ts 的 `classifyControlFlow` 逐词相等；`#DIM` 族每个
 *     投影名都能被真源 `parseDimDeclaration` 认出来；预处理三枚与契约真源**逐枚等值**（(b4)）；
 * (c) 变异闸——给投影器换一份词表 + 分类函数，产物必须立刻跟着变（证明它真吃输入而不是另抄）。
 * 另加：grammar.js 代码区零手抄（控制词 / 等值标记 / DIM 指令名都不许出现在字面量里）。
 */

const PKG = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(PKG, '..', '..');
const STRUCTURE_PATH = path.join(PKG, 'src', 'structure.json');
const HEADER_PATH = path.join(PKG, 'src', 'skip-marker.h');
/** 预处理三枚正则的契约真源（投影的第二枚真源，与 scanner.ts 并列） */
const PREPROC_SOURCE_PATH = path.join(REPO, 'packages', 'plugin-api', 'src', 'erb.ts');

const truth = await loadTruth();
const committed = JSON.parse(readFileSync(STRUCTURE_PATH, 'utf8')) as ReturnType<typeof buildStructure>;
const fresh = buildStructure(truth);

describe('ERB 结构投影单源守卫', () => {
  it('(a) 字节闸：committed structure.json / skip-marker.h 与重新生成逐字节一致', () => {
    // ① CLI --check（不一致它自己退非 0）
    execFileSync(process.execPath, [path.join(PKG, 'tools', 'gen-erb-structure.mjs'), '--check'], {
      stdio: 'pipe',
    });
    // ② 纯函数复核（防 --check 与写盘码路分叉）
    expect(readFileSync(STRUCTURE_PATH, 'utf8')).toBe(serializeStructure(fresh));
    expect(readFileSync(HEADER_PATH, 'utf8')).toBe(serializeSkipHeader(fresh));
  });

  it('(a2) 确定性：同输入两次投影逐字节相同', () => {
    expect(serializeStructure(buildStructure(truth))).toBe(serializeStructure(buildStructure(truth)));
  });

  it('(b) 语义闸：控制词角色/配对与 scanner.ts 的 classifyControlFlow 逐词相等', async () => {
    const scanner = await import('../../plugins/erb-parser/src/scanner.ts');
    const words = new Set<string>(scanner.ERB_CONTROL_STATEMENTS);
    const projected = new Set<string>([
      ...Object.keys(fresh.controlFlow.open),
      ...Object.keys(fresh.controlFlow.branch),
      ...Object.keys(fresh.controlFlow.close),
      ...fresh.controlFlow.leaf,
    ]);
    expect([...projected].sort()).toEqual([...words].sort());

    for (const word of words) {
      const c = scanner.classifyControlFlow(word);
      expect(c, `${word} 在真源里无分类`).not.toBeNull();
      if (c!.role === 'open') expect(fresh.controlFlow.open[word], `${word} open 配对`).toBe(c!.pair);
      else if (c!.role === 'branch') expect(fresh.controlFlow.branch[word], `${word} branch 配对`).toBe(c!.pair);
      else if (c!.role === 'close') expect(fresh.controlFlow.close[word], `${word} close 配对`).toBe(c!.pair);
      else expect(fresh.controlFlow.leaf, `${word} 应为 leaf`).toContain(word);
    }

    // 配对完整性：每个 open 类别有 close；每个 branch/close 都能回到一个 open 类别
    for (const [pair, p] of Object.entries(fresh.controlFlow.pairs)) {
      expect(p.open.length, `${pair} 无开块词`).toBeGreaterThan(0);
      expect(p.close.length, `${pair} 无收束词`).toBeGreaterThan(0);
      for (const w of [...p.open, ...p.branch, ...p.close]) expect(w, `${pair} 的词不是大写记号`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    // 覆盖面自证（不是空集自欺）
    expect(fresh.controlFlow.pairs.if?.open).toEqual(['IF']);
    expect(fresh.controlFlow.pairs.if?.branch).toEqual(['ELSE', 'ELSEIF']);
    expect(fresh.controlFlow.pairs.data?.close).toEqual(['ENDDATA']);
  });

  it('(b2) #DIM 族：投影的每个指令名都能被真源 parseDimDeclaration 认出来', async () => {
    const scanner = await import('../../plugins/erb-parser/src/scanner.ts');
    expect(fresh.dimDirectives.length).toBeGreaterThan(0);
    for (const d of fresh.dimDirectives) {
      const parsed = scanner.parseDimDeclaration(`#${d} PROBE_NAME`);
      expect(parsed?.directive, `#${d} 真源不认`).toBe(d);
      expect(parsed?.name).toBe('PROBE_NAME');
    }
    // 反证：不在投影里的近形不应被当成 DIM 族（避免投影把 `#DIMX` 收进来）
    expect(scanner.parseDimDeclaration('#DIMX PROBE_NAME')).toBeNull();
  });

  it('(b3) #DIM 修饰词：投影的每个词都能被真源 parseDimDeclaration 剥掉', async () => {
    const scanner = await import('../../plugins/erb-parser/src/scanner.ts');
    expect(fresh.dimModifiers.length).toBeGreaterThan(0);
    for (const mod of fresh.dimModifiers) {
      const parsed = scanner.parseDimDeclaration(`#DIM ${mod} PROBE_NAME`);
      expect(parsed?.directive, `#DIM ${mod} 真源不认修饰词`).toBe('DIM');
      expect(parsed?.name, `${mod} 没被剥成名字`).toBe('PROBE_NAME');
    }
  });

  it('(b4) 预处理三枚正则：JSON 的 open/branch/close/flags == plugin-api 真源的三段', async () => {
    const contract = await import('../../plugin-api/src/erb.ts');
    const roles = ['open', 'branch', 'close'] as const;
    for (const role of roles) {
      const truthRe = contract.ERB_PREPROC_PATTERNS[role];
      // ① committed 产物重建出的正则与真源**逐字符同源**（source 与 flags 两格都比）
      const committedRe = new RegExp(committed.preproc[role], committed.preproc.flags);
      expect(committedRe.source, `committed.preproc.${role} 与契约真源不同源`).toBe(truthRe.source);
      expect(committedRe.flags, `committed.preproc.${role} 的标志与契约真源不同`).toBe(truthRe.flags);
      // ② 现算的投影同样等于真源（证明 (a) 的字节闸不是唯一防线）
      const freshRe = new RegExp(fresh.preproc[role], fresh.preproc.flags);
      expect([freshRe.source, freshRe.flags], `fresh.preproc.${role}`).toEqual([truthRe.source, truthRe.flags]);
    }
    // ③ 行为对拍：语言包经投影得到的判据与契约层的 `erbPreprocRoleOf` 在同一样本集上同结果
    //    （样本集与 erb-parser 侧 `tests/preproc-block.test.ts` 那张对拍表同源）
    const { preprocRoleOf } = await import('../src/index');
    const samples = [
      '[IF XXX]', '[IF 口上]', '[IF_DEBUG]', '[IF_NDEBUG]', '[if xxx]', '[If_Debug]',
      '[ELSEIF XXX]', '[ELSE]', '[else]', '[ENDIF]', '[endif]',
      '[IF]', '[ENDIF] 尾巴', '[SKIPSTART]', '[RANDOMIZE]', '[[跳蛋]]', '[IF_DEBUG] 注',
      'IF X', 'ENDIF', '', '[IF_DEBUGX]', '[IF_DEBUG X]',
    ];
    for (const s of samples) {
      expect(preprocRoleOf(s), `${s}（语言包 vs 契约层）`).toBe(contract.erbPreprocRoleOf(s));
    }
    // ④ 标志纪律：投影出来的正则**无 `g`/`y`**（共享实例的 test() 必须无状态）
    expect(/[gy]/.test(fresh.preproc.flags), `preproc.flags = "${fresh.preproc.flags}"`).toBe(false);

    // ⑤ 零抄本：语言包的**代码区**不许再出现预处理标记词（判据只能来自 structure.json）
    const code = readFileSync(path.join(PKG, 'src', 'index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const word of ['IF_DEBUG', 'IF_NDEBUG', 'ELSEIF', 'ENDIF', 'ELSE']) {
      expect(code, `src/index.ts 代码区又出现手抄判据 ${word}（应经 structure.preproc 派生）`).not.toContain(word);
    }
  });

  it('(b5) 预处理投影 fail-closed：真源形态一变就抛，绝不静默留旧值', () => {
    const source = readFileSync(PREPROC_SOURCE_PATH, 'utf8');
    // ① 抽不到（真源没有那枚声明）
    expect(() => projectPreproc('export const 什么都不含 = 1;')).toThrow(/找不到/);
    // ② 缺角色（删掉 close 那一行）
    const noClose = source.replace(/^\s*close: \/\^\\\[ENDIF.*\n/m, '');
    expect(noClose).not.toBe(source);
    expect(() => projectPreproc(noClose)).toThrow(/close/);
    // ③ 标志换成有状态的 `g`（三枚都换：投影先比标志一致性，再查 g/y）
    const stateful = [
      'export const ERB_PREPROC_PATTERNS = Object.freeze({',
      '  open: /^[A]$/g,',
      '  branch: /^[B]$/g,',
      '  close: /^[C]$/g,',
      '});',
    ].join('\n');
    expect(() => projectPreproc(stateful)).toThrow(/有状态/);
    // ④ 三枚标志不一致（投影只有 flags 一格）
    const mixedFlags = source.replace(/^(\s*branch: )\/\S+\/i,$/m, '$1/^[PROBE]$/m,');
    expect(mixedFlags).not.toBe(source);
    expect(() => projectPreproc(mixedFlags)).toThrow(/标志不一致/);
    // ⑤ 一枚枚被拆成两行（投影按"一行一枚"抽取 ⇒ 必须叫，不许静默少一段）
    const splitEntry = source.replace(/^(\s*)open: (\/\S+\/i,)$/m, '$1open:\n$2');
    expect(splitEntry).not.toBe(source);
    expect(() => projectPreproc(splitEntry)).toThrow(/形态/);
    // ⑥ 正常源投影出的三段与 committed 一致（证明上面几条抛的是形态，不是判据本身写坏）
    expect(projectPreproc(source)).toEqual(committed.preproc);
    // ⑦ 换一枚真源正则 ⇒ 投影立刻跟着变（证明它真吃输入而不是另抄）
    const mutated = projectPreproc(source.replace('IF_DEBUG|IF_NDEBUG', 'IF_DEBUG|IF_PROBE'));
    expect(mutated.open).toContain('IF_PROBE');
    expect(mutated.open).not.toBe(committed.preproc.open);
  });

  it('(c) 变异闸：换一份词表 + 分类函数，投影立刻跟着变', () => {
    const fake = 'ZFAKE';
    const fakeEnd = 'ZFAKEEND';
    const classify = (w: string) => {
      if (w === fake) return { role: 'open' as const, pair: 'probe' };
      if (w === fakeEnd) return { role: 'close' as const, pair: 'probe' };
      return truth.classify(w);
    };
    const mutated = projectControlFlow([...truth.words, fake, fakeEnd], classify);
    expect(mutated.open[fake]).toBe('probe');
    expect(mutated.pairs.probe?.open).toEqual([fake]);
    expect(mutated.pairs.probe?.close).toEqual([fakeEnd]);
    // committed 产物此刻不含它（证明未重生成时 (a) 会红）
    expect(Object.keys(committed.controlFlow.open)).not.toContain(fake);
  });

  it('(d) 零抄本：grammar.js 代码区不含投影里的控制词 / 等值标记 / DIM 指令名', () => {
    const src = readFileSync(path.join(PKG, 'grammar.js'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const projectedNames = [
      ...Object.keys(fresh.controlFlow.open),
      ...Object.keys(fresh.controlFlow.branch),
      ...Object.keys(fresh.controlFlow.close),
      ...fresh.controlFlow.leaf,
      fresh.markers.skipStart,
      fresh.markers.skipEnd,
      ...fresh.dimDirectives,
      ...fresh.dimModifiers,
    ];
    // 只查"整条字符串字面量恰为投影名"（注释已剥；`'IF'` 这类手抄必红）
    const literals = [...stripped.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => (m[1] ?? m[2] ?? '').trim());
    const copied = [...new Set(literals.filter((l) => projectedNames.includes(l)))];
    expect(copied, `grammar.js 手抄了投影里的记号：${copied.join(' ')}`).toEqual([]);
    // 再查裸词（允许出现在诊断语之外？不存在：控制词都是大写 ASCII，代码区出现即抄本）
    const bare = projectedNames.filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n) && new RegExp(`\\b${n}\\b`).test(stripped));
    expect(bare, `grammar.js 代码区出现裸控制词：${bare.join(' ')}`).toEqual([]);
  });

  it('(e) folds.scm 覆盖投影里的每个配对类别与三类容器', () => {
    const folds = readFileSync(path.join(PKG, 'queries', 'folds.scm'), 'utf8');
    for (const node of ['function_block', 'branch_block', 'skip_block']) {
      expect(folds, `folds.scm 缺 (${node})`).toContain(`(${node}) @fold`);
    }
    for (const pair of Object.keys(fresh.controlFlow.pairs)) {
      expect(folds, `folds.scm 缺 (${pair}_block)`).toContain(`(${pair}_block) @fold`);
    }
  });
});
