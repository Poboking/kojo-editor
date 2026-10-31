/**
 * eraFL 方言指令表（ERB 侧**差集**产物）—— 游戏知识，只住 adapter。
 *
 * ## 这份表回答什么
 *
 * 「eraFL 的作者真在写、而编辑器词表不认识」的引擎词有哪些。宿主词表是两份：
 * `packages/app/src/monaco/erb-directives.ts`（`ERB_DIRECTIVES`，119 词）与
 * `erb-directives.ts` 物化的高亮补集（词表真源 `@kojo/erb-vocab/highlight-words`；
 * `ERB_HIGHLIGHT_EXTRA_WORDS` = 控制流 45 + 引擎内建 8，
 * 减去指令表后剩 29）——两者并集 148 词，就是本表求差集的分母。
 *
 * ## 扫描口径（2026-10-24，语料 `D:/Game/erafl`，只读）
 *
 * - 范围：`ERB` 树下全部 `.ERB`（递归、大小写不敏感）实测 **2,016 份**（任务书写的 2,013 略低，差异未追；
 *   本文件所有读数以 2,016 为准，可原样复跑复核）；
 * - 行数 601,586；**跳过的行**：`;` 整行注释、`[SKIPSTART]…[SKIPEND]` 死代码段、
 *   多行字符串的续行（按行内 `"` 奇偶判）、上一行未收尾（以 `,` `(` 或运算符结尾）
 *   的续行——这四类里出现的大写词是**数据**，不是语句；
 * - 两个计数面：`@函数名`（定义行）**17,750 种**；「行首大写词」= 行首 token 后
 *   紧跟空白的语句形态 **213 种**（词后粘 `=` `'` `:` `(` `,` 等一律不算——
 *   `TEXT '= …` 的 `TEXT`、`RESULTS = …` 的 `RESULTS` 都是**变量左值**，
 *   这条判据把它们全滤掉了，排除清单见文件尾「本批排除的几类」）。
 *
 * ## 差集（本表只收「确实是引擎指令/函数」的那一侧）
 *
 * | 面 | 种类 | 差集 | 进表 |
 * | --- | --- | --- | --- |
 * | `@函数名` | 17,750 | 17,749 | **0** |
 * | 行首语句词 | 213 | 127 | **127**（另人工补录 2，见下） |
 *
 * - `@` 面进表 0：`@名字` 本身就是**游戏侧定义**（Emuera 里用户函数必须先有 `@`
 *   定义、再由 `CALL`/表达式调用），所以这 17,749 个名字全是业务函数
 *   （`KOJO_*` / `QST_*` / `HO_*` / `COM_*` / `CLOTH_*` / `CREATE_MOB_*` …），
 *   把它们塞进"语言指令表"只会让补全里出现一堆本工程才有的名字。
 *   唯一与宿主词表重名的是 `@CHANGE_CFLAG`（1 个），那是游戏**重定义**了引擎同名语句，
 *   不是引擎词，仍不进表。
 * - 语句面 127 条**全部**进表（127/127）：判据两条**同时**成立——
 *   1. 它出现在**语句位**（行首、后跟空白、后跟的不是赋值/成员/运算符续接符）；
 *   2. **全语料 17,750 个 `@` 定义里没有它**（逐个核对，无一例外）。
 *   在 Emuera 里"语句位 + 无 `@` 定义"只可能是**引擎实现**：用户函数不能省 `CALL`。
 * - 另有 **2 条人工补录**（`SPRITEANIMEADDFRAME` / `DOTRAIN`）：它们被扫描的
 *   "上一行未收尾 ⇒ 本行是续行"启发式误滤（上一行恰好以 `,` 收尾的多行实参），
 *   人工复核确为语句位、且全语料无 `@` 定义，故按同一判据收进表尾并标注来源。
 *
 * ## 顺序与维护
 *
 * 表序 = **按族分组、族内语料出现次数降序**（同频按词面码元序），族头注释写清这一族
 * 是哪种引擎能力。谁在表里、为什么在、出现过几次、出自哪一行，四件事一条注释里读完。
 * 增删词只改本表，别在语言定义里另写字面量（同 `erb-directives.ts` 的纪律）。
 *
 * ## 与宿主的关系（本批**没有**接线）
 *
 * `packages/plugin-api/src/erb-ext.ts` 的 `ErbDialectExtension` 是**扩展名**联合
 * （`'.erb' | '.erm' | '.erh'`），不是"可追加词表"的载体——契约层目前**没有**
 * 「adapter 往语言面追加词」这条通道。所以本表以**纯数据**导出：宿主要不要并进
 * `ERB_HIGHLIGHT_WORDS` 由组长决定（本批按任务书不碰 `packages/app`）。
 * 若将来开通道，形状应是"扩展名 → 追加词表"，届时把 {@link ERAFL_EXTRA_DIRECTIVES}
 * 原样交出去即可，本文件不需要改语义。
 */

