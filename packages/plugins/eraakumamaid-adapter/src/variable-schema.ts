/**
 * eraAkumaMaid 变量字典（`VariableSchema`）——**由游戏数据文件驱动**（不硬编码索引表）。
 *
 * 落地口径 = eratw-adapter 同名模块的**逐字移植**（三层数据源、合并裁决、来源标注、
 * `inputDigest` 全部同构；差异只在"eraAkumaMaid 实测没有哪几层"，见下）。
 *
 * 数据来源（均取自当前打开的工程目录，随版本 / 魔改自动跟随）：
 * - 名称表（主表）：`CSV/{变量名}.csv`（`编号,名称[,注释]` 行格式）：
 *   `CFLAG.csv`（342 条编号行 / 341 个唯一名，`2,好感度` …）、`Talent.csv`（191 条）、`Abl.csv`（47 条）…
 *   实测行形态 `编号,名称,<tab><tab>;注释`（`CFLAG.csv:1` = `0,キャラ用,\t\t;各キャラ用の…`），
 *   第三列起是注释、不进名称；首行常为 BOM + `;` 分组注释（`Talent.csv:1` = `﻿;性別`）。
 * - **追加名表**：`CSV/{变量名}.als`（与 `.csv` 同一套行格式）——**eraAkumaMaid 实测
 *   全树 0 份**（`find . -iname '*.als'` 空，2026-10-18）⇒ 追加层**空转**：代码路径
 *   逐字保留（先全部 `.csv` 后全部 `.als`、"首个定义优先"只并集不覆盖），行为与 eratw
 *   一致；将来汉化 / 魔改版放进 `.als` 即自动生效，无需改本文件。
 * - **市场字典包追加名表**（KM-15）：已装字典包（`kind === 'dict-pack'`）的 `files/`
 *   目录（`LoadVariableSchemaOptions.marketAppendDirs`）——一律按追加名表并入。
 * - **作者自定名表**（FT-1）：整棵 ERB 子树内 `*.ERH` 的具名常量声明（`#DIM CONST NAME = 1101` /
 *   `#DEFINE NAME 0`）——口上作者自定义的符号名不住在 CSV 里，只住在 `.ERH`；引擎把它们
 *   当**全局变量**装（`IdentifierDictionary.cs:436-444`，键只有名字），`族头:NAME` 走的是
 *   "索引位是表达式"的求值路 ⇒ 收进字典 = 复刻引擎的可见性。
 *   实测：**9 份** `.ERH`（任务书初判 3 份有误，以实测为准——除 `ERB/ERH/` 三份外，
 *   还有 `ERB/EVENT_K/15 槞彁/` 下 5 份与 `ERB/TRANSLATION/SQN/` 1 份），两类声明共
 *   **111 行**（34 条 `#DIM CONST` + 77 条 `#DEFINE`），本表收录 **96 个唯一名字**：
 * `#DIM CONST NAME = 整数` 34 条全收（`ERB/TRANSLATION/SQN/TRANSLATION.ERH` 29 条，
 *   其中 28 条为 `0x` 十六进制色值 `C_YELLOW = 0xFFFF00` 一族；`EVENT_K15_Demoslaviya20XX.ERH`
 *   5 条）与 `#DEFINE NAME 整数` 62 条（`DAILY_CMD.ERH` 41 + `添い寝.ERH` 18 +
 *   `EVENT_K15_槞彁.ERH` 2 + `立ち絵.ERH` 1）；另 15 条 `#DEFINE` 是字符串值
 *   （`#DEFINE K15_VOICE_COLOR "ffdbff"` 一族）不收，无 `CONST` 的 `#DIM NAME = 351`
 *   （`ERB/ERH/GLAPHICS.ERH:1` 的 `#DIM Z_DEPTH = -2`，负值同样不收）、数组声明
 *   （`#DIM ANIME_FCOUNT, 6`）也一个都不收（理由见 `parseErhConsts` 注释）。
 *   9 份 `.ERH` **全部**首行带 BOM、其中 8 份为 CRLF（仅 `ERB/TRANSLATION/SQN/TRANSLATION.ERH`
 *   为 LF）——解析器两条都容（`trim()` 吃 BOM、按 `\r\n?|\n` 切行）。
 *
 * **eraAkumaMaid 没有的两层（实测结论，宁缺毋滥）**：
 * 1. **汉化词典层（chs）不实现**：游戏无 JP→CN 名词典——`#Translation/Dictionary.txt`
 *    实测是 **JP→EN 译者参考**（前三行 `体力,STAM,Stamina` / `精力,VIG,Vigor` /
 *    `魂,Soul`，头部注明 "for when the terms aren't present in _TR.CSV files"），
 *    `#Translation/ALL_TR.csv.disabled` 同为 JP→EN；`plugins/` 目录不存在（无 eraTW 式
 *    chs XML）⇒ 名称一律名称表原文；契约可选能力 `slotCn`（JP→CN 查询面）随之**缺省**
 *    （缺省 = 不猜；查不到回原文冒充命中正是该能力要根绝的 fail-open）。
 *    `LoadVariableSchemaOptions.chsMapPath` 仅为**契约形对齐**保留：本游戏无 CN 词典
 *    可读 ⇒ 不消费；调用方若传入即告警（铁律 4：不许静默）。
 * 2. **位表层（bits）不实现**：AM 的位注释形态是 `nbit名` / 散文，**没有** eratw
 *    `bit-tables.ts` 判据要求的 `n=名` 条目形态（全 `CSV/` 目录 `grep 'bit.*='` 0 命中）：
 *    `CSV/STAIN.csv:3-17`（`; 0bit Ｖ`…）、`CSV/CFLAG.csv:45`（`;bitで管理。0bit同棲可能, 1bit同棲中`）、
 *    `CSV/FLAG.csv:15`（`;0～9bitを使ってメインキャラを記録…`）。且 eratw 同族升格依据
 *    （STAIN 的掩码换算）是 ERB 侧 `GETBIT`/`FINDELEMENT` 实证链，本包未做该实证 ⇒ 不猜。
 *
 * **`_TR` 变体表不是追加名表**（实测结论）：`CSV/TALENT_TR.csv`（`オンナ,Female`）、
 * `CSV/ABL_TR.csv`（`信頼,Trust`）等 7 份首列是**名称不是编号** ⇒ 它们是 JP→EN 翻译表，
 * 不是 `编号,名称` 名表 ⇒ 经 `mergeVariableTable` 的"行首非数字不收录"**天然 0 条**，
 * 不按 append 层并入（也无可并入内容）、不另建翻译层（契约无 JP→EN 查询面）。
 * `SOURCE_TR.csv.disabled` 扩展名为 `.disabled`，连扫描都进不了。副作用（如实记录）：
 * 这些文件仍会建出**空表**（`tables` 里有 `TALENT_TR` 等键、0 条目）——与 eratw 对
 * 内容空 `.csv` 的行为逐字一致；`lookup('TALENT_TR', 1)` 因此回显
 * `{ name: 'TALENT_TR', index: 1 }`（"族在、索引无"）而非 `undefined`（"族无"）。
 *
 * 家族级名称（`lookup('CFLAG')` 无索引）：游戏目录**没有**机读的「家族→中文」表，
 * 故取适配器内置策展常量 `FAMILY_LABELS`（取值口径见其注释）；族头可写的中文别名
 * 见 `FAMILY_ALIASES`，其**全覆盖闸的分母**是 `ENGINE_FAMILIES`（引擎族全集，
 * 漏族即报红；不登记的族必须在 `FAMILY_ALIAS_EXCLUSIONS` 留名给理由）。
 *
 * 解析策略（宽容，与 eratw 逐字一致）：
 * - 跳过 `;` 开头注释行与空行；行首非数字的不收录；
 * - 第三个字段（注释）不进入名称；名称取第二个字段原文（日文/中文均可）；
 * - 同时建立**名称 → 编号**反向表（`lookup('TALENT', '恋慕')` 双向可用）；
 * - 同一编号/名称的**首个定义优先**（与引擎 CSV 加载顺序语义一致）。
 *
 * 追加名表（`*.als`）与**市场字典包**（KM-15）的**合并口径 = 只并集、不覆盖**：
 * 先按目录扫全部 `.csv` 建表，再把 `.als` 与市场名表**逐个并入同一张表**，沿用同一条
 * "首个定义优先" ⇒ ①`byIndex` 里 CSV 已定义的编号**逐字不变**（追加层只补 CSV
 * 没有的编号）；②`byName` 只**新增**名称键（同名的既有编号不改）。
 * 游戏自带工具 `tool/Generate_ERH.py`（eraTW 侧）实测同一口径（先 CSV 后 ALS，
 * 撞名时打印"保留旧值"），本并不另立标准。
 *
 * **来源层（ALS-R1）**：三层数据源在条目上如实标注（契约字段 `VariableInfo.source`）——
 * `.csv` → `'primary'`、`.als`（与市场字典包名表，KM-15）→ `'append'`、
 * `.ERH` 具名常量 → `'const'`，
 * 按"键第一次落地"的那一轮记源（与"首个定义优先"同一裁决）。本包只**标源**、
 * 不裁决归属：族归属如何分层由消费方（`kojo-sugar` 的 `resolveFamily`）决定，
 * 收录判定（拼错名核对）仍三层都算。
 *
 * 读取失败/缺表 → `lookup` 返回 undefined（通用层照常工作，只是没有标签；
 * 引擎侧「不静默」由调用方日志保证）。
 */

