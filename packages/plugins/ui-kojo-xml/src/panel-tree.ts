/**
 * 索引 → 面板树（纯函数投影，零 React、零 DOM、零 IO）。
 *
 * 为什么把投影从渲染里拆出来：面板的判据（角色分组、com 排序、搜索过滤、诊断计数）
 * 是**可枚举的事实**，必须能在没有 DOM / 没有服务实现的单测里逐条钉住；渲染层只剩
 * "把节点数组摆成 DOM"。这也是本插件唯一一处会碰 `KojoXmlIndex` 的地方——面板组件
 * 只消费这里产出的节点，不再自己遍历索引。
 *
 * 数据面口径（全部照 `KojoXmlIndex` 契约，本模块不重算任何游戏知识）：
 *   - 角色分组 = `byChara` 的键（adapter 已按角色号升序）；`charaNo === null` 的文件
 *     不在 `byChara` 里，单独收进末尾的「未归属」组——**不许静默丢文件**；
 *   - 角色名来自 `project.charaIndex`（由调用方折成 Map 传入），取不到就显示编号；
 *   - 条目排序按 `com`（数字串按数值比，非数字串按字典序，`com` 缺席排最后），
 *     同 `com` 保持文档顺序——排序必须确定，否则同一份索引每次渲染都换序。
 */

import type {
  KojoXmlCommand,
  KojoXmlCondition,
  KojoXmlFile,
  KojoXmlIndex,
  KojoXmlSeverity,
} from '@kojo/plugin-api';

/** 未归属角色组的显示名（`charaNo === null` 的文件） */
export const UNASSIGNED_LABEL = '未归属';

/** 诊断展开列表的条数上限（再多就是让作者在面板里翻页，不如去诊断面板） */
export const DIAGNOSTIC_ROW_LIMIT = 50;

/** 树节点类型判别位 */
export type PanelNodeKind = 'chara' | 'file' | 'command';

/** 一条 `<command>` 的投影 */
export interface PanelCommandNode {
  readonly kind: 'command';
  /** 稳定 key（同文件内位置唯一） */
  readonly id: string;
  readonly filePath: string;
  /** 1 基行（= `span.start.line`，直接喂 `editor.revealLocation`） */
  readonly line: number;
  /** 1 基列（UTF-16 码元） */
  readonly column: number;
  /** `com` 属性原值（缺席 = ''） */
  readonly com: string;
  /** `name` 属性原值（缺席 = ''） */
  readonly name: string;
  /** 行标题：`com · name`（两者都缺 = `条目 #n`） */
  readonly label: string;
  /** 行副标题：`kojoPlace / priority`（缺项自动省略，全缺 = ''） */
  readonly subtitle: string;
  /** 台词正文（搜索用；原样保留换行与未展开的占位符） */
  readonly text: string;
  /**
   * 条目原文（索引里的那一枚，**引用不复制**）。
   *
   * 预览要把它交给 `kojo.xml` 服务的 `preview()`，而契约入参就是 `KojoXmlCommand`。
   * 不在这里带上，面板就得回头再遍历一次索引去找"这一条是哪条"——那等于让渲染层
   * 认识索引结构，本文件"唯一碰索引的地方"这条界线就破了。
   */
  readonly source: KojoXmlCommand;
}

/** 一份口上 XML 的投影 */
export interface PanelFileNode {
  readonly kind: 'file';
  readonly id: string;
  readonly path: string;
  /** 文件名（路径末段；面板只显示这一截，完整路径进悬停） */
  readonly fileName: string;
  readonly commands: readonly PanelCommandNode[];
}

/** 一个角色（或「未归属」桶）的投影 */
export interface PanelCharaNode {
  readonly kind: 'chara';
  readonly id: string;
  /** `null` = 未归属桶（文件存在但角色号解析不到） */
  readonly charaNo: number | null;
  /** 显示名：角色名 → `#编号` → `未归属` */
  readonly label: string;
  readonly fileCount: number;
  readonly commandCount: number;
  readonly files: readonly PanelFileNode[];
}

/** 诊断展开列表的一行 */
export interface PanelDiagnosticRow {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: KojoXmlSeverity;
  readonly code: string;
  readonly message: string;
}

