/**
 * Kojo 2.0 **悬停**（K2-EDITOR-SEMANTIC）：`# 变量 / 常量 / 表 / 池 / 模`、`@函`、`# 幕`
 * 的声明事实（类型 / 初值 / 来源行）。
 *
 * ## 分层
 * 本文件是**纯函数**：源码文本 + 1 基行列进，事实出。零 IO、零 Monaco、零注册——
 * 消费方只把结果翻成悬停面的 `contents` / `range`。声明索引住在 `declarations.ts`
 * （与转定义 / 补全共用同一份），本文件只负责"光标下是哪条声明"与"这条声明怎么讲给作者看"。
 *
 * ## 位置门
 * - `@原生` 围栏体内不悬停（原文不解释）；
 * - 台词 / 旁白 / 转义字面文本的**正文**不悬停；`{…}` 插值内例外（那是表达式，不是台词）；
 * - 注释行不悬停。
 *
 * ## 事实口径
 * 名字、类型、初值、参数、表体行数全部来自 core 的 AST（`kojo2-declarations.ts` 搬运）；
 * 读不到就少说一行，**不编默认值**（例如没写初值就不写"初值：0"）。
 *
 * ## B3c 车道 2：为什么住在包 + 为什么带 Markdown 措辞
 *
 * 悬停的**供方**从 B3c 起是插件（`@kojo/plugin-kojo-lang`），插件读不到 `packages/app/src/**`。
 * 于是正文与措辞都得跟着判据走：{@link kojo2HoverMarkdown} 与 {@link kojo2DeclarationMarkdown}
 * 原住 `monaco/kojo2-providers.ts`（私有 `declarationMarkdown` 与导出的 `kojo2HoverMarkdown`），
 * 它们决定补全 `documentation` 与悬停正文的**字面**——留在宿主，插件就交不出这两段文字。
 * 搬入是**纯搬家**：首段 `**名字**（种类）`、其余每行一段、`\n\n` 相连的口径逐字不动；
 * 两枚函数共用同一个 `kojo2HoverLines`，不另写第二套措辞。唯一的文字改动是文件里那两句
 * 举例提到了具体游戏名（本包闸钉"零游戏名词"，扫的是正文含注释），改成"某方言 / 另一方言"，
 * 语义与判据一字未动。
 */

import { insideInterpolation } from './interpolation';
import { findEvent, type EventSpec, type GameAdapter } from '@kojo/kojo-core';
import { kojo2EventSiteAt, kojo2EventSitesOf, type Kojo2EventSite } from './event-sites';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DeclarationAt,
  kojo2DeclarationHeaderAt,
  kojo2DeclarationNamed,
  kojo2DocumentOf,
  kojo2IsCodeSurface,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2StorageWordOf,
  kojo2TokenSpanAt,
  kojo2TypeWordOf,
  type Kojo2Declaration,
  type Kojo2Document,
  type Kojo2Query,
} from './declarations';

/** 一次悬停的结果：显示名 / 声明种类 / 屏上区间 + 事实正文 + 声明落点。 */
export interface Kojo2HoverResult {
  readonly name: string;
  readonly kind: string;
  /** 屏上高亮区间（1 基、半开；引用处是引用词，声明处是名字段） */
  readonly startColumn: number;
  readonly endColumn: number;
  /** 事实正文（每行一段；宿主逐段渲染） */
  readonly lines: readonly string[];
  /** 声明落点（同文件；1 基） */
  readonly declaration: {
    readonly line: number;
    readonly column: number;
    readonly endColumn: number;
  };
}

/** 行原文（物理行缺失 = 空串；末尾空行等越界情形自然落空，不猜）。 */
function lineTextOf(document: ReturnType<typeof kojo2DocumentOf>, line: number): string {
  return document.physical[line - 1]?.text ?? '';
}

/** 声明事实正文（导出 = 可直接单测；渲染顺序 = 先位置、再语义）。 */
export function kojo2HoverLines(declaration: Kojo2Declaration): string[] {
  const lines: string[] = [
    `来源行：第 ${declaration.line} 行`,
    `原文：\`${truncate(declaration.lineText, 180)}\``,
  ];
  switch (declaration.kind) {
    case 'variable': {
      if (declaration.valueType !== undefined) {
        const array =
          declaration.arraySize === undefined ? '' : `[${declaration.arraySize}]`;
        lines.push(`类型：\`${kojo2TypeWordOf(declaration.valueType)}${array}\``);
      }
      if (declaration.storage !== undefined) {
        lines.push(`存储期：\`${kojo2StorageWordOf(declaration.storage)}\``);
      }
      if (declaration.initializer !== undefined) {
        lines.push(`初值：\`${declaration.initializer}\``);
      }
      break;
    }
    case 'constant': {
      if (declaration.valueType !== undefined) {
        lines.push(`类型：\`${kojo2TypeWordOf(declaration.valueType)}\``);
      }
      if (declaration.constantValue !== undefined) {
        lines.push(`初值：\`${declaration.constantValue}\``);
      }
      break;
    }
    case 'table': {
      if (declaration.subject !== undefined) {
        lines.push(`由：\`${declaration.subject.length === 0 ? '（空表达式）' : declaration.subject}\``);
      }
      if (declaration.rowCount !== undefined) {
        lines.push(`表体：${declaration.rowCount} 行`);
      }
      break;
    }
    case 'pool': {
      if (declaration.branchCount !== undefined) {
        lines.push(`分支：${declaration.branchCount} 条`);
      }
      break;
    }
    case 'template': {
      if (declaration.params !== undefined) {
        lines.push(`参数：\`${declaration.params.length === 0 ? '（无）' : declaration.params.join('、')}\``);
      }
      if (declaration.hasSlot !== undefined) {
        lines.push(`插槽：${declaration.hasSlot ? '有' : '无'}`);
      }
      break;
    }
    case 'function': {
      if (declaration.params !== undefined) {
        lines.push(`参数：\`${declaration.params.length === 0 ? '（无）' : declaration.params.join('、')}\``);
      }
      break;
    }
    case 'scene': {
      if (declaration.sceneTitle !== undefined) {
        lines.push(`场景标题：\`${declaration.sceneTitle}\``);
      }
      break;
    }
  }
  return lines;
}

