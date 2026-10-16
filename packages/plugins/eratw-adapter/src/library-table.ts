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
 * `ASK_YN` 1,771 · `HE_SHE_CN` 1,700 …（首批取高频头部约 55 条，边角长尾不收）。
 *
 * **ZH-2① 扩容批**（2026-10-16）= 同一判据下的长尾清扫：普查口径改由
 * `tests/library-coverage.corpus.test.ts` 独占定义并可复跑（表达式词元口径 =
 * `lowerSystemFunctions` 的扫描语义：跳过字符串字面量与 `;` 注释、取最大标识符整词、
 * 名字后随 `(`；行首词元与 `CALLFORM`/`TRYCALLFORM` 动态调用不计，纯中文名不需别名亦不计，
 *  callee 在 `個人口上` 内有 `@` 定义者视为作者私有 ⇒ 排除）。该口径下语料外部函数调用点
 * 约 5.3 万（基础库 4.6 万 + 引擎内建 0.7 万），本批按同一证据形态（各函数在基础库里的
 * `;概　要` 注释）补 83 条（表 55 → 138），覆盖率读数与闸阈值见该测试文件头注。
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

  // ================== ZH-2① 扩容批（语料普查长尾，2026-10-16） ==================
  // 每条 = 该函数在基础库里的 `;概　要 / 说明` 注释口径 + 语料调用点次数（注释即证据，
  // 见各条行尾；次数取 `tests/library-coverage.corpus.test.ts` 同一口径的普查读数）。

  // ---- 意识 / 状态判定族 ----
  ['意识清醒', 'SHIRAHU'], // COMMON.ERB「普通に意識がある状態か　2だとウフフ中」(406)
  ['是否陷落', 'IS_FALLEN'], // COMMON.ERB「思慕/恋慕/セフレ/愛欲 任一为真」(81)
  ['是否发情', 'IN_HEAT'], // COMMON.ERB「媚薬中または発情中なら 1」(25)
  ['自认处女', 'THINKS_IS_VIRGIN'], // COMMON.ERB「自己仍视自身为处女」(21)
  ['是女性', 'IS_FEMALE'], // COMMON.ERB「RETURNF !IS_MALE」(27)
  ['是否同性', 'HETEROSEX'], // COMMON.ERB「ARG と ARG:1 の性別が同じかどうか」(66)
  ['是否同处', 'IS_HERE'], // COMMON.ERB「渡した角色が全て MASTER と同地点か」(88)
  ['是否在家', 'AT_HOME'], // COMMON2.ERB「在宅判定：角色 ARG が拠点にいるか」(74)
  ['是否据点内', 'IN_HOME'], // COMMON2.ERB「拠点判定：場所 ARG が拠点の中か」(102)
  ['外出路人判定', 'DATE_HITOGOMI'], // MOB.ERB「お出かけ時の路人判定」(101)
  ['家中有路人', 'WITH_MOB'], // MOB.ERB「MASTER が在宅中かつ路人と同じ位置なら MAIN_MAP」(116)
  ['是否一般依頼', 'IS_COMMON_IRAI'], // FUNC_IRAI.ERB「依頼が一般依頼か固有依頼か」(63)
  ['是否所选指令', 'IS_SELECTCOM'], // COMMON.ERB「ARGS が現在の SELECTCOM と一致するか」(55)
  ['可显示裸像', 'CHECK_NUDE'], // IMAGE.ERB「裸表示条件を返却する」(21)
  ['不能弹幕战', 'CANNOT_DANMAKU'], // 一般依頼12「依頼での弾幕勝負ができない場合は真」(288)
  ['困倦度', 'NEMUKE'], // COMMON.ERB 起床時刻差（眠気）を返す (23)
  ['是否休日', 'CHARA_HOLIDAY'], // JOB_仕事内容.ERB「RETURN 0:仕事日, 1:休日」(23)
  ['已历事件', 'CEVENT'], // MISC.ERB「キャラクターごとの各種イベントの記録を参照」(23)
  ['湿透判定', 'SOAKED_OR_NOT'], // AFTER_AFFAIR.ERB「びしょ濡れ判定用式中関数」(37)

  // ---- 描写 / 文本族（文中函数） ----
  ['乳头描述', 'NIPPLE_DESCRIPTION'], // EVENT_MESSAGE.ERB 乳头の地の文（ARG:1 で形容詞付与）(154)
  ['精液描述', 'SAMEN_DESCRIPTION'], // EVENT_MESSAGE.ERB 精液の地の文（文中函数）(144)
  ['秘裂描述', 'SLIT'], // EVENT_MESSAGE.ERB「概　要:秘裂の地の文」(149)
  ['裙内描述', 'UNDER_SKIRT_DESCRIPTION'], // EVENT_MESSAGE.ERB「概　要:裙子の中の描写」(62)
  ['臀部描述', 'HIP'], // EVENT_MESSAGE.ERB 臀部の地の文（文中函数）(103)
  ['大腿描述', 'THIGHS'], // EVENT_MESSAGE.ERB「太ももは英语で THIGHS と言うらしい」(26)
  ['内裤描述', 'PANTS_DESCRIPTION'], // PANTS.ERB 下半身内衣「描写」字段取值 (27)
  ['路人描写', 'DATE_HITOGOMI_MESSAGE'], // EVENT_MESSAGE_COM_セクハラ.ERB「外出先路人描写」(40)
  ['痛吟', 'GROAN'], // SYNONYMS.ERB「Generator for groans of pain」(24)
  ['同义文本', 'FSYN'], // SYNONYMS.ERB「synonyms that can be randomized」(61)
  ['拖长音', 'SLUR'], // MISC.ERB「simply continue last letter of the word」(58)
  ['条件文本', 'COND_STR'], // COMMON.ERB 条件成立时回原样文本（免写 `\@…%\@`）(71)
  ['过场台词', 'CUTSCENESPEAK'], // MISC.ERB 过场 SPTALK 封装（匹配原版表情关键字）(47)
  ['暂现提示', 'DQPRINT'], // TUTORIAL.ERB「ARGS で括った文字列を クリックしたら消える」(51)
  ['彩虹打印行', 'PRINT_RAINBOW2L'], // RAINBOW系_from_eratohoЯeverse：PRINT_RAINBOW2 + PRINTL (20)

  // ---- 名称 / 查询族 ----
  ['宠物名', 'ANIMALNAME'], // MOB.ERB「ペットの名前」(109)
  ['素质名', 'GET_TALENTNAME'], // PRINT_TALENTNAME.ERB「返回素质的名称」(45)
  ['礼物名', 'GIFTNAME'], // 贈り物.ERB「贈り物の名前を出力する関数」(23)
  ['鱼名', 'FISH_NAME'], // COMF621 釣りをする.ERB「釣った魚のナンバーを名称に変換」(47)
  ['物品名翻译', 'ITEMNAME_TR'], // TRANSLATION/CSV.ERB ITEMNAME 的 CSV 翻译查表 (48)
  ['地点名', 'NAME_FROM_PLACE'], // PLACE_拠点別分岐.ERB「場所IDの名前文字列を返す」(22)
  ['取地图名', 'GET_MAPNAME'], // PLACE_拠点別分岐.ERB MAPID → 地图名 (20)
  ['取替换地图编号', 'GET_MAP_REPLACEMENT'], //「拠点の場所IDをお出かけMap上の場所IDに置換」(66)
  ['取自宅位置', 'GET_CHARAHOME'], // COMMON.ERB「自宅位置取得関数」(106)
  ['约会去处名', 'DATENAME_PLACE'], // DATE_CMN.ERB「RETURN デート先名」(147)
  ['约会地点名', 'DATENAME_SPOT'], // DATE_CMN.ERB「约会地点名取得関数」(25)
  ['约会道中', 'ROAD_TO'], // PLACE_拠点共通.ERB「约会道中」房间号 (23)
  ['待客室', 'OMANEKIBEYA'], // PLACE_拠点共通.ERB「待客室」房间号 (108)
  ['据点浴室', 'BATHROOM'], // PLACE_拠点共通.ERB「こっちは拠点内の風呂だけ」(146)
  ['有被窝', 'BEDROOM'], // PLACE_拠点共通.ERB「被窝がある部屋」(53)
  ['开阔处', 'OPENPLACE'], // PLACE_拠点共通.ERB「開阔处の良い場所 1=室内 2=野外」(50)
  ['逐出移动', 'GETOUT'], // COMMON.ERB「現在地点から移動可能な場所へ移動」(21)
  ['显示子女名', 'SHOW_CHILDNAME'], // 出産経過.ERB「現在育児中の兒童の名前を表示」(119)
  ['查出轨记录', 'GET_UWAKI_HISTORY'], // 情事発覚.ERB 浮气相手公認/認知的历史 (84)
  ['记录出轨', 'UWAKI_RECORD'], // 情事発覚.ERB 浮气记录写入 (30)
  ['行事名', 'FESTIVAL'], // 祭日イベント.ERB「行事を表す文字列を取得する関数」(155)
  ['月名', 'GET_MONTH'], // 日時天候管理.ERB「季節名取得」（无之月/春之月…）(57)
  ['月相', 'MOON_WATCH'], // MOON_WATCH.ERB「どんな月が見えるかを返す関数」(21)
  ['月相名', 'NAME_MOON'], // MOON_WATCH.ERB 朔月/三日月/望月… 名称表 (31)
  ['可望月', 'MOON_WATCH_POINT'], // PLACE_拠点共通.ERB「赏月ポイント 1=月が見える」(26)
  ['时钟转时刻', 'CLOCK_TO_TIME'], // COMMON.ERB「時刻変換(HOUR, MINUTE)」→ TIME (21)
  ['依頼文本', 'STR_DATA_IRAI'], // FUNC_IRAI.ERB 一般/固有依頼の文字列データ取得 (172)
  ['依頼号转委托人', 'IRAI_ID_TO_CLIENT'], // FUNC_IRAI.ERB「依頼ID→依頼者」(69)
  ['恋人计数', 'LOVER_COUNT'], // COMMON.ERB「Counts the number of lovers the player has」(24)

  // ---- 演出 / 打印族 ----
  ['色彩映射', 'COLOR'], // COLOR.ERB「旧的色彩映射，仅作为兼容性保留」(196)
  ['着色打印', 'PRINTCOLOR'], // PANIMATION.ERB「指定した文字色で文字列を表示します」(22)
  ['着色打印行', 'PRINTCOLORL'], // PANIMATION.ERB = PRINTCOLOR + 换行 (47)
  ['显示动画图片', 'PRINT_IMAGE_ANIMATION'], // ANIMATION.ERB 连幅动画插画 (34)
  ['打印日期', 'PRINT_DATE_F'], // COMMON.ERB 打印「第 N 年 X 月 Y 日（曜日）」(80)
  ['早安问候', 'MESSAGE_GOODMONING'], // BEFORETRAIN.ERB「早安通用问候」(85)
  ['评级打印', 'PRINT_RANK'], // COMMON.ERB「ステータス評価表示関数」（字母评级）(22)
  ['询问战斗', 'ASK_BATTLE'], // BATTLE.ERB 方向键限时询问 (56)
  ['询问记日记', 'ASK_DIARY'], // CHARA_DIARY.ERB「这件事要记进日记吗」(20)

  // ---- 数值 / 变动族 ----
  ['经验变动检查', 'EXP_UP'], // COMMON.ERB「概　要:経験値変動チェック」(98)
  ['按比例恢复', 'RECOVER_PERMIL'], // COMMON.ERB 以 MAXBASE 千分比回复 BASE (20)
  ['加特殊宝珠', 'JUEL_UP_SPECIAL'], // ABLUP.ERB「特殊なイベントで珠を増やすための関数」(59)
  ['触怒处理', 'GET_ANGRY'], // COMMON.ERB「イベントなどでキレた場合の処理」(41)
  ['当前衣装套', 'CURRENT_CLOTHES_SET'], // CHECK_CLO.ERB 当前衣装セット番号 (59)
  ['洗牌数组', 'FISHER_YATES_SHAFFLE'], // COMMON.ERB「Fisher-Yates アルゴリズムによるシャッフル配列」(25)
  ['英文断行', 'BREAKENG'], // STYLE_EFFECTS.ERB 按行宽插换行（英文字距用）(63)
  ['味觉反应', 'TASTE_REACTION'], // COMF414 食事を取る.ERB「刺激的味覚関数」(54)
  ['藏书地判定', 'IS_LIBRARY'], // COMF436 読書.ERB「蔵書閲覧判定・改」（返回可阅览的 PLACE_ID）(97)
  ['湿透胖次判定', 'PANTIES_TRANSPARENCY'], // PANTS.ERB「濡れて透けうる胖次を穿いてるか判定用式中関数」(26)
  ['浴室逐出地', 'KICKOUT'], // PLACE_拠点共通.ERB「風呂から追い出された時の逐出先」(19)
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
