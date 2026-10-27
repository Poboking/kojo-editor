/**
 * 脚手架「库内现成案例」的**溯源守卫**（照 tutorial.test.ts E10 的写法）。
 *
 * 纪律：有案例的核心面（`CASE_STEMS`；宁缺勿编 2026-10-14 案例批 + 补捞批后为
 * 事件／日常指令／刻印取得／性骚扰指令 4 面，撤掉面的空壳必须**整块不出现**
 * 【库内现成案例】标题）——
 * 空壳注释里的案例块**逐字来自真实口上库现成函数**：
 * `fixtures/scaffold/<stem>.erb` 是库内摘取的原 ERB 片段，`<stem>.kojo1` 是用本仓
 * 升糖投影 `liftProject`（`kojo-sugar/src/project.ts`）转写、台词按类目简化后的
 * 糖片段；`scaffold.ts` 的 `FACE_CASES` 常量承载同一份文本（脚手架纯函数、无 IO）。
 * 本文件钉住这条链，任何一环被手改一个字都会被抓出：
 *
 * 1. **常量 ↔ fixture**：`FACE_CASES[stem].lines` 与 `<stem>.kojo1` 正文逐行一致；
 *    且 `<stem>.erb` / `<stem>.kojo1` 成对存在；
 * 2. **空壳 ↔ fixture**：生成的面文件里案例块每一行（去 `; ` 前缀、trimStart）都能在
 *    `<stem>.kojo1` 里逐字找到（类目占位行与来源注释行按白名单放行）；
 * 3. **fixture ↔ 库片段（现场重推导）**：从 `<stem>.erb` 出发重跑「台词类目化 +
 *    liftProject 投影」，产物必须等于 `<stem>.kojo1` 正文——证明糖片段真是工具转出来的，
 *    不是人手工抄的；
 * 4. **不变量**：面文件每一行都以 `;` 开头（无活函数）；案例块**不得出现** `.erb` 里
 *    被简化掉的真实台词文本（反向断言，并自带"检测器不是空转"的正样本自证）；
 * 5. **反向自证**：样例里改一个字必须被抓出（守卫不退化成永远通过）；
 * 6. **可写性守卫**（返工批 2026-10-14）：把每面案例正文拼成最小可转译文档
 *    （`角色: <数字>` 文件头 + 正文），喂给**真实转译服务**（createSugarTranspileService
 *    + 本包真实分野表 + 本包真实变量字典），要求**零 error 级诊断**（warn 放行）。
 *    示例是给人照抄进 `.kojo1` 的——转译报错的写法就不是示例。
 *
 * 说明：本文件是**测试**，按解耦审计 C 项豁免可跨包 import——装配走仓内先例
 * （`kernel/package.json` 把插件包列 devDependencies 后按**包名** import）：
 * `@kojo/plugin-kojo-sugar`（真实投影 + 真实转译服务）+ `@kojo/plugin-erb-parser`
 * （真实控制流扫描）+ 本包真实分野表 / 真实变量字典，与 kojo-sugar
 * tests/lift.test.ts 同一套口径（投影不注入字典 ⇒ 条件/变量一律原样）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, FileIO, Logger, SugarTranspileResult } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import {
  createSugarTranspileService,
  liftProject,
  type DictionaryLookup,
  type LiftDeps,
} from '@kojo/plugin-kojo-sugar';
import { CORE_FACES, FACE_CASES, buildFaceStub, type KojoScaffoldOptions } from '../src/scaffold';
import { createEratwFaceTable } from '../src/face-templates';
import { loadEratwVariableSchema } from '../src/variable-schema';

/* ============================== fixture 读取 ============================== */

const FIXTURE_DIR = new URL('../../../../fixtures/scaffold/', import.meta.url);

function fixturePath(stem: string, ext: 'erb' | 'kojo1'): string {
  return fileURLToPath(new URL(`${stem}.${ext}`, FIXTURE_DIR));
}