import { ERB_BODY_PRIMARY_EXTENSION, type ErbDialectExtension } from '@kojo/plugin-api';

/**
 * eraFL 语料里**编辑器词表不认识、但确是引擎指令/函数**的词（129 条 = 差集 127 + 人工补录 2）。
 *
 * 每条注释 = `出现次数 · 一处出处 · 为什么判它是引擎侧`。
 * 判据统一（见文件头）：语句位 + 全语料无 `@` 定义。
 */
export const ERAFL_EXTRA_DIRECTIVES: readonly string[] = [
  // ── 变量声明 / 引擎核心语句 ───────────────────────────────────────────
  'VARI', // 1942 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:527 · `VARI MAP_IDX` 声明整型变量：Emuera 变量声明语句，宿主词表只收了 `DIM`/`DIMS`
  'VARS', // 1588 次 · EQUIP/EQUIP_MENU.ERB:71 · `VARS STRS` 声明字符串变量：同族语句（`DIM`/`DIMS` 的运行时对应物）
  'CVARSET', // 216 次 · HOUSING/HOUSING_MAIN.ERB:472 · `CVARSET TCVAR, GETNUM(...), 300` 按名写角色变量：引擎内建，无 `@` 定义
  'THROW', // 148 次 · EQUIP/_FUNCTION_ENCHANT.ERB:14 · 单独成句抛异常，与 `CATCH`/`ENDCATCH` 同族（后两者宿主已认）
  'RESTART', // 108 次 · EQUIP/_FUNCTION_CLOTH.ERB:339 · 单独成句重启游戏：引擎控制语句，语料零 `@RESTART`
  'ASSERT', // 1 次 · SYSTEM/FUNCTION/_FUNCTION.ERB:3818 · `ASSERT 0` 断言：引擎调试语句
  'DUMPRAND', // 4 次 · SYSTEM/NEWGAME.ERB:355 · 随机数状态转储：引擎调试语句
  'INITRAND', // 1 次 · SYSTEM/NEWGAME.ERB:100 · 随机数初始化：引擎语句
  'CALLSHARP', // 5 次 · SYSTEM/FL_TRAIN_DEBUG_MENU.ERB:79 · `CALLSHARP LAUNCH_BROWSER(...)` 调 .NET 方法：EmueraFL 的引擎扩展
  'SKIPDISP', // 12 次 · HOUSING/_FUNCTIONS/調教処理関連.ERB:676 · `SKIPDISP 1` 跳过显示：引擎语句
  'CURRENTREDRAW', // 9 次 · QUEST/COMMON_EVENT/QST_CEV_ROLL.ERB:58 · 当前行重绘：引擎语句（糖表已知英文名，但高亮词表没有）

  // ── 数据表 API（EmueraFL `DT_*`，本盘最重的一块） ──────────────────────
  'DT_ROW_ADD', // 1200 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:115 · `DT_ROW_ADD "GMAPDATA"` 加行：引擎数据表语句
  'DT_CELL_SET', // 193 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:122 · 按列名写单元格
  'DT_COLUMN_ADD', // 163 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:633 · `DT_COLUMN_ADD DB, "NODE_ID", "int16"` 加列（带类型）
  'DT_SELECT', // 140 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:73 · 空实参占位 `,,,` 也照常解析 ⇒ 引擎语句而非用户函数
  'DT_CREATE', // 35 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:632 · 建表
  'DT_CLEAR', // 26 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:567 · 清表
  'DT_ROW_REMOVE', // 25 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:150 · 删行
  'DT_RELEASE', // 17 次 · HOUSING/EDIT_MODE/HOUSING_EDIT_CRAFT_MENU.ERB:634 · 释放表
  'DT_CELL_GET', // 8 次 · EQUIP/EQUIP_OVERVIEW.ERB:61 · 按列名读单元格
  'DT_FROMXML', // 3 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:568 · 表 ← XML
  'DT_TOXML', // 1 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:407 · 表 → XML
  'DT_ROW_SET', // 1 次 · HOUSING/ITEM/CRAFT/HOUSING_ITEM_CRAFT.ERB:1095 · 整行赋值

  // ── XML API（EmueraFL `XML_*`） ────────────────────────────────────────
  'XML_GET', // 290 次 · EQUIP/EQUIP_MENU.ERB:404 · `XML_GET id, "//xpath", RESULTS` 取值：引擎 XML 语句
  'XML_DOCUMENT', // 25 次 · SHOP/SHOP_LIFE/SHOP_LIFE71_戦闘テスト.ERB:90 · 建文档
  'XML_RELEASE', // 11 次 · SHOP/SHOP_LIFE/SHOP_LIFE71_戦闘テスト.ERB:188 · 释放文档
  'XML_ADDATTRIBUTE', // 10 次 · SYSTEM/SHOW_INFO/SHOW_INFO_PORTRAIT_EDIT.ERB:1980 · 加属性
  'XML_ADDNODE', // 9 次 · SYSTEM/SHOW_INFO/SHOW_INFO_PORTRAIT_EDIT.ERB:2181 · 加节点
  'XML_REMOVENODE', // 3 次 · SYSTEM/SHOW_INFO/SHOW_INFO_PORTRAIT_EDIT.ERB:2142 · 删节点
  'XML_REMOVEATTRIBUTE', // 1 次 · SYSTEM/SHOW_INFO/SHOW_INFO_PORTRAIT_EDIT.ERB:1978 · 删属性
  'XML_REPLACE', // 1 次 · 口上/_KOJO_FLAG_MANAGE.ERB:43 · 节点替换
  'XML_SET', // 1 次 · SYSTEM/UI/CONTAINER/UI_CONTAINER_MAIN.ERB:115 · 节点赋值

  // ── 关联数组 API（EmueraFL `MAP_*`） ──────────────────────────────────
  'MAP_SET', // 146 次 · HOUSING/CHARA_ACT/行動定義/行動定義_演奏.ERB:47 · `MAP_SET MAP, "键", "值"`：引擎 map 语句
  'MAP_REMOVE', // 36 次 · HOUSING/EVENT/HOUSING_TRADE_SEDUCTION.ERB:25 · 删键
  'MAP_CREATE', // 32 次 · HOUSING/HOUSING_MAIN.ERB:294 · 建表
  'MAP_RELEASE', // 18 次 · HOUSING/HOUSING_MAIN.ERB:293 · 释放
  'MAP_CLEAR', // 16 次 · HOUSING/ITEM/CRAFT/HOUSING_ITEM_CRAFT.ERB:1341 · 清空
  'MAP_GETKEYS', // 8 次 · HOUSING/HOUSING_DRAW_MAP.ERB:553 · 取键集
  'MAP_SIZE', // 3 次 · HOUSING/HOUSING_DRAW_MAP.ERB:549 · 取尺寸
  'MAP_FROMXML', // 5 次 · SYSTEM/CHARA_TITLE/CHARA_TITLE.ERB:150 · map ← XML
  'MAP_TOXML', // 5 次 · SYSTEM/CHARA_TITLE/CHARA_TITLE.ERB:130 · map → XML

  // ── 图形 / 精灵 API（`G*` / `SPRITE*` / `CBG*`） ───────────────────────
  'GCREATE', // 27 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:37 · 建图形缓冲：引擎图形语句
  'SPRITECREATE', // 22 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:38 · 建精灵
  'GDISPOSE', // 17 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:277 · 释放图形
  'GSETBRUSH', // 14 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:43 · 设画刷
  'SPRITEDISPOSE', // 12 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:307 · 释放精灵
  'GDRAWSPRITE', // 11 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック合成.ERB:63 · 画精灵
  'GFILLRECTANGLE', // 9 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:45 · 填矩形
  'GSETFONT', // 8 次 · QUEST/COMMON_EVENT/QST_CARDGAME.ERB:649 · 设图形字体
  'GSETPEN', // 7 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:279 · 设画笔
  'GDRAWTEXT', // 6 次 · QUEST/COMMON_EVENT/QST_CARDGAME.ERB:682 · 画文本
  'GDRAWGWITHROTATE', // 3 次 · SYSTEM/IMAGE/画像関連.ERB:112 · 旋转画图形
  'GDRAWLINE', // 3 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:296 · 画线
  'GCLEAR', // 2 次 · SYSTEM/IMAGE/ポートレイト関連.ERB:199 · 清图形
  'SPRITEDISPOSEALL', // 2 次 · SYSTEM/NEWGAME.ERB:245 · 释放全部精灵
  'CBGREMOVERANGE', // 2 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック表示G.ERB:284 · 移除 z 区间
  'CBGSETSPRITE', // 2 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック表示G.ERB:107 · 设背景精灵
  'CBGCLEAR', // 1 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック表示G.ERB:282 · 清背景
  'CBGSETBMAPG', // 1 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック表示G.ERB:169 · 设背景图
  'CBGSETBUTTONSPRITE', // 1 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック表示G.ERB:235 · 设按钮精灵
  'CBGSETG', // 1 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック表示G.ERB:57 · 设背景图形
  'GLOAD', // 1 次 · SYSTEM/SHOW_INFO/SHOW_INFO_PORTRAIT_EDIT.ERB:2608 · 读图形文件
  'GSAVE', // 1 次 · SYSTEM/SHOW_INFO/SHOW_INFO_PORTRAIT_EDIT.ERB:2625 · 存图形文件
  'GWIDTH', // 1 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック生成.ERB:148 · 取宽
  'GHEIGHT', // 1 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック生成.ERB:150 · 取高
  'SETANIMETIMER', // 1 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック生成.ERB:356 · 设动画帧定时

  // ── 数组 API ──────────────────────────────────────────────────────────
  'ARRAYCOPY', // 145 次 · EQUIP/EQUIP_OVERVIEW.ERB:282 · 整数组拷贝：引擎语句，宿主只收了 `DIM`/`VARSET`
  'SPLIT', // 85 次 · DEBUGMENU/MAPEDITER/MAPEDIT.ERB:533 · `SPLIT src, "\n", out` 拆串入数组
  'ARRAYSHIFT', // 32 次 · HOUSING/HOUSING_DRAW_MAP.ERB:725 · 数组平移
  'ARRAYREMOVE', // 12 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック生成.ERB:211 · 按值删元素
  'ARRAYSORT', // 4 次 · SYSTEM/FUNCTION/_FUNCTION.ERB:479 · 排序
  'ARRAYMSORT', // 1 次 · TRAIN/COMF/COM_TEXT/COM_TEXT_AFTER_SUPPRESS_ORGASM.ERB:33 · 多键排序
  'ARRAYMSORTEX', // 3 次 · QUEST/QUEST_EVENT_FUNC.ERB:1610 · 多键排序（带数组键）
  'FINDELEMENT', // 6 次 · EQUIP/EQUIP_MENU.ERB:53 · 找元素（糖表已知，高亮词表缺）

  // ── 打印族 ────────────────────────────────────────────────────────────
  'DEBUGPRINTFORML', // 234 次 · DEBUGMENU/DEBUG.ERB:39 · 调试输出（带换行）：引擎调试族，宿主只认 PRINTFORML
  'PRINTPLAIN', // 92 次 · SHOP/SHOP_LIFE/SHOP_LIFE14_居住区_クラフト.ERB:34 · 原样输出（不解析 `%…%` 占位）
  'PRINTPLAINFORM', // 7 次 · SYSTEM/CONFIG/CONFIG.ERB:1242 · 原样输出 + 占位
  'PRINTS', // 6 次 · SYSTEM/FUNCTION/_FUNCTION_ASK_MULTI_ANNOTATION.ERB:122 · 输出字符串（PRINT 的 S 形态）
  'PRINTSL', // 1 次 · QUEST/クエストデータ/QUEST_16_アリーナ/QUEST_16_アリーナ.ERB:468 · 同族带换行
  'PRINTSW', // 1 次 · QUEST/クエストデータ/QUEST_16_アリーナ/QUEST_16_アリーナ.ERB:469 · 同族带等待
  'PRINT_RECT', // 6 次 · SYSTEM/COLORBAR.ERB:155 · 矩形区输出：EmueraFL 打印扩展
  'PRINT_IMG', // 1 次 · SYSTEM/LIBRARY/Function_TagSetText.ERB:881 · 输出图片标签：EmueraFL 打印扩展
  'PRINT_SPACE', // 3 次 · SYSTEM/FUNCTION/_FUNCTION_DESIGN.ERB:520 · 输出定宽空白
  'DEBUGPRINTFORM', // 5 次 · HOUSING/_FUNCTIONS/キャラ間交流制御.ERB:83 · 调试输出（占位）
  'DEBUGPRINTL', // 5 次 · SYSTEM/UPDATE.ERB:538 · 调试输出（换行）
  'REUSELASTLINE', // 11 次 · QUEST/クエストデータ/QUEST_46_トネリコの冒険.ERB:327 · 复用上一行重绘
  'CUSTOMDRAWLINE', // 8 次 · HOUSING/EDIT_MODE/HOUSING_EDIT_MODE.ERB:58 · 自定字符画分隔线

  // ── 输入 / 音频 / 存档 / 角色 ─────────────────────────────────────────
  'ONEINPUTS', // 14 次 · EQUIP/EQUIP_MENU.ERB:539 · 单字符输入：宿主收了 ONEINPUT，漏了 S 形态
  'BINPUT', // 8 次 · HOUSING/ITEM/HOUSING_ITEM_USING_COMMON_BASE_POINT_OPERATE.ERB:92 · 按钮输入
  'BINPUTS', // 5 次 · EQUIP/EQUIP_OVERVIEW.ERB:431 · 按钮输入（字符串）
  'SETBGMVOLUME', // 5 次 · SYSTEM/FL_SOUND.ERB:54 · 设 BGM 音量：EmueraFL 音频扩展
  'SETSOUNDVOLUME', // 2 次 · SYSTEM/FL_SOUND.ERB:25 · 设 SE 音量
  'PLAYBGM', // 1 次 · SYSTEM/FL_SOUND.ERB:58 · 播 BGM
  'PLAYSOUND', // 1 次 · SYSTEM/FL_SOUND.ERB:30 · 播音效
  'STOPBGM', // 2 次 · SYSTEM/FL_SOUND.ERB:100 · 停 BGM
  'STOPSOUND', // 2 次 · QUEST/クエストデータ/QUEST_61_ソラリスの牡牛/QUEST_61_ソラリスの牡牛.ERB:2981 · 停音效
  'CHKDATA', // 4 次 · SYSTEM/SAVELOAD.ERB:25 · 查存档槽：引擎存档族，宿主只收了 SAVEDATA/LOADDATA
  'COPYCHARA', // 1 次 · SYSTEM/NEWLOOP.ERB:1028 · 复制角色：引擎角色族，宿主收了 ADDCHARA/DELCHARA
  'DELALLCHARA', // 1 次 · SYSTEM/CUSTOM_CHARA/CUSTOM_CHARA.ERB:45 · 清空角色
  'ADDVOIDCHARA', // 3 次 · SYSTEM/FUNCTION/_FUNCTION.ERB:3864 · 加空角色
  'LOADCHARA', // 1 次 · SYSTEM/CUSTOM_CHARA/CUSTOM_CHARA_FUNCTION.ERB:54 · 读角色卡
  'SAVECHARA', // 1 次 · SYSTEM/CUSTOM_CHARA/CUSTOM_CHARA_FUNCTION.ERB:41 · 存角色卡
  'CHKCHARADATA', // 2 次 · SYSTEM/CUSTOM_CHARA/CUSTOM_CHARA.ERB:73 · 查角色数据
  'FIND_CHARADATA', // 1 次 · SYSTEM/CUSTOM_CHARA/CUSTOM_CHARA_FUNCTION.ERB:51 · 找角色数据

  // ── 字符串 / 数值 / 字体 / 颜色（引擎内建函数，语句位形态出现） ────────
  'TOINT', // 2 次 · TRAIN/PREGNANT/MOB_PREGNANT.ERB:170 · 串转整数：引擎内建（糖表已知，高亮词表缺）
  'ISNUMERIC', // 12 次 · EQUIP/_FUNCTION_WEAPON.ERB:396 · `ISNUMERIC <串>` 判数值：引擎内建
  'LIMIT', // 1 次 · QUEST/QUEST_EVENT_FUNC.ERB:1013 · `LIMIT v, 0, max` 限幅：引擎内建
  'POWER', // 2 次 · SYSTEM/IMAGE/画像関連.ERB:89 · `POWER 目标, 底, 幂` 乘方：引擎内建
  'STRFIND', // 3 次 · SYSTEM/FUNCTION/_FUNCTION.ERB:3344 · 找子串
  'SUBSTRING', // 2 次 · SYSTEM/FUNCTION/_FUNCTION.ERB:3347 · 取子串
  'SUBSTRINGU', // 2 次 · SYSTEM/CONFIG/CONFIG_HELP.ERB:255 · 取子串（Unicode）
  'VARSIZE', // 4 次 · SHOP/SHOP_LIFE/SHOP_LIFE46_人材を探す.ERB:442 · 取数组尺寸
  'REGEXPMATCH', // 2 次 · 口上/_KOJO_SYSTEM_EXTEND.ERB:800 · 正则匹配：EmueraFL 扩展
  'ENUMFUNCBEGINSWITH', // 1 次 · 口上/_FUNCTION_KOJO_DAILY.ERB:166 · 枚举前缀同名函数：引擎反射语句
  'CHKFONT', // 3 次 · HOUSING/HOUSING_MAIN.ERB:303 · 查字体可用性
  'GETFONT', // 2 次 · HOUSING/HOUSING_MAIN.ERB:302 · 取当前字体
  'SETFONT', // 11 次 · HOUSING/HOUSING_CHARA_DESCRIPTION.ERB:57 · 设字体（宿主只收了 FONTSIZE/FONTSTYLE）
  'GETCOLOR', // 4 次 · SYSTEM/FUNCTION/_FUNCTION.ERB:3292 · 取当前色
  'SETBGCOLOR', // 19 次 · QUEST/クエストデータ/QUEST_61_ソラリスの牡牛/QUEST_61_ソラリスの牡牛.ERB:2978 · 设背景色（宿主只收了 SETCOLOR）
  'SETTEXTBOX', // 4 次 · HOUSING/EDIT_MODE/HOUSING_EDIT_MODE.ERB:1199 · 写文本框变量：引擎语句

  // ── 提示框 API（EmueraFL `TOOLTIP_*`） ───────────────────────────────
  'TOOLTIP_CUSTOM', // 1 次 · TRAIN/TOOLTIP/TOOLTIP.ERB:2 · 自定义提示框：EmueraFL 引擎扩展
  'TOOLTIP_FORMAT', // 1 次 · TRAIN/TOOLTIP/TOOLTIP.ERB:9 · 设对齐
  'TOOLTIP_SETCOLOR', // 1 次 · TRAIN/TOOLTIP/TOOLTIP.ERB:4 · 设颜色
  'TOOLTIP_SETDELAY', // 1 次 · TRAIN/TOOLTIP/TOOLTIP.ERB:5 · 设延迟
  'TOOLTIP_SETDURATION', // 1 次 · TRAIN/TOOLTIP/TOOLTIP.ERB:6 · 设时长
  'TOOLTIP_SETFONT', // 1 次 · TRAIN/TOOLTIP/TOOLTIP.ERB:7 · 设字体
  'TOOLTIP_SETFONTSIZE', // 1 次 · TRAIN/TOOLTIP/TOOLTIP.ERB:8 · 设字号

  // ── 人工补录（扫描启发式误滤，复核后按同一判据收进来） ────────────────
  'SPRITEANIMEADDFRAME', // 2 次 · SYSTEM/LIBRARY/グラフィック表示ライブラリ/グラフィック生成.ERB:422 · 加动画帧：上一行以 `,` 收尾被误判成续行，实为语句位，全语料无 `@` 定义
  'DOTRAIN', // 1 次 · SYSTEM/FUNCTION/_FUNCTION.ERB:4925 · 执行调教：同上被续行判据误滤，实为语句位，全语料无 `@` 定义
];

