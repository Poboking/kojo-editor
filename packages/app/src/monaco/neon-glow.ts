/**
 * Synthwave '84 · 编辑器霓虹光（"Neon Dreams"）
 *
 * 实现直接照搬 robb0wen/synthwave-vscode 的 `src/js/theme_template.js`：
 *
 * 1. 官方**不认识 token id**，它是按**颜色**改写的 —— VS Code 会把每个 token 色写成
 *    `.mtk7 { color: #fede5d; }` 注进一个 `<style>`，扩展用 `color: #xxxxxx;` 正则把
 *    那一句换成"灯管芯色 + 几道 text-shadow"（`replaceTokens`）。
 * 2. 我们这套壳里 Monaco 0.57 生成的是同一张表（见 `languages/supports/tokenization.js`
 *    的 `generateTokensCSSForColorMap`：`.mtk${i} { color: ${color}; }`），所以同一招
 *    原封不动可用：扫 DOM 里的 `<style>`，捞出"颜色＝配方里那几枚霓虹色"的 mtk 序号。
 * 3. 官方挂了 `MutationObserver` 等令牌表出现（`watchForBootstrap`）。我们不观察 ——
 *    本仓有比观察更准的时机：Monaco 写表就在 `setTheme` 那一帧里同步完成，见
 *    `theme.ts::applyMonacoTheme`（确定点）+ `defineMonacoThemes`（开机早到的有限重试）。
 *
 * 为什么不能写死 `.mtk7`：mtk 序号是 Monaco 的 ColorMap 按 rules 顺序分配的，换一档主题、
 * 甚至只调整规则顺序就会变。按颜色查是唯一稳的办法——官方也是这么解决的。
 *
 * **本仓只启用官方表里的两档**（黄 `fede5d` + 粉 `ff7edb`，即本仓 ERB 关键字的全部两族），
 * 启停与理由写在 `NEON_GLOW_ENABLED` / `CORE_OVERRIDE` 两处；下面那张表仍是官方原表，
 * 一字未改。
 *
 * ## 配方逐字表（`theme_template.js` 的 `tokenReplacements`，一字未改）
 *
 * | 源色 | 灯管芯 | 辉光 |
 * |---|---|---|
 * | `fe4450` 红 | `#fff5f6` | `0 0 2px #000, 0 0 10px #fc1f2c<A>, 0 0 5px #fc1f2c<A>, 0 0 25px #fc1f2c<A>` |
 * | `ff7edb` 霓虹粉 | `#f92aad` | `0 0 2px #100c0f, 0 0 5px #dc078e33, 0 0 10px #fff3` |
 * | `fede5d` 黄 | `#f4eee4` | `0 0 2px #393a33, 0 0 8px #f39f05<A>, 0 0 2px #f39f05<A>` |
 * | `72f1b8` 绿 | `#72f1b8` | `0 0 2px #100c0f, 0 0 10px #257c55<A>, 0 0 35px #212724<A>` |
 * | `36f9f6` 青 | `#fdfdfd` | `0 0 2px #001716, 0 0 3px #03edf9<A>, 0 0 5px #03edf9<A>, 0 0 8px #03edf9<A>` |
 *
 * 三处容易被"顺手优化"掉、但必须保住的细节：
 * - 文字色**不是**霓虹色本身，而是一枚更亮（或更沉）的灯管芯色：黄档是过曝的近白暖色
 *   `#f4eee4`、青档是 `#fdfdfd`、粉档反而**压深**到 `#f92aad` —— 霓虹灯管是"芯亮壳艳"，
 *   照抄原色只会得到一圈脏光。
 * - 粉档的 alpha 是**写死**的：`#dc078e33`（0.2）与 `#fff3`（0.2）。它不吃亮度参数，官方
 *   就是这么写的，别"统一"成 `<A>`。
 * - 每档都带 `backface-visibility: hidden`：压掉 Chrome 在亚像素定位下给 text-shadow
 *   叠出来的重影。
 *
 * 亮度 0.45 是官方缺省，换算 `Math.floor(0.45 * 255).toString(16)` = `72`（两位十六进制
 * alpha 直接拼在色值后面，`#f39f0572`）；README 明确说调高会晃眼、不适合长时间使用。
 */

/** 官方缺省亮度 0.45 —— 再高会晃眼（README 原话：避免长时间使用高亮度） */
export const NEON_GLOW_BRIGHTNESS = 0.45;

/** 一条官方配方：源色（小写无 `#`）+ 灯管芯色 + 辉光（`%A` 会被换成两位 alpha） */
export interface NeonDreamRecipe {
  /** Monaco 令牌表里的源色（小写、不含 `#`）：命中这个色才上光 */
  readonly hex: string;
  /** 灯管芯色（文字本身染成这个） */
  readonly core: string;
  /** text-shadow，`%A` = 亮度换算出的两位十六进制 alpha */
  readonly shadow: string;
}

/**
 * 官方五色表，顺序与 `theme_template.js` 一致（红 → 粉 → 黄 → 绿 → 青）。
 *
 * 本仓调色板用不到 `fe4450`（没有红档），留着是为了"表就是官方那张表"——扫不到就自然
 * 不生成任何规则，不会多出半条废 CSS。
 */
