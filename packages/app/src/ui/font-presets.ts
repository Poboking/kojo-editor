/**
 * 字体档位表单一真源（视觉批十二 L20：「代码字体与界面字体各有多档可选」）。
 *
 * 分工：`code-font.ts` 仍是**缺省档**那条栈与其护栏（`isUsableCodeFontStack` /
 * `CODE_FONT_CSS_LINE` 闸）的真源；本文件在它之上登记"可选项"。两侧都不许另抄栈字符串。
 *
 * 三条硬口径（照 `code-font.ts` 文件头的不变式，每一档都得过）：
 * 1. **拉丁头 → CJK 尾 → 末位泛型**。中文面自带的半比例拉丁会接管前段（位置反了整套等宽就废），
 *    所以 CJK 成员一律排在全部拉丁成员之后——`font-presets.test.ts` 按名单逐档核对。
 * 2. 代码栈末位必须 `monospace`（`isUsableCodeFontStack`：空家族 = 整条声明失效）；
 *    UI 栈末位 `sans-serif`（`mono` 档例外——它吃所选代码栈，末位天然 `monospace`）。
 * 3. `custom` 档 `stack` 恒为空串：**真值在偏好里**（代码侧 = `fontFamily`，UI 侧 = `uiFontFamily`），
 *    不许把自定义吃进表里，也不许让表替自定义保管栈。
 *
 * 兼容红线（回归判据）：老用户存过非空 `fontFamily` 自由文本 ⇒ 它赢（`resolveCodeFontStack`
 * 先看文本再看档位 id）。档位选择是新加的一层，不是对旧口径的覆盖。
 */

import { CODE_FONT_STACK, isUsableCodeFontStack } from './code-font';

export interface FontPreset {
  readonly id: string;
  /** 作者面叫法（设置页卡片标题） */
  readonly label: string;
  /** 完整 CSS 栈；`custom` 档恒为空串（真值在偏好里） */
  readonly stack: string;
  /** 一句话理由（设置页卡片说明 / 悬停 title） */
  readonly note: string;
  /** 主打字体家族名（卡片副标题、搜索索引、"缺装时该装哪张"用） */
  readonly family: string;
  /**
   * 开源许可证短名（`OFL 1.1` / `Apache 2.0` / `MIT` / `UFL 1.0` / `开源`）。
   * 系统自带档、跟随档与自定义档恒为空串——不把闭源系统字体假装成开源。
   * 卡片只展示主打面的许可证；栈尾的 Consolas / 雅黑 / SimHei 是系统兜底，不参与这一格。
   */
  readonly license: string;
  /** 卡片筛选标签；chip 全集由两张表的 `tags` 现算，不另抄一张分类表 */
  readonly tags: readonly string[];
}

/** 代码档自定义的登记 id（`custom` = 吃 `fontFamily` 那条自由文本，语义与旧版逐字相同） */
export const CUSTOM_CODE_FONT_PRESET_ID = 'custom';
/** 界面档自定义的登记 id（吃 `uiFontFamily`） */
export const CUSTOM_UI_FONT_PRESET_ID = 'custom';

/**
 * 界面字体的现状栈：`tokens.css` 基础 `:root` 那行 `font-family` 的字面（逐字）。
 * `UI_FONT_CSS_LINE` 是它的闸——`font-presets.test.ts` 去 tokens.css 里逐字找，
 * 改一处必改两处（同 `CODE_FONT_CSS_LINE` 之于 styles/tokens 的 `--font-code`）。
 */
export const UI_FONT_SYSTEM_STACK =
  "'Segoe UI', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif";

export const UI_FONT_CSS_TOKEN = '--font-ui';
export const UI_FONT_CSS_LINE = `${UI_FONT_CSS_TOKEN}: ${UI_FONT_SYSTEM_STACK};`;

