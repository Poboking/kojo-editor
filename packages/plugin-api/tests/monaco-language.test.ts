/**
 * `ui.monaco.language` 契约的钉（SDK **B4**）。
 *
 * 四件事各用各的手段（分工口径同 `language-service-kinds.test.ts` /
 * `inline-completion.test.ts`）：
 *
 * 1. **形状**用 `expectTypeOf`（编译期断言）：三副面（词法 / 配置 / 主题）的字段与递归形态；
 * 2. **"不许存在的东西"**用源码文本反证：契约里不许出现 Monaco 的 import（**含 `import type`**），
 *    也不许出现 Monaco 枚举值形态（`indentAction: 2` 这种数字档位）；
 * 3. **档位是闭集**：`indentAction` / `base` / 部件色侧名三张联合逐项钉，
 *    多一档少一档都红——宿主按这几张表查表翻译，档位飘了就是"屏上没反应"那种隐性错；
 * 4. **零值导出**与**旧贡献方零改动**用源码/形状双向钉：前者管开机图，后者管"这一格是
 *    additive 的"这条承诺。
 *
 * 为什么值得四把闸：这一格最容易被改错的三处是——有人把 Monaco 类型引进来（"只是 type 而已"，
 * 运行时擦除、单测永远绿，等交给第三方宿主那天才崩）；有人给 `indentAction` 填数字
 * （那是 Monaco 的枚举值，不是语言事实）；有人给旧贡献方加必填字段（号称 additive，
 * 实为全仓改一遍）。三处的表现都是"有时候亮有时候不亮"，没人会去查契约。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EditorLanguageServiceContribution } from '../src/slots';
import type {
  MonacoLanguageContribution,
  MonacoLanguageSurface,
  MonacoMonarchAction,
  MonacoMonarchData,
} from '../src/monaco-language';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = readFileSync(
  fileURLToPath(new URL('../src/monaco-language.ts', import.meta.url)),
  'utf8',
);
const SLOTS_SRC = readFileSync(fileURLToPath(new URL('../src/slots.ts', import.meta.url)), 'utf8');
const INDEX_SRC = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

/** 剥掉注释后的正文（值导出与依赖两类判据只看正文；判据理由同 IC 批那把闸） */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 取某个 `export type Xxx =` 起、到下一个 `;` 止的文本 */
function unionBody(name: string): string {
  const head = `export type ${name} =`;
  const start = CODE.indexOf(head);
  if (start < 0) throw new Error(`契约里找不到 ${name}`);
  const end = CODE.indexOf(';', start);
  if (end < 0) throw new Error(`${name} 的联合没有结尾分号`);
  return CODE.slice(start + head.length, end);
}