import { foldDigest, isErbDeclarationPath, stableHash } from '@kojo/plugin-api';
import type { FileIO, Logger, VariableInfo, VariableSchema, VariableSource } from '@kojo/plugin-api';

/** 名称表键的来源层：`.csv` = 主表 / `.als` = 追加名表（`.ERH` 常量走另一条路，见 `lookup`） */
export type NameTableSource = Extract<VariableSource, 'primary' | 'append'>;

export interface VariableTable {
  byIndex: Map<string, string>;
  byName: Map<string, string>;
  /**
   * 键 → 来源层（**与 `byIndex`/`byName` 同一裁决：首个定义优先**，键新增时才记源）。
   * 存在的理由：族归属（`resolveFamily`）只许认主表 → 追加表这两层，而合并后的
   * 两张 Map 本身分不出"这个名字是哪一轮进来的"（ALS-R1）。
   */
  indexSource: Map<string, NameTableSource>;
  nameSource: Map<string, NameTableSource>;
}

/**
 * 把一个名称表文件**并入**累积表（纯函数；导出供测试）。
 *
 * 行格式（`.csv` 与 `.als` **同一套**；eraAkumaMaid 实测同 eratw——本游戏 `.als` 虽
 * 0 份，口径照钉）：`编号,名称[,注释]`；`;` 开头（含 tab 缩进的续行注释）与空行跳过；
 * 行首非数字不收录；名称取第二个字段原文，第三个字段不进名称。
 * AM 实测第三列起常为 `<tab><tab>;注释` 形态（`CFLAG.csv:1`），本函数的"取第二个
 * 字段"天然只吃名称段。
 *
 * **裁决 = 首个定义优先**：已存在的 `编号` / `名称` 键一律不覆盖，只回计新增数。
 * 加载方按「先 `.csv` 后 `.als`」的顺序调用本函数 ⇒ 追加名表天然只补不盖。
 *
 * `source`（ALS-R1，additive）= 本轮往表里加的**是哪一层**，缺省 `'primary'`（主表）。
 * 只有"键第一次落地"那一轮的名称才记为该层 ⇒ 主表已有的编号/名称，`.als` 再写一遍
 * 也不改其来源（正是"只并集不覆盖"的另一面）。
 */
export function mergeVariableTable(
  target: VariableTable,
  text: string,
  source: NameTableSource = 'primary',
): { addedIndex: number; addedName: number } {
  const beforeIndex = target.byIndex.size;
  const beforeName = target.byName.size;
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const line = rawLine.trim(); // `trim()` 顺带吃掉 UTF-8 BOM（U+FEFF 属 ES 空白集）
    if (line.length === 0 || line.startsWith(';')) continue;
    const firstComma = line.indexOf(',');
    if (firstComma <= 0) continue;
    const idx = line.slice(0, firstComma).trim();
    if (!/^\d+$/.test(idx)) continue;
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const name = (secondComma >= 0 ? rest.slice(0, secondComma) : rest).trim();
    if (name.length === 0) continue;
    if (!target.byIndex.has(idx)) {
      target.byIndex.set(idx, name);
      target.indexSource.set(idx, source);
    }
    if (!target.byName.has(name)) {
      target.byName.set(name, idx);
      target.nameSource.set(name, source);
    }
  }
  return { addedIndex: target.byIndex.size - beforeIndex, addedName: target.byName.size - beforeName };
}

