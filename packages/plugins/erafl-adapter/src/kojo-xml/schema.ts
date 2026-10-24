/**
 * 口上 XML 的**游戏侧规格**：属性表 / `com` 表 / `kojoPlace` 取值域。
 *
 * 这份表是「游戏知识」，只能住 adapter（架构铁律 1）；宿主拿它画补全、写悬停、
 * 判枚举，自己不内置任何一条。
 *
 * 取值域怎么来的：**从 `D:/Game/erafl/ERB/口上` 的 293 份 XML 里统计出来的**，
 * 不是照文档抄的（文档在 readme 里只有一句"口上编辑器"）。几个实测结论：
 * - `kojoPlace` 8 种：`TOP`(50,482) / `BOTTOM`(8,931) / `EXEC`(4,757) / `MIDDLE`(670) /
 *   `RESULT`(107) / `TRIGGER`(6)，另有 38 处小写 `top`/`bottom`——引擎大小写不敏感，
 *   故枚举判据**大小写不敏感**（大小写不一致只给 info，不算错）。
 * - 布尔族（`isMob`/`forMaster`/`isExclusive`/`isInitiative`/`atRaped`…）在语料里
 *   有 `TRUE`/`true`/`True` 三种写法，还出现过 `Ture`(15) / `ture`(5) 这类**拼错**——
 *   这正是"作者想知道但不会自己发现"的那类问题，值得一条 warning。
 * - `isFall` / `emotion` 是**逗号分隔的多值**（`LOVER,SLAVED_BY`、`怒,悲,恐,恨,鬱,狂`），
 *   判据要按逗号切开逐项看，不能整串比。
 * - `com` 有 425 种取值：数字（对应 `CSV/Train.csv` 的指令编号）+ 符号（`ANY` / `VSEX` /
 *   `ASEX` / `ORAL` …）。数字那部分由 `CSV/Train.csv` 在装载时注入（见 `plugin.ts`），
 *   本文件只放**符号表**与少量已知数字。
 */
import type { KojoXmlAttributeSpec, KojoXmlComSpec, KojoXmlSchema } from '@kojo/plugin-api';

/** 布尔族的规范取值（判据大小写不敏感，见文件头） */
const BOOL = ['TRUE', 'FALSE'] as const;

/** 位置族取值域（`kojoPlace` 与旧格式的 `place` 共用） */
export const KOJO_XML_PLACES: readonly string[] = ['TOP', 'MIDDLE', 'BOTTOM', 'EXEC', 'RESULT', 'TRIGGER'];

/**
 * 属性规格表。
 *
 * `doc` 是给悬停看的人话；`values` 只在**能穷举**时才给（`priority` / `lust` 这类
 * 数字域不给，否则补全会拿一堆数字糊住作者）。
 */
