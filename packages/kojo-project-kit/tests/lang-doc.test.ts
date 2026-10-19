/**
 * 语言档（起手写法）的共享层判据（NEW-ERB 2026-10-20）。
 *
 * 两件事分开守：
 * ① **行为面**——默认档 = 糖、草稿里的键"没声明就不出现"、落点预览那句与历史逐字相同；
 * ② **边界本身**——扩展名不许在任何向导/供数文件里手抄（手法照 `app/tests/kojo-extension-single-source.test.ts`：
 *   连注释行一起查、按行 + 处数钉死，多一处即红）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERB_BODY_EXTENSIONS, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import {
  DEFAULT_KOJO_LANG_DOC,
  KOJO_LANG_DOC_CHOICES,
  KOJO_LANG_DOC_VALUES,
  composeScaffoldDraft,
  draftLangDoc,
  kojoLangDocChoice,
  kojoLangDocExtension,
  kojoLangDocPreviewParenthesis,
  normalizeKojoLangDoc,
  readScaffoldLangDocs,
  scaffoldPreviewLine,
  withKojoLangDocs,
} from '../src/index';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string[] => readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);

const form = {
  workName: '取证作品',
  authorName: '取证作者',
  version: '1.0',
  charaNo: 63,
  charaName: '影狼',
  license: 'none' as const,
  extra: { scriptNo: 3 },
};

describe('① 档位与扩展名：只由契约单源派生', () => {
  it('两档、默认糖、取值清单就是这两档', () => {
    expect(KOJO_LANG_DOC_VALUES).toEqual(['sugar', 'native']);
    expect(DEFAULT_KOJO_LANG_DOC).toBe('sugar');
    expect(KOJO_LANG_DOC_CHOICES.map((c) => c.value)).toEqual([...KOJO_LANG_DOC_VALUES]);
    expect(KOJO_LANG_DOC_CHOICES[0]!.value).toBe(DEFAULT_KOJO_LANG_DOC);
  });

  it('扩展名取自契约两份清单（糖 = 表层源单源；原生 = 正文方言第一项的大写形态）', () => {
    expect(kojoLangDocExtension('sugar')).toBe(KOJO_SOURCE_EXTENSION);
    expect(kojoLangDocExtension('native')).toBe(ERB_BODY_EXTENSIONS[0]!.toUpperCase());
    // 大小写形态是现算派生物，不是第二处清单（与 erbMonacoExtensions 同一口径）
    expect(kojoLangDocExtension('native')).toBe(kojoLangDocExtension('native').toUpperCase());
    expect(kojoLangDocExtension('native')).toBe(kojoLangDocExtension('native').toLowerCase().toUpperCase());
  });

  it('文案里出现的扩展名 == 单源派生物（作者看到的与盘上落的一致）', () => {
    for (const c of KOJO_LANG_DOC_CHOICES) {
      const sugar = kojoLangDocExtension('sugar');
      const native = kojoLangDocExtension('native');
      expect(c.label).toContain(kojoLangDocExtension(c.value));
      expect(c.label + c.hint).toContain(sugar);
      expect(c.label + c.hint).toContain(native);
      expect(c.hint.length).toBeGreaterThan(20);
    }
  });

  it('糖档那句人话把"选糖也能逐行直写原生"说出来（去黑话，开发者注释翻成作者可见）', () => {
    const sugar = kojoLangDocChoice('sugar');
    expect(sugar.hint).toMatch(/原生/);
    expect(sugar.hint).toMatch(/逐行/);
    expect(sugar.hint).not.toMatch(/语法糖糖法|DSL|transpile|fail-closed/i);
    // 原生档如实说自己那一档不带糖案例（不留空头，也不误导）
    expect(kojoLangDocChoice('native').hint).toMatch(/不经转译|原样带走/);
  });

  it('取值不认识一律回落缺省档（不猜、不静默造新档）', () => {
    expect(normalizeKojoLangDoc(undefined)).toBe(DEFAULT_KOJO_LANG_DOC);
    expect(normalizeKojoLangDoc(null)).toBe(DEFAULT_KOJO_LANG_DOC);
    expect(normalizeKojoLangDoc('sao' as never)).toBe(DEFAULT_KOJO_LANG_DOC);
    expect(kojoLangDocChoice('bogus' as never).value).toBe(DEFAULT_KOJO_LANG_DOC);
    expect(kojoLangDocPreviewParenthesis(undefined)).toBe(kojoLangDocPreviewParenthesis('sugar'));
  });
});

describe('② 声明通道：没有声明就没有这一格', () => {
  const two = KOJO_LANG_DOC_CHOICES;

  it('withKojoLangDocs 随供数函数带出声明，函数本身照旧可调用', () => {
    const calls: string[] = [];
    const fn = withKojoLangDocs((draft) => {
      calls.push(draft.langDoc ?? '<无键>');
      return { dirName: 'd', files: {} };
    });
    expect(fn.langDocs).toBe(two);
    expect(readScaffoldLangDocs(fn)).toEqual(two);
    expect(readScaffoldLangDocs(fn)).toBe(fn.langDocs);
  });

  it('readScaffoldLangDocs 的容错归空（认不出 ⇒ 控件不出现，绝不渲半个假下拉）', () => {
    expect(readScaffoldLangDocs(undefined)).toEqual([]);
    expect(readScaffoldLangDocs(null)).toEqual([]);
    expect(readScaffoldLangDocs(() => ({ dirName: 'd', files: {} }))).toEqual([]);
    expect(readScaffoldLangDocs({ langDocs: '糖 / 原生' })).toEqual([]);
    expect(readScaffoldLangDocs({ langDocs: [two[0]] })).toEqual([]); // 只有一档 = 没有选择可言
    expect(readScaffoldLangDocs({ langDocs: [{ value: 'turbo', label: 'X', hint: 'Y' }, two[1]] })).toEqual([]);
    expect(readScaffoldLangDocs({ langDocs: [{ value: 'native', label: '', hint: 'Y' }, two[0]] })).toEqual([]);
  });

  it('草稿里的键：声明了才带 langDoc；没声明 ⇒ 连这个键都不出现', () => {
    const declared = composeScaffoldDraft(form, two, 'native');
    expect(declared.langDoc).toBe('native');
    expect(Object.keys(declared)).toContain('langDoc');

    const undeclared = composeScaffoldDraft(form, [], 'sugar');
    expect('langDoc' in undeclared).toBe(false);
    // 其余字段逐字与历史一致（不是"少一个键"顺带改了别的）
    expect(undeclared).toEqual({
      workName: '取证作品',
      authorName: '取证作者',
      version: '1.0',
      charaNo: 63,
      charaName: '影狼',
      license: 'none',
      extra: { scriptNo: 3 },
    });
    expect(draftLangDoc([], 'native')).toEqual({});
    expect(draftLangDoc(two, 'bogus' as never)).toEqual({ langDoc: DEFAULT_KOJO_LANG_DOC });
  });

  it('键的位置：langDoc 由展开追加在末尾（既有字段次序不动，meta/落盘路径零影响）', () => {
    const keys = Object.keys(composeScaffoldDraft(form, two, 'sugar'));
    expect(keys.slice(0, 7)).toEqual(['workName', 'authorName', 'version', 'charaNo', 'charaName', 'license', 'extra']);
    expect(keys[7]).toBe('langDoc');
  });
});

describe('③ 落点预览那句：糖档逐字等于历史文案', () => {
  /** 改前那一句原样抄在这里（本测试的全部意义就是"这句不许被无声改掉"） */
  const HISTORIC =
    '将生成 9 个文件：中文 README + 8 个核心面空壳（.kojo，可写 .kojo 也可写原生 ERB） + LICENSE；不含四件套，也不含活函数';

  it('缺省 / 糖档：与历史逐字节相同', () => {
    const args = { fileCount: 9, coreFaceCount: 8, licenseProduces: true, previewNote: '不含四件套，也不含活函数' };
    expect(scaffoldPreviewLine(args)).toBe(HISTORIC);
    expect(scaffoldPreviewLine({ ...args, langDoc: 'sugar' })).toBe(HISTORIC);
  });

  it('无 LICENSE / 无补充说明那两段拼接形态照旧', () => {
    expect(scaffoldPreviewLine({ fileCount: 9, coreFaceCount: 8, licenseProduces: false })).toBe(
      '将生成 9 个文件：中文 README + 8 个核心面空壳（.kojo，可写 .kojo 也可写原生 ERB）',
    );
  });

  it('原生档：同一句骨架换成原生扩展名（括注由单源插入）', () => {
    const line = scaffoldPreviewLine({ fileCount: 9, coreFaceCount: 8, licenseProduces: false, langDoc: 'native' });
    expect(line).toContain(`（${kojoLangDocExtension('native')}，只写原生语法、不经转译）`);
    expect(line).not.toContain(kojoLangDocExtension('sugar'));
    expect(kojoLangDocPreviewParenthesis('native')).toBe(
      `（${kojoLangDocExtension('native')}，只写原生语法、不经转译）`,
    );
  });
});