/** 解析单个变量名表 CSV（纯函数；导出供测试）——等价于并入一张空表 */
export function parseVariableCsv(text: string): VariableTable {
  const table: VariableTable = {
    byIndex: new Map(),
    byName: new Map(),
    indexSource: new Map(),
    nameSource: new Map(),
  };
  mergeVariableTable(table, text);
  return table;
}

/**
 * 无原型对象表（查表键可能来自**作者字节**，普通对象字面量会让
 * `constructor:` / `hasOwnProperty:` 命中 `Object.prototype` 成员——静默替换成
 * 函数源码，正是"未登记 ⇒ 不猜"要根绝的 fail-open）。
 */
const aliasTable = (entries: Record<string, string>): Readonly<Record<string, string>> =>
  Object.assign(Object.create(null) as Record<string, string>, entries);

/**
 * 家族级（数组行，如 `CFLAG` / `EXP`）中文标签 —— **策展常量，不是游戏提供的表**。
 *
 * 为什么内置：游戏目录**没有**机读的「变量家族 → 中文名」表 ⇒ 家族名只能在适配器
 * 内置（游戏知识归 adapter，架构铁律 3）。
 *
 * 取值口径：优先采纳游戏内既有显示证据——`ABL → 能力` / `MARK → 刻印` / `TALENT → 素质`
 * 取 `ERB/SHOP/PRINT_STATE.ERB:280/282/284` 的 `CASE "能力"` / `CASE "刻印"` /
 * `CASE "素質"`（SHOP 状态页栏目名）；其余取 emuera 通用中文族名（与表层语言一致）。
 * AM 特有族：`TRAIN → 指令`（`CSV/Train.csv` 是指令名表，本游戏 `TRAIN:` 表头写法
 * 0 处，族由名表实证）、`GLOBAL → 全局变量` / `GLOBALS → 共享全局变量`
 * （`CSV/Global.csv` / `CSV/Globals.csv` + `CSV/VariableSize.csv:20-21` 的
 * 「セーブデータ間で共有される変数」节）、`STRNAME → 字符串名`（`CSV/STRNAME.csv`）、
 * `GAMEBASE → 游戏基础信息`（`CSV/GameBase.csv`）、`TRCHARA → 替换角色`
 * （`CSV/TRCHARA.csv`）、`NOWEX → 现在绝顶` / `RAND → 随机`（引擎伪变量族）。
 * 改动本表 = 改产品的显示口径。
 */
export const FAMILY_LABELS: Readonly<Record<string, string>> = aliasTable({
  // —— 角色 1D 整数数组 ——
  BASE: '基础值',
  MAXBASE: '基础上限',
  DOWNBASE: '基础上降',
  ABL: '能力',
  TALENT: '素质',
  EXP: '经验',
  EXPLV: '经验等级',
  MARK: '刻印',
  PALAM: '参数',
  SOURCE: '欲求',
  EX: '绝顶',
  NOWEX: '现在绝顶',
  CFLAG: '角色标志',
  CDFLAG: '角色详细标志',
  JUEL: '宝珠',
  GOTJUEL: '取得宝珠',
  RELATION: '关系',
  EQUIP: '装备',
  TEQUIP: '临时装备',
  STAIN: '污渍',
  CUP: '参数上升',
  CDOWN: '参数下降',
  TCVAR: '临时角色变量',
  // —— 字符串族 ——
  CSTR: '角色字符串',
  STR: '字符串',
  TSTR: '临时字符串',
  SAVESTR: '存档字符串',
  STRNAME: '字符串名',
  // —— 全局 1D 整数数组 ——
  GLOBAL: '全局变量',
  GLOBALS: '共享全局变量',
  FLAG: '全局标志',
  TFLAG: '临时标志',
  DAY: '日期',
  TIME: '时间',
  MONEY: '金钱',
  ITEM: '道具',
  UP: '上升',
  DOWN: '下降',
  PALAMLV: '参数等级',
  EJAC: '射精次数',
  // —— 角色标量与名表 ——
  ISASSI: '助手',
  NO: '角色编号',
  NAME: '真名',
  CALLNAME: '称呼',
  NICKNAME: '昵称',
  MASTERNAME: '主人名',
  // —— 游戏侧名表族（CSV 目录实证）——
  TRAIN: '指令',
  GAMEBASE: '游戏基础信息',
  TRCHARA: '替换角色',
  // —— 引擎伪变量族 ——
  RAND: '随机',
});

/**
 * **引擎族全集**（策展常量）—— 家族头中文别名「全覆盖闸」的**分母**。
 *
 * 为什么另立一张表：`FAMILY_LABELS` 是**显示名**表，被闸门当成分母 ⇒ 一个族只要
 * 没进策展表就**静默漏**。本表把分母换成"引擎到底有哪些族"，于是**漏一个族必须
 * 报红**（`tests/variable-schema.test.ts` 的全覆盖闸）。
 *
 * 权威来源（eraAkumaMaid 实测，2026-10-18）：
 * - `CSV/VariableSize.csv`（引擎变量尺寸表，逐族列出尺寸——文件自述
 *   "VariableSize.CSV中でサイズを指定していない変数については標準の値が使われます"）：
 *   「キャラクタ変数」节给出 BASE/MAXBASE/ABL/TALENT/EXP/MARK/PALAM/SOURCE/EX/CFLAG/
 *   CDFLAG/JUEL/RELATION/EQUIP/TEQUIP/STAIN/GOTJUEL/NOWEX/CSTR/CUP/CDOWN/DOWNBASE/
 *   TCVAR/TSTR/STR，「セーブデータ間で共有される変数」节给出 GLOBAL/GLOBALS，
 *   「数値配列変数」节给出 DAY/MONEY/ITEM/FLAG/TFLAG/UP/DOWN/PALAMLV/EXPLV/EJAC/TIME；
 * - `CSV/` 目录名表实证：STRNAME / TRAIN / GAMEBASE / TRCHARA（有 CSV 但不在
 *   VariableSize 里的游戏侧族）；
 * - ERB 语料实测（`grep -rEo "\b族名:"`，2026-10-18 复测）：`RAND:` 28,139 处、
 *   `TALENT:` 32,065 处、`CFLAG:` 8,550 处…（引擎伪变量族 RAND 由此入场）。
 *
 * **全集边界（有意为之，不是遗漏）**：只收"作者会在条件 / 引用里写成表头"的**具名族**。
 * 以下三类**不在**本表，故闸门也不管它们——
 * - 通用字母数组 `A`–`Z` / `DA`–`DE` / `DITEMTYPE`：无固定语义，作者不会用中文表头写；
 * - 执行上下文量 `TARGET` / `ASSI` / `MASTER` / `PLAYER` / `RESULT` / `RESULTS` / `COUNT` /
 *   `SELECTCOM` / `PREVCOM` / `NEXTCOM` / `ASSIPLAY` / `BOUGHT` / `PBAND` / `ITEMSALES` /
 *   `RANDDATA` / `NOITEM` / `LOSEBASE`：值是"当前场景的编号 / 返回值"，不是可枚举的名表；
 * - 语言层 `LOCAL` / `LOCALS` / `ARG` / `ARGS`：由糖的语言层与语句关键字轴消化；
 * - 引擎内部名表数组 `ITEMNAME` / `EQUIPNAME` / `FLAGNAME` / `CFLAGNAME` / `TFLAGNAME`
 *   （VariableSize「csv変数」节）：作者不写这些表头；
 * - `_TR` 翻译表（`TALENT_TR` 等）：JP→EN 翻译文件，不是变量族（见文件头）。
 *
 * 引擎标识符大小写不敏感（`emuera.config:1 大文字小文字の違いを無視する:YES`，
 * Shift-JIS 实测）⇒ 本表一律大写。
 */