/** 诊断计数（`total` 含 info——面板正文只显示 error / warning 两档，但总数不许少算） */
export interface PanelDiagnosticCounts {
  readonly total: number;
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

/** 面板树（渲染层的唯一输入） */
export interface PanelTree {
  readonly charas: readonly PanelCharaNode[];
  readonly fileCount: number;
  readonly commandCount: number;
  /** 角色数：只数**有编号**的组，「未归属」不算一个角色 */
  readonly charaCount: number;
  readonly diagnostics: PanelDiagnosticCounts;
}

/* ------------------------------ 行文案 ------------------------------ */

/**
 * 条目行标题。
 *
 * `com` 是引擎侧命令编号，`name` 是作者写的人读名——两个都在才有 `com · name`；
 * 只剩一个就只显示那个（拼一个空的分隔符出来等于让作者猜左边缺了什么）。
 */
export function commandLabel(com: string, name: string, index: number): string {
  if (com !== '' && name !== '') return `${com} · ${name}`;
  if (com !== '') return com;
  if (name !== '') return name;
  return `条目 #${index + 1}`;
}

/**
 * 条目行副标题：`kojoPlace / priority`。
 *
 * 两个属性都是**原样透传**（取值域是游戏知识，本插件不解释、不翻译）；缺一个就少一段，
 * 都缺返回空串——渲染层据此不画空行。
 */
export function commandSubtitle(attrs: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  const place = attrs['kojoPlace'];
  const priority = attrs['priority'];
  if (place !== undefined && place !== '') parts.push(place);
  if (priority !== undefined && priority !== '') parts.push(priority);
  return parts.join(' / ');
}

/** 顶部统计行：`{文件数} 份 / {条目数} 条 / {角色数} 个角色` */
export function panelStatsLine(tree: PanelTree): string {
  return `${tree.fileCount} 份 / ${tree.commandCount} 条 / ${tree.charaCount} 个角色`;
}

/**
 * 一条命中条件的显示文案。
 *
 * 只翻译**契约里已定义的两个维度**（`kind` / `negated`），不认识任何具体属性名：
 * - `value` 是取值匹配 → `isFall = LOVER` / `isFall ≠ LOVER`；
 * - `expr` 是表达式 → `eval: TSTR:X == "Y"`（表达式原文照抄，不在面板里重排）。
 *
 * `expr` 的 `negated` 按契约无意义（`!` 留在表达式里），故不参与拼装。
 */
export function conditionLabel(condition: KojoXmlCondition): string {
  if (condition.kind === 'expr') return `${condition.source}: ${condition.expression}`;
  return `${condition.source} ${condition.negated ? '≠' : '='} ${condition.expression}`;
}

/**
 * 诊断摘要行：`诊断 N 条（error X / warning Y）`。
 *
 * 恒显示（含 0 条）：空着不写等于让作者分不清「没问题」和「没扫」。info 不计入括号，
 * 但仍计入 N——N 是索引里的**全部**诊断数。
 */
export function diagnosticSummary(tree: PanelTree): string {
  const { total, error, warning } = tree.diagnostics;
  return `诊断 ${total} 条（error ${error} / warning ${warning}）`;
}

/* ------------------------------ 排序 ------------------------------ */

const NUMERIC = /^\d+$/;

/**
 * `com` 排序：数字串按数值（`300` < `1000`），其余按字典序，缺席（''）排最后。
 *
 * 为什么不能只比字符串：真实语料的 `com` 是 1~4 位数字混排，字典序会把 `1000` 排到
 * `300` 前面，作者按命令顺序找条目时会以为少了东西。
 */
export function compareCom(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  if (NUMERIC.test(a) && NUMERIC.test(b)) {
    const delta = Number(a) - Number(b);
    if (delta !== 0) return delta;
  }
  return a < b ? -1 : 1;
}

/** 文件路径升序（跨平台一致：按码元比，不按本地化规则） */
function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------ 投影 ------------------------------ */

function projectCommand(filePath: string, command: KojoXmlCommand): PanelCommandNode {
  const com = command.attrs['com'] ?? '';
  const name = command.attrs['name'] ?? '';
  const line = command.span.start.line;
  const column = command.span.start.column;
  return {
    kind: 'command',
    id: `${filePath}:${line}:${column}:${command.index}`,
    filePath,
    line,
    column,
    com,
    name,
    label: commandLabel(com, name, command.index),
    subtitle: commandSubtitle(command.attrs),
    text: command.text,
    source: command,
  };
}

function projectFile(file: KojoXmlFile): PanelFileNode {
  const commands = file.commands
    .map((command) => projectCommand(file.path, command))
    // 同 com 保持文档顺序：`sort` 在 ES2019+ 稳定，但显式比较更耐改（不依赖引擎实现细节）
    .sort((a, b) => compareCom(a.com, b.com) || 0);
  const segments = file.path.split(/[\\/]/);
  return {
    kind: 'file',
    id: file.path,
    path: file.path,
    fileName: segments[segments.length - 1] ?? file.path,
    commands,
  };
}

function projectChara(
  charaNo: number | null,
  files: readonly KojoXmlFile[],
  charaNames: ReadonlyMap<number, string>,
): PanelCharaNode {
  const nodes = [...files].sort((a, b) => comparePath(a.path, b.path)).map(projectFile);
  const label =
    charaNo === null ? UNASSIGNED_LABEL : (charaNames.get(charaNo) ?? `#${charaNo}`);
  return {
    kind: 'chara',
    id: charaNo === null ? 'chara:none' : `chara:${charaNo}`,
    charaNo,
    label,
    fileCount: nodes.length,
    commandCount: nodes.reduce((sum, file) => sum + file.commands.length, 0),
    files: nodes,
  };
}

/**
 * 索引 → 面板树。
 *
 * 分组顺序：`byChara` 的既有顺序（adapter 已按角色号升序）在前，「未归属」恒在末尾。
 * 条目数与文件数一律从节点**现算**（不信 `index.commandCount` 单独一份数）——
 * 面板显示的数和树里能点到的数必须是同一个数。
 */
export function buildPanelTree(
  index: KojoXmlIndex | null,
  charaNames: ReadonlyMap<number, string>,
): PanelTree {
  if (!index) {
    return {
      charas: [],
      fileCount: 0,
      commandCount: 0,
      charaCount: 0,
      diagnostics: { total: 0, error: 0, warning: 0, info: 0 },
    };
  }

  const charas: PanelCharaNode[] = [];
  for (const [charaNo, files] of index.byChara) {
    charas.push(projectChara(charaNo, files, charaNames));
  }

  // 未归属：角色号解析不到的文件不在 byChara 里，丢掉它们等于让作者以为没有这份文件
  const unassigned = index.files.filter((file) => file.charaNo === null);
  if (unassigned.length > 0) charas.push(projectChara(null, unassigned, charaNames));

  let fileCount = 0;
  let commandCount = 0;
  for (const chara of charas) {
    fileCount += chara.fileCount;
    commandCount += chara.commandCount;
  }

  const diagnostics = countDiagnostics(index);
  return {
    charas,
    fileCount,
    commandCount,
    charaCount: charas.filter((chara) => chara.charaNo !== null).length,
    diagnostics,
  };
}

function countDiagnostics(index: KojoXmlIndex): PanelDiagnosticCounts {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const diagnostic of index.diagnostics) {
    if (diagnostic.severity === 'error') error++;
    else if (diagnostic.severity === 'warning') warning++;
    else info++;
  }
  return { total: index.diagnostics.length, error, warning, info };
}

