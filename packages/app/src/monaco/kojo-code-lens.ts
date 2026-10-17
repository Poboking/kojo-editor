import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  EditorCodeLens,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import { registerForKojoDialects } from './register-dialects';

/**
 * 行上内联注解的**宿主接线**（B8，2026-10-16 行内注解批）：`ui.editor.languageService`
 * 判别式联合第五员 `codeLens` 的 Monaco 翻译层。
 *
 * 分层照本仓每一批 monaco 接线的旧例：**纯逻辑**（合并 / 抛错隔离 / 去重 / 越界丢弃 /
 * 排序 / 产出预算）与 **Monaco 协议翻译**（`installCodeLensProvider`）分开，前者可脱离
 * React 与编辑器单测。宿主**不认识**"被引用"是什么意思、更不认识 `@` 函数——文本说什么
 * 全由贡献方给（B8 的供方是 `erb-parser` 的 `erb-usage-lens`，判据与反向索引同源，
 * 见 `packages/plugins/erb-parser/src/usage-lens.ts`），宿主只管画出来、以及点击时把落点
 * 交给**既有**导航通道 `editor.revealLocation`（与转到定义那条腿同一条通道，不新造第二套跳转）。
 *
 * ## 与相邻呈现面的分工（同一状态只在一处显示，判据照 `breadcrumb-path.ts` 的写法）
 *
 * 注解说的是**这一处定义被谁用到**（反向边），与悬停（记号的中文名）、转到定义（正向边：
 * 这个名字定义在哪）、大纲/折叠/面包屑（结构）、条件矩阵（走到它的条件）都不重合；
 * "在什么条件下会走到"这类状态**已由条件矩阵面板独占呈现**，本批刻意不再在行上重复一遍。
 *
 * ## 代价模型（为什么必须有下面那三档降级；取证 monaco-editor 0.57）
 *
 * `editor/contrib/codelens/browser/codelens.js:42` ⇒ `provideCodeLenses(model, token)`
 * **没有可视区间参数**：一次请求就是**整篇文档**的注解，不是当前屏那几十行。
 * `codelensController.js` 的 `onDidChangeModelContent → scheduler.schedule()`（"Ask for all
 * references again"）⇒ **每次停笔都重算整篇**（缺省防抖 ≥250ms，且 Monaco 会按上一次实测
 * 耗时自适应放大这个间隔）。所以单价 = 全文解析一遍 + 每个定义一次索引查询。
 *
 * 真实语料实测（3,971 份方言文件 / 110,194 处定义；**读数由
 * `packages/plugins/erb-parser/tests/usage-lens.corpus.test.ts` 走真注册复跑并钉住**）：
 *
 * | 对象 | 行数 | 定义数 | 一次完整产出（parse + 全部计数） |
 * |---|---|---|---|
 * | 门槛外最大单文件 | 52,602 | 124 | parseText 冷 5.6 / 热 5.5ms；**整篇 provide 5.8ms 出 62 条** |
 * | 门槛内最贵那篇（COMMON.ERB） | 4,353 | — | **7.1–9.4ms** 出 148 条（热态 5.8ms） |
 * | 门槛内产出最多那篇 | 3,830 | — | 1.1–1.9ms → **163 条**（全库最高） |
 *
 * 全库产出总账：门槛内 **2,187 篇出注解、共 33,231 条**，每篇 P50=1 / P90=19 / P99=71 /
 * max=163 ⇒ **顶到 200 条上限的 0 篇**（那条纯护栏），**超 1/5 密度的 6 篇**。
 *
 * ⇒ **代价曲线实测是平的**：52,602 行那篇一次只 5.8ms，和门槛内最贵那篇同量级（parse 单价
 * 远低于预期）。所以体量档**不是**"这一篇跑不动"的决定，跑不动的档位 Monaco 自己划在
 * 30 万行 / 20MB（`textModel.js` 的 `LARGE_FILE_LINE_COUNT_THRESHOLD`，越过它 Monaco 连
 * tokenization 都不做，code lens 一条不画）——那条线比我们宽 60 倍，指望不上。
 * 这一档立着的两条真理由：
 * ① **与本仓既有降级同一条线**（`stickyScroll` / 面包屑都用 `LARGE_FILE_LINES`）：作者看到的
 * 是"超长文件里省着来的功能"这一条规则，而不是每面各划一档；
 * ② **上限是 O(行数) 而无别的护栏**：parse 单价随行数线性走，语料最大 5.2 万行≠以后最大，
 * 一次押注"当前这份刚好不贵"的降级，下次换个巨型合并文件就变成每次停笔付 50ms。
 * 判在**问供方之前**（省掉那一次全文 parse 与全文字符串拷贝）。
 */