/**
 * 代码字体档位（含自定义共二十档）。
 *
 * 2026-11-05 开源字体扩展批：新增 14 张**有据可查的开源面**（主打面许可证写在 `license`），
 * 与既有 5 档一起构成可选面。三条硬口径一条没松：拉丁头 → CJK 尾 → 末位 `monospace`，
 * 栈尾的 Consolas / 雅黑 / SimHei 只是系统兜底，不参与"这一档是不是开源"的判断。
 *
 * 口径说明（避免误会）：本仓**不打包字体文件**，档位只是 CSS 家族名清单——装着就生效，
 * 没装自动落到栈后面那张面，设置页的可用性徽章会把这件事逐张标出来。开源许可证是给作者
 * 的"可以放心自行安装"凭据，不是"应用内自带"的承诺。
 */
export const CODE_FONT_PRESETS: readonly FontPreset[] = [
  {
    id: 'default',
    label: '均衡（内置）',
    stack: CODE_FONT_STACK,
    note: 'Cascadia 系打头、Era Mono SC 收尾的现缺省栈，缺哪张跳哪张',
    family: 'Cascadia Code',
    license: '',
    tags: ['内置', '等宽', '中文'],
  },
  {
    id: 'sarasa',
    label: '更纱黑体等宽',
    stack: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Sarasa Term SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Cascadia + Sarasa Term SC：更纱严格 2:1 全角，网格最稳',
    family: 'Sarasa Term SC',
    license: 'OFL 1.1',
    tags: ['中文', '等宽'],
  },
  {
    id: 'jbmono-noto',
    label: 'JetBrains + 思源等宽',
    stack: "'JetBrains Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'JetBrains Mono 打头、Noto Sans Mono CJK SC 收尾（两张都免安装费）',
    family: 'JetBrains Mono',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'lxgw',
    label: '霞鹜等宽',
    stack: "'Cascadia Mono', Consolas, 'LXGW Console Mono', 'LXGW WenKai Mono', 'Microsoft YaHei', SimHei, monospace",
    note: '拉丁头喂 Cascadia/Consolas，霞鹜两名单收（Console Mono / WenKai Mono 都认）管汉字，口上作者常装',
    family: 'LXGW Console Mono',
    license: 'OFL 1.1',
    tags: ['中文', '等宽'],
  },
  {
    id: 'system',
    label: '系统零安装',
    stack: "Consolas, 'Microsoft YaHei UI', 'Microsoft YaHei', SimHei, monospace",
    note: 'Consolas + 雅黑 + SimHei：Windows 必装组合，一台新机器也不缺字',
    family: 'Consolas',
    license: '',
    tags: ['系统', '等宽'],
  },
  {
    id: 'fira-noto',
    label: 'Fira Code',
    stack: "'Fira Code', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Mozilla 系的 Fira Code：字宽偏松、零与 O 区分最狠；连字恒关时看的就是它的字形骨架',
    family: 'Fira Code',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'source-code-sarasa',
    label: 'Source Code Pro',
    stack: "'Source Code Pro', Consolas, 'Sarasa Mono SC', 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Adobe 的 Source Code Pro 配更纱黑体 Mono：字面偏大，高分屏小字号也不糊',
    family: 'Source Code Pro',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'ibmplex-noto',
    label: 'IBM Plex Mono',
    stack: "'IBM Plex Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'IBM Plex Mono：带一点人文味的工业等宽，斜体与正文同族，注释读感好',
    family: 'IBM Plex Mono',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'hack-noto',
    label: 'Hack',
    stack: "'Hack', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Hack（DejaVu 血统）：字形偏方正、标点开口大，密集 ERB 指令里不易看串行',
    family: 'Hack',
    license: 'MIT',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'iosevka-sarasa',
    label: 'Iosevka',
    stack: "'Iosevka Term', 'Iosevka', Consolas, 'Sarasa Term SC', 'Noto Sans Mono CJK SC', SimHei, monospace",
    note: 'Iosevka：可自定字宽的超窄等宽，一屏塞得下更多列；中文交给更纱 Term',
    family: 'Iosevka Term',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'inconsolata-noto',
    label: 'Inconsolata',
    stack: "'Inconsolata', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Inconsolata：人文等宽，圆润的括号与引号在台词串里最不刺眼',
    family: 'Inconsolata',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'roboto-mono-noto',
    label: 'Roboto Mono',
    stack: "'Roboto Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Roboto Mono：与 Android / Material 同一套字面， numerals 等宽且非常好认',
    family: 'Roboto Mono',
    license: 'Apache 2.0',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'ubuntu-mono-noto',
    label: 'Ubuntu Mono',
    stack: "'Ubuntu Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Ubuntu Mono：Ubuntu 字体家族的等宽面，笔画带轻微手写味',
    family: 'Ubuntu Mono',
    license: 'UFL 1.0',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'dejavu-noto',
    label: 'DejaVu Sans Mono',
    stack: "'DejaVu Sans Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'DejaVu Sans Mono：Linux 桌面常年自带，覆盖符号最全的一张老牌等宽',
    family: 'DejaVu Sans Mono',
    license: '开源',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'victor-mono-sarasa',
    label: 'Victor Mono',
    stack: "'Victor Mono', Consolas, 'Sarasa Mono SC', 'Noto Sans Mono CJK SC', SimHei, monospace",
    note: 'Victor Mono：半斜体的意大利体独一份，写惯了斜体注释的人一眼就认得',
    family: 'Victor Mono',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'space-mono-noto',
    label: 'Space Mono',
    stack: "'Space Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Space Mono：Google Fonts 上的复古终端面，转角夸张、辨识度极高',
    family: 'Space Mono',
    license: 'OFL 1.1',
    tags: ['拉丁', '等宽', '中文'],
  },
  {
    id: 'lxgw-wenkai-mono',
    label: '霞鹜文楷等宽',
    stack: "'LXGW WenKai Mono', 'LXGW WenKai', 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: '纯中文档：楷体字面配等宽网格，长台词读起来像排版过的书页',
    family: 'LXGW WenKai Mono',
    license: 'OFL 1.1',
    tags: ['中文', '等宽', '楷体'],
  },
  {
    id: 'noto-mono-cjk',
    label: '思源等宽',
    stack: "'Noto Sans Mono CJK SC', 'Source Han Mono SC', 'Sarasa Mono SC', SimHei, monospace",
    note: '纯中文档：Adobe/Google 的思源等宽（Noto Sans Mono CJK / Source Han Mono 两名都认）',
    family: 'Noto Sans Mono CJK SC',
    license: 'OFL 1.1',
    tags: ['中文', '等宽'],
  },
  {
    id: 'sarasa-fixed',
    label: '更纱黑体 Fixed',
    stack: "'Sarasa Fixed SC', 'Sarasa Mono SC', 'Sarasa Term SC', 'Noto Sans Mono CJK SC', SimHei, monospace",
    note: '纯中文档：更纱黑体的 Fixed / Mono / Term 三张面全认，2:1 全角最严的那一家',
    family: 'Sarasa Fixed SC',
    license: 'OFL 1.1',
    tags: ['中文', '等宽'],
  },
  {
    id: CUSTOM_CODE_FONT_PRESET_ID,
    label: '自定义',
    stack: '',
    note: '手打字体名（旧口径原样保留，非空时说了算）',
    family: '',
    license: '',
    tags: ['自定义'],
  },
];

