/**
 * 语言档的 eraTW 侧产物判据（NEW-ERB 2026-10-20）。
 *
 * 三条硬账，一条都不许是"改前改后都过"的空测试：
 * ① **默认档逐字节不变**——与**改前金样**（`tests/fixtures/default-sugar/`，见下方出处注）
 *    逐文件比字节；抬默认档动任何一个字节都红；
 * ② **原生档不含糖记号**——判据用的是 kojo-sugar 的**真实词表** `lookupKeyword`
 *    （不是本文件自己数的关键字），糖档那几个带案例的面必须**有**命中（否则 ② 是空判据）；
 * ③ **原生档真的走通下游**——`erb-parser` 的**真实索引函数**扫得到它，
 *    制品计划 `planArtifacts` 对它**一次编译器都不叫**、字节原样携带。
 *
 * 哈希一律不在本文件现算：全仓 SHA-256 实现只许住 `kojo-market/src/digest.ts`
 * （`kojo-market/tests/single-source.test.ts` 守着，测试文件也在它的扫描面内），
 * 所以改前基线交金样文件、比对交字节。
 */
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbIndex, ErbParserService, EventBus, FileIO, PluginContext, ScaffoldFileSet, Unsubscribe } from '@kojo/plugin-api';
import { ERB_BODY_EXTENSIONS, isErbDialectPath, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../../erb-parser/src/plugin';
import { makeComputeStub } from '../../erb-parser/tests/support';
import { lookupKeyword } from '../../kojo-sugar/src/keywords';
import {
  DEFAULT_KOJO_LANG_DOC,
  composeScaffoldDraft,
  kojoLangDocExtension,
  readScaffoldLangDocs,
  type KojoScaffoldDraft,
} from '@kojo/kojo-project-kit';
import { planArtifacts } from '../../../kojo-project-kit/src/artifact';
import { ERATW_SCAFFOLD_DEPS } from '../src/new-project-wizard';
import {
  CORE_FACES,
  FACE_CASES,
  FACE_STUB_EXT,
  scaffoldKojoProject,
  scaffoldStubExt,
  type KojoScaffoldOptions,
} from '../src/scaffold';

const BASE: Omit<KojoScaffoldOptions, 'langDoc'> = {
  workName: '取证作品',
  authorName: '取证作者',
  version: '1.0',
  charaNo: 63,
  charaName: '影狼',
  scriptNo: 1,
  license: 'none',
};

/**
 * 默认档（糖）产物的**改前逐字节金样**：`tests/fixtures/default-sugar/`。
 *
 * 出处（可复核，不是"跑出来的现在态"）：2026-10-20 在 `origin/dev` = `7b81e59` 的
 * **未改动工作树**上取同一组输入的产物，逐文件 SHA-256 记在案（本文件头注那次
 * 取证运行），落地实现后先核对九份金样与那九个摘要逐字相等，再入库为 golden。
 * 因此这里比的是字节：`expect(bytes).toEqual(golden)`。
 * 仓库 `.gitattributes` 是 `* text=auto eol=lf`，checkout 必得 LF ⇒ 金样与产物同为
 * LF 字节，`sugar.test.ts` 那套 golden 靠同一条纪律成立，这里照搬。
 */
const GOLDEN_DIR = nodePath.join(import.meta.dirname, 'fixtures', 'default-sugar');
const DEFAULT_KEYS = [
  'README.md',
  '事件.kojo',
  '日常指令.kojo',
  '性交指令.kojo',
  '奉仕指令.kojo',
  '爱抚指令.kojo',
  '绝顶.kojo',
  '刻印取得.kojo',
  '性骚扰指令.kojo',
] as const;

/** 金样读成字节（不给任何规范化机会：行尾 / BOM / 空白都在比较范围内） */
const goldenBytes = (rel: string): Uint8Array => new Uint8Array(readFileSync(nodePath.join(GOLDEN_DIR, rel)));
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/* ───────────────────────── ① 默认档逐字节不变 ───────────────────────── */

describe('① 默认档：与改前逐字节相同（抬默认行为必红）', () => {
  it('九个文件的键序与逐文件字节全等于改前金样', () => {
    const out = scaffoldKojoProject(BASE);
    expect(Object.keys(out.files)).toEqual([...DEFAULT_KEYS]);
    expect(out.dirName).toBe('取证作品-影狼 v1.0');
    const drift = DEFAULT_KEYS.filter((rel) => {
      const text = out.files[rel];
      if (text === undefined) return true;
      const got = bytesOf(text);
      const want = goldenBytes(rel);
      return got.length !== want.length || !got.every((b, i) => b === want[i]);
    });
    expect(drift, '与改前金样不一致的文件').toEqual([]);
  });

  it('金样本体自证：糖档扩展名就是那枚单源常量（金样目录名不会自己骗自己）', () => {
    for (const rel of DEFAULT_KEYS.slice(1)) expect(rel.endsWith(FACE_STUB_EXT)).toBe(true);
  });

  it('显式糖档 == 不传该字段（缺省即历史行为）', () => {
    const withSugar = scaffoldKojoProject({ ...BASE, langDoc: 'sugar' });
    const without = scaffoldKojoProject(BASE);
    expect(withSugar.dirName).toBe(without.dirName);
    expect(Object.keys(withSugar.files)).toEqual(Object.keys(without.files));
    for (const rel of Object.keys(without.files)) expect(withSugar.files[rel]).toBe(without.files[rel]);
  });

  it('糖档扩展名 = 契约单源，不是本包自己抄的一份', () => {
    expect(FACE_STUB_EXT).toBe(KOJO_SOURCE_EXTENSION);
    expect(scaffoldStubExt(undefined)).toBe(KOJO_SOURCE_EXTENSION);
    expect(scaffoldStubExt('sugar')).toBe(KOJO_SOURCE_EXTENSION);
    expect(scaffoldStubExt('native')).toBe(kojoLangDocExtension('native'));
    expect(scaffoldStubExt('native')).toBe(ERB_BODY_EXTENSIONS[0]!.toUpperCase());
  });
});

/* ───────────────────── ② 原生档：同一份骨架、不含糖记号 ───────────────────── */

/**
 * 一行是不是"糖记号"：**判据来自 kojo-sugar 的真实词表**（`lookupKeyword`），
 * 外加台词糖形 `「…」` 那一支（它不是关键字、是成对记号）。
 * 先剥掉行首的 `; `（脚手架空壳一律注释，案例块就住在注释里），仍带 `;` 的行是真注释 ⇒ 跳过。
 */
function sugarMarks(text: string): string[] {
  const hits: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const body = raw.startsWith('; ') ? raw.slice(2) : raw === ';' ? '' : raw;
    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed.startsWith(';')) return;
    if (trimmed.startsWith('「')) {
      hits.push(`${i + 1} 台词糖形`);
      return;
    }
    const head = trimmed.split(/[\s(（:：,，]/)[0]!;
    if (lookupKeyword(head) !== undefined) hits.push(`${i + 1} 关键字 ${head}`);
  });
  return hits;
}