describe('④ 单源守卫：向导与档位文件里一个扩展名字面量都不许出现', () => {
  /**
   * 引号或反引号包住的 `.kojo` / `.ERB` / `.erb` 形态，**以及散文里裸写的 `.kojo`**
   * （`（.kojo，可写 …）` 这类文案最容易从"注释"长成"字符串"，故连注释一起查——
   * 手法照 `app/tests/kojo-extension-single-source.test.ts` 的"连注释行一起查"）。
   */
  const EXT_TOKEN = /\.(kojo|ERB|erb|erm|erh)\b/;

  const SCOPED: ReadonlyArray<{ readonly rel: string; readonly count: number }> = [
    { rel: 'packages/kojo-project-kit/src/lang-doc.ts', count: 0 },
    { rel: 'packages/kojo-project-kit/src/new-project-wizard.ts', count: 0 },
    { rel: 'packages/plugins/eratw-adapter/src/new-project-wizard.ts', count: 0 },
  ];

  it('三处文件的扩展名 token 命中数钉死为 0（多一处即红）', () => {
    for (const s of SCOPED) {
      const hits = read(s.rel)
        .map((line, i) => ({ at: `${s.rel}:${i + 1}`, line }))
        .filter(({ line }) => EXT_TOKEN.test(line))
        .map(({ at, line }) => `${at} ${line.trim().slice(0, 100)}`);
      expect(hits, `${s.rel} 的扩展名手抄处数（要求 ${s.count}）`).toHaveLength(s.count);
    }
  });

  it('糖档扩展名在本文件里的唯一写法是"取契约常量"（不许退回字面量）', () => {
    const lang = read('packages/kojo-project-kit/src/lang-doc.ts').join('\n');
    expect(lang).toMatch(/export const DEFAULT_KOJO_LANG_DOC: KojoLangDoc = 'sugar';/);
    expect(lang).toMatch(/if \(doc === 'sugar'\) return KOJO_SOURCE_EXTENSION;/);
    expect(lang).toMatch(/const body = ERB_BODY_EXTENSIONS\[0\];/);
    expect(lang).toMatch(/return body\.toUpperCase\(\);/);
    expect(lang).toMatch(/import \{ ERB_BODY_EXTENSIONS, KOJO_SOURCE_EXTENSION \} from '@kojo\/plugin-api';/);
  });

  it('adapter 侧那枚扩展名常量也指回契约（FACE_STUB_EXT 不再是自家的字符串字面量）', () => {
    const sc = read('packages/plugins/eratw-adapter/src/scaffold.ts');
    const line = sc.find((l) => /^export const FACE_STUB_EXT = /.test(l));
    expect(line, 'FACE_STUB_EXT 的定义行').toBeDefined();
    expect(line).not.toMatch(/['"`]\.kojo['"`]/);
    expect(sc.join('\n')).toMatch(/import \{ kojoLangDocExtension, type KojoLangDoc \} from '@kojo\/kojo-project-kit';/);
  });

  it('反向对照：判据确实住在契约层（不是"哪里都不许有"）', () => {
    const sugar = read('packages/plugin-api/src/sugar.ts').join('\n');
    expect(sugar).toMatch(/export const KOJO_SOURCE_EXTENSION = '\.kojo'/);
    const erb = read('packages/plugin-api/src/erb-ext.ts').join('\n');
    expect(erb).toContain("'.erb'");
  });
});