/**
 * 界面字体档位（含自定义共十七档）。
 * 与代码档同一条口径：`license` 只写主打面的许可证，栈尾雅黑 / Segoe 是系统兜底；
 * 除 `mono` 档（吃代码栈，末位 `monospace`）外一律以 `sans-serif` 收尾——
 * `font-presets.test.ts` 的末位泛型闸一条没松。
 */
export const UI_FONT_PRESETS: readonly FontPreset[] = [
  {
    id: 'system',
    label: '系统（现状）',
    stack: UI_FONT_SYSTEM_STACK,
    note: 'Segoe UI + 雅黑 UI：本来的样子，选它 = 一位都不覆写',
    family: 'Segoe UI',
    license: '',
    tags: ['系统'],
  },
  {
    id: 'source-han',
    label: '思源黑体',
    stack: "'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'Noto Sans SC / 思源黑体优先，中文界面字重更整',
    family: 'Noto Sans SC',
    license: 'OFL 1.1',
    tags: ['中文', '黑体'],
  },
  {
    id: 'pingfang',
    label: '苹方',
    stack: "'PingFang SC', 'Segoe UI', 'Microsoft YaHei UI', sans-serif",
    note: 'PingFang SC 打头（Mac 味），Windows 上自动落到 Segoe/雅黑',
    family: 'PingFang SC',
    license: '',
    tags: ['系统'],
  },
  {
    id: 'mono',
    label: '等宽（跟随代码字体）',
    // 表内值是缺省代码栈的代表；生效时 `resolveUiFontStack` 现取所选代码栈
    stack: CODE_FONT_STACK,
    note: '界面文字跟随所选代码字体，全等宽控选这档',
    family: '',
    license: '',
    tags: ['随代码', '等宽'],
  },
  {
    id: 'noto-sans',
    label: 'Noto Sans + 思源黑体',
    stack: "'Noto Sans', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: '拉丁与中文同族：Noto Sans 配 Noto Sans SC，整套界面的字重与字宽最齐',
    family: 'Noto Sans',
    license: 'OFL 1.1',
    tags: ['拉丁', '中文', '黑体'],
  },
  {
    id: 'sarasa-gothic',
    label: '更纱黑体',
    stack: "'Sarasa Gothic SC', 'Sarasa UI SC', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: '更纱黑体的界面面（Gothic / UI）：与等宽档同一套字面，编辑器与外壳能对上',
    family: 'Sarasa Gothic SC',
    license: 'OFL 1.1',
    tags: ['中文', '黑体', '等宽'],
  },
  {
    id: 'lxgw-wenkai-ui',
    label: '霞鹜文楷',
    stack: "'LXGW WenKai', 'LXGW WenKai Screen', 'LXGW WenKai Mono', 'Microsoft YaHei UI', sans-serif",
    note: '楷体书卷气最足的一档；Screen 版为小字号屏显优化过',
    family: 'LXGW WenKai',
    license: 'OFL 1.1',
    tags: ['中文', '楷体'],
  },
  {
    id: 'source-han-serif',
    label: '思源宋体',
    stack: "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, 'Microsoft YaHei UI', sans-serif",
    note: '衬线档：Noto Serif SC / 思源宋体，长段说明文字的横细竖粗更好读',
    family: 'Noto Serif SC',
    license: 'OFL 1.1',
    tags: ['中文', '衬线'],
  },
  {
    id: 'wqy-microhei',
    label: '文泉驿微米黑',
    stack: "'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'Linux 中文桌面的老牌开源黑体，字重轻、小字号不糊',
    family: 'WenQuanYi Micro Hei',
    license: '开源',
    tags: ['中文', '黑体'],
  },
  {
    id: 'glow-sans',
    label: '未来荧黑',
    stack: "'Glow Sans SC', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: '未来荧黑（Glow Sans）：几何味更重的现代黑体，标题与卡片名很有辨识度',
    family: 'Glow Sans SC',
    license: 'OFL 1.1',
    tags: ['中文', '黑体'],
  },
  {
    id: 'smiley-sans',
    label: '得意黑',
    stack: "'Smiley Sans', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: '得意黑：斜切笔画的开源标题体，做界面大标题很出挑（正文仍落到思源黑体）',
    family: 'Smiley Sans',
    license: 'OFL 1.1',
    tags: ['中文', '标题'],
  },
  {
    id: 'inter-noto',
    label: 'Inter + 思源黑体',
    stack: "'Inter', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'Inter 是专为 UI 屏显设计的拉丁面，数字与大写标签最清楚',
    family: 'Inter',
    license: 'OFL 1.1',
    tags: ['拉丁', '中文', '黑体'],
  },
  {
    id: 'ibmplex-sans-noto',
    label: 'IBM Plex Sans',
    stack: "'IBM Plex Sans', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'IBM Plex Sans：与 Plex Mono 同族，编辑器和外壳想要一套气质时选它',
    family: 'IBM Plex Sans',
    license: 'OFL 1.1',
    tags: ['拉丁', '中文', '黑体'],
  },
  {
    id: 'roboto-noto',
    label: 'Roboto + 思源黑体',
    stack: "'Roboto', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'Roboto：Android 的老牌界面面，中性、紧凑、久看不累',
    family: 'Roboto',
    license: 'Apache 2.0',
    tags: ['拉丁', '中文', '黑体'],
  },
  {
    id: 'fira-sans-noto',
    label: 'Fira Sans',
    stack: "'Fira Sans', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'Fira Sans：与 Fira Code 同族，代码用 Fira Code 时外壳跟着它最搭',
    family: 'Fira Sans',
    license: 'OFL 1.1',
    tags: ['拉丁', '中文', '黑体'],
  },
  {
    id: 'open-sans-noto',
    label: 'Open Sans',
    stack: "'Open Sans', 'Noto Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'Open Sans：Google 早期的开源界面面，字面开阔、低分屏也清楚',
    family: 'Open Sans',
    license: 'OFL 1.1',
    tags: ['拉丁', '中文', '黑体'],
  },
  {
    id: CUSTOM_UI_FONT_PRESET_ID,
    label: '自定义',
    stack: '',
    note: '手打界面字体名（自动补 sans-serif 兜底）',
    family: '',
    license: '',
    tags: ['自定义'],
  },
];