describe('② 原生档：产物不含糖记号，且判据本身不是空判据', () => {
  const native = scaffoldKojoProject({ ...BASE, langDoc: 'native' });

  it('起手文件全部换成原生扩展名；README 键序不变', () => {
    const ext = kojoLangDocExtension('native');
    expect(Object.keys(native.files)).toEqual([
      'README.md',
      ...CORE_FACES.map((f) => `${f.stem}${ext}`),
    ]);
    expect(Object.keys(native.files).some((r) => r.endsWith(KOJO_SOURCE_EXTENSION))).toBe(false);
    expect(native.dirName).toBe(scaffoldKojoProject(BASE).dirName);
  });

  it('糖档确实有糖记号（案例块在）——否则下一条就是空判据', () => {
    const sugar = scaffoldKojoProject(BASE);
    const withMarks = CORE_FACES.filter((f) => sugarMarks(sugar.files[`${f.stem}${FACE_STUB_EXT}`]!).length > 0);
    expect(withMarks.length).toBeGreaterThan(0);
    expect(withMarks.map((f) => f.stem).sort()).toEqual(Object.keys(FACE_CASES).sort());
  });

  it('原生档逐面零糖记号；【库内现成案例】整块不出现（宁缺勿编，不现编"原生案例"）', () => {
    const ext = kojoLangDocExtension('native');
    for (const face of CORE_FACES) {
      const text = native.files[`${face.stem}${ext}`]!;
      expect(sugarMarks(text), `${face.stem} 的糖记号`).toEqual([]);
      expect(text).not.toContain('【库内现成案例】');
      // 起手骨架的老纪律照旧：只有注释，不生成任何活函数
      expect(text.split(/\r?\n/).every((l) => l.trim() === '' || l.startsWith(';')), `${face.stem} 应全是注释`).toBe(true);
    }
  });

  it('README 说的是这一档的真话：原样带走、不带糖案例、想混排就换扩展名', () => {
    const readme = native.files['README.md']!;
    const ext = kojoLangDocExtension('native');
    expect(readme).toContain(ext);
    expect(readme).toMatch(/不经转译/);
    expect(readme).toMatch(/原样带走/);
    expect(readme).toMatch(/本包没有需要转译的文件/);
    expect(readme).toMatch(/不带糖写法案例/);
    // 面清单那一格跟着档位走（README 与实际产物同源，不出现对不上号的文件名）
    for (const face of CORE_FACES) expect(readme).toContain(`\`${face.stem}${ext}\``);
  });

  it('糖档 README 那句关于转译的话一字未动（默认档的作者面也不许被无声改写）', () => {
    const readme = scaffoldKojoProject(BASE).files['README.md']!;
    expect(readme).toContain('扩展名是 `.kojo`：.kojo 写法与原始 ERB 写法可以写在同一个文件里');
    expect(readme).toContain('**直接把 `.kojo` 放进游戏目录是不生效的**——引擎只读 `.ERB`');
  });
});