export const ENGINE_FAMILIES: readonly string[] = Object.freeze([
  // —— 角色 1D 整数数组（`CSV/VariableSize.csv`「キャラクタ変数」节）——
  'BASE',
  'MAXBASE',
  'DOWNBASE',
  'ABL',
  'TALENT',
  'EXP',
  'MARK',
  'PALAM',
  'SOURCE',
  'EX',
  'NOWEX',
  'CFLAG',
  'CDFLAG',
  'JUEL',
  'GOTJUEL',
  'RELATION',
  'EQUIP',
  'TEQUIP',
  'STAIN',
  'CUP',
  'CDOWN',
  'TCVAR',
  // —— 字符串族（VariableSize「キャラクタ変数」/「csv変数」节）——
  'CSTR',
  'TSTR',
  'STR',
  'SAVESTR',
  'STRNAME',
  // —— 全局 1D 整数数组（VariableSize「共有」+「数値配列変数」节）——
  'GLOBAL',
  'GLOBALS',
  'DAY',
  'MONEY',
  'ITEM',
  'FLAG',
  'TFLAG',
  'UP',
  'DOWN',
  'PALAMLV',
  'EXPLV',
  'EJAC',
  'TIME',
  // —— 角色标量与名表（`X:i` 取第 i 号角色的属性）——
  'ISASSI',
  'NO',
  'NAME',
  'CALLNAME',
  'NICKNAME',
  'MASTERNAME',
  // —— 游戏侧名表族（CSV 目录实证）——
  'TRAIN',
  'GAMEBASE',
  'TRCHARA',
  // —— 引擎伪变量族（AM ERB 语料 `RAND:` 28,139 处）——
  'RAND',
]);

/**
 * 家族头的**作者可写中文别名** —— 与 `FAMILY_LABELS`（家族**显示名**）**不同轴**的独立策展常量。
 *
 * - `FAMILY_LABELS`：家族 → 人类可读**显示名**（悬停描述 / 家族级 `lookup` 的 `description`），
 *   面向"看"（如 `FLAG:'全局标志'`）；
 * - `FAMILY_ALIASES`：表层中文**输入别名** → 引擎变量族头，面向"写"——作者在表达式 / 段条件里
 *   写 `现在:噴乳` 等价于原生 `NOWEX:噴乳`（语法糖 §表达式一节的族头中文化）。
 *
 * **两者不许混用、不许覆盖**：显示名（`全局标志`）不是别名（`标记`），别名（`标记`）也不是
 * 显示名；把一张表当另一张用必然产出"作者写不出 / 读者看不懂"的错位。表小、策展、纯数据，
 * 与 `FAMILY_LABELS` 同属"游戏目录无机读表 ⇒ 适配器内置"（架构铁律 3）。未登记 ⇒ 不猜。
 *
 * 策展口径（目标 = 安全上限；每条别名都可考据，宁缺毋滥）：
 * 1. 别名取「作者会自然写的表头形」——能站住的显示名原样采纳（本表层与 eraTW 同语言，
 *    故多数条目与 eratw 同名表一致；AM 侧证据：`能力`/`刻印`/`素质` 有 SHOP 状态页
 *    栏目名正证，`ERB/SHOP/PRINT_STATE.ERB:280/282/284`）；
 * 2. 一形不可配两族：`TEQUIP` / `EQUIP` 显示名在中文表层拆为「临时装备」/「装备」；
 * 3. 长别名包含短别名（「角色字符串」⊃「字符串」、「临时装备」⊃「装备」）可同登：写侧按
 *    **标识符整段**匹配 ⇒「角色字符串:」整段命中 `CSTR:`，绝不切出「字符串:」误配 `STR:`；
 * 4. 撞语言关键字 / 中文表头形无实证的族不进表、进 `FAMILY_ALIAS_EXCLUSIONS` 台账。
 *
 * 注：`随机` 同时是**随机块的块关键字**（糖的语言层），本表只声明"它在**表达式位**的族头
 * 别名 = `RAND`"；块头位由词法器先判，两义不冲突。
 */
export const FAMILY_ALIASES: Readonly<Record<string, string>> = aliasTable({
  // —— D2 绰号（既有 4 条，与 eratw 表层一致）——
  现在: 'NOWEX',
  时标: 'TFLAG',
  标记: 'FLAG',
  随机: 'RAND',
  // —— 全量批（显示名原样采纳；`PALAM` / `EX` 见排除台账）——
  基础值: 'BASE',
  基础上限: 'MAXBASE',
  基础上降: 'DOWNBASE',
  能力: 'ABL',
  素质: 'TALENT',
  经验: 'EXP',
  经验等级: 'EXPLV',
  刻印: 'MARK',
  欲求: 'SOURCE',
  参数上升: 'CUP',
  参数下降: 'CDOWN',
  角色标志: 'CFLAG',
  角色详细标志: 'CDFLAG',
  宝珠: 'JUEL',
  取得宝珠: 'GOTJUEL',
  关系: 'RELATION',
  装备: 'EQUIP',
  临时装备: 'TEQUIP',
  污渍: 'STAIN',
  临时角色变量: 'TCVAR',
  角色字符串: 'CSTR',
  字符串: 'STR',
  临时字符串: 'TSTR',
  存档字符串: 'SAVESTR',
  全局变量: 'GLOBAL',
  日期: 'DAY',
  金钱: 'MONEY',
  道具: 'ITEM',
  时间: 'TIME',
  上升: 'UP',
  下降: 'DOWN',
  参数等级: 'PALAMLV',
  射精次数: 'EJAC',
  角色编号: 'NO',
  真名: 'NAME',
  称呼: 'CALLNAME',
  昵称: 'NICKNAME',
  主人名: 'MASTERNAME',
  助手: 'ISASSI',
  指令: 'TRAIN',
});