export const CODE_FONT_PRESET_IDS: readonly string[] = CODE_FONT_PRESETS.map((p) => p.id);
export const UI_FONT_PRESET_IDS: readonly string[] = UI_FONT_PRESETS.map((p) => p.id);

/** 两张表里带开源许可证的档（设置页「开源 N 款」计数与判据同源，不另抄名单） */
export function openSourceFontPresets(): readonly FontPreset[] {
  return [...CODE_FONT_PRESETS, ...UI_FONT_PRESETS].filter((p) => p.license !== '');
}

/**
 * 标签展示次序（只排常用几类）。UI 收束批之后清单是行式的、不再画筛选 chip；
 * 这两个导出留作标签词表 / 派生工具（检索、分组扩展与判据用）。口径不变：表里没有的标签
 * 不列，表里新加而这里没排的追加在后面，不会静默消失。
 */
export const FONT_FILTER_TAGS: readonly string[] = [
  '等宽', '中文', '拉丁', '黑体', '楷体', '衬线', '标题', '系统', '内置', '随代码', '自定义',
];

/** 一组档位的标签全集（按上面的次序排好；要不要在最前补「全部」由调用方决定） */
export function fontFilterTagsFor(presets: readonly FontPreset[]): string[] {
  const present = new Set(presets.flatMap((p) => [...p.tags]));
  const ordered = FONT_FILTER_TAGS.filter((t) => present.has(t));
  const rest = [...present].filter((t) => !FONT_FILTER_TAGS.includes(t)).sort();
  return [...ordered, ...rest];
}

