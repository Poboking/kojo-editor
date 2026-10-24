/**
 * eraFL 基础库 / 常用函数名表 —— **游戏知识，只住 adapter**。
 *
 * 「函数中文化」第二条落地线：让作者能用**中文函数名**书写 eraFL 基础库助手
 * （`角色名(0)` → `ANAME(0)`），由糖层降糖成原生 ERB 函数名。与
 * `instruction-table.ts`（引擎指令中文词）**消费方不同**：那张表进高亮/补全词表，
 * 这张进糖层降糖 + 反向本地化/正向补全（`KojoLibraryTable` 三个查询面）。
 *
 * ## 收录判据（静态、手工维护、随实测增补）
 * - **收**：eraFL **基础库**（`ERB/` 树里 `口上` 域之外）`@` 定义的高频助手 / 宏；
 * - **不收**：① 引擎内建（`GETBIT` / `FIRSTTIME` / `CHK_*` …）——跨游戏语言层，
 *   住 kojo-sugar 的 `SYSTEM_FUNCTION_ALIASES`（系统表优先于本表）；
 *   ② 作者私有 `@函数`（`口上/**` 内 `@` 定义者——`KOJO_*_K{n}` 之类）；
 *   ③ 单次调用的长尾（本表收「口上域调用 ≥2 次」，见下）。
 *
 * ## 语料读数（2026-10-25 `D:/Game/erafl` 真盘普查；扫描口径逐字照
 * `eratw-adapter/tests/library-coverage.corpus.test.ts` 头注：跳字符串/注释、
 * 最大标识符词元、后随 `(`、行首词元与 `CALLFORM` 动态名不计、纯中文名不计）
 * - 口上域 ERB：**417 份 / 8,990 个基础库调用点 / 226 个不同函数名**；
 * - 本表收 **170 名**（≥2 次的全部 + 无一例外），覆盖 **8,933 / 8,990 = 99.37%** 调用点；
 *   长尾 **55 名（各 1 次，57 处）明确不收**（判据与 eraTW 首版一致：长尾不收，宁缺勿猜）；
 *   另有 1 名（`取参数等级`）**刻意不收**：与系统函数表撞名且口上域零调用，
 *   见 {@link ERAFL_LIBRARY_CONFLICTS}；
 * - 头部读数：`ANAME` 2,569 · `KJ_PRINT` 904 · `PRINT_DIAG` 884 · `NAME_TO_CHARA` 578 ·
 *   `IS_INITIATIVE` 496 · `DRAW_PORTRAIT` 487 · `KOJO_XML_REGISTER` 290 ·
 *   `FL_PLAYBGM` 168 · `SET_FACEIMG` 162 · `IS_MPLY` 150（前十覆盖 74.4%）。
 *
 * ## 与 eraTW 表的差别（**不是裁剪，是另一套语料**）
 * eraFL 的口上主力是 XML（293 份），ERB 侧是 417 份**注册壳**；所以本表的高频头部
 * 不是 eraTW 的 `HPH_PRINT` / `CHARA_TEXT`，而是 `ANAME`（角色名，XML 打印前的
 * 名字解析）与 `KJ_PRINT`（按角色口上色打印）、`PRINT_DIAG`（分栏打印）。
 * 两边**没有一条可以照抄**——这也是本表逐条回真盘取证据的原因。
 *
 * 查不到的名字一律 `undefined`（**绝不猜**，规范 §5.3 精神）；未收录的中文调用形态
 * 由糖层**原样保留**并报诊断（fail-visible）。
 */

import type { KojoLibraryTable } from '@kojo/plugin-api';

/**
 * 中文名 → 原生 ERB 函数名（单一真源；手工维护）。
 *
 * 每条行尾注释 = **定义处证据**（`文件 · 概要原文节选`），便于换盘复核。
 * 排序：按 2026-10-25 口上域调用频次降序分族，族内按语义聚簇。
 */
