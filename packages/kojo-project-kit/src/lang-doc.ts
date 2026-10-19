/**
 * 「语言档」——同一份起手骨架的两种书写形态（NEW-ERB，2026-10-20）。
 *
 * ## 这条反馈说的是什么
 *
 * 新建口上项目时只有糖写法一条路，作者想要"从原生就开始写"就没有选项。
 * 本模块把这件事变成**作者看得见的一格**，而不改任何默认行为：
 * 默认档仍是糖档（`sugar`），选它产物与历史逐字节相同。
 *
 * ## 为什么住共享层（而不是某个 adapter）
 *
 * 「糖 / 原生」是**表层 DSL 与引擎**的关系，不是某个游戏的约定：两种扩展名
 * 都由契约层单源给出（`KOJO_SOURCE_EXTENSION` 与 `ERB_BODY_EXTENSIONS`），与
 * `new-item.ts` 里那两条「新建口上文件 / 新建 ERB 文件」菜单项同源同判据。
 * 因此这一档**游戏无关**：哪个游戏想支持就声明，不想支持就不声明。
 *
 * ## 一条纪律：扩展名一律现算，不许手抄
 *
 * 消费方（向导、脚手架）也不许出现扩展名字面量——`kojoLangDocExtension()` 是唯一
 * 取值口，大小写形态同样是现算派生物（与 `erb-ext.ts` 的 `erbMonacoExtensions` 同口径）。
 * `tests/lang-doc.test.ts` 按行 + 处数钉死这条边界（多一处即红）。
 */