export const NEON_DREAMS_RECIPES: readonly NeonDreamRecipe[] = [
  {
    hex: 'fe4450',
    core: '#fff5f6',
    shadow: '0 0 2px #000, 0 0 10px #fc1f2c%A, 0 0 5px #fc1f2c%A, 0 0 25px #fc1f2c%A',
  },
  {
    hex: 'ff7edb',
    // 官方粉档不吃亮度：`#dc078e33` / `#fff3` 两枚 alpha 是写死的（勿"统一"）
    core: '#f92aad',
    shadow: '0 0 2px #100c0f, 0 0 5px #dc078e33, 0 0 10px #fff3',
  },
  {
    hex: 'fede5d',
    core: '#f4eee4',
    shadow: '0 0 2px #393a33, 0 0 8px #f39f05%A, 0 0 2px #f39f05%A',
  },
  {
    hex: '72f1b8',
    core: '#72f1b8',
    shadow: '0 0 2px #100c0f, 0 0 10px #257c55%A, 0 0 35px #212724%A',
  },
  {
    hex: '36f9f6',
    core: '#fdfdfd',
    shadow: '0 0 2px #001716, 0 0 3px #03edf9%A, 0 0 5px #03edf9%A, 0 0 8px #03edf9%A',
  },
];

/** 亮度 → 两位十六进制 alpha（官方算法逐字：`Math.floor(brightness * 255).toString(16)`） */
export function glowAlphaHex(brightness: number = NEON_GLOW_BRIGHTNESS): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(brightness) ? brightness : NEON_GLOW_BRIGHTNESS));
  return Math.floor(clamped * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * 灯管芯色的**唯一一处**例外：粉档不压深。
 *
 * 官方粉档把文字从 `#ff7edb` 压到 `#f92aad`（上图那张表逐字在案），那是 VS Code 深底
 * `#241b2f` 上的手感。本盘底色是 `#262335`，`#f92aad` 在上面只有 **4.34:1** —— 低于
 * WCAG AA 的 4.5，而本仓对 Synthwave 的公开承诺是"最弱一档仍有 4.66"（见 `theme.ts`
 * 的色板头注）。粉色档又正压在 `variable` / `keyword.erb`（ERB 控制流）这两族高频
 * token 上，压深等于把整个文件的可读性往下拽一档。
 *
 * 所以：**辉光照搬官方**（`#dc078e33` + `#fff3` 两枚写死 alpha 一个没改），只把灯管芯
 * 留在原色上。视觉上仍是"粉灯管"，因为它本来就亮得起来；差别只是不靠压暗换对比。
 */
const CORE_OVERRIDE: Readonly<Record<string, string>> = { ff7edb: 'ff7edb' };

/**
 * 本仓**只启用这两档**：`fede5d`（`keyword` 基底指令/声明）与 `ff7edb`（`keyword.erb`
 * ERB 控制流，在本盘与 `variable` 同色）。理由不是"少即是多"，是这三条：
 *
 * - 用户要的是**关键字**发光。本仓 ERB 的关键字散在两档颜色上（`IF` 一族走
 *   `keyword.erb` 粉、`PRINTFORMW` 一族走 `keyword` 黄），两档都点才叫"关键字都亮了"；
 * - **色相是语义**：官方把青档 `36f9f6` 推到近白 `#fdfdfd`、绿档原地发光。可本盘
 *   `36f9f6` 是 `label` —— ERB 里 `@标签` 这个**定位锚点**，全文件靠它认段落；改成近白
 *   就和 `identifier`（`#eae6f5`）撞成一色，"标签 vs 正文"这一层信息直接消失。
 *   台词薄荷 `72f1b8` 同理（它是"这是人说的话"的唯一记号）。宁可这族不亮，也不换色；
 * - `fe4450` 红：本盘没有这一档，留着只是让表是官方那张表（扫不到就自然不生成规则）。
 */
export const NEON_GLOW_ENABLED: readonly string[] = ['fede5d', 'ff7edb'];

/**
 * 实际生效的配方表 = 官方五色表里被启用的那几档 + 上面那一处芯色例外。
 *
 * 扫色、上光、单测全用这一份；`NEON_DREAMS_RECIPES` 只作为"官方原表"的对照物留在案上，
 * 免得下次有人以为芯色或档位是随手改的。
 */
export const NEON_GLOW_RECIPES: readonly NeonDreamRecipe[] = NEON_DREAMS_RECIPES.filter((r) =>
  NEON_GLOW_ENABLED.includes(r.hex),
).map((r) => {
  const core = CORE_OVERRIDE[r.hex];
  return core === undefined ? r : { ...r, core: `#${core}` };
});

/** 一条配方 → 一条 text-shadow（把 `%A` 换成 alpha） */
export function shadowOf(recipe: NeonDreamRecipe, brightness: number = NEON_GLOW_BRIGHTNESS): string {
  return recipe.shadow.replace(/%A/g, glowAlphaHex(brightness));
}

/** 扫描式：`theme_template.js` 的 `new RegExp('color: #' + color + ';', 'gi')`，但我们不替换原表 */
function classIdsOfColor(cssText: string, hex: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(`\\.mtk(\\d+)\\s*\\{[^}]*?\\bcolor:\\s*#${hex}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** 一条规则（作用域三重收口，见 `buildGlowCss`） */
function ruleFor(ids: readonly string[], recipe: NeonDreamRecipe, brightness: number): string {
  const shadow = shadowOf(recipe, brightness);
  return ids
    .map(
      (id) =>
        `:root[data-theme='synthwave84'] .monaco-editor .view-line span.mtk${id} {\n` +
        `  color: ${recipe.core};\n` +
        `  text-shadow: ${shadow};\n` +
        `  backface-visibility: hidden;\n` +
        `}`,
    )
    .join('\n');
}

/**
 * 生成要注入的规则。作用域三重收口：
 * - `:root[data-theme='synthwave84']` —— 换到别的档，这段 CSS 自然失效，不用撤销；
 * - `.monaco-editor` —— 只碰编辑器，不碰补全/hover 等浮层的同名 class；
 * - `.view-line span` —— 只碰正文行的 token，行号、缩略图、装饰层一概不进光。
 *
 * 为什么不学官方"直接改令牌表文本"：那张表是 Monaco 的私有产物，它换主题就整段重写；
 * 改写它等于跟 Monaco 抢同一份 DOM，还得自己负责换档撤销。附加规则同样逐字得到官方的
 * 视觉结果（灯管芯色 + 同款光影），却天然可按主题作用域开关。
 */
export function buildGlowCss(
  hits: ReadonlyArray<{ readonly recipe: NeonDreamRecipe; readonly ids: readonly string[] }>,
  brightness: number = NEON_GLOW_BRIGHTNESS,
): string {
  return hits
    .filter((h) => h.ids.length > 0)
    .map((h) => ruleFor(h.ids, h.recipe, brightness))
    .join('\n');
}

/** 注入点 id（幂等键：重复 install 只会覆盖同一枚 `<style>`） */
const STYLE_ID = 'kojo-synthwave-keyword-glow';

/** 从文档里捞出"配方里那些霓虹色"的 mtk 序号（扫所有 `<style>` 的文本，官方同法） */
export function scanGlowHits(
  doc: Document,
  recipes: readonly NeonDreamRecipe[] = NEON_GLOW_RECIPES,
): Array<{ recipe: NeonDreamRecipe; ids: string[] }> {
  const hits = recipes.map((recipe) => ({ recipe, ids: [] as string[] }));
  for (const el of Array.from(doc.querySelectorAll('style'))) {
    const text = el.textContent ?? '';
    if (!text.includes('mtk')) continue;
    for (const hit of hits) {
      for (const id of classIdsOfColor(text, hit.recipe.hex)) {
        if (!hit.ids.includes(id)) hit.ids.push(id);
      }
    }
  }
  return hits;
}

/**
 * 装一次（幂等）。一条都扫不到说明 Monaco 还没把令牌表写进 DOM，或者当前不是 Synthwave
 * 这一档 —— 此时**不注入半成品**（并把旧的撤掉，避免换档后留一层孤儿样式），交给调用方
 * 决定要不要重试。
 *
 * @returns 本次是否成功注入
 */
export function installKeywordGlow(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): boolean {
  if (!doc || !doc.head) return false;
  const css = buildGlowCss(scanGlowHits(doc));
  const existing = doc.getElementById(STYLE_ID);
  if (!css) {
    existing?.remove();
    return false;
  }
  const style = existing ?? doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  if (!existing) doc.head.appendChild(style);
  return true;
}

/**
 * 取一个可用的 `setTimeout`。**不能直接 `window.setTimeout`**：node 侧与部分 DOM 替身里
 * `window` 存在却没有挂定时器（实测 `monaco-token-mirror` 用例：`window.setTimeout is not
 * a function`，一次把 6 个套件拖红）。拿不到就不排重试——少一层兜底，绝不抛。
 */
function later(fn: () => void, ms: number): void {
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    window.setTimeout(fn, ms);
    return;
  }
  if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(fn, ms);
}

/**
 * 定时兜底：令牌表是 Monaco 在**第一次 setTheme 之后**才写进 `<head>` 的，而
 * `defineMonacoThemes` 跑在语言注册时，比它更早。这里用有限次重试（不是轮询常驻）：
 * 成功即停；失败也只是没有光晕，绝不影响编辑器本身。
 *
 * 真正确定的时机在 `theme.ts::applyMonacoTheme`（`setTheme` 之后紧跟一发），本函数只兜
 * "开机就带着项目进来"那种更早的路径。
 */
export function scheduleKeywordGlow(attempts = 12, intervalMs = 250): void {
  if (typeof window === 'undefined') return;
  let left = attempts;
  const tick = (): void => {
    if (installKeywordGlow()) return;
    left -= 1;
    if (left > 0) later(tick, intervalMs);
  };
  tick();
}