/** 悬停 kind 文案（`变量声明` / `函声明` …；词形来自 core 词表）。 */
function hoverKindOf(declaration: Kojo2Declaration): string {
  return `${KOJO2_DECL_WORD_BY_KIND[declaration.kind]}声明`;
}

/** 超长行截断（悬停块不是正文阅读器）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* ============================== Markdown 措辞（B3c 自宿主搬入） ============================== */

/**
 * 悬停结果的 Markdown 形态（**唯一**渲染口径：悬停面与补全的 documentation 共用）。
 * 与 `kojo-hover.ts` 的既有写法同形：首段 `**名字**（种类）`，其余每行一段。
 */
export function kojo2HoverMarkdown(hover: Kojo2HoverResult): string {
  return [`**${hover.name}**（${hover.kind}）`, ...hover.lines].join('\n\n');
}

/** 声明事实 → 同一形态的 Markdown（种类文案取 core 词表，与悬停的 `x声明` 逐字同构） */
export function kojo2DeclarationMarkdown(declaration: Kojo2Declaration): string {
  return [
    `**${declaration.name}**（${KOJO2_DECL_WORD_BY_KIND[declaration.kind]}声明）`,
    ...kojo2HoverLines(declaration),
  ].join('\n\n');
}

/* ============================== 事件挂点（LAU-D2） ============================== */

/** 悬停的可选注入面（LAU-D2：`adapter` 让 `# 机` / `@织` 的事件名讲得出方言事实） */
export interface Kojo2HoverAtOptions {
  /**
   * 当前方言的 2.0 事实；缺省 / `null` = **不猜**（事件名一律不给悬停，其余事实照旧）。
   * 由宿主按**当前项目**现取（与补全 / 签名的 adapter 同一枚），本层不 import 任何 adapter。
   */
  readonly adapter?: GameAdapter | null;
}

/** 派发模型的中文短名（语言词，不是游戏名词；值域 = core `EventDispatchModel`） */
const DISPATCH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'engine-dispatch': '引擎分发',
  'label-dispatch': '标签分发',
  hook: '钩子',
  metadata: '数据表派发',
});

/** 优先级模型的中文短名（值域 = core `EventPriorityModel`） */
const PRIORITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'emuera-buckets': '引擎桶（可 之前 / 之后 / 接管）',
  'load-order': '加载序',
  none: '无优先级模型',
});

/** 这一行是不是锚点行（`#` / `@` 开头，允许前导空白）——事件挂点只可能住在这里 */
function looksLikeAnchorLine(text: string): boolean {
  const trimmed = text.replace(/^[ \t\u3000]*/, '');
  return trimmed.startsWith('#') || trimmed.startsWith('@');
}

/**
 * 事件挂点的悬停正文（LAU-D2）：**方言事实**，不是本文件事实。
 *
 * 这是六类服务里"悬停"那条腿此前唯一没有方言来源的格子——同一行 `# 机 <事件>` 在**能编出
 * 这个事件**的方言里讲的是引擎落点，在**目录里没有它**的方言里只能如实说"没有这个事件"；
 * 两枚方言 adapter 喂同一份文本，悬停必须说得不一样（§5.2 "事实面 = 既有 `GameAdapter`"）。
 * 目录里有 ⇒ 讲引擎落点 / 派发模型 / 优先级 / 参数形状；目录里没有 ⇒ 如实说"这个方言没有它"，
 * 并列出可用事件（不猜）。
 */