/** fixture 文件 → 去 BOM、统一 LF 后的行数组 */
function fixtureLines(stem: string, ext: 'erb' | 'kojo1'): string[] {
  return readFileSync(fixturePath(stem, ext), 'utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
}

/** fixture 第一行必须是来源注释（两文件同一份），其后空一行再是正文 */
function fixtureHeader(stem: string, ext: 'erb' | 'kojo1'): string {
  const first = fixtureLines(stem, ext)[0] ?? '';
  expect(first, `${stem}.${ext} 缺来源注释`).toMatch(/^; 来源：.+ :: @.+；摘取日期 2026-10-14$/);
  return first;
}

/** fixture 正文（去掉来源注释行与紧随的空行） */
function fixtureBody(stem: string, ext: 'erb' | 'kojo1'): string[] {
  const lines = fixtureLines(stem, ext);
  expect(lines[1] ?? '', `${stem}.${ext} 来源注释后应为空行`).toBe('');
  const body = lines.slice(2);
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  return body;
}

/* ============================== 升糖口径（与派生时一致） ============================== */

const liftDeps: LiftDeps = {
  transpile: (): SugarTranspileResult => {
    throw new Error('投影不调用转译器');
  },
  scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
  faceTable: () => createEratwFaceTable(),
};

const PRINT_RE = /^(\s*)(PRINT[A-Z]*)([ \t]+)([\s\S]*)$/;

/** 台词类目化：非空 PRINT 行的文本体换成占位（裸指令打空行不动） */
function simplifySpeech(lines: string[], category: string): string[] {
  return lines.map((l) => {
    const m = PRINT_RE.exec(l);
    if (!m) return l;
    if (m[4]!.trim().length === 0) return l;
    expect(l).not.toContain('HPH'); // 演出行不在案例取材范围内
    return `${m[1]}${m[2]} ${category}`;
  });
}

/** liftProject 整文件投影 → 逐行视图（段外原生行原样、段尾空行收缩） */
function projectView(snippet: string[]): string[] {
  const { segments } = liftProject(liftDeps, { source: `${snippet.join('\n')}\n` });
  const out: string[] = [];
  let cur = 0;
  for (const seg of segments) {
    for (let g = seg.fromLine - 1; cur < g; cur++) out.push(snippet[cur]!);
    out.push(...seg.sugarText.split('\n'));
    cur = seg.toLine;
  }
  while (cur < snippet.length) out.push(snippet[cur]!);
  while (out.length > 0 && out[out.length - 1]!.trim().length === 0) out.pop();
  return out;
}

/* ============================== 空壳解析 ============================== */

const CASE_HEAD_RE = /^; 【库内现成案例】照抄 /;
const CASE_TAIL_TEXT = '; 上面的编号与角色号来自那份现成口上，照你自己要写的场合改；写法详见「.kojo1 语言教程」。';

const stubOptions: KojoScaffoldOptions = {
  workName: '东方口上合集',
  authorName: '某作者',
  version: '1.0',
  charaNo: 1,
  charaName: '博丽 灵梦',
  scriptNo: 1,
  license: 'none',
  // LAU-3b-FLIP：案例块只在封存糖档出现，缺省档已翻原生 ⇒ 这里必须显式选糖档
  langDoc: 'sugar',
};

function stubFor(stem: string): string {
  const spec = CORE_FACES.find((f) => f.stem === stem)!;
  return buildFaceStub(spec, stubOptions, createEratwFaceTable());
}

/** 从空壳注释里切出案例正文行（去 `; ` 前缀；不含来源两行与收尾行） */
function caseBodyLines(stubText: string): string[] {
  const lines = stubText.split('\n');
  const head = lines.findIndex((l) => CASE_HEAD_RE.test(l));
  expect(head, '空壳缺【库内现成案例】块').toBeGreaterThanOrEqual(0);
  // head+1 = 「的 @函数名，…」行；正文从其下一行起，到收尾行为止（不含）
  const tail = lines.indexOf(CASE_TAIL_TEXT, head);
  expect(tail, '案例块缺收尾说明行').toBeGreaterThanOrEqual(0);
  return lines.slice(head + 2, tail).map((l) => (l.startsWith('; ') ? l.slice(2) : l === ';' ? '' : l));
}

/* ============================== 守卫工具（E10 口径） ============================== */

/** fixture 按行归一：trimStart、丢空行 */
function lineSet(lines: string[]): Set<string> {
  return new Set(lines.map((l) => l.trimStart()).filter((l) => l.length > 0));
}

/** 类目占位行白名单（亲密面／日常事件面） */
const PLACEHOLDER_PREFIXES = ['「涩涩的话」', '「日常的对话」'];

/** 样例里所有"在 fixture 中找不到"的行（空数组 = 逐字对得上；占位行放行） */
function driftedLines(sample: string[], allowed: Set<string>): string[] {
  return sample
    .map((line) => line.trimStart())
    .filter(
      (line) =>
        line.length > 0 &&
        !allowed.has(line) &&
        !PLACEHOLDER_PREFIXES.some((p) => line.startsWith(p)),
    );
}

/** .erb 中非空台词行的文本体（原样，含引号/插值） */
function dialogueBodies(erbBody: string[]): string[] {
  const out: string[] = [];
  for (const line of erbBody) {
    const m = PRINT_RE.exec(line);
    if (!m) continue;
    const body = m[4]!.trim();
    if (body.length === 0) continue; // 裸指令打空行：没有台词
    out.push(body);
  }
  return out;
}

/** 从 .erb 台词体里取"被简化掉的真实文本"片段（去引号、去 %…%/{…} 插值后 ≥4 字的连段） */
function dialogueFragments(erbBody: string[]): string[] {
  const frags: string[] = [];
  for (const line of erbBody) {
    const m = PRINT_RE.exec(line);
    if (!m) continue;
    const body = m[4]!;
    if (body.trim().length === 0) continue;
    const stripped = body.replace(/「/g, '').replace(/」/g, '').replace(/%[^%]*%/g, '').replace(/\{[^}]*\}/g, '');
    for (const run of stripped.split(/[\s，。、…！?？:：;；,.]+/)) {
      if (run.length >= 4) frags.push(run);
    }
  }
  return frags;
}