export const ERAFL_LIBRARY_FUNCTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // ---- 名字 / 角色标识（最高频：ANAME 2,569） ----
  ['角色名', 'ANAME'], // _FUNCTION.ERB · キャラ名を返す関数（CHARA_ID / CHARA_NUM / 職業名表示）
  ['名转角色号', 'NAME_TO_CHARA'], // _FUNCTION.ERB · キャラクターの識別名(CSTR:99)を元にキャラ番号を返す
  ['角色ID转番号', 'ID_TO_CHARA'], // _FUNCTION.ERB · IDを元にキャラ番号を返す関数
  ['取角色ID', 'GET_ID'], // _FUNCTION.ERB · ARG:0番のキャラのIDを取得する関数
  ['角色爱称', 'NAME_NICK'], // _FUNCTION.ERB · 「愛称」を返す／未設定なら名を返す
  ['取地点名', 'GET_PLACENAME'], // _FUNCTION.ERB · ARG:0番に対応する場所名の取得
  ['取道具名', 'GET_ITEM_NAME'], // アイテム名を取得

  // ---- 打印 / 演出（KJ_PRINT 904 · PRINT_DIAG 884） ----
  ['口上色打印', 'KJ_PRINT'], // HOUSING/_FUNCTIONS/汎用関数.ERB · メッセージ関連（CFLAG 口上カラーコードで着色）
  ['分栏打印', 'PRINT_DIAG'], // HOUSING/_FUNCTIONS/汎用関数.ERB · TEXT_SPLIT_RAWTEXT + PRINT_TEXT_COLUMN
  ['着色打印换行', 'COLOR_PRINTW'], // _FUNCTION_DESIGN.ERB · COLOR_PRINTFORML 族（打印后等待）
  ['着色打印行', 'COLOR_PRINTL'], // _FUNCTION_DESIGN.ERB · 同上（不等待）
  ['取色', 'COLOR'], // _FUNCTION_DESIGN.ERB · 色名 → 色番号
  ['画彩线', 'COLOR_LINE'], // ◆色つきのラインを指定する（ARG:1 = 线宽 0/1/2）
  ['画线', 'DRAW_LINE'], // UI描画関連の関数 · 水平線描画
  ['随机打印', 'PRINT_RAND'], // 引数分の文字列からランダムに一つ出力
  ['打字打印', 'TYPE_PRINT'], // タイプした風に一文字ずつ出力する関数
  ['标签打印', 'TAG_PRINT'], // Function_TagSetText.ERB · 0x04 = ボタンを数値ボタンで処理
  ['打印通知', 'PRINT_NOTICE'], // 汎用関数.ERB · 通知行
  ['通用翻页等待', 'COMMON_PAGE_END_WAIT'], // 汎用関数.ERB · ページ送り（ICON / F_COLOR / MAX_PERIOD）
  ['生成拟声', 'GEN_ONOMATOPE'], // テンポ / カナ / ハート無し で擬音を組む
  ['整理拟声', 'ARRANGE_ONOMATOPE'], // 機械的に生成した文字列を文として自然に整形（文中/文末）

  // ---- 口上 XML / 事件注册（KOJO_XML_REGISTER 290） ----
  ['注册口上XML', 'KOJO_XML_REGISTER'], // FL_INIT_LOADER.ERB · XML_PATH / CHARA_NO / KOJO_CLASS
  ['载入专属立绘XML', 'LOAD_UNIQUE_XML_PORTRAIT'], // XML_PATH / CHARA_ID / SAVE_ID
  ['追加训练事件被调', 'ADD_EVENTTRAIN_CALLEE'], // EVENTSTART_CALLEE に追加する
  ['追加结束事件被调', 'ADD_EVENTEND_CALLEE'], // EVENTEND_CALLEE に追加する
  ['是通用口上角色', 'IS_COMMON_KOJO_CHARA'], // 汎用口上が適用されるキャラかどうか(非独特または你)
  ['住房口上数据入CSTR', 'HOKJ_SET_CHARADATA_TO_CSTR'], // ハウジングモードの諸キャラデータをまとめてCSTRに格納

  // ---- 判定：身份 / 关系（IS_INITIATIVE 496 · IS_MPLY 150） ----
  ['有主导权', 'IS_INITIATIVE'], // _COM_COMMON.ERB · 主導権を持っていれば1
  ['取主导权值', 'GET_INITIATIVE_RATE'], // 主人公との相対的な主導権基準値
  ['是玩家', 'IS_MPLY'], // _FUNCTION.ERB · プレイヤーかどうか
  ['是目标', 'IS_MTAR'], // _FUNCTION.ERB · ターゲットかどうか
  ['是男性', 'IS_MALE'], // _FUNCTION.ERB · ベースとして男扱いなら1
  ['是女性', 'IS_FEMALE'], // _FUNCTION.ERB · ベースとして女扱いなら1
  ['是同性', 'IS_SAMESEX'], // 二角色同性别
  ['是年少', 'IS_KIDS'], // 年少者かどうか（暫定）
  ['是独特角色', 'IS_UNIQUE_CHARA'], // ランダムキャラ/子供/特殊キャラ以外
  ['是恋慕', 'IS_LOVER'], // 恋慕系素質
  ['是陷落', 'IS_FALLEN'], // 恋慕系・服従系・主人系のいずれか
  ['是深陷落', 'IS_MASTER_UP'], // 深陥落素質
  ['是服従', 'IS_SLAVE'], // 服従系 or 烙印
  ['匹配陷落', 'GMATCH_FALLEN'], // SLAVE / SLAVED_BY / FALLEN 三档
  ['是淫乱', 'IS_NASTY'], // 淫乱系素質の有無
  ['是发情', 'IS_ESTRUS'], // 発情判定（TCVAR:60 = 媚薬使用中）
  ['是醉酒', 'IS_DRUNK'], // どの程度酔っているか判定
  ['是湿润', 'IS_WET'], // 十分に潤滑しているか
  ['同势力', 'IS_SAME_FACTION'], // RESULT:0 {bool}
  ['有技能', 'HAS_SKILL'], // 定義名でスキルレベルを返す（装備スキルは DID を RESULT:1）
  ['情境标签', 'AT_SITU'], // TSTR:COM_SITUATION 上のタグ有無（RESULT:1 = 索引）
  ['判定感情', 'CHECK_EMOTION'], // 対象キャラの感情を分類で判定
  ['心情名', 'TOSTR_EMOTION'], // 現在の機嫌の名称
  ['日常事件可发生', 'IS_DAILY_EVENT_HAPPEN'], // 放浪/死亡/捕虜/所属 を見る
  ['是有效ID', 'IS_VALID_ID'], // 有効な CHARA_ID か

  // ---- 判定：身体 / 性（HAS_PENIS 47 · HAS_VAGINA 10） ----
  ['有阴茎', 'HAS_PENIS'], // 竿があるか（第二引数でＰ保護遗物を考慮）
  ['有阴道', 'HAS_VAGINA'], // Ｖがあるか（第二引数でＶ保護遗物を考慮）
  ['是双性', 'HAS_FUTANARI'], // 竿とＶの両方
  ['转为双性', 'TO_FUTANARI'], // ふたなり付与（TEMPORAL:X で残期間）
  ['是阴道占用', 'IS_V_HOLD'], // Ｖが埋まっているか
  ['是肛门占用', 'IS_A_HOLD'], // Ａが埋まっているか
  ['绝顶次数合计', 'SUM_NOWEX'], // NOWEX 合計（ARG:1 射精 / ARG:2 噴乳）
  ['取射精部位', 'GET_STACK_SPERM_TO'], // 相手のどこに射精してるか（無指定=-1）
  ['取射精部位随意', 'NOW_BUKKAKED'], // 同上但射精者任意（計算量増）
  ['取精液ID', 'GET_SPERM_ID'], // 指定名の精液 ID
  ['子宫精液量', 'SUM_WOMB_SPERM_AMOUNT'], // 子宮内の精液量を合算
  ['胃内精液量', 'SUM_STOMACH_SPERM_AMOUNT'], // 胃内の精液量を合算
  ['肠内精液量', 'SUM_ANUS_SPERM_AMOUNT'], // 腸内の精液量を合算
  ['是奉仕部位', 'IS_SERVEAT'], // 単発コマンド/継続状態から指定部位の奉仕を判定

  // ---- 数值 / 关系（REL_ADD 18 · PRINT_ADD_EXP 57） ----
  ['加好感', 'REL_ADD'], // SLG_FUNCTION.ERB · FROM→TO の好感度を VALUE 加算
  ['取好感', 'REL_GET_LIKE'], // GET_REL のラッパー（好感度）
  ['加经验并显示', 'PRINT_ADD_EXP'], // 経験値を加算し、その旨を表示
  ['自动能力上升', 'TRAIN_AUTO_ABLUP'], // ABL.ERB · コマンド実行時の自動能力上昇
  ['百分比判定', 'PERCENT'], // ARG% の判定（デフォルト百分率）
  ['完成全局目标', 'GLOBAL_GOAL_COMPLETE'], // GOAL_NAME / IGNORE_ERROR

  // ---- 继续 / 装备 / 技能（IS_EQUIP 20 族 · EQUIP_WEAPON 16） ----
  ['是继续', 'IS_EQUIP'], // _EQUIP.ERB · コマンド番号 ARG:1～10 の継続状態（プレイヤー/ターゲット）
  ['是目标继续', 'IS_EQUIP_TARGET'], // 同上（ターゲット側のみ）
  ['是玩家继续', 'IS_EQUIP_PLAYER'], // 同上（プレイヤー側のみ）
  ['是口塞', 'IS_EQUIP_CONTINUE'], // 口上の互換性のため／口が塞がっているか
  ['设定继续', 'SET_EQUIP'], // ARG:1=1 で COM_IS_EQUIP を無視して強制継続
  ['解除继续扩展', 'RELEASE_EQUIP_EX'], // EQUIP解除（ARG:0=コマンド番号 / -1 で一括）
  ['设自动命令优先度', 'AUTOCOM_SET_PRIORITY_CUSTOM'], // コマンド自動実行カテゴリ-カスタム用の優先度設定（同時に登録）
  ['装备武器', 'EQUIP_WEAPON'], // 武器をキャラに装備させる
  ['删除武器', 'DELETE_WEAPON'], // 武器を削除する
  ['装备名转ID', 'EQUIP_NAME_TO_DID'], // 武器名 → 装備ID(RESULT)
  ['装备ID转武器ID', 'EQUIP_DID_TO_WEAPONID'], // 指定 WEAPON_ID を持つか判定
  ['取武器库存表', 'GET_WEAPON_STOCK_TABLE'], // 武器在庫テーブル
  ['设装备说明', 'EQUIP_SET_DESCRIPTION_TEXT'], // ツールチップ用（<br> 区切り）
  ['装备技能名校验', 'GET_EQUIP_SKILLNAME_CHECK'], // GENRE: 武器スキル_アクティブ=1 / パッシブ=0
  ['习得技能', 'SKILL_LEARN2'], // FL用技能習得（習得可能判定は呼び出し前）
  ['编辑主动技能槽', 'SKILL_EDIT_ACTIVE_SKILL_SLOT'], // 激活技能スロットの編集
  ['任务取武器', 'QST_GET_WEAPON'], // 1=表示 / 2=入手・廃棄の選択肢
  ['任务取装备', 'QST_GET_EQUIP'], // QST_GET_WEAPON のラッパー（辞書形式）

  // ---- 衣装（CLOTH_* / HO_*） ----
  ['按名着装', 'SET_CLOTH_BY_NAME'], // 名称から衣装を設定（重いので多用しないこと）
  ['衣装已穿', 'CLOTH_IS_EQUIP'], // RESULT:0 0=未着用 1=着用
  ['取衣装名', 'GET_CLOTH_NAME'], // 衣装名を取得するラッパ
  ['取衣装标签', 'GET_CLOTH_TAG'], // 衣服の属性タグの取得とチェック
  ['有衣装标签', 'HAS_CLOTH_TAG'], // 同族（真偽だけ）
  ['是遮挡', 'IS_COVERED'], // 被覆部位 / 下着のみ判定（RESULT:0 部位・RESULTS:0 名）
  ['重置衣装', 'CLOTH_RESET'], // 衣装のリセット
  ['改衣装库存', 'CHANGE_CLOTH_STOCK'], // 衣装在庫を追加
  ['设定角色衣装数据', 'SET_CHARA_CLOTH_DATA'], // PRESET_ID=-1 は CFLAG 衣装プリセット
  ['衣橱按字典初始化', 'CLOTH_DRAWER_INIT_REGIST_FROM_DIC'], // "[TOP:运动服][BOTTOM:裤子]…" 字典注册
  ['强制脱衣', 'HO_UNDRESS'], // 問答無用で全裸（強制脱衣=1 で衣装状態_強脱）
  ['指定部位脱衣', 'HO_STRIP'], // 部位指定脱衣（枚数指定 >0 で枚数分）
  ['复原衣装', 'HO_REDRESS'], // 衣装を初期状態に（OPTION=1 破れ / 2 破れ+強脱）
  ['住房周', 'HO_WEEK'], // HOUSING/_FUNCTIONS/汎用関数.ERB · DAY % 8
  ['住房季节', 'HO_SEASON'], // 同上 · (DAY-1)/8 % 4
  ['住房取角色ID', 'HO_GET_CHARAIDXF'], // キャラリストに無い ID は -1（式中関数版）
  ['住房取角色数据', 'HO_GET_CHARADATAF'], // 式中関数版
  ['检查使用模块', 'HO_CHECK_USE_MODULE_ELEMENT'], // 使用中モジュールの属性が引数と合致するか

  // ---- 身体数值 ----
  ['设定阴茎大小', 'SET_PENISSIZE'], // -2:絶壁～2:爆乳（定义处注释误抄バスト，以函数名为准）
  ['取阴茎大小', 'GET_PENISSIZE'], // 数値に変換（-2～2）
  ['取胸围', 'GET_BUSTSIZE'], // 数値に変換（-2:絶壁～2:爆乳）
  ['胸围名', 'TOSTR_STATUS_BUSTSIZE'], // 数値 → 文字列
  ['设定体型', 'SET_BODYSIZE'], // 体格設定
  ['部位描写', 'STR_BODY'], // 指定した部位についての描写を返す
  ['算子宫大小', 'CALC_WOMB_SIZE'], // 子宮サイズ算出
  ['算胃大小', 'CALC_STOMACH_SIZE'], // 胃サイズ算出
  ['算肠大小', 'CALC_ANUS_SIZE'], // 腸サイズ算出

  // ---- 立绘 / 图像（DRAW_PORTRAIT 487 · SET_FACEIMG 162） ----
  ['显示立绘', 'DRAW_PORTRAIT'], // 辞書形式で属性を指定して任意キャラのポートレイトを表示
  ['显示一枚绘', 'DRAW_STILL'], // 任意の登録済み一枚絵を出力
  ['设定脸图', 'SET_FACEIMG'], // 顔グラパーツ管理用キャラ変数に格納（PARTS は 画像管理.ERH）
  ['取脸图', 'GET_FACEIMG'], // 顔グラパーツ取得
  ['有脸图', 'EXIST_FACEIMG'], // 指定文字列を含むスプライトが登録されていれば 1
  ['设定脸叠加', 'SET_FACEOVL'], // 顔グラオーバーレイ（赤面など）を格納
  ['有脸叠加', 'EXIST_FACEOVL'], // オーバーレイ登録有無
  ['删除脸叠加', 'DEL_FACEOVL'], // パーツ単位で OVL をクリア
  ['绘脸并设脸图', 'DRAW_FACE_SET_FACEIMG'], // 顔描画 + SET_FACEIMG の合成
  ['重置脸精灵', 'RESET_FACE_SPRITE'], // スプライト初期化
  ['设定通用服装脸', 'SET_FACE_COMMON_OUTFIT'], // 汎用規格のポートレイトパーツ処理
  ['编辑立绘部件色', 'EDIT_PORTRAIT_PARTS_COLOR'], // 顔グラパーツの色編集

  // ---- 声音（FL_PLAYBGM 168 · FL_PLAYSE 84） ----
  ['播放BGM', 'FL_PLAYBGM'], // FL_SOUND.ERB · VOLUME は百分率指定
  ['停止BGM', 'FL_STOPBGM'], // FL_SOUND.ERB
  ['暂停BGM', 'FL_PAUSEBGM'], // FL_SOUND.ERB
  ['播放音效', 'FL_PLAYSE'], // FL_SOUND.ERB · VOLUME は百分率指定

  // ---- 选项 / 输入（ASK_YN 114 · ASK_MULTI 34） ----
  ['询问是非', 'ASK_YN'], // はい／いいえ（戻り値 0=はい 1=いいえ）
  ['询问选项', 'ASK_MULTI'], // 最大5個（戻り値 = 選択番号）
  ['询问选项带条件', 'ASK_MULTI_JUDGE'], // 条件を満たさない選択肢をグレー表示
  ['询问选项隐藏无效', 'ASK_MULTI_JUDGE_HIDE_DEACTIVE'], // 同上但隐藏而非灰显

  // ---- 字符串 / 随机（SPLIT_R 145 · IFRAND 27） ----
  ['随机分割', 'SPLIT_R'], // STR_BODY.ERB · ：で区切られた文字列からランダムに一つ
  ['随机取一', 'SPLIT_RAND'], // _FUNCTION.ERB · 候补带条件（空条件=1）
  ['条件随机取一', 'S_R'], // SPLIT_RAND の短縮形（返却候補なし = 空文字列）
  ['条件随机文本', 'TEXT_RANDC'], // 引数分の文字列から条件を満たすもののみランダム
  ['串匹配', 'STR_MATCH'], // カンマ区切り複数 + AND/OR（既定 OR）
  ['洗牌', 'FISHER_YATES_SHAFFLE'], // Fisher-Yates（専用配列 SHAFFLE_ARRAY）
  ['随机挑选分支', 'IFRAND'], // LOCAL:0 に 0-5,7 のいずれか（素質で候補拡張）
  ['权重随机初始化', 'RAND_WT_INIT'], // 重み付き乱択の短縮ラッパー
  ['权重随机设定', 'RAND_WT_SET'], // 同 RESULT 値許容フラグ付き
  ['权重随机结果', 'RAND_WT_RESULT'], // 重み付き乱択の結果取得

  // ---- 列表 / 字典 ----
  ['表追加', 'LIST_ADD'], // _List.ERB · 可変長配列（文字列）に追加
  ['表追加引用', 'LIST_ADD_REF'], // CALLF 参照渡し版（文字列代入の凡ミス対策）
  ['表长度', 'LIST_COUNT'], // 要素数
  ['表查找下标', 'LIST_INDEXOF'], // 発見された INDEX 又は -1
  ['表取元素', 'LIST_GET'], // _INDEX の要素
  ['表取整数', 'LIST_GETINT'], // TOINT の挙動に沿う
  ['字典取值', 'DIC_GET'], // 連想配列（文字列）のキー引き

  // ---- 窗口（WNDMGR_*） ----
  ['建窗口', 'WNDMGR_CREATEWINDOW'], // 0x02 枠あり（細枠）/ 0x03
  ['窗口设文本', 'WNDMGR_TEXTSET'], // nLine 指定でテキスト設定
  ['窗口追加文本', 'WNDMGR_TEXTADD'], // nLine 指定で追記
  ['窗口属性', 'WNDMGR_ATTRIBUTE'], // ARGS="LogButton" など

  // ---- 杂项 ----
  ['技名转番号', 'T_N'], // COM_AUTOSELECT_FUNC.ERB · TRAINNAME → TRAIN 番号（短縮形）
  ['建空角色', 'ADD_VOID_CHARA'], // 特殊キャラのひな型を生成
  ['改道具库存', 'CHANGE_ITEM_STOCK'], // 1つのアイテムの在庫を増減
  ['取任务整型标记', 'QST_GETINT_FLAGMAP'], // QST_SET_FLAGMAP でセットした値を数値変換
  ['任务复刻检查', 'QST_QUEST_57_59_REVIVAL_CHK'], // 復刻クエストかどうか
  ['队伍判定', 'QST_PARTY_ROLL'], // RESULT:0 キャンセル=-1/失敗=0/成功=1
  ['任务入队训练退出', 'QST_ENQUEUE_TRAIN_EXIT_FUNC'], // 訓練退出関数のキュー登録
  ['近战打印', 'CC_PRINT'], // CLOSE_COMBAT/CC_ACTION_LOG.ERB · テキストメッセージ出力
  ['近战行动信息', 'CC_GET_ACT_INFO'], // 近战行动情報（数値）
  ['近战行动信息串', 'CC_GETS_ACT_INFO'], // 近战行动情報（文字列）
  ['调用LLM', 'LLM_CALL'], // 外部サービス優先（応答待ち 50ms ウェイト）
  ['取被打断角色', 'INTERRUPTED_CHARA_BY'], // 割込コマンド実行時、直前の実行者/対象を返す
]);