/** `FAMILY_ALIASES` 的反向表（族头 → 中文别名；键统一大写 ⇒ 引擎大小写不敏感） */
export const FAMILY_ALIASES_REVERSE: Readonly<Record<string, string>> = aliasTable(
  Object.fromEntries(
    Object.entries(FAMILY_ALIASES).map(([alias, family]) => [family.toUpperCase(), alias]),
  ),
);

/**
 * `FAMILY_ALIASES` 的**排除名单**（家族 → 一行理由）：暂不登记的族在此留名，不留白——
 * 全覆盖闸要求 `ENGINE_FAMILIES`（引擎族全集）**每族要么有别名、要么在此名单
 * 且有理由**，防"悄悄没登记"（增删条目时三张台账对账）。
 *
 * 两类理由各有其位：**①撞语言关键字**（作者写了会两义）；**②中文表头形无实证**
 * （宁缺毋滥——猜一个显示名 = 造一个作者不会写、读者也不认的假词）。
 *
 * 同由 `aliasTable` 造（无原型）：本台账键 = 引擎族头（ASCII 大写），不装作者输入。
 */
export const FAMILY_ALIAS_EXCLUSIONS: Readonly<Record<string, string>> = aliasTable({
  PALAM: '「参数」是语法层关键字（时机命名参数声明 `参数: ARG`，规范 §3.2）：同词再作族头别名 = 一形两义，宁缺',
  EX: '「绝顶」一词横跨 EX（本回合绝顶发生，CSV/EX.csv:2 `;0～19は各種絶頂`）/ NOWEX（现在绝顶）/ EXP（绝顶经验）三族，一形配三义 ⇒ 宁缺，待表层规范定夺',
  GLOBALS: '与 GLOBAL 同语义域（全局数组；GLOBALS 为跨存档共享，CSV/VariableSize.csv:20-21），一形不配两族；AM 语料 33 处 `GLOBALS:` 但无中文表头形实证 ⇒ 不猜',
  STRNAME: 'AM 语料 0 处 `STRNAME:` 表头写法（CSV/STRNAME.csv 存在但无人按族头引用；实测匹配全是 CSTRNAME 子串）⇒ 无中文表头形',
  GAMEBASE: '作者侧写引擎常量 `GAMEBASE_VERSION` / `GAMEBASE_TITLE`（实测 10 处，如 ERB/SYSTEM/TITLE.ERB:28），不写 `GAMEBASE:编号` 表头 ⇒ 无中文表头形',
  TRCHARA: 'CSV/TRCHARA.csv 是角色替换映射表（`NO,0,` 形态）而非编号名表，AM 语料 0 处 `TRCHARA:` ⇒ 无中文表头形',
});

/**
 * 解析 `.ERH` 声明行 → **作者自定名表** `Map<大写名称, 整数编号>`（纯函数；导出供测试）。
 *
 * 收的是**"名字 = 一个整数"**这一类声明——引擎侧它们与 CSV 名称表无关，是**全局具名常量**，
 * `族头:名字` 走的是"索引位是一个表达式"这条普通求值路（`VariableEvaluator.cs:215` 只对
 * **字面串**索引走 CSV 名称表；标识符索引直接求值）。eraAkumaMaid 实测形态（9 份 `.ERH`
 * / 111 条声明行，本表收 96 个名字）：
 * - `#DIM CONST NAME = 1101`（34 条全收；含 `0x` 十六进制 28 条，`ERB/TRANSLATION/SQN/TRANSLATION.ERH`
 *   的色值常量 `C_YELLOW = 0xFFFF00` 一族）
 * - `#DEFINE NAME 0`（77 条里 62 条收：纯整数 / `0x`；另 15 条是 `"字符串"` ⇒ 不收。
 *   例：`#DEFINE K15_VOICE_COLOR "ffdbff"` 不收，`#DEFINE K15_MACHINE_COLOR 0xccffe5` 收）
 * - `#DIM NAME, 10`（声明的是"新变量族"，不是"名字=编号"）——不收
 * - `#DIM NAME = 351`（无 `CONST` ⇒ 可写变量，运行期可被改写 ⇒ 收了就是猜；实测
 *   `ERB/ERH/GLAPHICS.ERH:1` 的 `#DIM Z_DEPTH = -2` 属此形态，且为负值）——不收
 * - `#DIM CONST NAME = 0, 100, 500`（数组，无唯一编号）/ 表达式（`0x44 + …`）——不收
 * 行尾 `;` 注释实测常见（`#DEFINE DAILY_写真撮影をする 190 ;290`），先截后解析。
 * 9 份文件首行**全部**带 BOM、8 份为 CRLF ⇒ `trim()` + `\r\n?|\n` 两条都容（与 eratw 同一解析器）。
 *
 * 键按**大写**存（`emuera.config:1 大文字小文字の違いを無視する:YES` ⇒ 引擎标识符本就
 * 大小写不敏感），同名**首个定义优先**（与名称表同一裁决口径；实测 9 份 **0 组
 * "同名不同值"**，故顺序不影响结果）。
 */