import { ERB_BODY_EXTENSIONS, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import type { ScaffoldFileSet } from '@kojo/plugin-api';
import type { KojoScaffoldDraft } from './new-project-wizard';

/** 语言档取值（`sugar` = 表层 DSL 超集，可混写原生；`native` = 只有原生语法） */
export type KojoLangDoc = 'sugar' | 'native';

/** 取值清单（顺序即向导下拉顺序：默认档在前） */
export const KOJO_LANG_DOC_VALUES: readonly KojoLangDoc[] = ['sugar', 'native'];

/** 缺省档：既有作者升级后感觉不到差别，是这条反馈的硬约束 */
export const DEFAULT_KOJO_LANG_DOC: KojoLangDoc = 'sugar';

/**
 * 该档起手文件的扩展名（**唯一取值口**）。
 *
 * - 糖档 = 契约的表层源扩展名；
 * - 原生档 = 引擎预载的**正文**方言扩展名第一项，取大写形态——引擎按大小写不敏感
 *   收文件，而本仓在盘上/产物名上一贯写大写形态（`resolveSugarTarget` 的产物名也是它），
 *   故这里现算 `.toUpperCase()`，不在任何消费方手抄。
 */
export function kojoLangDocExtension(doc: KojoLangDoc): string {
  if (doc === 'sugar') return KOJO_SOURCE_EXTENSION;
  const body = ERB_BODY_EXTENSIONS[0];
  if (body === undefined) throw new Error('ERB 正文扩展名清单为空：无法给原生档定扩展名。');
  return body.toUpperCase();
}

/** 语言档下拉的一项（值 + 作者看到的 label + 选中后常驻的那句人话） */
export interface KojoLangDocChoice {
  readonly value: KojoLangDoc;
  readonly label: string;
  readonly hint: string;
}

/**
 * 两档的作者面文案（**去黑话**）。
 *
 * 糖档那句是把 adapter `scaffold.ts` 头注里"先不要替作者收窄表达"那段只有开发者
 * 看得到的理由，翻成作者在向导里看得见的一句话——**选了糖也能逐行直写原生**；
 * 这一寸不说明，作者就会以为"用不了原生"而绕路（本条反馈的原始症状）。
 */
export const KOJO_LANG_DOC_CHOICES: readonly KojoLangDocChoice[] = [
  {
    value: 'sugar',
    label: `糖写法（${kojoLangDocExtension('sugar')}，默认）`,
    hint:
      `起手文件是 ${kojoLangDocExtension('sugar')}：糖写法与原生 ERB 写法能写在同一个文件里，原生语句逐行直通；` +
      `导出或部署时自动转成游戏认得的 ${kojoLangDocExtension('native')}，工作区里始终只有这一份源。`,
  },
  {
    value: 'native',
    label: `原生写法（${kojoLangDocExtension('native')}）`,
    hint:
      `起手文件直接就是游戏认得的 ${kojoLangDocExtension('native')}：只写原生语法，不经转译，导出或部署时原样带走。` +
      `这一档的骨架不带糖写法示例（那是 ${kojoLangDocExtension('sugar')} 的写法）。`,
  },
];

/** 取值不认识（缺省 / 越界）一律回落缺省档，不猜、不静默造新档 */
export function normalizeKojoLangDoc(doc: KojoLangDoc | undefined | null): KojoLangDoc {
  return doc !== undefined && doc !== null && KOJO_LANG_DOC_VALUES.includes(doc) ? doc : DEFAULT_KOJO_LANG_DOC;
}

/** 按取值取文案项 */
export function kojoLangDocChoice(doc: KojoLangDoc | undefined | null): KojoLangDocChoice {
  const value = normalizeKojoLangDoc(doc);
  return KOJO_LANG_DOC_CHOICES.find((c) => c.value === value) ?? KOJO_LANG_DOC_CHOICES[0]!;
}

/**
 * 落点预览那句里关于起手骨架的括注（作者看到"这些文件到底是什么"）。
 * 糖档那句与历史文案逐字相同（历史那句写的是"糖扩展名，可写糖也可写原生"），
 * 扩展名由单源插入，本函数自身不抄任何扩展名。
 */
export function kojoLangDocPreviewParenthesis(doc: KojoLangDoc | undefined | null): string {
  const value = normalizeKojoLangDoc(doc);
  const ext = kojoLangDocExtension(value);
  return value === 'sugar'
    ? `（${ext}，可写 ${ext} 也可写原生 ERB）`
    : `（${ext}，只写原生语法、不经转译）`;
}

/** 脚手架供数函数（`NewKojoProjectWizardDeps.scaffold` 的形状，此处再述一次以免循环依赖） */
export type KojoScaffoldFn = (draft: KojoScaffoldDraft) => ScaffoldFileSet;

/**
 * 语言档的**声明通道**：跟着 `deps.scaffold` 这枚供数函数一起带出来。
 *
 * 为什么不给 `NewKojoProjectWizardDeps` 加一条新字段：那条字段要每家 adapter 的
 * 组装点（`plugin.ts`）逐行接线，而"这个游戏支持几种档"本来就是**脚手架自己的事**
 * ——脚手架是谁产的，就随谁声明。没有声明的游戏 ⇒ 向导那一行不出现、草稿里也不出现
 * `langDoc` 这个键（与"未自选位置 ⇒ 连 rootDir 键都不出现"同一口径），
 * 老游戏的产物与表单逐字不变。
 */
export interface KojoLangDocProvider {
  readonly langDocs: readonly KojoLangDocChoice[];
}

/** 给供数函数附上语言档声明（返回同一枚函数，只多带一个只读属性） */
export function withKojoLangDocs(
  scaffold: KojoScaffoldFn,
  langDocs: readonly KojoLangDocChoice[] = KOJO_LANG_DOC_CHOICES,
): KojoScaffoldFn & KojoLangDocProvider {
  return Object.assign(scaffold, { langDocs });
}

/** 单档形状校验：宁可不显示这一行，也不把认不出的档位渲染给作者 */
function isLangDocChoice(v: unknown): v is KojoLangDocChoice {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as { value?: unknown; label?: unknown; hint?: unknown };
  return (
    typeof c.value === 'string' &&
    KOJO_LANG_DOC_VALUES.includes(c.value as KojoLangDoc) &&
    typeof c.label === 'string' &&
    c.label.length > 0 &&
    typeof c.hint === 'string'
  );
}

/**
 * 从供数函数读出语言档声明（**容错归空**：不是数组、项形不对、取值越界 ⇒ `[]`）。
 * 归空 = 这一行不出现，与"本游戏没有这类档位"同形；绝不拿半个声明渲出假控件。
 */
export function readScaffoldLangDocs(scaffold: unknown): readonly KojoLangDocChoice[] {
  const raw = (scaffold as Partial<KojoLangDocProvider> | null | undefined)?.langDocs;
  if (!Array.isArray(raw)) return [];
  if (raw.length < 2) return [];
  if (!raw.every(isLangDocChoice)) return [];
  // 项形全对 ⇒ 交回声明**本身**（不复制、不重排：向导渲染的就是 adapter 给的那一份）
  return raw as readonly KojoLangDocChoice[];
}

/**
 * 组装草稿里的语言档字段：**没声明就没有这个键**（不是 `undefined`、不是缺省值占位）。
 * 声明只有一档也同理（没有选择可言）。
 */
export function draftLangDoc(
  langDocs: readonly KojoLangDocChoice[],
  chosen: KojoLangDoc,
): Pick<KojoScaffoldDraft, 'langDoc'> | Record<never, never> {
  return langDocs.length >= 2 ? { langDoc: normalizeKojoLangDoc(chosen) } : {};
}
