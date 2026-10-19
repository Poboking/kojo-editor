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
 * **ADICT-1 全覆盖批**（2026-10-19）= 把同一普查口径下**剩余的全部基础库档名字**收完
 * （320 名 / 1,563 调用点）：基础库档覆盖 100%，合并覆盖 99.98%（引擎档只剩 6 个
 * 无法可靠判义的名字，未收录）。长尾条目命名以定义处注释为证据，见各条行尾；
 * 阈值随之抬到 `library-coverage.corpus.test.ts` 头注的新读数。
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

  // ================== ZH-D1 收录批（基础库里**本来就用中文/日文命名**的高频函数） ==================
  // **形状说明**（这批与全表不同：`中文名 === 原生名`，是**恒等条目**）。
  // 游戏基础库里有一批函数名本身就是中文/日文（`@充填率` / `@金額表示` …），作者写它们时
  // 不需要"改名"，但**仍然需要被表认下来**——否则糖层判它们"表外名"，`function-name-unknown`
  // 就在真语料里刷出上千条假告警（实测 1,396 处表外调用点里这批占 857 处），
  // 于是"名字拼错"这条真信号被噪声埋掉，ZH-D1 的分级升档也就失去可依赖的告警面。
  // ⇒ 收录判据不变（基础库里 `@` 定义的高频助手），只是 `中文名` 直接取盘上的原生名；
  // 恒等条目对产物**零影响**（`lowerSystemFunctions` 换成同名 ⇒ 逐字节相同）。
  // 每条证据 = 基础库定义文件（`個人口上` 之外）+ 同一口径的语料调用点次数。
  ['充填率', '充填率'], // ERB/ステータス表示関連/Look.ERB (566)
  ['SHOW_下半身内衣', 'SHOW_下半身内衣'], // ERB/衣服/CLOTHES.ERB (61)
  ['金額表示', '金額表示'], // ERB/COMMON.ERB (51)
  ['仕事中チェック', '仕事中チェック'], // ERB/MOVEMENTS/MOVEMENT_SUB.ERB (44)
  ['素質計算', '素質計算'], // ERB/ステータス計算関連/COUNTER/COUNTER_MESSAGE.ERB (42)
  ['抱き寄せ', '抱き寄せ'], // ERB/ステータス計算関連/ATTITUDE.ERB (26)
  ['画像セット', '画像セット'], // ERB/グラフィック表示ライブラリ/グラフィック表示.ERB (26)
  ['睡眠時間', '睡眠時間'], // ERB/COMMON.ERB (24)
  ['妊娠可否', '妊娠可否'], // ERB/イベント関連/妊娠関連/HININSHITE.ERB (9)
  ['宴会場表示', '宴会場表示'], // ERB/イベント関連/宴会.ERB (8)
  // ↑ **这批会自造"一字之差的双生真函数"**：`SHOW_下半身内衣`↔`SHOW_上半身内衣`、
  // `仕事中チェック`↔`仕事日チェック`、`金額表示`↔`金额表示`（盘上各自有 `@` 定义，都是合法函数），
  // 语料里还有 `脱衣处理`↔`脱衣処理`、`挿入不可`↔`插入不可`、`SOURCE_快Ｍ`↔`SOURCE_快Ｖ` 等同款。
  // ⇒ 糖层的拼错升档判据（ZH-D1 `system-functions.ts::suggestFunctionName`）**只拿别名条目当候选**，
  // 恒等条目一律不作"你该改成它"的建议——否则合法的 `SHOW_上半身内衣(…)` 会被判成拼错并打死整棵口上。
  // 下面三条按同一判据补录（基础库 `@` 定义 + 盘上调用点次数），既降噪也让近名对在表内成对齐全。
  ['SHOW_上半身内衣', 'SHOW_上半身内衣'], // ERB/衣服/CLOTHES.ERB (11)
  ['仕事日チェック', '仕事日チェック'], // ERB/MOVEMENTS/MOVEMENT_SUB.ERB (1)
  ['金额表示', '金额表示'], // ERB/COMMON.ERB（与 `金額表示` 是**两枚**不同函数）(1)

  // ================== ADICT-1 全覆盖批（2026-10-19） ==================
  // 判据不变（基础库 `@` 定义的高频助手）；本批把语料普查里**全部剩余的基础库档调用点**
  // 一次收完：320 个名字、1,563 处调用（`tests/library-coverage.corpus.test.ts` 同一口径）。
  // 命名以定义处的 `;概　要` / 函数体为准（证据见各条行尾注释）；数字后缀函数（SPEVENT /
  // MAP_SEARCH_REPLACEMENT / KOJO_*）按序数直译。收录后基础库档覆盖 100%，长尾里只剩
  // 引擎内建档的个别名字（后者住 kojo-sugar 的系统表）。

  // ---- 演出 / 打印 / 文本族 ----
  ['着色打印宽', 'PRINTCOLORW'], // PRINTCOLOR 的 W 变体（CALL PRINTCOLOR(..., 2)）
  ['三点省略', 'TRIPLEDOT'], // 逐点打印"..."（可反向 / 带等待）
  ['彩虹打印宽', 'PRINT_RAINBOW2W'], // RAINBOW2 的 W 变体
  ['网页打印行', 'HTMLPRINTL'], // HTML 系打印 + 换行
  ['成组打印', 'PRINT_GROUP'], // 数组元素顺序显示
  ['彩色片段', 'PRINT_COLOR'], // 同一行内分段着色
  ['逐字键入', 'KEYTYPING'], // 逐字显示（可检测按键跳过）
  ['震动屏幕', 'QUAKE'], // 屏幕上下抖动
  ['全屏切入', 'FULLCUTIN'], // 清屏后全屏切入图
  ['淡出', 'FADEOUT'], // 文字淡出到背景色
  ['淡入淡出', 'FADE'], // FADE 系公共流程
  ['淡出删行', 'FADE_CLINE'], // FADE 后删除若干行
  ['动画背景过渡', 'ANIMATION_BGCOLOR_TRANSITION'], // 背景色平滑过渡
  ['覆盖显示图', 'PRINT_IMAGE_OVERRAP'], // 覆盖式图片显示
  ['过渡动画图', 'PRINT_IMAGE_TRANSANIMATION'], // 多帧过渡动画
  ['显示自慰图', 'PRINTONANISMIMAGE'], // AFTERTRA 自慰图
  ['图文对话', 'IMG_TALK'], // SPTALK 与立绘融合
  ['单空行', 'SINGLE_EMPTY_LINE'], // 末尾只留一个空行
  ['最大宽度', 'MAXWIDTH'], // 行宽定义
  ['首字母大写', 'CAPITALIZE'], // 首字母大写化
  ['首字母处理', 'CAP_PROCESS'], // handle capitalization
  ['序数', 'ORDINAL'], // 1st/2nd/3rd…
  ['文本转网页', 'CONVERT_STR_TO_HTML'], // @PRINT_STR 语法转 HTML

  // ---- 判定 / 查询族 ----
  ['显示上装', 'SHOW_TOP'], // TEQUIP:1 对应最上层衣装名
  ['显示厘米尺', 'SHOWSCALEINCM'], // 厘米刻度显示
  ['是处女', 'IS_VIRGIN'], // 处女判定
  ['是童贞', 'IS_DOUTEI'], // 童贞判定
  ['主角是处女', 'MASTER_IS_VIRGIN'], // 主角适用处女判定
  ['是同性', 'IS_SAMESEX'], // 两角色同性判定
  ['是儿童', 'IS_CHILD'], // 身心幼小判定
  ['是智者', 'IS_WISEMAN'], // 学习系判定
  ['是愤怒', 'IS_ANGRY'], // 愤怒 / 憎恶标记
  ['是兔女郎', 'IS_BUNNY'], // 兔耳装扮判定
  ['是吸血鬼', 'IS_VAMPIRE'], // 种族素质判定
  ['是双性', 'IS_FUTA'], // 双性判定
  ['是勃起', 'IS_ERECT'], // 勃起度判定
  ['是平日', 'IS_WEEKDAY'], // 周一至周五
  ['是周末', 'IS_WEEKEND'], // 周六日
  ['是发情期', 'IsHeat'], // TCVAR 发情 / 发情周期
  ['是花园有效', 'IsGardenValid'], // 花园设置有效判定
  ['是香有效', 'IsInsenceValid'], // 香的有效判定
  ['无雨', 'IS_NO_RAIN'], // 区域无雨判定
  ['是活动时段', 'VISIT'], // 活动时间带判定
  ['在工作时段', 'WORKING'], // 工作时段判定
  ['在建筑内', 'IS_IN_BUILDING'], // 建筑内判定
  ['在厕所', 'IN_TOILET'], // 厕所有无判定
  ['在区域', 'AT_AREA'], // 角色所在区域
  ['可见', 'CAN_SEE'], // 角色是否在视野内
  ['可移动', 'CAN_MOVE'], // 移动可行性
  ['可演奏', 'MUSIC_ABLE'], // 乐器 / 地点可演奏
  ['可伴奏', 'ACCOMPANY_ABLE'], // 伴奏可行性
  ['可搭讪', 'CAN_NANPA'], // 搭讪可行性
  ['他人在场', 'HITOKE'], // 其他房间 / 同室人数判定
  ['目击判定', 'EYEWITNESS'], // 有人看着 / 路人看着
  ['忍耐判定', 'ENDURE'], // 忍耐系判定

  // ---- 时间 / 地点 / 天气族 ----
  ['时段判定', 'BETWEENTIME'], // TIME 是否落在区间
  ['所需时间', 'TIME_REQUIRED'], // 出挂地所需时间
  ['取天气', 'GET_WEATHER'], // 当前天气
  ['取星期', 'GET_DAY'], // 日/月/火…字符串
  ['星期中文', 'GET_DAY_CN'], // 星期中文名
  ['取地点名', 'GET_PLACENAME'], // PLACE_ID → 名称
  ['取地图区域', 'MAP_AREASELECT'], // MAPID → 区域号
  ['取出入口', 'GET_ENTRANCE'], // 据点出入口地点
  ['地图替换零', 'MAP_SEARCH_REPLACEMENT_0'],
  ['地图替换一', 'MAP_SEARCH_REPLACEMENT_1'],
  ['地图替换二', 'MAP_SEARCH_REPLACEMENT_2'],
  ['地图替换三', 'MAP_SEARCH_REPLACEMENT_3'],
  ['地图替换四', 'MAP_SEARCH_REPLACEMENT_4'],
  ['地图替换五', 'MAP_SEARCH_REPLACEMENT_5'],
  ['地图替换六', 'MAP_SEARCH_REPLACEMENT_6'],
  ['地图替换七', 'MAP_SEARCH_REPLACEMENT_7'],
  ['地图替换八', 'MAP_SEARCH_REPLACEMENT_8'],
  ['地图替换九', 'MAP_SEARCH_REPLACEMENT_9'],
  ['地图替换十', 'MAP_SEARCH_REPLACEMENT_10'],
  ['隙间', 'SUKIMA'], // 无处可去角色的收容地点
  ['进入待客室', 'OMANEKI_ENTER'], // 外泊 / 待客室处理
  ['钱汤地点', 'PLACE_SENTO'], // 钱汤房间号
  ['房间人数', 'IN_ROOM_NUMBER'], // 房内人数
  ['房间成员', 'IN_ROOM_MEMBER'], // 房内变量成员
  ['妖怪历日期', 'PRINT_DATE_F_YOUKAI'], // 妖怪历日期打印
  ['妖怪历季节', 'PRINT_DATE_F_YOUKAI_SEASON'], // 妖怪历季节打印
  ['西方年份', 'EHOU_DIRECTION'], // TW 内西历换算
  ['季节事件', 'SEASONAL'], // 祭日 / 季节事件
  ['热雷判定', 'GET_HEAT_THUNDERSTORM'], // 热雷发生
  ['界雷判定', 'GET_FRONTAL_THUNDERSTORM'], // 界雷发生

  // ---- 衣服 / 装备族 ----
  ['取衣装编号', 'CLOTHES_ID'], // 部位 + 名 → 类内 ID
  ['衣装名', 'CLOTHNAME'], // EQUIP 衣装名
  ['衣装翻译', 'CLOTHES_TR'], // 衣装名 CSV 翻译
  ['衣装调教设置', 'CLOTHES_SETTING_TRAIN'], // EQUIP → TEQUIP
  ['控制衣装套', 'CTRL_CLOTHES_SET'], // 衣装套保存 / 复原
  ['临时换装', 'OKIGAE'], // 临时更衣
  ['取得内裤', 'PANTS_GET'], // 脱下 / 收取内裤
  ['内裤已收集', 'PANTS_ALREADY_COLLECTED'], // 收藏状态
  ['透隙内裤', 'PANTS_SUKIMA'], // 隙间透出判定
  ['脱裤', 'DATUI_BOTTOM'], // 下半身脱衣
  ['脱裤后', 'DATUI_BOTTOM_LATE'], // 下半身脱衣后处理
  ['对象脱裤', 'DATUI_BOTTOM_T'], // 对象下半身脱衣
  ['脱上衣后', 'DATUI_TOP_LATE'], // 上半身脱衣后处理
  ['对象脱上衣后', 'DATUI_TOP_T_LATE'], // 对象上半身脱衣后处理
  ['脱鞋', 'DATUI_SHOES'], // 靴 / 袜子
  ['装备检查', 'EQUIP_CHECK'], // 常驻道具检查
  ['吸乳装备处理', 'EQUIP_COM11'], // 指令 11 装备延续
  ['揉胸装备处理', 'EQUIP_COM12'], // 指令 12 装备延续
  ['接吻装备处理', 'EQUIP_COM19'], // 指令 19 装备延续
  ['裸体检查', 'NUDITYCHECK'], // 差分图像用
  ['检查汗', 'CHECK_SWEAT'], // 汗差分条件
  ['影狼水手服', 'K63_WEAR_SAILOR'], // K63 角色专用
  ['取胸围档', 'GET_BUSTSIZE'], // 胸围数值档
  ['胸围转文本', 'TOSTR_BUSTSIZE_ATW'], // 胸围描述文本
  ['取基础样式', 'GET_BASESTYLE'], // 表示形式
  ['取基础样式译', 'GET_BASESTYLE_TRANS'], // 表示形式（翻译版）
  ['取基础资源', 'GET_BASE_RESOURCE'], // 立绘资源选择
  ['取基础资源译', 'GET_BASE_RESOURCE_TRANS'], // 资源选择（翻译版）
  ['取特效资源', 'GET_EFFECT_RESOURCE'], // 特效资源数量
  ['角色图覆盖', 'IMAGE_CHARA_OVERRIDE'], // 立绘覆盖
  ['资源索引检查', 'RM_RESOURCECHECK'], // 精灵索引存在性
  ['精灵宽度', 'RM_SPRITEWIDTH'], // 精灵宽度

  // ---- 状态 / 数值 / 事件族 ----
  ['加经验编号', 'ADDEXP_D'], // AddEXP 的编号参数版
  ['有序加经验', 'ADDEXPORDERED'], // 带排序 / 消息形态
  ['加百合经验', 'ADD_EXP_LESNIAN'], // 同性经验追加
  ['经验获得检查', 'EXP_GOT_CHECK'], // 经验获得后处理
  ['经验翻译', 'EXP_TR'], // 经验名 CSV 翻译
  ['设置能力与经验', 'SET_ABL_AND_XP'], // ABL + 最低经验
  ['变动能力', 'CHANGEABL'], // ABL 增减
  ['快感经验值', 'SOURCE_EXP'], // SOURCE 经验处理
  ['快感修正一', 'SOURCE_REVISION1'], // 快感 ABL 补正 /10
  ['快感修正二', 'SOURCE_REVISION2'], // 欲望 ABL 补正 /100
  ['快感额外', 'SOURCE_EXTRA'], // SOURCE 额外处理
  ['快感额外修正', 'SOURCE_CVAB_EXTRA'], // CVAB 额外修正
  ['快感基础下降', 'SOURCE_DOWNBASE'], // BASE 下降
  ['性交源检查', 'SOURCE_SEX_CHECK'], // SOURCE 性交判定
  ['绝顶追加', 'ORGASM_ADD'], // 绝顶处理
  ['绝顶计数', 'ORGASM_COUNT'], // 本次性交绝顶次数
  ['同时绝顶', 'SYNCED_ORGASM'], // 同时绝顶判定
  ['对象喷乳检查', 'TARGET_MILK_CHECK'], // 喷乳处理
  ['送入子宫', 'SAMEN_SHOOT3'], // 精子送入
  ['射精阴道处理', 'ADD_SAMEN_V'], // 指令外 V 射精
  ['射精肛门处理', 'ADD_SAMEN_A'], // 指令外 A 射精
  ['失去处女', 'LOST_VIRGIN'], // 丧失处女处理
  ['记录阴道丧失', 'SET_HISTORY_LOST_V'], // 历史记录（V）
  ['记录肛门丧失', 'SET_HISTORY_LOST_A'], // 历史记录（A）
  ['记录角色事件', 'SET_CEVENT'], // cEvent 记录
  ['当前魅力', 'CHARISMA_NOW'], // 当前魅力值
  ['取渐近值', 'GET_REVISION'], // 渐近上限换算
  ['按百分比乘', 'MULTIPLY'], // A * B / 100
  ['按百分比除', 'DIVIDE'], // A * 100 / B
  ['取百分比', 'GETPERCENT'], // GvT 百分比
  ['百分比判定', 'PERCENT'], // 概率判定
  ['取成功率', 'GET_SUCCESS_RATE'], // 成功率
  ['三噪声', 'NOISE3'], // 三噪声平均（正态近似）
  ['数组抽取', 'ARRAY_HIT'], // 配列抽選
  ['表现变体', 'EXPR_VAR'], // 表现变体用式中函数
  ['取方法整数', 'GETMETH_INT'], // qol OBJ 方法取整数
  ['费雪耶茨洗牌', 'FUNC_FISHER_YATES_SHAFFLE'], // Fisher-Yates 洗牌
  ['设置睡眠', 'SET_SLEEP'], // 睡眠中标记
  ['设置同寝', 'SET_TOGETHER'], // 添寝标记
  ['设置避孕', 'SET_HININ'], // 避妊设置
  ['设置双性', 'SET_FUTANARI'], // 双性设置
  ['醉态', 'DRUNKEN'], // 醉酒状态
  ['醉度判定', 'IS_DRUNK'], // 0–3 醉度
  ['醉复前处理', 'DRUNK_RECOVER_BEFORE'], // 烂醉复活前处理
  ['心情变化', 'KIGEN_CHANGE'], // 機嫌 变动
  ['吃菜反应', 'MESSAGE_EAT_DISH_DRG'], // 仕込み料理反应
  ['多胎意识', 'BABYMULTIAWARE'], // 多胎妊娠意识
  ['总受孕数', 'TOTAL_CONCEPTION_COUNT'], // 受孕总数
  ['发情分类', 'ESTRUS_CATEGORY'], // 生理周期文字
  ['拜倒事件', 'OGAMITAOSHI'], // 拝み倒し 怀孕事件
  ['显示爱意', 'SHOW_LOVEPOWER'], // 爱意显示
  ['情事暴露', 'AFFAIR_DISCLOSURE'], // 情事発覚
  ['宣示妖怪', 'REVEAL_YOUKAI'], // 妖怪现身
  ['静默调试', 'CALMME'], // debug 静默
  ['进入约会', 'DATEME'], // debug 强制约会
  ['格式版本', 'FORMAT_VERSION'], // major.minor.patch
  ['变量或默认', 'VAR_OR_DEFAULT'], // 变量为空取默认
  ['单段分割', 'SPLIT_SINGLE'], // 取分割后的指定段
  ['分割带尾', 'SPLIT_M'], // 带占位符的分割
  ['串重复计数', 'STR_MULTI_COUNT'], // 子串重复次数
  ['字典写入', 'DIC_SET'], // 连想数组写入
  ['字典读取', 'DIC_GET'], // 连想数组读取
  ['跑开', 'RUNOFF'], // K97 离场处理
  ['收尾处理', 'OAZUKE'], // SOURCE 收尾
  ['加疲劳', 'ADD_TIRED'], // TCVAR 疲劳加算
  ['诶嘿嘿重置', 'ENDUFUFU'], // 诶嘿嘿结束复位
  ['重置陷阱变量', 'TRAP_V_RESET'], // 陷阱变量全清
  ['鲜度加成', 'SPOIL_ENHANCEMENT'], // 捕获物鲜度
  ['鲜度文本', 'SPOIL_TEXT'], // 鲜度文本
  ['评价料理', 'REVIEW_DISH'], // 料理评价
  ['调合等级', 'PHARMACY_RANK'], // 调合难度 / 可否
  ['道具数据', 'ITEMDATA'], // 商店道具数据
  ['道具种类', 'ITEMTYPE'], // 道具种类
  ['整箱购买', 'ITEM_CARTON'], // 超额购买处理
  ['物品说明', 'ITEM_EXPLANATION'], // 道具解说
  ['打印物品说明', 'PRINT_ITEM_EXPLANATION'], // 道具解说打印
  ['丢失物品', 'LOST_ITEM'], // 失去道具消息
  ['丢失日元', 'LOST_MONEY_YEN'], // 失去金钱消息
  ['取所持日元', 'GET_MONEY_YEN'], // 所持金
  ['支付日元', 'PAY_MONEY_YEN'], // 支付现金
  ['支付筹码', 'PAY_MONEY_CM'], // 支付筹码
  ['付钱或筹码', 'PAY_YEN_OR_CM'], // 现金 / 筹码二择
  ['礼物数据主体', 'GIFTDATA_MAIN'], // 礼物本体数据
  ['礼物形容数据', 'GIFTDATA_ADJECT'], // 礼物形容词数据
  ['由角色生成礼物', 'CREATE_GIFT_FROM_CHARA'], // 角色依存礼物
  ['角色定制礼物', 'GIFT_ORDER_MADE_FROM_CHARA'], // 角色特注品
  ['主角定制礼物', 'GIFT_ORDER_MADE_FROM_MASTER'], // 主角特注品
  ['礼物事件', 'GIFT_EVENT'], // 赠礼事件
  ['特产店名', 'GIFTSHOP_NAME'], // 土产屋名
  ['检查收藏', 'CHECK_COLLECTION'], // 收藏 / 手持统计
  ['小生物数据', 'CRITTER_DATA'], // critter 数据
  ['采集地点', 'GATHERING_SPOT'], // 采集点
  ['采集产物', 'GATHERING_PRODUCT'], // 采集产物出现
  ['钓鱼说明', 'FISHING_EXPLANATION'], // 钓果说明
  ['钓鱼尺寸', 'FISHING_SIZE'], // 鱼尺寸
  ['全局指令可用', 'GLOBAL_COMABLE'], // COMABLE 一括管理
  ['指令顺序元素', 'QOL_COM_ORDER_ELEMENT'], // QoL 指令排序
  ['指令拒绝检查', 'REJECT_CHECK'], // 指令拒否判定
  ['口上强制失败', 'KOJO_FORCED_FAILURE'], // 强制失败分支

  // ---- 口上 / 角色 / 调教族 ----
  ['特殊事件消息一', 'SPEVENT_MESSAGE_1'], // SP 事件口上
  ['特殊事件消息二', 'SPEVENT_MESSAGE_2'], // 约会告白共通
  ['特殊事件消息三', 'SPEVENT_MESSAGE_3'], // 约会反感刻印消去
  ['口上消息发送', 'KOJO_MESSAGE_SEND'], // KOJO_MESSAGE 通用发送
  ['口上设置', 'KOJO_SETTING'], // 口上设置入口
  ['口上配置', 'KOJO_CONFIGURE'], // 口上配置
  ['口上设置性别', 'KOJO_SETTING_SEX'],
  ['口上设置体型', 'KOJO_SETTING_SIZE'],
  ['口上设置胸部', 'KOJO_SETTING_BREASTS'],
  ['口上设置纯洁', 'KOJO_SETTING_PURITY'],
  ['口上提交性别', 'KOJO_SUBMIT_SEX'],
  ['口上提交体型', 'KOJO_SUBMIT_SIZE'],
  ['口上提交胸部', 'KOJO_SUBMIT_BREASTS'],
  ['口上提交纯洁', 'KOJO_SUBMIT_PURITY'],
  ['口上选项攻略', 'KOJO_OPTION_WALKTHROUGH'], // KOJO_OPTION_ITEM 封装
  ['取口上色', 'GET_CN_WORD_COLOR'], // 路人子口上色
  ['口交指令', 'CCOMF51'], // CCOMF51 本体
  ['骑乘位指令', 'CCOMF85'],
  ['骑乘肛门指令', 'CCOMF87'],
  ['口交可用', 'CCOM_ABLE51'], // CCOMF51 可否
  ['骑乘位可用', 'CCOM_ABLE85'],
  ['骑乘肛门可用', 'CCOM_ABLE87'],
  ['六九式转移', 'EVENT_COUNTER_POSE_69'], // 69 式共通迁移
  ['更新口上对象', 'DOKU_KM_RENEW_TARGET'], // 口上 TARGET 更新
  ['条件随机结果', 'DOKU_RAND_RESULT_WC'], // WithCondition 随机
  ['重置口上角色', 'RESET_KOJO_CHARA'], // 口上角色重置
  ['设定接触部位', 'TOUCH_SET'], // MASTER / TARGET 接触
  ['重置对象接触', 'TOUCH_RESET_T'], // TARGET 接触复位
  ['重置主角接触', 'TOUCH_RESET_M'], // MASTER 接触复位
  ['检查角色', 'CHECK_CHARA'], // 角色条件合致
  ['查找恋人', 'FIND_LOVER'], // 恋人所在
  ['查找周围', 'FIND_AROUND'], // 周围角色抽取
  ['取角色名', 'TNAME'], // 角色名（英文形态）
  ['取种族名', 'GET_TRIBENAME'], // 种族素质名
  ['素质翻译', 'TALENT_TR'], // 素质名 CSV
  ['名称翻译', 'NAME_TR'], // 名称 CSV
  ['字符串翻译', 'STR_TR'], // 字符串 CSV
  ['节日翻译', 'FESTIVAL_TR'], // 节日名 CSV
  ['好高度高阶', 'K77_RANK_FAVOR_INHIGH'], // K77 好感档
  ['主人好感检查', 'MASTER_FAVOR_CHECK'], // 好感加成
  ['技巧加成', 'TECHNIQUE_CHECK'], // 技巧加成
  ['情绪加成', 'MOOD_CHECK'], // 情绪加成
  ['理性加成', 'REASON_CHECK'], // 理性加成
  ['主角技巧检查', 'PLAYER_SKILL_CHECK'], // 主角技巧
  ['痛苦检查甲', 'PAIN_CHECK_A'], // 痛苦处理后
  ['取工作名', 'GET_JOBNAME'], // 工作名
  ['角色工作结束', 'CHARA_JOBEND'], // 工作结束处理
  ['去上学', 'GO_SCHOOL'], // 子女通学
  ['接受委托', 'IRAI_START'], // 委托受诺
  ['委托可同行', 'CAN_IRAI_CHARA_GO_TOGATHER'], // 委托连出可否
  ['委托进展', 'IRAI_CHARA_TO_PROGRESS'], // 委托状况文本
  ['查找委托槽', 'SEARCH_IRAI_SLOT'], // 依頼ID → 槽
  ['查找空委托槽', 'SEARCH_IRAI_EMPTY'], // 空槽检索
  ['委托槽转人物', 'IRAI_SLOT_TO_PERSON'], // 槽 → 要求人物
  ['连出条件', 'COM_351_CONDITION'], // 连出可行性
  ['约会宴会', 'DATE_PARTY'], // 约会吃饭地点
  ['路人种类', 'DATE_HITOGOMI_SYUBETU'], // 外出路人名种类
  ['特殊初吻', 'SPECIAL_FIRSTKISS'], // 初吻共通
  ['特殊初吻中文', 'SPECIAL_FIRSTKISS_CN'], // 初吻中文版
  ['增加接吻经验', 'ADD_KISS'], // 接吻经验 / 初吻
  ['接吻', 'KISS'], // 同义随机
  ['接吻中文', 'KISS_CN'], // 中文版
  ['随机接吻', 'RANDKISS'], // 随机同义
  ['随机吻描', 'RANDKISS_CN'], // 中文随机吻描
  ['随机唇', 'RANDLIPS'], // 随机唇部描写
  ['随机唇描', 'RANDLIPS_CN'], // 中文随机唇描
  ['痛吟中文', 'GROAN_CN'], // 中文痛吟
  ['厌男判定', 'OTOKOGIRAI'], // 讨厌男 / 女
  ['是性交指令', 'IS_COM_SEX'], // 指令判定
  ['是阴道插入指令', 'IS_V_INSERT_COM'], // V 插入指令
  ['是肛门插入指令', 'IS_A_INSERT_COM'], // A 插入指令
  ['性对话', 'DIALOGUE_SEX'], // 性行为对话
  ['毒体消息', 'POISONBODY_MESSAGE'], // 毒体绝顶消息

  // ---- 英文语法 / 翻译族 ----
  ['英文他她', 'HE_SHE'], // 主格 / 所有格
  ['英文他她宾', 'HIM_HER'], // 宾格 / 所有格
  ['英文他她属', 'HES_SHES'], // 所有格形态
  ['英文尊称', 'CHAN_KUN'], // -chan / -kun
  ['冠词判定', 'ARTICLE'], // a / an
  ['内裤冠词', 'ARTICLE_PANTIES'], // 内裤冠词
  ['内裤英文代词', 'IT_THEM_PANTIES'], // it / them
  ['名词复数', 'PLNOUN'], // 名词复数化
  ['动词复数', 'PLVERB'], // 动词第三人称单数
  ['复数打印', 'PRINT_PLUR'], // 数值 + 词同时输出
  ['解析称呼', 'PARSE'], // 称呼 / 行为者替换
  ['打印男性称谓', 'PRINT_MALE'], // 男性称谓表
  ['打印阴核', 'PRINT_CLIT'], // 阴核打印
  ['阴核简描', 'TINKO_SIMPLE'], // 简略描写
  ['数值转汉字', 'TOKANJIT'], // 数值 → 汉字（带数词）
  ['数值转汉字数字', 'TOKANJI'], // 数值 → 汉字数字
  ['色彩空间转换', 'HSV_TO_RGB'], // 色彩换算
  ['条色设置', 'BARCOLORSET'], // 自定义条颜色
  ['着色条打印', 'PRINT_COLORBAR'], // 颜色条
  ['打印指定日', 'PRINT_DATE'], // 指定 DAY → 年月日（曜日）
  ['打印室外', 'PRINT_OUTSIDE'], // inside / outside 文本

  // ---- 杂项 / 调试 ----
  ['取酒编号', 'ALC_ID'], // 名称 → 酒番号
  ['取酒名', 'ALC_NAME'], // 酒番号 → 名称
  ['关键字随机', 'RANDNR'], // 字符串关键字随机
  ['简单选择', 'CHOICE'], // 简易选择肢
  ['显示理性壁', 'SHOW_REASONWALL'], // 理性壁显示
  ['日常消息二', 'DAILY_MESSAGE_2'], // 日常事件口上 2
  ['日常消息四', 'DAILY_MESSAGE_4'], // 日常事件口上 4
  ['日常消息十二', 'DAILY_MESSAGE_12'], // 日常事件口上 12
  ['潜伏地点名', 'NAME_HIDING_PLACE'], // 潜伏地点字符串
  ['逆推丧失', 'LOST_GYAKURE'], // 逆推事件丧失记录
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