export function parseErhConsts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const put = (name: string, value: number): void => {
    const key = name.toUpperCase();
    if (key.length === 0 || out.has(key)) return;
    out.set(key, value);
  };
  for (const rawLine of text.split(/\r\n?|\n/)) {
    // `trim()` 顺带吃掉 UTF-8 BOM；`;` 起行 = 整行注释，行中 `;` = 行尾注释 ⇒ 一律先截断
    const head = rawLine.trim();
    if (!head.startsWith('#')) continue;
    const semi = head.indexOf(';');
    const line = (semi >= 0 ? head.slice(0, semi) : head).trim();
    const m = /^#(DIMS|DIMF|DIM|DEFINE)([\s\S]*)$/i.exec(line);
    if (!m) continue;
    let rest = (m[2] ?? '').trim();
    const keywords = new Set<string>();
    if (m[1]!.toUpperCase() !== 'DEFINE') {
      for (;;) {
        const km = /^([A-Za-z_][A-Za-z0-9_]*)[\s\S]*$/.exec(rest);
        if (km === null) break;
        const kw = (km[1] ?? '').toUpperCase();
        if (!ERH_DECL_KEYWORDS.has(kw)) break;
        keywords.add(kw);
        rest = (km[0] ?? '').slice(km[1]!.length).trim();
      }
      if (!keywords.has('CONST')) continue; // 普通 `#DIM NAME, 10` 是"新变量族"，不是"名字=编号"
      const eq = rest.indexOf('=');
      if (eq <= 0) continue;
      const name = (rest.slice(0, eq) ?? '').trim();
      const value = integerLiteral(rest.slice(eq + 1) ?? '');
      if (value === undefined) continue;
      put(name, value);
      continue;
    }
    const space = rest.search(/[\s(]/);
    const name = (space < 0 ? rest : rest.slice(0, space)).trim();
    const value = integerLiteral(space < 0 ? '' : rest.slice(space));
    if (value === undefined) continue;
    put(name, value);
  }
  return out;
}

/** `.ERH` 声明行的前置关键字（Emuera `UserDefinedVariableData.Create` 认的关键词集） */
const ERH_DECL_KEYWORDS = new Set([
  'CONST',
  'LOCAL',
  'STATIC',
  'DYNAMIC',
  'GLOBAL',
  'SAVEDATA',
  'REF',
  'OUT',
  'CHARADATA',
]);

/** 整数字面量（十进制 / `0x` 十六进制）→ 编号；其它形态（表达式、数组、字符串、负值）一律不认 */
function integerLiteral(text: string): number | undefined {
  const s = text.trim();
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(s)) return undefined;
  const n = /^0[xX]/.test(s) ? Number.parseInt(s.slice(2), 16) : Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export interface LoadVariableSchemaOptions {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径） */
  csvDir: string;
  /** ERB 根目录（绝对路径；FT-1）。**缺省 = 完全不读 `.ERH`** */
  erbDir?: string;
  /**
   * 变量名汉化词典路径（绝对路径）。
   *
   * **eraAkumaMaid 无 JP→CN 名词典 ⇒ 本参数当前不消费**（契约形对齐 eratw；实测
   * `#Translation/Dictionary.txt` 是 JP→EN 译者参考、无 `plugins/` chs XML，详见文件头）。
   * 调用方若传入即告警（不静默），名称一律取名称表原文。
   */
  chsMapPath?: string;
  /**
   * 市场字典包（`kind === 'dict-pack'`）的 contentDir 列表（KM-15；additive）。
   *
   * 轮序：游戏主表（`csvDir/*.csv`）→ 游戏追加名表（`csvDir/*.als`）→ 本列表
   * （目录间与文件间**按路径排序**：先定义优先的裁决不许随枚举顺序漂）。
   * 每个目录里的名表文件（仍只收 `.csv` / `.als` 两种，变量名 = 去扩展名大写）
   * **一律以 `source: 'append'` 并入**——市场包没有"主表"语义。
   * 缺省 / 空数组 = 不读市场，与历史行为逐字一致（零新增输出）。
   */
  marketAppendDirs?: readonly string[];
  log: Logger;
}

/** 名称表文件：`{变量名}.csv` = 主表 / `{变量名}.als` = 追加名表（市场字典包同轮收两种） */
interface NameTableFile {
  variableName: string;
  path: string;
}

/** 字符串路径序（确定性：目录与文件两级的"先定义优先"裁决都不许随枚举顺序漂） */
const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 加载 eraAkumaMaid 变量字典：扫描 `CSV/` 根目录的全部 `*.csv` 名称表**与** `*.als`
 * 追加名表（文件名去掉扩展名后大写即变量名；子目录不进入——`CSV/CHARA` 是角色数据，
 * 不是变量表），再把市场字典包目录（`marketAppendDirs`，KM-15）里的名表**同轮并入**。
 *
 * 三轮顺序 = 裁决顺序：先把全部 `.csv` 建成主表，再把游戏 `.als` 并入，
 * 最后并市场字典包名表（目录间与文件间按路径排序）——同一条"首个定义优先"
 * ⇒ 主表的编号名称逐字不变，追加层只贡献新名称 / 主表缺的编号。
 *
 * eraAkumaMaid 实测：`CSV/` 下 33 份 `.csv`，其中 21 份有编号行（CFLAG 342 / TALENT 191 /
 * TRAIN 155 / TCVAR 109 …）、12 份 0 条（7 份 `_TR` 翻译表 + GameBase / Globals / TRCHARA /
 * VariableSize / _Replace——后者是键值 / 尺寸 / 替换配置，不是编号名表）；`.als` 0 份。
 */
