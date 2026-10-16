import type { EditorOptionPatch } from './editor-options';

/**
 * 编程字体单一真源：一条栈同时喂 Monaco 与 CSS。
 *
 * 改前实况：Monaco 干脆没设 `fontFamily`（走它自己的平台默认栈）、`--font-mono` 另写一份、
 * 还有八处散装 `Consolas, 'Cascadia Mono', monospace` —— 编辑器字面 / UI 等宽面 / 流面
 * 三处口径互不相干。这里只管第一档：`--font-code`（CSS 侧是它的镜像，见下）。
 *
 * 键全部对 monaco-editor@0.57.0 实测核实（`IEditorOptions` 在册）：`fontFamily`(4197) /
 * `fontLigatures`(3715) / `fontVariations`(3720) / `fullwidthCharacterWidth`(4008) /
 * `letterSpacing`(4213)。`fontInformation` **在这版 d.ts 里根本不存在**（VS Code 的 settings
 * 词汇）——字体缺失的兜底走 `BareFontInfo.getMassagedFontFamily()`：Monaco 自动把平台默认栈
 * （Windows：`Consolas, 'Courier New', monospace`）追加到我们这条之后。所以没入口可钉、也不该钉，
 * 唯一要防的事故是**把空串喂进去**（`EditorStringOption.string` 只挡非字符串，空串原样通过，
 * 追加结果变成 `, Consolas, ...` ⇒ 度量错位、光标格子错宽）⇒ `isUsableCodeFontStack`。
 *
 * `lineHeight` 与 `fontSize` 刻意不进这份补丁：字号是 A1 偏好独立管的那条轴，行高沿用 Monaco
 * 自己的计算值（`round(1.35 × fontSize)`，天然整数，不引入本仓明令禁止的半像素）。
 */

/**
 * 唯一一条栈：拉丁代码面 → 中文回退 → 泛型兜底。
 *
 * 拉丁：Cascadia Code 打头（Win11 自带、终端向 hinting、单元格 0.586em 比 Consolas 0.55em 透气；
 * 它是变量字体，靠 `fontVariations:false` 走默认实例，轴不进网格）。Cascadia Mono 兜「有系统
 * 没装 Terminal」的机器——连字整体关掉之后 Code/Mono 此刻像素等价，Code 在前只为「哪天开连字
 * 不必重排栈」。JetBrains Mono / Fira Code 是别人机器上的加分项，缺了零成本跳过。Consolas 是
 * Windows 一定有的等宽底线。
 *
 * 中文：实测 Consolas / Cascadia 三张拉丁面都不含汉字与全角标点（gid 0），必然落到这一段。
 * `Era Mono SC` 打头——口上作者常自装的等宽中文代码面，全角严格 = 2 半角，整屏网格与
 * `fullwidthCharacterWidth:'twoCells'` 的口径一致；雅黑 / SimHei 是系统级兜底（实测 SimHei
 * 半角 0.5em、全角 1.0em，2:1 严格成立）。**中文字面一律排在拉丁面之后**：位置反了，拉丁字形
 * 会被中文面自带的半比例拉丁接管，整套等宽就废了。
 */
export const CODE_FONT_STACK =
  "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Era Mono SC', 'Microsoft YaHei UI', 'Microsoft YaHei', SimHei, '黑体', 'Noto Sans SC', monospace";

/** CSS 侧镜像 token 名（Monaco 不读 CSS；真源在这份 TS） */
export const CODE_FONT_CSS_TOKEN = '--font-code';

/** 镜像声明整行：单测拿它去 styles.css 里逐字找——改一处必改两处，这条闸就是防这个 */
export const CODE_FONT_CSS_LINE = `${CODE_FONT_CSS_TOKEN}: ${CODE_FONT_STACK};`;

/**
 * 连字关。两条理由，第二条是硬的：本仓编辑的是**数据**（中文口上 + ERB 指令 + 全角标点），
 * `!=` `->` `::` 糊成一个字形会让「看到的」与「选中/删除的 code point」不一致 = 误读；
 * 且 vendor 实测 `fontMeasurements.js:139` 拿 `fontFeatureSettings === EditorFontLigatures.OFF`
 * 判 `isMonospace` —— 连字一开，Monaco 直接放弃等宽判定，连带 `fullwidthCharacterWidth:'twoCells'`
 * （它要求 `fontInfo.isMonospace`）与空格/Tab 度量优化一起失效。
 */
export const CODE_FONT_LIGATURES = false;

/** 字距 0：`letterSpacing` 是逐字符加在推进上的，非 0 会让 spaceWidth 网格与字形脱钩 */
export const CODE_FONT_LETTER_SPACING = 0;

/** 全角按两列算：跨机器不变量「1 汉字 = 2 列」，软换行断点不随「装了哪张中文字面」漂移 */
export const CODE_FONT_FULLWIDTH_CELL: 'font' | 'twoCells' = 'twoCells';

/** 能否安全交给 Monaco：非空、成员无空位、泛型 monospace 在末位（空家族 = 整条声明失效） */
export function isUsableCodeFontStack(stack: string): boolean {
  if (stack.trim() === '') return false;
  const members = stack.split(',');
  if (members.some((m) => m.trim() === '')) return false;
  return members.at(-1)?.trim() === 'monospace';
}

/** 抛错口径（单测 / 开发期用；生产链路走下面的静默回落，绝不把崩抛进渲染链） */
export function assertCodeFontStack(stack: string = CODE_FONT_STACK): void {
  if (!isUsableCodeFontStack(stack)) throw new Error(`编程字体栈不可用：${stack}`);
}

function buildCodeFontBaseline(): EditorOptionPatch {
  // 栈坏掉 ⇒ 整条不注入：让 Monaco 用它自己的平台默认栈（等宽、度量自洽），比喂半坏值好
  if (!isUsableCodeFontStack(CODE_FONT_STACK)) return {};
  return {
    fontFamily: CODE_FONT_STACK,
    fontLigatures: CODE_FONT_LIGATURES,
    fontVariations: false,
    letterSpacing: CODE_FONT_LETTER_SPACING,
    fullwidthCharacterWidth: CODE_FONT_FULLWIDTH_CELL,
  };
}

/**
 * 喂 Monaco 的那一份。**只 spread 在实例创建路径**，不进 `editorOptionsForLineCount`
 * （体量降级集永不含字体键，与「降级集永不含 fontSize/zoomLevel」同一条不变式）。
 * 连带面实测自动继承，无需另钉：`codeLensFontFamily` 空 = 随编辑器家族（字号 `fontSize*.9|0`
 * 仍是整数），`inlayHints.fontFamily` 空 = `options.fontFamily || editorFontFamily`。
 */
export const CODE_FONT_BASELINE: EditorOptionPatch = buildCodeFontBaseline();