/**
 * 单篇文档的注解条数上限（**整篇**，不是可视区——见上方代价模型）。
 *
 * 语料读数：行数门槛之内的 3,831 份文件里，实际产出最多的一篇是 **163 条**，
 * 一篇顶到 200 的都没有 ⇒ 这条上限在真实工程上**够不着**，它是给"未来某个供方一次给出
 * 几千条"兜底的护栏，不是用来裁剪现有语料的。
 */
export const CODE_LENS_MAX_PER_DOCUMENT = 200;

/**
 * 密度上限：**每 5 行正文最多 1 条注解**。
 *
 * 为什么按密度而不是只按条数：一条注解 = Monaco 的一个 view zone，**实打实往正文里插一行**。
 * 作者抱怨的不是"有注解"，是"正文被插满了"。
 *
 * 真实语料上这道档拦到的**只有微型文件**：超密的 6 篇全是 2–5 行那批（`floor(行数/5)=0`
 * ⇒ 一行都不许插），过得了预算的最坏一份是 5 行出 1 条（20.0% 的行）。定义密度高
 * **不等于**注解密度高：门槛内定义最多的一篇有 621 个定义，却压根没顶到这条线
 * （名单里没有它——超密那 6 篇全是微型文件）；大量定义拿不到可证明的引用，见供方那条"孤儿"口径。
 * 所以它的两个身份要分开说清：**当下**它管的是"两行的文件不许被插成一半是批注"，
 * **将来**它是给"某个供方一次给出几百条"兜底的第二道护栏（与条数上限同性质）。
 * 刻意不写成"裁剪"：过了这道线整篇不给，而不是把超出的几条抹掉（理由见下一段）。
 */
export const CODE_LENS_MAX_DENSITY = 5;

/**
 * 这次值不值得去问供方（**宿主档降级**，与 `editor-options` 里 `stickyScroll` /
 * 面包屑的 `crumbsNeedRefresh` 同一条理由、同一个阈值）。
 *
 * 判在**请求之前**：`provideCodeLenses` 没有可视区间，一开口就是整篇文档的解析与全文字符串。
 * 这一档不是"少报"，是"这一篇不办"（两条真理由与实测代价曲线见本模块头注：
 * 当前语料上跑一次只要 5.8ms，立这条档买的是**一致性**与**行数线性下的上限**，不是今天的速度）。
 */
export function codeLensAffordable(lineCount: number): boolean {
  return lineCount < LARGE_FILE_LINES;
}

/**
 * 产出预算（**全有或全无**，纯函数）。
 *
 * 为什么超限时要**整篇不给**而不是"给前 N 条"：行上注解的缺席本身携带语义
 * （贡献方的口径是"没有可证明的东西可说 ⇒ 这一行闭嘴"）。一旦让缺席同时表示
 * "额度用完了"，作者在一行没看到注解时读到的是两句不同的话，而他没有办法分辨。
 * code lens 也没有列表头可以写"另有 N 条未列出"（工作区符号那套补白在这里没有落点）。
 * ⇒ 宁可整篇没有，也不要让"没有"变成谎话。
 */
export function withinCodeLensBudget(lensCount: number, lineCount: number): boolean {
  if (lensCount > CODE_LENS_MAX_PER_DOCUMENT) return false;
  return lensCount <= Math.floor(lineCount / CODE_LENS_MAX_DENSITY);
}

/**
 * 合并全部贡献方的注解。
 *
 * 隔离与去重口径同 `collectFoldingRanges` / `collectDocumentSymbols`：**单枚贡献抛错
 * 不能让整篇注解消失**（能力出错退化可见，不让一条呈现面带崩编辑器）。
 * 去重键 = 行 + 文本：两枚供方在同一行给同一句话（例如日后 ERB 与别的方言线都答同一份
 * 文件）不该画出两个一模一样的气泡。同**行**不同**文本**保留——Monaco 会把同一行的多条
 * 注解并排渲染，那是两句话，不是一句话被说了两遍。
 */