export function kojo2EventHoverLines(
  spec: EventSpec | undefined,
  site: Kojo2EventSite,
  adapter: GameAdapter,
): string[] {
  if (spec === undefined) {
    const available = adapter.eventCatalog.events.map((item) => item.event);
    return [
      `方言 \`${adapter.id}\` 的事件目录里没有“${site.name}”`,
      `可用事件：${available.length === 0 ? '（无）' : available.join('、')}`,
      site.machine
        ? '`# 机` 只挂本文件；换一个事件名，或先给这个方言补事件目录。'
        : '`@织` 监听的是方言事件；没有登记的事件监听了也不会被引擎调到。',
    ];
  }
  const lines: string[] = [
    `引擎落点：\`${spec.engine}\``,
    `派发：\`${DISPATCH_LABELS[spec.dispatch] ?? spec.dispatch}\` · 优先级：\`${PRIORITY_LABELS[spec.priority] ?? spec.priority}\``,
  ];
  if (spec.args.length === 0) {
    lines.push('参数：（无）');
  } else {
    lines.push(
      `参数：${spec.args
        .map(
          (arg) =>
            `\`${arg.name}\`：${arg.kind === 'int' ? '整数' : arg.kind === 'string' ? '字符串' : '任意值'}${arg.required ? '（必填）' : '（可选）'}`,
        )
        .join('、')}`,
    );
  }
  if (spec.forced) lines.push('强制事件：引擎保证触发');
  lines.push(
    site.machine
      ? '`# 机`：本文件挂到这个事件上（一个文件只挂一个）。'
      : spec.weavable
        ? '`@织`：监听这个事件（可加 之前 / 之后 / 接管 修饰词）。'
        : '`@织`：这个事件声明为不可监听（`weavable: false`）。',
  );
  return lines;
}

/**
 * 光标在事件挂点上时的悬停事实（`undefined` = 这里不是事件挂点）。
 *
 * 只有锚点行才去投影事件挂点（悬停是鼠标移动级热路径：普通台词行多扫一遍整篇没有收益）。
 */
function eventHoverAt(
  document: Kojo2Document,
  text: string,
  line: number,
  col0: number,
  adapter: GameAdapter | null | undefined,
): Kojo2HoverResult | undefined {
  if (adapter === null || adapter === undefined) return undefined;
  if (!looksLikeAnchorLine(text)) return undefined;
  const site = kojo2EventSiteAt(kojo2EventSitesOf(document), line, col0 + 1);
  if (site === null) return undefined;
  let spec: EventSpec | undefined;
  try {
    spec = findEvent(adapter, site.name);
  } catch {
    spec = undefined;
  }
  return {
    name: site.name,
    kind: '事件',
    startColumn: site.startColumn,
    endColumn: site.endColumn,
    lines: kojo2EventHoverLines(spec, site, adapter),
    declaration: {
      line: site.line,
      column: site.startColumn,
      endColumn: site.endColumn,
    },
  };
}

/**
 * 光标处的悬停事实（**纯函数**）。
 *
 * 解析顺序：位置门 → 事件挂点（`# 机` / `@织`，**要 adapter**）→ 声明名字段（声明处）→
 * 名字段反查（引用处）。
 * 引用处只认代码面（声明 / 调度 / 触发 / 条件 / 调度区裸行）；台词正文与原生体在位置门已退让。
 */
export function kojo2HoverAt(
  query: Kojo2Query,
  options: Kojo2HoverAtOptions = {},
): Kojo2HoverResult | undefined {
  const document = kojo2DocumentOf(query.source);
  const record = document.lines[query.line - 1];
  const text = lineTextOf(document, query.line);
  const col0 = Math.min(Math.max(query.column - 1, 0), text.length);
  if (record === undefined) return undefined;
  if (kojo2IsNativeRecord(record)) return undefined;
  if (record.kind === 'comment' || record.kind === 'legacy') return undefined;
  // 台词的**正文**不悬停；`{…}` 插值里是表达式，照常给事实。
  const interpolated = insideInterpolation(text, col0);
  if (kojo2IsTextSurface(record) && !interpolated) return undefined;

  // 事件挂点：名字不是声明、事实也不在本文件里（方言的 `eventCatalog`），先认这一格。
  const event = eventHoverAt(document, text, query.line, col0, options.adapter);
  if (event !== undefined) return event;

  const atDeclaration = kojo2DeclarationAt(document, query.line, col0);
  const headerDeclaration =
    atDeclaration === undefined
      ? kojo2DeclarationHeaderAt(document, query.line, col0)
      : undefined;
  const declaration = atDeclaration ?? headerDeclaration;
  if (declaration !== undefined) {
    return {
      name: declaration.name,
      kind: hoverKindOf(declaration),
      startColumn: atDeclaration !== undefined ? declaration.nameStart : 1,
      endColumn: atDeclaration !== undefined ? declaration.nameEnd : declaration.nameStart,
      lines: kojo2HoverLines(declaration),
      declaration: {
        line: declaration.line,
        column: declaration.nameStart,
        endColumn: declaration.nameEnd,
      },
    };
  }

  if (!kojo2IsCodeSurface(record) && !(kojo2IsTextSurface(record) && interpolated)) {
    return undefined;
  }
  const span = kojo2TokenSpanAt(text, col0);
  if (span === null) return undefined;
  const resolved = kojo2DeclarationNamed(document, span.text, query.line);
  if (resolved === undefined) return undefined;
  return {
    name: resolved.name,
    kind: hoverKindOf(resolved),
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    lines: kojo2HoverLines(resolved),
    declaration: {
      line: resolved.line,
      column: resolved.nameStart,
      endColumn: resolved.nameEnd,
    },
  };
}