/* ------------------------------ 搜索 ------------------------------ */

function includesQuery(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query);
}

/**
 * 纯前端过滤（输入即筛，不再起第二轮索引查询）。
 *
 * 命中口径三条：角色名、条目行标题（`com · name`，因此 `com` 与 `name` 都能搜到）、
 * 台词正文。**角色名命中 = 该角色整组保留**（作者想"看这个角色"时不该被命令名再筛一遍）；
 * 命令/台词命中则只保留命中的条目，空文件与空角色组一并折叠掉——列表里不留空壳。
 */
export function filterPanelTree(tree: PanelTree, query: string): PanelTree {
  const needle = query.trim().toLowerCase();
  if (needle === '') return tree;

  const charas: PanelCharaNode[] = [];
  for (const chara of tree.charas) {
    if (includesQuery(chara.label, needle)) {
      charas.push(chara);
      continue;
    }
    const files: PanelFileNode[] = [];
    for (const file of chara.files) {
      const commands = file.commands.filter(
        (command) => includesQuery(command.label, needle) || includesQuery(command.text, needle),
      );
      if (commands.length > 0) files.push({ ...file, commands });
    }
    if (files.length === 0) continue;
    charas.push({
      ...chara,
      fileCount: files.length,
      commandCount: files.reduce((sum, file) => sum + file.commands.length, 0),
      files,
    });
  }

  return {
    charas,
    fileCount: charas.reduce((sum, chara) => sum + chara.fileCount, 0),
    commandCount: charas.reduce((sum, chara) => sum + chara.commandCount, 0),
    charaCount: charas.filter((chara) => chara.charaNo !== null).length,
    // 诊断不随搜索变：它是"这份索引的健康度"，不是"当前筛选结果的问题"
    diagnostics: tree.diagnostics,
  };
}

/* ------------------------------ 诊断 ------------------------------ */

/**
 * 诊断列表（前 `limit` 条，缺省 50）。
 *
 * 顺序照索引原样（adapter 已按 path/行/列/码排好）——面板不重排，否则同一批诊断在
 * 面板与诊断面板里顺序不同，作者会以为看到的是两批。
 */
export function diagnosticRows(
  index: KojoXmlIndex | null,
  limit: number = DIAGNOSTIC_ROW_LIMIT,
): readonly PanelDiagnosticRow[] {
  if (!index) return [];
  const capped = Math.max(0, Math.min(limit, index.diagnostics.length));
  const out: PanelDiagnosticRow[] = [];
  for (let i = 0; i < capped; i++) {
    const diagnostic = index.diagnostics[i]!;
    const line = diagnostic.span.start.line;
    const column = diagnostic.span.start.column;
    out.push({
      id: `${diagnostic.path}:${line}:${column}:${diagnostic.code}:${i}`,
      path: diagnostic.path,
      line,
      column,
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
    });
  }
  return out;
}
