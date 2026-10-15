/**
 * eraTW 基础库 / 常用函数名表 —— **游戏知识，只住 adapter**（ZH-F1）。
 *
 * 「函数中文化」第一条落地线：让作者能用**中文函数名**书写基础库 / 常用助手函数，
 * 由糖层降糖成**原生 ERB 函数名**（`角色文本(她的名字)` → `CHARA_TEXT(...)`）。
 * 与 `instruction-table.ts` 同形——adapter 建一张**纯数据表**、糖层只查不解释。
 *
 * ## 收录判据（静态、手工维护、随实测增补）
 * - **收**：游戏**基础库**里 `@` 定义的高频助手 / 宏（`COMMON.ERB` / `Print_&_Input.ERB` /
 *   `STYLE_EFFECTS.ERB` / `COMMON_KOJO.ERB` …），即"非作者私有 `@函数`；
 * - **不收**：① 引擎内建系统函数（`GETBIT` / `FIRSTTIME` / `CHK_*` …）——那是
 *   **跨游戏语言层**，住 kojo-sugar 的 `SYSTEM_FUNCTION_ALIASES`（系统表优先于本表）；
 *   ② 作者私有 `@函数`（`M_KOJO…` / `K{n}_…` / 项目内自定义名）——规范 §7.2 已排除
 *   "用户自定义扩展函数"（投影读侧另有通道）。
 *
 * 种子 = eraTW 4.980（画蛇添足版）真实语料普查：`個人口上` 2,285 份文件里，
 * 基础库调用点约 13.5 万，头部依次 `HPH_PRINT` 68,303 · `CHARA_TEXT` 5,237 ·
 * `TRAIN_MESSAGE` 3,775 · `SET_KOJO_COLOR` 3,562 · `TEXTR` 3,385 · `COLORMESSAGE` 3,248 ·
 * `ASK_YN` 1,771 · `HE_SHE_CN` 1,700 …（本批取高频头部约 55 条，边角长尾不收）。
 *
 * 查不到的名字一律 `undefined`（**绝不猜**，规范 §5.3 精神）；未收录的中文调用形态
 * 由糖层**原样保留**并报诊断（fail-visible）。
 */

import type { KojoLibraryTable } from '@kojo/plugin-api';

/**
 * 中文名 → 原生 ERB 函数名（单一真源；手工维护）。仅 `心形` 一条取自规范
 * §3.9 / §4.1（`演出行 CALL HPH_PRINT → 心形`），其余按语料频次手工命名。
 */