/** 解析所需的最小偏好面（避免与 `editor-display-prefs.ts` 成循环依赖） */
export interface CodeFontPrefs {
  readonly fontFamily: string;
  readonly codeFontPreset: string;
}

export interface UiFontPrefs extends CodeFontPrefs {
  readonly uiFontFamily: string;
  readonly uiFontPreset: string;
}

export interface ResolvedFontStack {
  /** 生效栈（一定可用：代码侧过 `isUsableCodeFontStack`，界面侧过 `isUsableUiFontStack`） */
  readonly stack: string;
  /** 实际生效的档位 id（恒在册）——设置页"当前生效哪档"就看它，不许静默换栈 */
  readonly presetId: string;
  /** 用户存的原始档位 id（可能与生效的不同；回落事实由 `presetId !== requestedPresetId` 读出） */
  readonly requestedPresetId: string;
  /** 回落 = 生效档位不是请求档位（id 不认识的兜底与旧自定义覆盖都算，UI 要能看出来） */
  readonly fellBack: boolean;
}

function findPreset(presets: readonly FontPreset[], id: string): FontPreset | undefined {
  return presets.find((p) => p.id === id);
}

function fallbackToDefaultCode(requested: string): ResolvedFontStack {
  return { stack: CODE_FONT_STACK, presetId: 'default', requestedPresetId: requested, fellBack: true };
}