export function collectCodeLenses(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorCodeLens[] {
  const out: EditorCodeLens[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-code-lens] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    if (!result || result.kind !== 'codeLens') continue;
    for (const lens of result.lenses) {
      const key = `${lens.line}\u0000${lens.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(lens);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** CodeLens 点击命令 id（宿主自注册，见 `installCodeLensProvider`） */
export const CODE_LENS_COMMAND = 'kojo.codeLens.execute';

/**
 * 贡献方的注解 → Monaco 的 code lens（**越界行一律丢弃**）。
 *
 * 为什么不夹取——这里与折叠区间那批**刻意不同**，值得写清理由：折叠的区间
 * 夹一夹还是那一块，而注解是钉在某一行头上的话，把第 5,000 行的话夹到第 4,999 行
 * = 把别人的数字贴在隔壁函数脸上（错标比不标危险）。行号过期只可能是"供方拿着旧快照"，
 * 少一条注解不亏。
 */
export function toMonacoCodeLenses(
  model: Monaco.editor.ITextModel,
  lenses: readonly EditorCodeLens[],
): Monaco.languages.CodeLens[] {
  const lineCount = model.getLineCount();
  const out: Monaco.languages.CodeLens[] = [];
  for (const lens of lenses) {
    if (!Number.isFinite(lens.line)) continue;
    const line = Math.trunc(lens.line);
    if (line < 1 || line > lineCount) continue;
    out.push({
      // 零宽区间挂在行首：Monaco 用这条 range 追踪"这一行还在不在"（删行 ⇒ 注解跟着没），
      // 它不参与任何绘制（标签画在上一行的 view zone 里），所以宽度不影响观感
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      // id 必须**逐条唯一**（Monaco 的 code lens 缓存按 id 认符号）：同一行并排两条不同
      // 注解是合法形态（见 `collectCodeLenses` 的去重口径），按行号做 id 会让第二条没有身份
      id: `b8:${line}:${out.length}`,
      // 标签就是 command.title（Monaco 只渲染有 command 的注解，取证 codelensWidget.js
      // 的 `if (codeLensData.symbol.command)`）⇒ 没有落点的注解也给同一条命令、空参数，
      // 由命令处理端第一行判掉：**不给 Monaco 一个它不认识的命令 id**（那会变成一枚
      // 点了弹"No command handler"错误通知的假按钮）
      command: {
        id: CODE_LENS_COMMAND,
        title: lens.label,
        arguments: lens.target ? [lens.target] : [],
      },
    });
  }
  return out;
}

/** 命令参数是不是宿主发出去的那个形状（Monaco 的参数面是 `unknown[]`，边界上验一次） */
export function isCodeLensTarget(arg: unknown): arg is EditorSymbolLocation {
  if (typeof arg !== 'object' || arg === null) return false;
  const candidate = arg as Partial<EditorSymbolLocation>;
  return typeof candidate.filePath === 'string' && Number.isFinite(candidate.line);
}

/** 宿主注入的两件事：这篇文档该答什么、点击往哪落 */
export interface CodeLensHandlers {
  /**
   * 整篇文档的注解。宿主接线在这里做**全部**判据（开关 / 糖视图 / 活动标签 / 体量与预算）——
   * 抛错由本函数隔离，供方与槽都不必知道编辑器的存在。
   */
  resolve(model: Monaco.editor.ITextModel): EditorCodeLens[];
  /** 落地一次跳转（走 `editor.revealLocation`，与转到定义同一条通道） */
  navigate(target: EditorSymbolLocation): void;
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册 code lens 供给器 + 点击命令。
 *
 * **为什么两种语言都注册**：应答判据（`resolve`）本来就在宿主接线里逐次现判，
 * 注册面多一门语言不产生任何代价；而 `.kojo` 这一路将来若由糖线给出注解，
 * 不必再回来改这里（与 hover / definition / folding 各批同形）。
 *
 * 卸载纪律（注册即托管）：provider 与 command 一起 dispose，不留第二份。
 */
export function installCodeLensProvider(monaco: typeof Monaco, handlers: CodeLensHandlers): Monaco.IDisposable {
  const command = monaco.editor.registerCommand(CODE_LENS_COMMAND, (_accessor, ...args: unknown[]) => {
    const target = args[0];
    if (!isCodeLensTarget(target)) return; // 无落点的注解 = 只读的一句话
    handlers.navigate(target);
  });
  const provider: Monaco.languages.CodeLensProvider = {
    provideCodeLenses(model) {
      let lenses: EditorCodeLens[];
      try {
        lenses = handlers.resolve(model);
      } catch (e: unknown) {
        // 注解是只读呈现面：出错就"没有注解"，绝不把编辑器的输入链带崩
        console.warn(`[kojo-code-lens] resolve 抛错：${errorText(e)}`);
        return { lenses: [], dispose: () => undefined };
      }
      return { lenses: toMonacoCodeLenses(model, lenses), dispose: () => undefined };
    },
  };
  const dialectSubs = registerForKojoDialects(monaco, (m, id) => m.languages.registerCodeLensProvider(id, provider));
  return {
    dispose: () => {
      dialectSubs.dispose();
      command.dispose();
    },
  };
}