/*
 * 本批**排除**的几类，写在这里免得下一个人再判一遍：
 *
 * - **业务函数（17,749 个 `@` 名，全部排除）**：`KOJO_*`（口上）/ `QST_*`（任务）/
 *   `HO_*`（住房）/ `COM_*`（调教指令）/ `CLOTH_*`（装备）/ `CREATE_MOB_*` 等，
 *   全是本工程自己 `@` 定义的函数。它们"编辑器不认识"是**正常**的——语言面不该装
 *   某个游戏的内容；它们归 adapter 的库表 / 函数索引，不归指令表。
 * - **变量左值**：`TEXT`（`#DIMS DYNAMIC TEXT` 声明）、`RESULTS`、`HTML`、`TEXTBOX`、
 *   `WEAPON_DID` 等——语料里以 `TEXT '= …` / `RESULTS = …` 出现，`'=` 是字符串赋值号；
 *   扫描按"词后紧跟 `=` `'` `:` 等即非语句"滤掉，故**不进表**（不是漏收）。
 * - **表达式调用形态**：`TEXT_CONCATE(` / `TEXT_CONCATEC(` / `GROUPMATCH(` / `MAX(` /
 *   `T_N(` 等行首带括号的调用，是**函数调用表达式**而非语句；它们属引擎/库函数名，
 *   但本表口径是"语句词"，且宿主已有系统函数表（`kojo-sugar/system-functions.ts`）
 *   负责函数名，故此处不收。
 * - **续行与字符串里的词**：多行实参表的后续行（`WEAPON_LIST_IDX` / `ACTOR_DID` /
 *   `REST_ITEM_STOCK` …）与多行字符串里的拉丁文（`ET POPVLI DVCI` / `ORBIS TERRAR` …）
 *   都不是语句；扫描按"上一行未收尾"与"引号奇偶"两把尺子滤掉。
 */