/* ============================== 用例 ============================== */

const STEMS = CORE_FACES.map((f) => f.stem);

/**
 * 有案例的面（宁缺勿编，2026-10-14 案例批 + 补捞批）：性交指令／奉仕指令／爱抚指令／绝顶
 * 的候选来源函数经真实管线实测（逐个截法跑「台词类目化 → liftProject → 转译」），
 * 投影形态要么作者写不出（`IF LOCAL && …` 信封截半 ⇒ `如果` 落 0 列报 indent-mismatch；
 * 缩进则 `LOCAL` 报 unknown-identifier；家族注记头报 timing-instruction-unknown），
 * 要么正文超 10 行、要么首闭合分支无台词——案例全部撤掉，fixture 一并删除。
 * 撤掉不是放行：下面额外钉"撤掉的面必须无案例键、无 fixture、空壳不得出现空的
 * 【库内现成案例】标题块"。
 */
const CASE_STEMS = ['事件', '日常指令', '刻印取得', '性骚扰指令'];
const REMOVED_STEMS = ['性交指令', '奉仕指令', '爱抚指令', '绝顶'];

describe('脚手架案例溯源守卫（fixtures/scaffold ↔ FACE_CASES ↔ 空壳注释）', () => {
  it('有案例的面齐全：FACE_CASES 键集恰好 = CASE_STEMS；.erb / .kojo1 成对存在；来源注释两文件一致', () => {
    expect(Object.keys(FACE_CASES).sort()).toEqual([...CASE_STEMS].sort());
    for (const stem of CASE_STEMS) {
      expect(existsSync(fixturePath(stem, 'erb')), `缺 fixtures/scaffold/${stem}.erb`).toBe(true);
      expect(existsSync(fixturePath(stem, 'kojo1')), `缺 fixtures/scaffold/${stem}.kojo1`).toBe(true);
      expect(fixtureHeader(stem, 'kojo1'), `${stem} 两 fixture 来源注释应一致`).toBe(
        fixtureHeader(stem, 'erb'),
      );
    }
    for (const stem of REMOVED_STEMS) {
      expect(FACE_CASES[stem], `${stem}：案例已撤，不许再有 FACE_CASES 键`).toBeUndefined();
      expect(existsSync(fixturePath(stem, 'erb')), `${stem}：案例已撤，不许留 .erb fixture`).toBe(false);
      expect(existsSync(fixturePath(stem, 'kojo1')), `${stem}：案例已撤，不许留 .kojo1 fixture`).toBe(false);
      expect(stubFor(stem), `${stem}：空壳不得输出【库内现成案例】标题块`).not.toContain('【库内现成案例】');
    }
  });

  it('FACE_CASES 常量与 <stem>.kojo1 正文逐字一致（单一真源 = fixture）', () => {
    for (const stem of CASE_STEMS) {
      expect(FACE_CASES[stem]!.lines, `${stem}：常量 ≠ fixture`).toEqual(fixtureBody(stem, 'kojo1'));
    }
  });

  it('空壳案例块每一行都能在对应 <stem>.kojo1 里逐字找到（占位行白名单放行）', () => {
    for (const stem of CASE_STEMS) {
      const allowed = lineSet(fixtureBody(stem, 'kojo1'));
      const drift = driftedLines(caseBodyLines(stubFor(stem)), allowed);
      expect(drift, `${stem}：案例块出现了 fixture 里没有的行`).toEqual([]);
    }
  });

  it('反向自证：改一个字就被抓出（守卫不是空转）', () => {
    const allowed = lineSet(fixtureBody('刻印取得', 'kojo1'));
    // 正样本：真实存在的行（含带缩进原样与 trimStart 两种写法）必须通过
    expect(driftedLines(['时机 标记：', '\t\t「日常的对话」', '\t如果 TFLAG:22 == 1：'], allowed)).toEqual([]);
    // 负样本：条件里改一个字（编号/变量不许漂移）必须被抓出
    expect(driftedLines(['如果 TFLAG:22 == 1!：'], allowed)).not.toEqual([]);
    expect(driftedLines(['时机 标记2：'], allowed)).not.toEqual([]);
  });

  it('<stem>.kojo1 现场重推导 == <stem>.erb 台词类目化后 liftProject（糖不是手抄的）', () => {
    for (const stem of CASE_STEMS) {
      const erb = fixtureBody(stem, 'erb');
      const category = FACE_CASES[stem]!.category;
      const derived = projectView(simplifySpeech(erb, category));
      expect(derived, `${stem}：.kojo1 ≠ 由 .erb 派生（重跑升糖对不上）`).toEqual(fixtureBody(stem, 'kojo1'));
    }
  });

  it('案例正文 ≤10 行', () => {
    for (const stem of CASE_STEMS) {
      expect(FACE_CASES[stem]!.lines.length, `${stem}：案例超过 10 行`).toBeLessThanOrEqual(10);
    }
  });

  it('不变量：面文件每行都以 `;` 开头（只有注释、没有活函数）', () => {
    for (const stem of STEMS) {
      for (const line of stubFor(stem).split('\n')) {
        if (line.trim() === '') continue;
        expect(line.startsWith(';'), `${stem}：出现非注释行 ${line}`).toBe(true);
      }
    }
  });

  it('不变量：案例块不得出现 .erb 里被简化掉的真实台词', () => {
    for (const stem of CASE_STEMS) {
      const stub = stubFor(stem);
      const bodies = dialogueBodies(fixtureBody(stem, 'erb'));
      expect(bodies.length, `${stem}：.erb 里没取到台词（取材或规则变了）`).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(stub, `${stem}：案例里漏出了真实台词「${body}」`).not.toContain(body);
      }
      for (const frag of dialogueFragments(fixtureBody(stem, 'erb'))) {
        expect(stub, `${stem}：案例里漏出台词片段「${frag}」`).not.toContain(frag);
      }
    }
  });

  it('台词反向断言自证：把真实台词塞进注释必须被同一条规则抓出', () => {
    const bodies = dialogueBodies(fixtureBody('刻印取得', 'erb'));
    expect(bodies.length).toBeGreaterThan(0);
    expect(stubFor('刻印取得')).not.toContain(bodies[0]!); // 干净样本：通过
    const polluted = `${stubFor('刻印取得')}; ${bodies[0]}\n`; // 负样本：同一条判断必须变红
    expect(polluted.includes(bodies[0]!)).toBe(true);
  });

  /* ============ 6. 可写性守卫（返工批 2026-10-14） ============ */

  /**
   * 真实变量字典：`loadEratwVariableSchema`（本包，CSV 驱动）+ 逐字摘自游戏
   * `CSV/` 的真实行（仅案例正文用到的变量族；IO 替身照 variable-schema.test.ts 先例）。
   * `VariableSchema → DictionaryLookup` 的适配镜像 kojo-sugar `makeLookup`
   * （该函数未导出；此处是测试装配，不是第二份产品逻辑）。
   */
  const ENGINE_VARIABLE_FAMILIES: readonly string[] = [
    'CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR',
    'FLAG', 'TFLAG', 'CALLNAME', 'NAME', 'JVEL', 'STAIN', 'DOWNBASE', 'CUP',
    'GOTJUEL', 'NOWEX', 'SOURCE',
  ];

  const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  /** 逐字摘自语料 `CSV/` 的真实名表行（只读摘录；够案例用到的族即可） */
  /**
   * 语料 `CSV/` 逐字摘录（游戏目录只读、测试不依赖游戏盘 ⇒ 内嵌；已对照
   * `C:\game\eratw-sub-modding-eratw4.980\CSV\{Talent,CFLAG,FLAG,TFLAG}.csv` 核对）。
   */
  const realCsvLines: Record<string, string> = {
    'Talent.csv': '3,恋慕,;愛情に似た感情を抱いている状態。=2で上位互換\n',
    'CFLAG.csv': '331,恶作剧\n',
    'FLAG.csv': '70,時間停止\n',
    'TFLAG.csv': '22,苦痛刻印取得\n',
  };

  async function realDictionary(): Promise<DictionaryLookup> {
    const io = {
      listDir: async (dir: string) =>
        Object.keys(realCsvLines).map((name) => ({ name, path: `${dir}/${name}`, isDirectory: false })),
      readText: async (path: string) => ({ text: realCsvLines[path.split('/').pop()!] ?? '', path }),
      // FileIO 契约的批量读（字典的两条读循环走这里）
      readTexts: async (paths: readonly string[]) =>
        paths.map((p) => ({ text: realCsvLines[p.split('/').pop()!] ?? '', path: p })),
    } as unknown as FileIO;
    const schema = await loadEratwVariableSchema({ io, csvDir: '/game/CSV', log: silentLog });
    return {
      resolveFamily(name: string): string | undefined {
        for (const family of ENGINE_VARIABLE_FAMILIES) {
          const info = schema.lookup(family, name);
          if (info && (info.description !== undefined || info.resolvedIndex !== undefined)) return family;
        }
        return undefined;
      },
      resolve(ident: string): string | undefined {
        const head = ident.split(':')[0]!.toUpperCase();
        return ENGINE_VARIABLE_FAMILIES.includes(head) ? ident : undefined;
      },
      nameAt(family: string, index: string): string | undefined {
        const name = schema.lookup(family, index)?.description;
        return name !== undefined && name.length > 0 ? name : undefined;
      },
    };
  }

  it('可写性守卫：案例正文拼成最小文档后转译必须零 error（warn 放行）', async () => {
    const dictionary = await realDictionary();
    const svc = createSugarTranspileService({ dictionary, faceTable: createEratwFaceTable() });
    const failing: Record<string, string[]> = {};
    for (const stem of CASE_STEMS) {
      const doc = `角色: 1\n${FACE_CASES[stem]!.lines.join('\n')}\n`;
      const { diagnostics } = svc.transpile(doc, { filePath: `packages/脚手架/${stem}.kojo1` });
      const errors = diagnostics.filter((d) => d.severity === 'error').map((e) => `${e.code}: ${e.message}`);
      if (errors.length > 0) failing[stem] = errors;
    }
    expect(failing, '案例不是可写糖形（作者照抄会转译报错）').toEqual({});
  });

  it('不变量：案例不得出现孤立 `续` 行（台词替换后的残渣不是作者写法）', () => {
    for (const stem of CASE_STEMS) {
      for (const line of FACE_CASES[stem]!.lines) {
        expect(/^\s*续\s*$/.test(line), `${stem}：出现孤立续行标记 ${line}`).toBe(false);
      }
    }
  });

  it('可写性守卫自证：把家族注记形态塞回案例必须被同一条规则抓出（守卫不空转）', async () => {
    const dictionary = await realDictionary();
    const svc = createSugarTranspileService({ dictionary, faceTable: createEratwFaceTable() });
    const run = (lines: string[]) =>
      svc
        .transpile(`角色: 1\n${lines.join('\n')}\n`, { filePath: '自证.kojo1' })
        .diagnostics.filter((d) => d.severity === 'error');
    // 正样本：纯数字编号
    expect(run(['时机 指令 88：', '\t「涩涩的话」'])).toEqual([]);
    // 负样本：投影加出来的家族注记头（本次返工的起因，逐字取自旧案例）
    expect(run(['时机 指令 88_1（TOKI版）：', '\t「涩涩的话」']).length).toBeGreaterThan(0);
    // 负样本（结构规则）：孤立 `续` 行由上面不变量测试兜住，这里自证该规则非空转
    expect(/^\s*续\s*$/.test('\t续')).toBe(true);
  });
});