/**
 * **刻意不收**的中文名：与 2.0 系统函数表（`@kojo/plugin-kojo-sugar` 的
 * `SYSTEM_FUNCTION_ALIASES`）撞名，而两边指向**不同**的 ERB 函数。
 *
 * 判据是「系统表优先」——`KojoLibraryTable` 只是**兜底**候选源，2.0 语言层先查系统表。
 * 若这里也收一条，它永远不会被查到（死条目）；更糟的是让读者以为 `取参数等级` 指
 * eraFL 的 `GET_PALAMLV`，而实际产物是引擎内建 `GETPALAMLV`——两者只差一个下划线，
 * 语义却不同（eraFL 那份是带 `ARG:0` 参数量的包装）。
 *
 * ⇒ 不猜作者要哪一个：中文名让给系统表（内建），eraFL 的那条**只能用原生名**
 * `GET_PALAMLV` 调用。这条注释就是那次冲突的账，删掉它等于把坑重新埋回去。
 */
export const ERAFL_LIBRARY_CONFLICTS: ReadonlyMap<string, { readonly erb: string; readonly reason: string }> =
  new Map([
    ['取参数等级', { erb: 'GET_PALAMLV', reason: '系统表已有同名（→ 内建 GETPALAMLV）；eraFL 自家的 GET_PALAMLV 差一个下划线' }],
  ]);

/**
 * 由「中文名 → 原生 ERB 函数名」映射构建 `KojoLibraryTable`（纯数据，无 IO）。
 *
 * 与 eraTW 的同名工厂**语义完全一致**（`hasTable = 映射非空`；反查取首条；
 * `names()` 按声明序）——两边各持一份而不是抽公共包：表是**游戏知识**，
 * 工厂是十行纯函数，跨 adapter 抽包会把「谁的表」变成公共契约。
 */
export function createEraflLibraryTable(map: ReadonlyMap<string, string>): KojoLibraryTable {
  const byName = new Map(map);
  const byFunction = new Map<string, string>();
  for (const [cn, erb] of byName) {
    if (!byFunction.has(erb)) byFunction.set(erb, cn);
  }
  return {
    hasTable: byName.size > 0,
    lookupByName: (name) => byName.get(name),
    lookupByFunction: (functionName) => byFunction.get(functionName),
    names: () => [...byName.keys()],
  };
}

/** 空表实例（无表时返回它；`hasTable=false`，查啥都 undefined） */
export const EMPTY_LIBRARY_TABLE: KojoLibraryTable = createEraflLibraryTable(new Map());