/**
 * 代码栈解析（生效链唯一入口）：
 * ① 非空 `fontFamily`（老用户 / 自定义档）说了算——兼容红线，不许把自定义吃掉；
 * ② `custom` 档但文本为空 ⇒ 回落 `default` 并标记 `fellBack`（可见，不是静默换栈）；
 * ③ 档位 id 不认识 ⇒ 回落 `default` 并标记 `fellBack`；
 * ④ 表内栈过不了护栏（理论不该发生，闸在测试里）⇒ 同样回落 `default`。
 */
export function resolveCodeFontStack(prefs: CodeFontPrefs): ResolvedFontStack {
  const requested = typeof prefs.codeFontPreset === 'string' ? prefs.codeFontPreset : 'default';
  const customText = typeof prefs.fontFamily === 'string' ? prefs.fontFamily.trim() : '';
  if (customText !== '') {
    const usable = isUsableCodeFontStack(prefs.fontFamily) ? prefs.fontFamily : CODE_FONT_STACK;
    return {
      stack: usable,
      presetId: 'custom',
      requestedPresetId: requested,
      fellBack: requested !== CUSTOM_CODE_FONT_PRESET_ID || usable !== prefs.fontFamily,
    };
  }
  if (requested === CUSTOM_CODE_FONT_PRESET_ID) {
    // 选了自定义却没填字：不猜，回落内置并让它可见
    return fallbackToDefaultCode(requested);
  }
  const preset = findPreset(CODE_FONT_PRESETS, requested);
  if (!preset || preset.stack === '' || !isUsableCodeFontStack(preset.stack)) {
    return fallbackToDefaultCode(requested);
  }
  return { stack: preset.stack, presetId: preset.id, requestedPresetId: requested, fellBack: false };
}

/** 泛型末位判定：sans-serif / serif / monospace 三个泛型关键字（大小写不敏感） */
const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace']);

/** UI 栈可用性：成员无空位 + 末位是泛型（同 `isUsableCodeFontStack` 的"空家族整条失效"理由） */
export function isUsableUiFontStack(stack: string): boolean {
  if (stack.trim() === '') return false;
  const members = stack.split(',');
  if (members.some((m) => m.trim() === '')) return false;
  const last = members.at(-1)?.trim().toLowerCase();
  return last !== undefined && GENERIC_FAMILIES.has(last);
}

/**
 * UI 自定义栈清洗（口径与 `sanitizeFontFamily` 对称）：空 = 用档位；否则去空成员、
 * 缺泛型补 `sans-serif`，半坏栈一律回落空串（= 不生效，宁可这次自定义不算数也不喂坏值）。
 */
export function sanitizeUiFontFamily(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const members = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (members.length === 0) return '';
  const last = members.at(-1)!.toLowerCase();
  if (!GENERIC_FAMILIES.has(last)) members.push('sans-serif');
  const stack = members.join(', ');
  return isUsableUiFontStack(stack) ? stack : '';
}

