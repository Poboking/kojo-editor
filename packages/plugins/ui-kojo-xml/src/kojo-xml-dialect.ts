/**
 * 口上 XML 的**方言事件面**（LAU-D3；`ARCH-language-unification.md` §5.4 第 3 行 / §8 LAU-D3）。
 *
 * ## 它把哪两件事接上了
 *
 * 1. **载体归属**（`carriers`）：这份 XML 是不是当前方言的"事件面"。不是 ⇒ 事件名一条不问
 *    （`core/carrier/unowned` 由解析器说）；是 ⇒ 按事件目录校验三格。
 * 2. **事件目录**（`eventCatalog`）：XML 三格里出现的 2.0 事件名/引擎落点 ⇒ 这是**写错了载体**
 *    （`core/event/wrong-carrier`）；命令格里出现方言命令表之外的符号命令 ⇒ `core/event/unknown`。
 *
 * ## 三格的分工（为什么不是三格都做"闭集校验"）
 *
 * | 格 | 属性 | 判据 | 理由 |
 * |---|---|---|---|
 * | 命令 | `com` | 方言 XML 命令表（`KojoXmlSchema.commands`，来自 `CSV/Train.csv`）的**ASCII 符号**记号 | 这是半封闭域：`ANY` / `VSEX` / `ASEX` / `ORAL`（+ 少量符号编号）。真盘 293 份 XML 里 ASCII 未知只有 `RAPE_INSERTED` 一族（10 处），正好是要报的那类 |
 * | 名字 | `name` | 只做**跨载体**判据（值恰好是 2.0 事件名/引擎落点 ⇒ wrong-carrier） | 真盘 8,473 个不同取值、75% 不在 `Train.csv`：把它当闭集等于替作者宣布"这个命令名不存在" |
 * | 位置 | `kojoPlace` / `place` | 只做跨载体判据；取值域由 `kojo-xml-diagnostics` 的封闭枚举面报 `kojo-xml.attr.value` | 同一事实两处报 = 聚合纪律失效（§5.5 呈现纪律） |
 *
 * **数字 `com` 不判**（刻意）：`CSV/Train.csv` 之外的魔改编号真盘有 4 种 / 20 处
 * （350 / 725 / 862 / 135，`KOJO_K1180_COM.xml` 一类文件在用），判了就是 20 条误报；
 * 点分多值 `81.82,87`（13 处）同属编号写法。数字域是**开放**的（魔改盘会加编号），
 * ASCII 符号域才是可判的封闭子集。
 * **`eventId` 也不对命令表判**：它对应 `CSV/KojoEvent.CSV` 的调用点，与 `com`（Train.csv）
 * 不是同一条轴，拿命令表判它是拿错表。
 *
 * ⚠ **已知契约缺口**（照 §8 的"无法表达就停下写清"）：`CarrierBinding` 只声明"哪类事实由
 * 哪个载体校验"，没有**逐事件**的载体格；所以"这个事件属于 ERB 却写在 XML"在本实现里取的是
 * **事件目录 ⇒ 一定不在 XML 数据面**这条等价判据（`eventCatalog` 里的事件全部落 ERB/2.0 面），
 * 而不是方言逐事件的声明。要更强的判据需要 `EventSpec` 加一格 `carrier?`（additive），本批不动。
 *
 * ## 聚合
 *
 * 本模块只产诊断；按 `(码, 方言)` 聚成一条走 **LAU-D2 同一枚** `aggregateKojo2DialectLint`
 * （`@kojo/kojo-lang/dialect-lint`；B5b C 类第二车起判据住包），顺序用同一枚
 * `sortDialectDiagnostics`。不新造第二张码表：
 * 产出的码全部来自 core 闭集，严重级由 `severityOf` 决定。
 *
 * ## 为什么住插件不住宿主（B5b C 类第三车）
 *
 * 判据本体逐字搬自宿主 `monaco/kojo-xml-dialect.ts`（该文件同批删除），指路只换两处：
 * 事件三格投影改同包相对路径（`./kojo-xml-event-sites`），命令表类型仍是契约层的
 * `KojoXmlSchema`（本插件本来就依赖 `@kojo/plugin-api`）。落点选插件而不是
 * `@kojo/kojo-lang`：那枚包自己的 purity 闸整文件禁 `口上` / 方言名（连注释与文案都扫），
 * 而本模块的诊断文案是给作者看的人话、一字不许改 ⇒ 逐字搬进去必红；
 * 判据消费方只有宿主的 `kojo-xml` marker 装配与单测，都在懒边上 ⇒ 开机图一枚字节都不涨。
 */
import {
  findEvent,
  type CarrierBinding,
  type DialectBinding,
  type GameAdapter,
  type KojoDiagnostic,
} from '@kojo/kojo-core';
import type { KojoXmlSchema } from '@kojo/plugin-api';
import {
  eventCarrierGateOf,
  makeEventDiagnostic,
  sortDialectDiagnostics,
  type Kojo2DialectLintReport,
} from '@kojo/kojo-lang/dialect-lint';
import { kojoXmlEventSitesOf, type KojoXmlEventSite } from './kojo-xml-event-sites';