export async function loadErakumamaidVariableSchema(
  opts: LoadVariableSchemaOptions,
): Promise<VariableSchema> {
  const { io, csvDir, erbDir, log } = opts;
  const tables = new Map<string, VariableTable>();
  /** 输入摘要素材：实际读到的每个名称表文件的「路径 + 正文」哈希（排序后折叠 ⇒ 与目录顺序无关） */
  const digestParts: string[] = [];

  // eraAkumaMaid 无 JP→CN 词典（实测见文件头）⇒ chs 层不实现；传入即告警，不静默忽略
  if (opts.chsMapPath !== undefined) {
    log.warn(
      `eraAkumaMaid 无 JP→CN 名词典（#Translation/Dictionary.txt 实测为 JP→EN 译者参考），` +
        `chsMapPath 不消费、名称一律原文：${opts.chsMapPath}`,
    );
  }

  let entries: Awaited<ReturnType<FileIO['listDir']>>;
  try {
    entries = await io.listDir(csvDir);
  } catch (err) {
    log.warn(`变量字典加载失败（CSV 目录不可读）：${csvDir} — ${String(err)}`);
    entries = [];
  }

  /** 主表与追加名表**分桶收集** ⇒ 加载顺序恒为"先全部主表，再全部追加表"（与目录枚举顺序无关） */
  const primaryFiles: NameTableFile[] = [];
  const appendFiles: NameTableFile[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (/\.csv$/i.test(e.name)) {
      const variableName = e.name.replace(/\.csv$/i, '').toUpperCase();
      if (variableName.length > 0) primaryFiles.push({ variableName, path: e.path });
    } else if (/\.als$/i.test(e.name)) {
      const variableName = e.name.replace(/\.als$/i, '').toUpperCase();
      if (variableName.length > 0) appendFiles.push({ variableName, path: e.path });
    }
  }

  let appendedNames = 0;
  let appendedIndexes = 0;
  const tableOf = (variableName: string): VariableTable => {
    let t = tables.get(variableName);
    if (!t) {
      t = { byIndex: new Map(), byName: new Map(), indexSource: new Map(), nameSource: new Map() };
      tables.set(variableName, t);
    }
    return t;
  };

  /**
   * 一轮加载：**一次批量读** → 按序并入表 → 记摘要。
   *
   * `readTexts` 一次 `read_files_raw` 批带回 N 份，失败位是 `null`（契约：不整批抛），
   * 与旧的"单文件读失败只 warn 跳过"同一可见口径——**不静默**。
   * 并入顺序 = 入参顺序 ⇒「首个定义优先」的裁决与摘要顺序逐字不变。
   */
  const runPass = async (files: readonly NameTableFile[], source: NameTableSource): Promise<void> => {
    if (files.length === 0) return;
    const texts = await io.readTexts(files.map((f) => f.path));
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const tf = texts[i];
      if (tf === null || tf === undefined) {
        log.warn(`变量表读取失败（跳过）：${f.path}`);
        continue;
      }
      const merged = mergeVariableTable(tableOf(f.variableName), tf.text, source);
      digestParts.push(stableHash(`${f.path}\u0000${tf.text}`));
      if (source === 'append') {
        appendedNames += merged.addedName;
        appendedIndexes += merged.addedIndex;
      }
    }
  };

  await runPass(primaryFiles, 'primary');
  await runPass(appendFiles, 'append');
  if (appendFiles.length > 0) {
    log.info(
      `追加名表（*.als）：${appendFiles.length} 份，并入 ${appendedNames} 个新名称 / ${appendedIndexes} 个新编号（主表已有的编号名称不改写）`,
    );
  }

  /**
   * 第三轮：市场字典包（KM-15）。目录与文件**都先按路径排序**再并入（`runPass` 逐文件
   * 读并入 `digestParts` ⇒ 字典换了指纹就变），故"先定义优先"的裁决与市场安装顺序 /
   * 目录枚举顺序无关。全部按 `'append'` 记源：主表仍只认游戏 CSV 目录。
   * 目录不可读 / 文件读失败一律 warn 跳过（不静默），其余输入照常。
   */
  const marketAppendNamesStart = appendedNames;
  const marketAppendIndexesStart = appendedIndexes;
  const marketDirs = [...(opts.marketAppendDirs ?? [])].sort(comparePaths);
  const marketFiles: NameTableFile[] = [];
  for (const dir of marketDirs) {
    let dirEntries: Awaited<ReturnType<FileIO['listDir']>>;
    try {
      dirEntries = await io.listDir(dir);
    } catch (err) {
      log.warn(`变量字典：市场字典包目录不可读（跳过）：${dir} — ${String(err)}`);
      continue;
    }
    for (const e of dirEntries) {
      if (e.isDirectory) continue;
      const m = /\.(csv|als)$/i.exec(e.name);
      if (m === null) continue;
      const variableName = e.name.slice(0, e.name.length - m[0].length).toUpperCase();
      if (variableName.length > 0) marketFiles.push({ variableName, path: e.path });
    }
  }
  marketFiles.sort((a, b) => comparePaths(a.path, b.path));
  await runPass(marketFiles, 'append');
  if (marketFiles.length > 0) {
    log.info(
      `市场字典包追加名表：${marketDirs.length} 个目录 / ${marketFiles.length} 份，并入 ` +
        `${appendedNames - marketAppendNamesStart} 个新名称 / ${appendedIndexes - marketAppendIndexesStart} 个新编号（主表已有的编号名称不改写）`,
    );
  }

  /**
   * 作者自定名表（整棵 ERB 子树内的 `*.ERH` 具名常量声明，FT-1）——**全局一张，不按角色分桶**。
   *
   * 取证结论（Emuera 源码克隆，分支 develop-skiasharp；eraTW 侧已核）：
   * `.ERH` 由 `Process.cs:221` 一次性从**整个 ERB 根**装载（递归与否取
   * `Config.SearchSubdirectory`）⇒ 全树，每行的 `#DIM` 进**同一条**队列
   * （`ErhLoader.cs:126`，isPrivate 恒为 false），最终落进
   * `IdentifierDictionary.cs:436-444` 的 `varTokenDic`/`nameDic`——**键只有名字，
   * 没有文件/角色维度**。⇒ 引擎侧"声明即全局可见"，跨角色引用是合法的既有写法
   * （eraAkumaMaid 实测 9 份 / 96 名、**0 组同名不同值**；引擎用 `Dictionary.Add`，
   * 重名直接报错），故本表按全局收录不会引入引擎不认的误判。
   * eraAkumaMaid 的 9 份里 6 份在 `ERB/EVENT_K/15 槞彁/` 与 `ERB/TRANSLATION/` 下
   * （口上作者自定义常量正是要收的）⇒ 必须递归整个 ERB 根，不能只扫 `ERB/ERH/`。
   */
  const erhConsts = new Map<string, number>();
  if (erbDir !== undefined) {
    /** 实际要读的 `.ERH` 路径（排序后 = 摘要与"首个定义优先"的裁决序） */
    let erhPaths: string[] = [];
    try {
      // `filter` 由内核兑现且**只筛输出条目、不剪枝**（见 `WalkOptions`）⇒ 目录侧无需
      // 放行以外的技巧，但**本层不信任回来的都是 `.ERH`**：读盘前自己再按扩展名筛一遍
      // （读集合的规模是本函数的性能与安全边界，不能委托给一具可能跨进程的桥）。
      // 判扩展名一律问契约层单一真源（FT-2 收口），本包不再抄第二份 `.erh` 字面量。
      const found = await io.walkDir(erbDir, {
        filter: (e) => e.isDirectory || isErbDeclarationPath(e.name),
      });
      // 确定性顺序：首个定义优先的裁决不该随目录枚举顺序漂移（引擎按路径排序装载）
      erhPaths = found
        .filter((e) => !e.isDirectory && isErbDeclarationPath(e.name))
        .map((e) => e.path)
        .sort(comparePaths);
    } catch (err) {
      log.warn(`自定名表扫描失败（跳过，具名索引回落名称表）：${erbDir} — ${String(err)}`);
    }
    // 一次批量读替掉逐份 `await readText`：串行 IPC 往返在真语料上是秒级耗时
    const erhTexts = erhPaths.length > 0 ? await io.readTexts(erhPaths) : [];
    let skippedDup = 0;
    for (let i = 0; i < erhPaths.length; i++) {
      const path = erhPaths[i]!;
      const tf = erhTexts[i];
      if (tf === null || tf === undefined) {
        log.warn(`自定名表读取失败（跳过）：${path}`);
        continue;
      }
      digestParts.push(stableHash(`${path}\u0000${tf.text}`));
      for (const [name, value] of parseErhConsts(tf.text)) {
        if (erhConsts.has(name)) {
          skippedDup++;
          continue;
        }
        erhConsts.set(name, value);
      }
    }
    if (erhPaths.length > 0) {
      log.info(
        `自定名表（*.ERH 具名常量）：${erhPaths.length} 份，收录 ${erhConsts.size} 个名字` +
          (skippedDup > 0 ? `（重名 ${skippedDup} 处按首个定义优先跳过）` : ''),
      );
    }
  }

  log.info(`变量字典：${tables.size} 张名称表（${[...tables.keys()].join(', ')}）`);

  // 输入摘要：字典由游戏 CSV 驱动，玩家改一行描述就该让下游派生缓存失效。
  // 一张都没读到也是**确定值**（区别于 undefined = "没有判据"）。
  const inputDigest = foldDigest(digestParts);

  return {
    version: '1',
    inputDigest,
    lookup(variableName: string, index?: number | string): VariableInfo | undefined {
      const key = variableName.toUpperCase();
      const table = tables.get(key);
      if (!table) return undefined;
      if (index === undefined) {
        // 家族级：游戏无机读的家族名表 → 取适配器内置策展常量（无则只给变量名）
        const label = FAMILY_LABELS[key];
        return label !== undefined ? { name: key, description: label } : { name: key };
      }
      const idxStr = String(index);
      const byIdx = table.byIndex.get(idxStr);
      if (byIdx !== undefined) {
        // 编号索引（如 CFLAG:2）→ 名称为描述；resolvedIndex = 自身
        const n = Number(idxStr);
        const info: VariableInfo = {
          name: key,
          index,
          description: byIdx,
          source: table.indexSource.get(idxStr) ?? 'primary',
        };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      if (table.byName.has(idxStr)) {
        // 具名索引（如 TALENT:恋慕）→ 名称本身即描述；resolvedIndex = 字典编号
        const info: VariableInfo = {
          name: key,
          index,
          description: idxStr,
          // 来源层如实上报（ALS-R1）：`.als` 给的别名 = `'append'`，主表给的 = `'primary'`。
          // 消费方（族归属）据此区分"主表的归属"与"追加表抢走的归属"；收录判定不受影响。
          source: table.nameSource.get(idxStr) ?? 'primary',
        };
        const n = Number(table.byName.get(idxStr));
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      /**
       * 名称表查无 → 作者自定名表（`.ERH` 具名常量）兜底。引擎侧这条路不是"名称表"，
       * 而是"索引位是一个表达式"（`VariableEvaluator.cs:215` 只把**字面串**索引交给 CSV
       * 名称表；标识符索引按变量求值）⇒ `CFLAG:K15C_X` 与 `CFLAG:1101` 是同一个槽位。
       * 常量**不属于任何族**（同一个名字可以写在任意族后面），故此处只做"名字→编号"的
       * 换算，不宣称族归属；描述取作者原文（本游戏无汉化词典，见文件头）。
       * 名称表在前、本表在后 ⇒ 既有（含 `*.als`）读数一条都不受影响。
       * `source: 'const'`（ALS-R1）把"不宣称族归属"这条意图**交给消费方**：
       * 收录判定（拼错名核对）三层都算，族归属只认 `'primary'` → `'append'` 两层。
       */
      const constIndex = erhConsts.get(idxStr.toUpperCase());
      if (constIndex !== undefined) {
        return {
          name: key,
          index,
          description: idxStr,
          resolvedIndex: constIndex,
          source: 'const',
        };
      }
      return { name: key, index };
    },
    /**
     * 枚举该族可写的索引名（KC-1；契约 `VariableSchema.names` 的 eraAkumaMaid 实现）。
     *
     * 由 `byIndex`（编号 → 名，天生可枚举）直接产出：每个条目的 `name` = **索引名**
     * （作者可写的名字），`index`/`resolvedIndex` = 其编号，`source` = 该编号的来源层
     * （`.csv` 主表 / `.als` 追加名表）。无该族 → 空数组。**不改动 `lookup` 既有行为**。
     */
    names(family: string): readonly VariableInfo[] {
      const table = tables.get(family.toUpperCase());
      if (!table) return [];
      const out: VariableInfo[] = [];
      for (const [idxStr, name] of table.byIndex) {
        const n = Number(idxStr);
        const info: VariableInfo = {
          name,
          index: Number.isNaN(n) ? idxStr : n,
          source: table.indexSource.get(idxStr) ?? 'primary',
        };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        out.push(info);
      }
      return out;
    },
    /**
     * 家族头中文别名（D2；契约 `VariableSchema.familyAlias` 的 eraAkumaMaid 实现）。
     * 表层输入别名 → 引擎族头（`现在` → `NOWEX`）；**未登记 ⇒ `undefined`（不猜）**。
     */
    familyAlias(name: string): string | undefined {
      return FAMILY_ALIASES[name];
    },
    /**
     * 家族头中文别名的反向（D2；契约 `VariableSchema.familyAliasReverse`）。
     * 引擎族头 → 表层中文别名（`NOWEX` → `现在`）；**未登记 ⇒ `undefined`（不猜）**。
     * 引擎标识符大小写不敏感 ⇒ 键统一大写后查。
     */
    familyAliasReverse(family: string): string | undefined {
      return FAMILY_ALIASES_REVERSE[family.toUpperCase()];
    },
    /**
     * 槽位名的 JP→CN 汉化查询（契约 `VariableSchema.slotCn`）——**eraAkumaMaid 不实现**：
     * 游戏无 JP→CN 名词典（`#Translation/Dictionary.txt` 实测为 JP→EN 译者参考，
     * 无 `plugins/` chs XML）⇒ 缺省（不猜）；查不到回原文冒充命中正是该能力要根绝的
     * fail-open。待将来出现可解析的 JP→CN 词典再按 eratw 同款两段裁决补登。
     */
  };
}