/** 界面栈解析：`mono` 档现取所选代码栈；自定义吃 `uiFontFamily`；未知 id 回落 `system` */
export function resolveUiFontStack(prefs: UiFontPrefs): ResolvedFontStack {
  const system = (): ResolvedFontStack => ({
    stack: UI_FONT_SYSTEM_STACK,
    presetId: 'system',
    requestedPresetId: typeof prefs.uiFontPreset === 'string' ? prefs.uiFontPreset : 'system',
    fellBack: true,
  });
  const requested = typeof prefs.uiFontPreset === 'string' ? prefs.uiFontPreset : 'system';
  if (requested === CUSTOM_UI_FONT_PRESET_ID) {
    const custom = typeof prefs.uiFontFamily === 'string' ? prefs.uiFontFamily.trim() : '';
    if (custom !== '' && isUsableUiFontStack(prefs.uiFontFamily)) {
      return { stack: prefs.uiFontFamily, presetId: 'custom', requestedPresetId: requested, fellBack: false };
    }
    return system();
  }
  if (requested === 'mono') {
    // 跟随代码字体：代码侧解析已经保证可用（末位 monospace）
    const code = resolveCodeFontStack(prefs);
    return { stack: code.stack, presetId: 'mono', requestedPresetId: requested, fellBack: false };
  }
  const preset = findPreset(UI_FONT_PRESETS, requested);
  if (!preset || preset.stack === '' || !isUsableUiFontStack(preset.stack)) return system();
  return { stack: preset.stack, presetId: preset.id, requestedPresetId: requested, fellBack: false };
}

/* ---------------------------- 可用性判定（可注入替身） ---------------------------- */

/** 判定替身：吃 CSS `font` 简写串（如 `16px "Cascadia Code"`），返回本机是否存在该面 */
export type FontPresenceChecker = (fontSpec: string) => boolean;