/** 体检输入（纯数据；零 IO、零 Monaco） */
export interface KojoXmlDialectInput {
  /** 文件正文（三格从这里投影） */
  readonly source: string;
  /** 方言事实；`null` / 缺省 = 未绑定 ⇒ 交 `null`（不校验也不猜） */
  readonly facts?: GameAdapter | null;
  /** 已解析的方言绑定（`resolveDialectBinding` 的结果）；缺省 = 不做载体归属 */
  readonly binding?: DialectBinding | null;
  /** 方言的 XML 命令表（`kojo.xml` 服务交来的 `schema()`）；缺省 = 只做跨载体判据 */
  readonly schema?: KojoXmlSchema | null;
}

/**
 * 方言 XML 命令表 → 已知记号集（**大小写不敏感**：`com="any"` 与 `ANY` 同一条）。
 *
 * 只收 `code` 与 `label`：`KojoXmlSchema.commands` 的语义就是"命令编号 + 人读名"，
 * 两边都是作者可能写进 `com` 的形态（真盘 `com="会話"` 1,596 处）。
 */
export function knownXmlCommandTokens(schema: KojoXmlSchema | null | undefined): Set<string> {
  const out = new Set<string>();
  if (schema === null || schema === undefined) return out;
  for (const command of schema.commands) {
    if (typeof command.code === 'string' && command.code.length > 0) out.add(command.code.toLowerCase());
    if (typeof command.label === 'string' && command.label.length > 0) out.add(command.label.toLowerCase());
  }
  return out;
}

/** 只看 ASCII 记号：CJK 命令名在魔改盘上是开放域，不能当闭集判（见文件头三格表） */
const ASCII_TOKEN = /^[\x20-\x7e]+$/;

/** 命令值按逗号切（`VSEX,ASEX` / `10,106`）；返回每段与它在原值里的起点 */
function commandTokens(value: string): Array<{ token: string; offset: number }> {
  const out: Array<{ token: string; offset: number }> = [];
  let offset = 0;
  for (const raw of value.split(',')) {
    const lead = raw.length - raw.trimStart().length;
    const token = raw.trim();
    if (token.length > 0) out.push({ token, offset: offset + lead });
    offset += raw.length + 1;
  }
  return out;
}

/** 值是否是事件目录里的一枚事件（名字精确 / 引擎落点大小写不敏感） */
function catalogEventOf(facts: GameAdapter, value: string): ReturnType<typeof findEvent> {
  const byName = findEvent(facts, value);
  if (byName !== undefined) return byName;
  const upper = value.toUpperCase();
  return facts.eventCatalog.events.find((spec) => spec.engine.toUpperCase() === upper);
}

/** 位置区间（1 基、尾列半开）；`offset` = 值内偏移，用来指到逗号段而不是整格 */
function valueSpan(site: KojoXmlEventSite, offset = 0, length = site.value.length): {
  start: { line: number; column: number };
  end: { line: number; column: number };
} {
  return {
    start: { line: site.line, column: site.startColumn + offset },
    end: { line: site.line, column: site.startColumn + offset + length },
  };
}

/** 格的中文名（文案用；不是码表） */
function cellLabel(site: KojoXmlEventSite): string {
  if (site.cell === 'command') return `命令 \`${site.attribute}\``;
  if (site.cell === 'name') return `名字 \`${site.attribute}\``;
  return `位置 \`${site.attribute}\``;
}

function wrongCarrierMessage(
  site: KojoXmlEventSite,
  value: string,
  engine: string,
  facts: GameAdapter,
  binding: DialectBinding,
): string {
  return (
    `${cellLabel(site)} 的取值“${value}”是方言 ${facts.id} 的事件目录成员（引擎落点 ${engine}）：` +
    `事件不写在 XML 数据面（这份文件的载体是 ${String(binding.carrier)}）。` +
    '口上条目请写 `<command com= name= kojoPlace=>`；2.0 的 `# 机` 请写进 `.kojo2` 文件。'
  );
}

/**
 * 三格 → 诊断（纯函数）。
 *
 * 判定顺序（写死，别调）：
 * 1. 载体裁决复用 {@link eventCarrierGateOf}：归属不明 / 无处可去 ⇒ 一条都不报；
 *    没交绑定 / 方言没声明载体 ⇒ 只做**不依赖归属**的那几格（见 3）；
 * 2. 本载体不校验事件而别处校验 ⇒ 每个格一条 `core/event/wrong-carrier`（`expected.glob` 说去处）；
 * 3. 本载体就是事件面（或没有载体输入）：
 *    - 取值是 2.0 事件名 / 引擎落点 ⇒ `core/event/wrong-carrier`（写错载体，不是"不知道"；
 *      这一条要**知道**载体，没有绑定时只说命令格）；
 *    - 命令格是 ASCII 符号命令且不在方言命令表里 ⇒ `core/event/unknown`（指到那一段）；
 *    - CJK 命令名 / 数字编号 / 名字格 / 位置格：不判（理由见文件头三格表）。
 */