describe('ui.monaco.language 的形状（B4）', () => {
  it('一枚完整贡献编得过：词法 + 配置 + 主题三副都在', () => {
    const contribution: MonacoLanguageContribution = {
      id: 'demo-surface',
      order: 10,
      surface: {
        languageId: 'demo',
        monarch: {
          ignoreCase: false,
          defaultToken: '',
          wordLists: { keywords: ['由', '否'] },
          tokenizer: {
            root: [
              [/^\/\/.*$/, 'role.comment'],
              [/\s+/, { token: '', next: '@speech' }],
              [
                /^(\s*#)(\S+)/,
                [
                  'role.anchor',
                  { cases: { '@keywords': 'role.keyword', '@default': 'role.text' } },
                ],
              ],
            ],
          },
        },
        configuration: {
          comments: { lineComment: '//' },
          brackets: [
            ['{', '}'],
            ['「', '」'],
          ],
          autoClosingPairs: [{ open: '{', close: '}' }],
          surroundingPairs: [{ open: '{', close: '}' }],
          onEnterRules: [{ beforeText: /：\s*$/, action: { indentAction: 'indent' } }],
          indentationRules: { increaseIndentPattern: /：\s*$/, decreaseIndentPattern: /(?!)/ },
        },
        themes: [
          {
            id: 'demo-dark',
            base: 'vs-dark',
            inherit: false,
            rules: [{ token: 'role.anchor', foreground: 'ff41b9', fontStyle: 'bold' }],
            componentPalette: 'dark',
          },
        ],
      },
    };
    expectTypeOf(contribution.surface.languageId).toEqualTypeOf<string>();
    expect(contribution.surface.themes?.[0]?.id).toBe('demo-dark');
  });

  it('三副面各自可选（一门语言可以只交词法），但 `languageId` 必填', () => {
    expectTypeOf<MonacoLanguageSurface>().toHaveProperty('languageId');
    const onlyMonarch: MonacoLanguageSurface = {
      languageId: 'demo',
      monarch: { tokenizer: { root: [[/x/, 'role.text']] } },
    };
    expect(onlyMonarch.themes).toBeUndefined();
    expectTypeOf(onlyMonarch.configuration).toEqualTypeOf<
      MonacoLanguageSurface['configuration']
    >();
  });

  it('Monarch 的动作是递归形状（字符串 / {token,next} / {cases} / 并列数组都算一档）', () => {
    const cases: Record<string, MonacoMonarchAction> = {
      '@default': 'role.text',
      '@keywords': { token: 'role.keyword', next: '@push' },
      $1: [{ token: '' }, 'role.anchor'],
    };
    expect(cases['@default']).toBe('role.text');
    expectTypeOf<MonacoMonarchData['tokenizer']>().toMatchTypeOf<
      Readonly<Record<string, readonly unknown[]>>
    >();
  });
});

describe('契约层零 Monaco（B4 的 purity 判据）', () => {
  it('正文里零 monaco-editor 依赖（含 `import type`——它运行时被擦除，只能扫源码）', () => {
    const specs = [
      ...[...CODE.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string),
      ...[...CODE.matchAll(/import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string),
    ];
    expect(specs.filter((s) => /monaco/i.test(s))).toEqual([]);
  });

  it('`indentAction` 是档位名而不是 Monaco 枚举值', () => {
    // 反证：正文里不许出现 `indentAction: 数字`（那是 `monaco.languages.IndentAction` 的序号）
    expect(CODE).not.toMatch(/indentAction\s*:\s*\d/);
    expect(CODE).toContain('IndentAction');
  });
});

describe('三张档位联合是闭集', () => {
  it('`MonacoIndentAction` 与 Monaco 的 IndentAction 同名五档，不多不少', () => {
    expect([...unionBody('MonacoIndentAction').matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([
      'none',
      'indent',
      'indentOutdent',
      'appendTab',
      'outdent',
    ]);
  });

  it('`MonacoThemeBase` 四档 / 部件色侧名三档', () => {
    expect([...unionBody('MonacoThemeBase').matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([
      'vs',
      'vs-dark',
      'hc-black',
      'hc-light',
    ]);
    expect(
      [...unionBody('MonacoComponentPaletteSide').matchAll(/'([^']+)'/g)].map((m) => m[1]),
    ).toEqual(['dark', 'light', 'mint']);
  });
});

describe('本叶子零值导出（开机图纪律，同 IC 批）', () => {
  it('正文里没有任何值导出（`export const` / `function` / `class` / `enum` / `default` / 裸 import）', () => {
    expect(CODE).not.toMatch(/\bexport\s+(const|let|var|function|class|enum|default)\b/);
    expect(CODE).not.toMatch(/\bexport\s*\{/);
    // 唯一的 `export` 形态：`export interface` / `export type`
    const exports = [...CODE.matchAll(/\bexport\s+(\w+)/g)].map((m) => m[1] as string);
    expect([...new Set(exports)].sort()).toEqual(['interface', 'type']);
  });

  it('桶里只许 `export type` 引它（值导出会把这一枚拉进开机图）', () => {
    const stmt = /export\s+(type\s*)?\{[^}]*\}\s*from\s*'\.\/monaco-language';/s.exec(INDEX_SRC);
    expect(stmt, "桶里没有 './monaco-language' 的导出语句").toBeTruthy();
    expect(stmt![1], '桶里对这一枚叶子只许 `export type`').toBe('type ');
  });

  it('`slots.ts` 用 `import type` 引它（值 import 会留下静态边）', () => {
    expect(SLOTS_SRC).toMatch(
      /^import type \{ MonacoLanguageContribution \} from '\.\/monaco-language';$/m,
    );
  });
});

describe('additive：旧贡献方零改动', () => {
  it('SlotMap 只在**表尾**追加这一格，其余键与顺序逐字不变', () => {
    const body = SLOTS_SRC.slice(
      SLOTS_SRC.indexOf('export interface SlotMap {'),
      SLOTS_SRC.indexOf('export type SlotName'),
    );
    const keys = [...body.matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1] as string);
    expect(keys).toEqual([
      'ui.panel',
      'ui.toolbar',
      'ui.statusbar',
      'ui.overlay',
      'editor.command',
      'ui.editor.decorator',
      'ui.editor.codeAction',
      'ui.editor.languageService',
      'ui.editor.liftPreview',
      'ui.editor.saveHandler',
      'game.adapter',
      'export.target',
      'search.scope',
      'completion.source',
      'ui.monaco.language',
    ]);
  });

  it('旧的 `ui.editor.languageService` 贡献方不填任何新字段仍然合法', () => {
    const legacy: EditorLanguageServiceContribution = {
      id: 'erb-definition',
      order: 20,
      provide: (request) =>
        request.kind === 'definition' ? { kind: 'definition', locations: [] } : undefined,
    };
    expect(legacy.id).toBe('erb-definition');
  });

  it('那一格的成员没被顺手加宽（B4 只新立一格，不动旧形状）', () => {
    expectTypeOf<keyof EditorLanguageServiceContribution>().toEqualTypeOf<
      'id' | 'order' | 'pluginId' | 'provide'
    >();
    expectTypeOf<EditorLanguageServiceContribution>().not.toMatchTypeOf<MonacoLanguageContribution>();
  });
});