/**
 * eraFL 的 `.ERD` 要不要进语言面 —— **不进，故本表为空**。
 *
 * 结论依据是盘上**仅有的两份**样本（`ERB/EQUIP/` 下）：
 *
 * - `ERB/EQUIP/CC_TARGETING.ERD`：`0,無作為` / `1,高脅威` / … / `99,全体`，13 行；
 * - `ERB/EQUIP/EQUIP_MATERIAL_NAME_SHORT.ERD`：`0,木` / `1,銅` / … / `99,他`，10 行。
 *
 * 两份都是 **UTF-8 BOM + CRLF 的 `编号,名称[,注释]` 数据表**（第二份第 3 列还带
 * `;` 注释），与 `.csv` 同形、**零 `@` 定义、零语句**——它是引擎按编号查名的**数据**，
 * 不是脚本正文。引擎预载白名单确实收 `.erd`（`plugin-api/erb-ext.ts` 的
 * `ERB_ENGINE_RESERVED_EXTENSIONS` 已记这条事实），但"引擎会读"≠"该当脚本高亮"：
 * 把 CSV 塞进语言面，得到的只会是每行都被当 ERB 语句、每个数字都被当语法错误的噪声。
 *
 * 所以本盘的语言面追加扩展名 = **0 个**（`.ERB` / `.ERH` 宿主已认，见
 * `ERB_DIALECT_EXTENSIONS`）。将来若某盘出现**脚本形态**的 `.ERD`（含 `@` 或语句），
 * 判据是"打开看形态"，不是"改这一行"。
 */
export const ERAFL_ERD_EXTENSIONS: readonly string[] = [];

/**
 * eraFL 的 ERB 方言扩展名。
 *
 * **为什么返回的是一个扩展名字符串而不是词表**：契约层
 * `packages/plugin-api/src/erb-ext.ts` 的 `ErbDialectExtension` 就是
 * `'.erb' | '.erm' | '.erh'` 这个**扩展名**联合类型，没有任何"追加词表"的字段
 * （本批照真实类型实现，不臆造形状）。本盘正文 2,016 份全是 `.ERB`、声明 112 份
 * 全是 `.ERH`，两者都已在 `ERB_DIALECT_EXTENSIONS` 内 ⇒ **adapter 侧新增注册为 0**，
 * 这里如实回报正文类扩展名 `.erb`。
 *
 * 词表那一半以纯数据形式由 {@link ERAFL_EXTRA_DIRECTIVES} 导出：宿主若开通道，
 * 直接消费它；没开之前不接线（本批不碰 `packages/app`）。
 */
export function createEraflErbDialectExtension(): ErbDialectExtension {
  // 取单一真源的常量，不写字面量：另立一份就会被 erb-ext 的副本闸判红
  return ERB_BODY_PRIMARY_EXTENSION;
}