export function kojoXmlEventDiagnosticsOf(
  sites: readonly KojoXmlEventSite[],
  facts: GameAdapter,
  binding: DialectBinding | null | undefined,
  schema: KojoXmlSchema | null | undefined,
): KojoDiagnostic[] {
  if (sites.length === 0) return [];
  const gate = eventCarrierGateOf(facts, binding);
  if (gate.kind === 'unowned' || gate.kind === 'unvalidated') {
    return [];
  }
  if (gate.kind === 'wrong-carrier') {
    const expected: CarrierBinding = gate.expected;
    return sites.map((site) =>
      makeEventDiagnostic(
        'core/event/wrong-carrier',
        `${cellLabel(site)} 的取值“${site.value}”出现在不校验事件的载体上：` +
          `事件面属于 ${expected.carrier}（${expected.glob}）覆盖的文件，请把这一条挪过去。`,
        valueSpan(site),
      ),
    );
  }

  const known = knownXmlCommandTokens(schema);
  // 没有命令表 = 没有可判的封闭子集（不拿空表当"所有命令都不认识"）；跨载体判据照常。
  const hasCommandTable = schema !== null && schema !== undefined && schema.commands.length > 0;
  const out: KojoDiagnostic[] = [];
  for (const site of sites) {
    const event = catalogEventOf(facts, site.value.trim());
    if (event !== undefined && binding !== null && binding !== undefined) {
      out.push(
        makeEventDiagnostic(
          'core/event/wrong-carrier',
          wrongCarrierMessage(site, site.value.trim(), event.engine, facts, binding),
          valueSpan(site),
        ),
      );
      continue;
    }
    if (site.cell !== 'command') continue;
    // `eventId` 对应 `CSV/KojoEvent.CSV`，不是 `com`（Train.csv）那条轴 ⇒ 不拿命令表判。
    if (site.attribute === 'eventId') continue;
    if (!hasCommandTable) continue;
    for (const { token, offset } of commandTokens(site.value)) {
      // 数字编号：`300` 与点分多值 `81.82`（真盘 13 处）都是编号写法，魔改编号不判
      // （宁可漏报不误报，见文件头）。
      if (/^[\d.]+$/.test(token)) continue;
      if (!ASCII_TOKEN.test(token)) continue; // CJK 命令名是开放域
      if (known.has(token.toLowerCase())) continue;
      const available = [...known].slice(0, 8);
      out.push(
        makeEventDiagnostic(
          'core/event/unknown',
          `命令“${token}”不在方言 ${facts.id} 的 XML 命令表里` +
            `（可用：${available.length === 0 ? '(命令表未加载)' : available.join('、')}）。`,
          valueSpan(site, offset, token.length),
        ),
      );
    }
  }
  return out;
}

/**
 * 跑一次 XML 方言体检（纯函数）。
 *
 * 返回 `null` = 未绑定 / 没有 2.0 事实面 ⇒ 一条都不报（"没有事实"不等于"事实不符"）。
 * 返回的报告与 `lintKojo2Dialect` **同形**：`aggregateKojo2DialectLint` 直接可用。
 */
export function lintKojoXmlDialect(input: KojoXmlDialectInput): Kojo2DialectLintReport | null {
  const facts = input.facts ?? null;
  if (facts === null || typeof facts !== 'object' || typeof facts.id !== 'string') return null;
  const lines = typeof input.source === 'string' ? input.source.split(/\r\n|\n|\r/) : [];
  const diagnostics = kojoXmlEventDiagnosticsOf(
    kojoXmlEventSitesOf(lines),
    facts,
    input.binding ?? null,
    input.schema ?? null,
  );
  return { dialect: facts.id, diagnostics: sortDialectDiagnostics(diagnostics) };
}

/** 体检诊断 → 行级问题（marker / 问题面板同形；`severity` 由 core 码表定） */
export interface KojoXmlDialectProblem {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}

/**
 * 报告 → 行级问题（**只做投影**，不重新判）。
 *
 * XML 的波浪线走 `kojo-xml-diagnostics` 那一条既有通道（owner = `kojo-xml`），
 * 本函数把同一份诊断翻成那条通道要的形状——**不新开第二个 diagnostic owner**。
 */
export function kojoXmlDialectProblems(
  report: Kojo2DialectLintReport | null,
): KojoXmlDialectProblem[] {
  if (report === null) return [];
  const out: KojoXmlDialectProblem[] = [];
  for (const diagnostic of report.diagnostics) {
    const span = diagnostic.span;
    if (span === null) continue;
    out.push({
      line: span.start.line,
      startColumn: span.start.column,
      endColumn: Math.max(span.end.column, span.start.column + 1),
      severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
      code: diagnostic.code,
      message: diagnostic.message,
    });
  }
  return out;
}