export const ERATW_LIBRARY_FUNCTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // ---- 演出 / 打印族（最高频） ----
  ['心形', 'HPH_PRINT'], // 规范 §3.9：嗯/演出行的 `HPH_PRINT`
  ['角色文本', 'CHARA_TEXT'], // 以角色色打印一行文本
  ['着色消息', 'COLORMESSAGE'], // 着色 print（存色复归）
  ['随机文本', 'TEXTR'], // `甲/乙/丙` 等概率取一
  ['询问是非', 'ASK_YN'], // 是 / 否 选择肢
  ['询问选项', 'ASK_M'], // 多选择肢（可灰显无效项）
  ['显示图片', 'PRINT_IMAGE'], // 插画式配图
  ['显示表情', 'PRINT_FACE'], // 立绘 / 颜绘
  ['设定口上色', 'SET_KOJO_COLOR'], // 依当前台词设角色色
  ['调教消息', 'TRAIN_MESSAGE'], // 调教时文本
  ['计数器消息', 'EVENT_COUNTER_MESSAGE'], // 计数器口上
  ['口上选项项', 'KOJO_OPTION_ITEM'], // KOJO_OPTION 选项条目
  ['参数消息甲', 'PALAM_MESSAGE_A'], // 射精面 PALAM 文本
  ['男性名文本', 'PRINT_MALE_CN'], // 男名本地化
  ['料理名', 'DISHNAME_TR'], // 料理名（翻訳）
  ['呻吟', 'MOAN'], // 呻吟生成
  ['呻吟文本', 'MOAN_CN'], // 呻吟（汉化库）
  ['拟声文本', 'FSYN_CN'], // 拟声词（汉化库）
  ['他她', 'HE_SHE_CN'], // 第三人称代词
  ['阴核描述', 'TINKO'], // 阴核描写（文中函数）
  ['胸部描述', 'OPPAI_DESCRIPTION'], // 胸部描写
  ['内裤名', 'PANTSNAME'], // 内裤名
  ['显示下装', 'SHOW_BOTTOM'], // 下装种类名
  ['醉态表情', 'ALCOHOL_FACE'], // 醉酒状态表情
  ['酒口味', 'ALCOHOL_TASTE'], // 酒的味觉描述
  ['自动喘息', 'AUTO_AEGI'], // 无口上角色的自动喘息
  ['淡入', 'FADEIN'], // 淡入演出

  // ---- 数值 / 标记变动族 ----
  ['加经验', 'AddEXP'], // 附带消息的经验增加
  ['改角色标记', 'CHANGE_CFLAG'], // 带消息的 CFLAG 变动
  ['恢复', 'RECOVER'], // BASE 回复处理
  ['基础强化', 'BUFF_BASE'], // 临时强化某 BASE
  ['取得物品', 'GET_ITEM'], // 带消息的物品获取 / 支付
  ['取礼物数据', 'GET_GIFTDATA'], // 赠礼数据抽取
  ['取目标数', 'GET_TARGETNUM'], // 同室 TARGET 数
  ['分割串', 'SPLIT_G'], // 按分隔符取子串
  ['建整数变量', 'MAKE_INT'], // 临时 INT 变量
  ['建字符串变量', 'MAKE_STR'], // 临时 STR 变量

  // ---- 判定 / 查询族 ----
  ['是男性', 'IS_MALE'], // 性别判定
  ['有阴茎', 'HAS_PENIS'], // 有无阴茎
  ['有阴道', 'HAS_VAGINA'], // 有无阴道
  ['是否立位', 'IS_STANDING_SEX'], // 该体位是否立位
  ['非人类判定', 'IS_NONHUMAN'], // 人 / 妖 / 人偶
  ['是否室内', 'INROOM'], // 室内判定
  ['是否室外', 'OUTROOF'], // 屋外（无屋顶）判定
  ['是否浴场', 'BATHCHECK'], // 该地点有无浴室
  ['星期匹配', 'YOUBI_MATCH'], // 与"日月火…"之一匹配
  ['条件随机', 'IFRAND'], // 按条件选值
  ['取地图编号', 'GET_MAPID'], // 地点 → MAPID
  ['未读判定', 'ONCE'], // 事件首次判定
  ['日记页设置', 'CHARA_DIARY_PAGESETTING'], // 日记写入页
  ['发情周期', 'ESTRUS_CYCLE'], // 发情周期
  ['时间推进', 'TIME_PROGRESS'], // 时间经过处理

  // ---- 互动族 ----
  ['相互接吻', 'MUTUAL_KISS'], // 相互接吻
  ['设定初吻', 'SET_FIRSTKISS'], // 初吻记录
  ['主角体位', 'MASTER_POSE'], // 主角体位名
]);

/**
 * 由「中文名 → 原生 ERB 函数名」映射构建 `KojoLibraryTable`（纯数据，无 IO）。
 * `hasTable = 映射非空`；反查（原生名 → 中文名）取**首条**，无则 `undefined`。
 */
export function createEratwLibraryTable(map: ReadonlyMap<string, string>): KojoLibraryTable {
  const byName = new Map(map);
  const byFunction = new Map<string, string>();
  for (const [cn, erb] of byName) {
    // 原生名 → **首条**中文名（与 byName 的取首条同口径）
    if (!byFunction.has(erb)) byFunction.set(erb, cn);
  }
  return {
    hasTable: byName.size > 0,
    lookupByName: (name) => byName.get(name),
    lookupByFunction: (functionName) => byFunction.get(functionName),
    // 正向补全的唯一名字源：`byName` 的键（种子表声明序）；空映射 = `[]`
    // （`EMPTY_LIBRARY_TABLE` 因此天然零候选，无需另写）
    names: () => [...byName.keys()],
  };
}

/** 空表实例（无表时返回它；`hasTable=false`，查啥都 undefined） */
export const EMPTY_LIBRARY_TABLE: KojoLibraryTable = createEratwLibraryTable(new Map());