export const KOJO_XML_ATTRIBUTES: readonly KojoXmlAttributeSpec[] = [
  {
    name: 'com',
    doc: '命令编号或符号（`300` 会話 / `ANY` 汎用 / `VSEX`・`ASEX` 性交汎用 …）。数字部分见 `CSV/Train.csv`。',
    required: true,
  },
  { name: 'name', doc: '命令显示名（如 `会話`、`愛撫`）；同一 `com` 下可有多条不同 `name` 的条目。' },
  {
    name: 'kojoPlace',
    doc: '台词出现的位置：`TOP` 开场 / `MIDDLE` 中途 / `BOTTOM` 收尾 / `EXEC` 执行者侧 / `RESULT` 结果 / `TRIGGER` 触发。',
    values: KOJO_XML_PLACES,
    closed: true,
  },
  { name: 'place', doc: '旧格式（`<kojodef>`）的位置属性，语义同 `kojoPlace`。', values: KOJO_XML_PLACES, closed: true },
  {
    name: 'priority',
    doc: '同位置多条命中时的优先级（数字越大越优先）；同 `com`+`kojoPlace`+`priority` 重复会让引擎选择不确定。',
  },
  {
    name: 'isFall',
    doc: '恋爱状态条件，可逗号分隔多值（`LOVER` 恋人 / `FALLEN` 恋慕 / `SLAVE` 従属 / `!LOVER` 取反）。',
    values: ['LOVER', 'FALLEN', 'SLAVE', 'SLAVED_BY', '!LOVER', '!FALLEN', '!SLAVE', '!SLAVED_BY'],
  },
  {
    name: 'emotion',
    doc: '情绪条件，可逗号分隔多值（`GOOD` / `NEGATIVE` / `POSITIVE` / `HAPPY` / `SAD` / `FEAR` …，`!X` 取反）。',
    values: ['GOOD', 'NEGATIVE', 'POSITIVE', 'HAPPY', 'SAD', 'FEAR', '!GOOD', '!NEGATIVE', '!POSITIVE'],
  },
  { name: 'isInitiative', doc: '是否由角色主动发起（`TRUE` / `FALSE`，也见过 `有` / `無`）。', values: [...BOOL, '有', '無'], closed: true },
  { name: 'isMob', doc: '是否适用于随机生成的杂兵角色（`TRUE` / `FALSE`）。', values: [...BOOL, '1'], closed: true },
  { name: 'forMaster', doc: '是否为主人公（MASTER）专用条目。', values: [...BOOL], closed: true },
  { name: 'isExclusive', doc: '命中后是否独占（不再叠加同位置其它条目）。', values: [...BOOL, '1'], closed: true },
  { name: 'isUfufu', doc: '是否属于"うふふ"（调笑）语气组。', values: [...BOOL], closed: true },
  { name: 'cutDescription', doc: '是否截断动作描述文本。', values: [...BOOL], closed: true },
  {
    name: 'PLYorTGT',
    doc: '文本里的 `%CALLNAME%` 类替换以谁为准：`PLAYER` 主人公 / `TARGET` 对象（语料里还有 `対象` / `実行` 写法）。',
    values: ['PLAYER', 'TARGET', '対象', '実行'],
  },
  { name: 'ACTorTGT', doc: '动作主体是执行者还是对象：`ACTOR` / `TARGET`。', values: ['ACTOR', 'TARGET'], closed: true },
  { name: 'isPlayer', doc: '旧格式里的主体标记（`実行` / `対象`）。', values: ['実行', '対象'], closed: true },
  { name: 'speakerSex', doc: '限定说话者性别：`MALE` / `FEMALE`。', values: ['MALE', 'FEMALE'], closed: true },
  { name: 'lust', doc: '欲望值条件（数字；语料里 2–15 都有）。' },
  { name: 'atRaped', doc: '被侵犯状态条件：`ONLYRAPED` / `TRUE` / `FALSE`。', values: ['ONLYRAPED', ...BOOL], closed: true },
  { name: 'randRate', doc: '随机命中率（百分比数字，`50` 表示一半概率）。' },
  { name: 'option', doc: '选项编号（数字）或 `ANY`。' },
  { name: 'sequence', doc: '动作序列位（`0` / `1`）。' },
  { name: 'eventId', doc: '事件编号（对应 `CSV/KojoEvent.CSV` 的调用点）。' },
  { name: 'skillDefName', doc: '技能定义名（战斗口上专用）。' },
  { name: 'actionName', doc: '动作名（战斗口上专用）。' },
  { name: 'HO_Act', doc: '据点行动条件（`食事中` / `採集中` / `休憩中` …，与当前行动一致才命中）。' },
  {
    name: 'eval',
    doc: '附加表达式条件，写在 `{…}` 里（如 `{TSTR:会話モード == &quot;商談&quot;}`）；表达式语法同 ERB。',
  },
  /* ---- 任务 / 据点 / 设施族（真盘 `ERB/口上/QUEST*`、`HOUSING*` 目录在用） ---- */
  { name: 'questId', doc: '任务编号条件（只在该任务流程里命中）。' },
  { name: 'questRoomId', doc: '任务房间编号条件。' },
  { name: 'questEventId', doc: '任务事件编号条件。' },
  { name: 'isDateMode', doc: '是否仅在约会模式下命中。', values: [...BOOL], closed: true },
  { name: 'datePLYorTGT', doc: '约会场景下的替换主体口径（同 `PLYorTGT`）。', values: ['PLAYER', 'TARGET'], closed: true },
  { name: 'moduleAttributes', doc: '据点设施属性条件（设施带该属性才命中）。' },
  { name: 'moduleUsage', doc: '据点设施用途条件。' },
  { name: 'talent', doc: '素質条件（对应 `CSV/Talent.csv` 的名字）。' },
  { name: 'ability', doc: '能力条件（对应 `CSV/Abl.csv` 的名字）。' },
  { name: 'token', doc: '文本记号（引擎侧替换用的短标记）。' },
  { name: 'initiative', doc: '主动性条件的旧写法（现行写法是 `isInitiative`）。', values: [...BOOL, '有', '無'] },
  { name: 'val', doc: '通用数值条件（具体语义随所在元素而定）。' },
  { name: 'rate', doc: '通用比率条件（百分比）。' },
];

/** 符号 `com` 表（数字部分由 `CSV/Train.csv` 装载时注入） */
export const KOJO_XML_SYMBOL_COMMANDS: readonly KojoXmlComSpec[] = [
  { code: '300', label: '会話' },
  { code: 'ANY', label: '汎用（任意命令）' },
  { code: 'VSEX', label: 'V性交汎用' },
  { code: 'ASEX', label: 'A性交汎用' },
  { code: 'ORAL', label: '口交汎用' },
];

/**
 * 合并符号表与外部注入的指令表（`CSV/Train.csv` 的 233 条）。
 *
 * 同 code 时**外部优先**：CSV 是游戏自己的权威来源，静态表只是兜底
 * （游戏版本换了，静态表可能过期，CSV 不会）。
 */
export function mergeComSpecs(
  base: readonly KojoXmlComSpec[],
  extra: readonly KojoXmlComSpec[] | null | undefined,
): KojoXmlComSpec[] {
  const out = new Map<string, KojoXmlComSpec>();
  for (const spec of base) out.set(spec.code, spec);
  for (const spec of extra ?? []) out.set(spec.code, spec);
  return [...out.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** 组装完整规格（`comTable` 缺席 = 只用符号表） */
export function buildKojoXmlSchema(
  comTable?: readonly KojoXmlComSpec[] | null,
): KojoXmlSchema {
  return {
    attributes: KOJO_XML_ATTRIBUTES,
    commands: mergeComSpecs(KOJO_XML_SYMBOL_COMMANDS, comTable),
    places: KOJO_XML_PLACES,
  };
}