/** 栈成员拆名（去引号、去空白；泛型关键字也返回，由调用方过滤） */
export function fontStackMembers(stack: string): string[] {
  return stack
    .split(',')
    .map((m) => m.trim().replace(/^['"]|['"]$/g, ''))
    .filter((m) => m !== '');
}

/** 栈里的具体家族名（排除泛型关键字——泛型永远"存在"，标了是噪声） */
export function fontStackConcreteMembers(stack: string): string[] {
  return fontStackMembers(stack).filter((m) => !GENERIC_FAMILIES.has(m.toLowerCase()));
}

export interface FontPresenceEntry {
  readonly family: string;
  readonly present: boolean;
}

/**
 * 逐成员可用性（不静默口径的实现处）：返回每个具体家族的在册与否。
 * `checker` 拿不到（node 测试 / 老壳没有 `document.fonts`）⇒ 返回 `null` = **无法判定**，
 * UI 必须显示"判定不了"而不是"都装了"。
 */
export function checkFontStackPresence(
  stack: string,
  checker: FontPresenceChecker | null = domFontPresenceChecker(),
): FontPresenceEntry[] | null {
  if (checker === null) return null;
  return fontStackConcreteMembers(stack).map((family) => {
    try {
      return { family, present: checker(`16px "${family}"`) };
    } catch {
      // 判定本身抛错 = 判定不了这一枚，标成存在会撒谎，标成缺失会误报——按"存在"跳过标注，
      // 但整表仍返回（口径：判定失败不影响兜底栈本身生效）
      return { family, present: true };
    }
  });
}

/**
 * 判定用的**拉丁 + 数字 + 符号**样本。不许换成汉字：CJK 面里全角字的步进几乎恒等于 1em
 * （同一个 `無` 在宋体 / 黑体 / 等宽面里都是 16px），拿它比宽会把**装了的面**读成"和兜底一样宽"
 * ⇒ 误报缺装。拉丁 + 比例符号才有区分度（实测见 `measureFontPresence` 注记）。
 */
export const PRESENCE_SAMPLE = 'MWil@%3mw0123';
/** 三把泛型尺：缺装的面在**每一把**尺上都逐字等于该尺自己的兜底宽度 */
export const PRESENCE_GENERICS = ['sans-serif', 'serif', 'monospace'] as const;

/**
 * 纯判定核（量尺可注入，单测在这里自证，不依赖真壳）：`measure(cssFontShorthand) => 文本宽度`。
 *
 * 判据：**每一把**泛型尺上 `16px "F", G` 与 `16px G` 完全同宽 ⇒ F 根本没被用上 ⇒ 缺装。
 * 只看一把尺会被巧合骗过去，三把都重合基本只剩"整条栈落到兜底"这一种解释。
 * 任一次量尺拿不到数（NaN / 0 / 负数 / 抛错）⇒ 返回 `true` = 判定不了就不标注（与 `checkFontStackPresence` 同口径）。
 *
 * 实测（真壳 WebView2 `canvas.measureText`，同一段样本，2026-10-24 组长复验）：
 *  - 装着的：`'Segoe UI'` 103.717 / `'Microsoft YaHei UI'` 112.828，且配任意泛型仍保持自己的宽度；
 *  - 没装的：`'LXGW WenKai Mono'` / `'Sarasa Mono SC'` / `'JetBrains Mono'` / 生造名——配 sans 逐字等于
 *    `sans-serif`(106.116)、配 mono 等于 `monospace`(84)、配 serif 等于 `serif`(110.991)。
 *  - 同一段名单在 `document.fonts.check('12px "…"')` 下**全部返回 true**（Chromium 那个 API 问的是
 *    "这条字体串能不能渲染"，走兜底也叫能）⇒ 它当不了"装没装"的判据，本函数因此换掉它。
 */
export function measureFontPresence(family: string, measure: (cssFontShorthand: string) => number): boolean {
  const width = (spec: string): number | null => {
    try {
      const w = measure(spec);
      // 0 / 负数 / 非有限数都算"量不到"：一把恒发 0 的尺子会让每格都"三把尺同宽"，
      // 于是全场误报缺装——判定不了就不标注，宁可不说。
      return Number.isFinite(w) && w > 0 ? w : null;
    } catch {
      return null;
    }
  };
  for (const generic of PRESENCE_GENERICS) {
    const baseline = width(`16px ${generic}`);
    const probed = width(`16px "${family}", ${generic}`);
    if (baseline === null || probed === null) return true;
    if (baseline !== probed) return true;
  }
  return false;
}

/** 从 CSS `font` 简写串里取家族名（引号收尾优先，退化到最后一个不含逗号的记号；取不到 ⇒ null） */
function familyFromFontSpec(spec: string): string | null {
  const quoted = /(["'])([^"']+)\1\s*$/.exec(spec);
  if (quoted?.[2] !== undefined && quoted[2] !== '') return quoted[2];
  const last = spec.trim().split(/\s+/).at(-1);
  if (last === undefined || last === '' || last.includes(',')) return null;
  return last;
}

/**
 * 真壳判定源：**canvas 量宽**（判据与实测见 `measureFontPresence`）。
 * 没有 DOM / 拿不到 2D 上下文（jsdom 与没装 canvas 依赖的测试环境就是这样）⇒ `null`，
 * 调用方据此显示"判定不了"，绝不显示"都装了"。
 */
export function domFontPresenceChecker(): FontPresenceChecker | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext?.('2d');
  if (!ctx) return null;
  return (fontSpec: string): boolean => {
    const family = familyFromFontSpec(fontSpec);
    if (family === null) return true;
    return measureFontPresence(family, (shorthand) => {
      ctx.font = shorthand;
      return ctx.measureText(PRESENCE_SAMPLE).width;
    });
  };
}

/** 所见即所得预览样例：全角百分号 + 全角空格 + 中日汉字 + 常被连字糊掉的符号串 */
export const FONT_PREVIEW_SAMPLE = '@KOJO_無個性 霊夢 100％　ＡＢＣ != -> ::';