/* ───────────────────── ③ 下游真走通：索引 + 制品计划 ───────────────────── */

/** 伪 FileIO：与 erb-parser 测试侧同一套（readText / readTexts / stat / walkDir） */
function fakeIO(files: Record<string, string>): FileIO {
  return {
    async readText(p: string) {
      const text = files[p];
      if (text === undefined) throw new Error(`not found: ${p}`);
      return { path: p, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((p) => {
        const text = files[p];
        return text === undefined ? null : { path: p, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
      });
    },
    async stat(p: string) {
      const text = files[p];
      return text === undefined ? null : { size: text.length, mtimeMs: null, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(files)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
}

function erbParserService(files: Record<string, string>): ErbParserService {
  const services = new Map<string, unknown>();
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const on = (type: string, h: (p: unknown) => void): Unsubscribe => {
    let s = handlers.get(type);
    if (!s) handlers.set(type, (s = new Set()));
    s!.add(h);
    return () => s!.delete(h);
  };
  const bus = {
    on,
    once: on,
    emit: (type: string, payload: unknown) => {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload);
    },
  } as unknown as EventBus;
  createErbParserPlugin().activate({
    pluginId: 'erb-parser',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return fakeIO(files) as unknown as T;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    slots: { register: () => () => undefined, query: () => [] },
    onDispose: () => {},
  } as unknown as PluginContext);
  return services.get('erb.parser') as ErbParserService;
}

describe('③ 原生档进得了索引、也出得了制品（取证实测固化为判据）', () => {
  const native = scaffoldKojoProject({ ...BASE, langDoc: 'native' });
  const root = 'C:/作者工作区/我的口上项目/取证作品-影狼 v1.0';

  it('erb-parser 真实索引扫到全部起手文件（糖记号为 0 ⇒ 名录 0 条是事实，不是没扫到）', async () => {
    const dialect = Object.entries(native.files).filter(([rel]) => isErbDialectPath(rel));
    expect(dialect.length).toBe(CORE_FACES.length);
    const files: Record<string, string> = {};
    for (const [rel, text] of dialect) files[`${root}/${rel}`] = text;
    const parser = erbParserService(files);
    const idx: ErbIndex = await parser.buildIndex!([root]);
    expect(idx.files.size).toBe(CORE_FACES.length);
    expect(idx.byName.size).toBe(0);

    // 同一台机器：作者在原生档里写一条活函数，名录就该有 1 条（证明上面那个 0 是"真没有"，不是"没解析"）
    const withLive = { ...files, [`${root}/手写.ERB`]: '@M_KOJO_TEST_NATIVE\nPRINTL ok\n' };
    const idx2 = await erbParserService(withLive).buildIndex!([root]);
    expect(idx2.files.size).toBe(CORE_FACES.length + 1);
    expect(idx2.byName.size).toBe(1);
    expect(idx2.byName.get('M_KOJO_TEST_NATIVE')?.length).toBe(1);
  });

  it('制品计划：非 .kojo 一律字节级原样携带，编译器一次都不叫（不是报错、也不是静默跳过）', () => {
    const sources = Object.entries(native.files).map(([rel, text]) => ({ relPath: rel, bytes: new TextEncoder().encode(text) }));
    let compilerCalls = 0;
    const plan = planArtifacts(sources, (src, label) => {
      compilerCalls += 1;
      throw new Error(`编译器不该被叫到：${label}`);
    });
    expect(compilerCalls).toBe(0);
    expect(plan.entries).toHaveLength(sources.length);
    expect(plan.transpiled).toBe(0);
    expect(plan.passthrough).toBe(sources.length);
    expect(plan.ignoredDerived).toEqual([]);
    for (const e of plan.entries) {
      expect(new TextDecoder().decode(e.bytes)).toBe(native.files[e.relPath]);
      expect(e.sourceRel).toBe(e.relPath);
    }
    // 产物名一个 .kojo 都不留（引擎读不到它）
    expect(plan.entries.every((e) => !/\.kojo$/i.test(e.relPath))).toBe(true);
  });

  it('反向对照：糖档走的是转译腿（8 个转译 + README 原样），两档在导出链上是两条都能跑的路', () => {
    const sugar = scaffoldKojoProject(BASE);
    const sources = Object.entries(sugar.files).map(([rel, text]) => ({ relPath: rel, bytes: new TextEncoder().encode(text) }));
    // 替身编译器按来源给**互不相同**的函数名（引擎函数名全局唯一，同名会 fail-closed——
    // 那条冲突本身由 artifact 的测试守着，这里只要它别把两条腿都挡掉）
    const fnSeq = new Map<string, number>();
    const plan = planArtifacts(sources, (_src, label) => {
      const n = (fnSeq.get(label) ?? fnSeq.size) + 1;
      fnSeq.set(label, n);
      const erb = `@FN取证${String(n)}\nPRINTL ok\n`;
      return { bytes: new TextEncoder().encode(erb), transpile: { erb, diagnostics: [] } } as never;
    });
    expect(plan.transpiled).toBe(CORE_FACES.length);
    expect(plan.passthrough).toBe(1); // README.md
    expect(plan.entries.filter((e) => e.relPath.endsWith(kojoLangDocExtension('native')))).toHaveLength(CORE_FACES.length);
  });
});

/* ───────────────────── ④ 接线腿：声明真的挂在这枚供数函数上 ───────────────────── */

describe('④ 供数接线（这一格在 eraTW 的向导里真的会出现）', () => {
  it('ERATW_SCAFFOLD_DEPS.scaffold 带着两档声明出厂（把 withKojoLangDocs 摘掉即红）', () => {
    const declared = readScaffoldLangDocs(ERATW_SCAFFOLD_DEPS.scaffold);
    expect(declared.map((c) => c.value)).toEqual(['sugar', 'native']);
    expect(declared[0]!.value).toBe(DEFAULT_KOJO_LANG_DOC);
    expect(ERATW_SCAFFOLD_DEPS.coreFaceCount).toBe(CORE_FACES.length);
  });

  it('这枚供数函数认草稿里的 langDoc：原生档出原生扩展名，缺省出糖档且逐字节等于改前金样', () => {
    const draft = { ...BASE, extra: { scriptNo: 1 } };
    const nativeOut = ERATW_SCAFFOLD_DEPS.scaffold({ ...draft, langDoc: 'native' });
    expect(Object.keys(nativeOut.files).filter((r) => r.endsWith(kojoLangDocExtension('native')))).toHaveLength(CORE_FACES.length);
    const sugarOut = ERATW_SCAFFOLD_DEPS.scaffold(draft);
    expect(Object.keys(sugarOut.files)).toEqual([...DEFAULT_KEYS]);
    // 接线腿没夹带任何改写：与改前金样逐字节相同（不只是"和另一个函数一致"）
    const drift = DEFAULT_KEYS.filter((rel) => {
      const got = bytesOf(sugarOut.files[rel]!);
      const want = goldenBytes(rel);
      return got.length !== want.length || !got.every((b, i) => b === want[i]);
    });
    expect(drift, '接线腿与金样不一致的文件').toEqual([]);
  });

  it('没有声明的游戏（另一家 adapter 那形）读出来是空 ⇒ 那一行不出现、草稿也不带键', () => {
    const plain = (_draft: KojoScaffoldDraft): ScaffoldFileSet => ({ dirName: 'd', files: {} });
    expect(readScaffoldLangDocs(plain)).toEqual([]);
    const draft = composeScaffoldDraft({ ...BASE, extra: {} }, readScaffoldLangDocs(plain), 'native');
    expect('langDoc' in draft).toBe(false);
  });
});
