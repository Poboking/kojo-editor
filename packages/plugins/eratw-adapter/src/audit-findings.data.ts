/**
 * erbcc audit 审计读数快照 —— **生成文件，勿手改**。
 *
 * 由 `node tools/gen-erb-audit-findings.mjs` 从 eraTW 4.981 全量审计 TSV 生成：
 *   erbcc audit --corpus <语料>/ERB --game-root <语料> --out unresolved-symbols.tsv
 * 源文件 SHA-256 = `4f8dcb9d3dafa5801e3e12f247c0d4461492b79bf15ebd7893fb4f0846208b9e`（TSV 去 BOM + EOL 归一化后，避免 checkout 换 EOL 假红）；共 28 个文件 / 102 条 Finding。
 *
 * `s` = 源文件正文的 stableHash（去 BOM + normalizeEol 后，与 plugin-api 同尺）。
 * `r` = 该文件的 Finding 行：`[kind序号, functionKey, 0基行号, name, detail, count]`。
 * kind 序号对应 AUDIT_FINDING_KINDS 的下标（见 audit-findings.ts）。
 */
export const AUDIT_SOURCE_SHA256 = '4f8dcb9d3dafa5801e3e12f247c0d4461492b79bf15ebd7893fb4f0846208b9e';
export const AUDIT_FILE_COUNT = 28;
export const AUDIT_FINDING_COUNT = 102;

export const AUDIT_FILES = {
  'CHARALIST_DT/TEMP_CHARA_LIST_BY_DT_FUNC.ERB': {
    s: '07a3009a6f705b',
    r: [
      [0, 'CHARA_TRIBE_STR', 2045, 'C_REF_TALENT', 'VARSIZE("C_REF_TALENT") 的名字在运行期命名空间里不存在（运行期现解析，indices=0 noArg=false）', 1],
      [0, 'CHARA_TRIBE_STR', 2046, 'C_REF_TALENT', 'operand=INT indices=1 noArg=false const=true', 1],
      [0, 'CHARA_TRIBE_STR', 2048, 'C_REF_TALENT', 'operand=INT indices=1 noArg=false const=true', 1],
      [0, 'CHARA_TRIBE_STR_OPTION', 2075, 'C_REF_TALENT', 'VARSIZE("C_REF_TALENT") 的名字在运行期命名空间里不存在（运行期现解析，indices=0 noArg=false）', 1],
      [0, 'CHARA_TRIBE_STR_OPTION', 2076, 'C_REF_TALENT', 'operand=INT indices=1 noArg=false const=true', 1],
      [0, 'CHARA_TRIBE_STR_OPTION', 2078, 'C_REF_TALENT', 'operand=INT indices=1 noArg=false const=true', 1],
      [7, '', 2024, 'C_REF_TALENT', '#DIM 解析失败（level 2）: #DIM C_REF_TALENT 的常量表达式含函数调用 GETNUM(...)，不是编译期常量（原版 cs:325 非 SingleLongTerm） | #DIM CONST C_REF_TALENT =    GETNUM(TALENT, "人类") ,    GETNUM(TALENT, "妖怪") ,    GETNUM(TALENT, "妖精") ,    GETNUM(TALENT', 1],
      [7, '', 2061, 'C_REF_TALENT', '#DIM 解析失败（level 2）: #DIM C_REF_TALENT 的常量表达式含函数调用 GETNUM(...)，不是编译期常量（原版 cs:325 非 SingleLongTerm） | #DIM CONST C_REF_TALENT =    GETNUM(TALENT, "追加種族") ,', 1],
    ],
  },
  'DIM.ERH': {
    s: '0f9be5de54bc24',
    r: [
      [7, '', 410, 'PANTS_TEMP', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA PANTS_TEMP, MAXPANTS', 1],
      [7, '', 571, 'BUFF', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA BUFF,50', 1],
      [7, '', 577, 'EFFECTIVE_PATTERN_V', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA EFFECTIVE_PATTERN_V, 3', 1],
      [7, '', 578, 'EFFECTIVE_PATTERN_A', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA EFFECTIVE_PATTERN_A, 3', 1],
      [7, '', 583, 'CHILDNAME', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA CHILDNAME, 101', 1],
      [7, '', 587, 'CHILD_SEX', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_SEX, 101', 1],
      [7, '', 589, 'CHILD_BIRTHDAY', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_BIRTHDAY, 101', 1],
      [7, '', 591, 'CHILD_BIRTHDATE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_BIRTHDATE, 101', 1],
      [7, '', 593, 'CHILD_LOVE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_LOVE, 101', 1],
      [7, '', 595, 'CHILD_WEATHER', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA CHILD_WEATHER, 101', 1],
      [7, '', 597, 'CHILD_ACT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA CHILD_ACT, 101', 1],
      [7, '', 599, 'CHILD_AREA', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_AREA, 101', 1],
      [7, '', 602, 'CHILD_SEX_PREG', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_SEX_PREG, 101;pregnancy', 1],
      [7, '', 616, 'GIFT_GOT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA GIFT_GOT, 101', 1],
      [7, '', 617, 'GIFT_GAVE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA GIFT_GAVE, 101', 1],
      [7, '', 618, 'GIFT_GOT_ORI_ADJECT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA GIFT_GOT_ORI_ADJECT, 101', 1],
      [7, '', 619, 'GIFT_GOT_ORI_MAIN', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA GIFT_GOT_ORI_MAIN, 101', 1],
      [7, '', 620, 'GIFT_GAVE_ORI_ADJECT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA GIFT_GAVE_ORI_ADJECT, 101', 1],
      [7, '', 621, 'GIFT_GAVE_ORI_MAIN', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA GIFT_GAVE_ORI_MAIN, 101', 1],
      [7, '', 865, 'UWAKI_KNOWN', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA UWAKI_KNOWN', 1],
      [7, '', 866, 'UWAKI_ACCEPTED', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA UWAKI_ACCEPTED', 1],
      [7, '', 893, 'COMMON_EFFECT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS SAVEDATA CHARADATA COMMON_EFFECT', 1],
      [7, '', 898, 'custom_talent', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA custom_talent, MAX_CUSTOM_TALENT  ;开关', 1],
      [7, '', 899, 'custom_talent_name', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS SAVEDATA CHARADATA custom_talent_name, MAX_CUSTOM_TALENT ;名称', 1],
      [7, '', 900, 'custom_talent_color', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA custom_talent_color, MAX_CUSTOM_TALENT ;颜色,0的话为定义颜色', 1],
      [7, '', 901, 'CUSTOM_TALENT_TYPE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA CUSTOM_TALENT_TYPE, MAX_CUSTOM_TALENT ;(省略可)表示タイプ 1/種族 2/性的 3/身体的 4/精神的 5/技術的 他は「その他」', 1],
      [7, '', 950, 'custom_button_name', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS SAVEDATA CHARADATA custom_button_name, MAX_CUSTOM_SHOP ;名称', 1],
    ],
  },
  'DLC/DLC.ERH': {
    s: '106c61f8691ca8',
    r: [
      [7, '', 48, 'DEBUG_INGNOREANCE_CHARACTER_VALUE_SAVE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA DEBUG_INGNOREANCE_CHARACTER_VALUE_SAVE', 1],
      [7, '', 102, 'CHILD_DADDY', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_DADDY, 101', 1],
      [7, '', 112, '诱导逆推_进程', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA 诱导逆推_进程', 1],
    ],
  },
  'DLC/GENSOKYO_MAP_FIX/GENSOKYO_MAP_FIX.ERH': {
    s: '18a38f3e99239e',
    r: [
      [7, '', 6, 'GMF_MAPNAME', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 字符串变量不能是多维 | #DIMS SAVEDATA GMF_MAPNAME, 20, 15  ;对应MAPNAME', 1],
    ],
  },
  'DLC/MEDICINE/EIRIN.ERH': {
    s: '18325da42d57f1',
    r: [
      [7, '', 4, 'EI_BASE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA EI_BASE,100', 1],
    ],
  },
  'DLC/SEX_TATTOO/SEX_TATTOO.ERH': {
    s: '14212d1d9392d0',
    r: [
      [7, '', 1, 'st_name', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA st_name', 1],
      [7, '', 3, 'exist_st', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA exist_st', 1],
      [7, '', 6, 'st_m_id', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA st_m_id', 1],
      [7, '', 8, 'st_a_lv', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA st_a_lv, 999', 1],
      [7, '', 10, 'st_introduce', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA st_introduce', 1],
    ],
  },
  'DLC/实用设置补丁/实用设置.ERH': {
    s: '14cb5d82af151f',
    r: [
      [7, '', 12, 'Setting_CFLAG', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA Setting_CFLAG,100', 1],
      [7, '', 13, 'Setting_TCVAR', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA Setting_TCVAR,100', 1],
    ],
  },
  'DLC/魔法DLC/魔法相关参数.ERH': {
    s: '1faa5b3d985b7d',
    r: [
      [7, '', 18, 'M_TALENT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA M_TALENT,22', 1],
      [7, '', 19, 'M_CFLAG', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA M_CFLAG,100', 1],
      [7, '', 24, 'MP_GRADE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA MP_GRADE', 1],
    ],
  },
  'FROMEN/ADDITION/ADD_HATEMARKFORGIVENESS.ERH': {
    s: '11b5de73ab62f6',
    r: [
      [7, '', 0, 'addDateForgivenessProgress', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA addDateForgivenessProgress', 1],
    ],
  },
  'FROMEN/ADDITION/ADD_MISC.ERH': {
    s: '02c7f6bd0c2e6e',
    r: [
      [7, '', 4, 'cBannedDialogue', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA cBannedDialogue', 1],
    ],
  },
  'FROMEN/ADDITION/ADD_MOB.ERH': {
    s: '049e33d5962b0b',
    r: [
      [7, '', 0, 'Str_Mob_Description', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA Str_Mob_Description, 3', 1],
      [7, '', 7, 'strMobOGRaceName', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA strMobOGRaceName', 1],
    ],
  },
  'FROMEN/DAYEVENTS.ERH': {
    s: '0ad25cb16ebd76',
    r: [
      [7, '', 20, 'LastHomeVisit', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA LastHomeVisit, 2', 1],
    ],
  },
  'FROMEN/MODULARCHARACTERUPDATE.ERH': {
    s: '0772e479066294',
    r: [
      [7, '', 18, 'nCharaSaveUp', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA nCharaSaveUp, 5, 22', 1],
    ],
  },
  'FROMEN/OMOGATARI/OMOGATARI.ERH': {
    s: '0530b24d468010',
    r: [
      [7, '', 277, 'ExtraFilters', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA ExtraFilters, 4', 1],
      [7, '', 290, 'HoleStretch', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA HoleStretch, 3', 1],
    ],
  },
  'FROMEN/OMOGATARI/OMOGATARI_STR.ERB': {
    s: '17c801bed759e2',
    r: [
      [0, 'TW_PORT_STR', 2171, 'NAS_VERSION', 'EXISTVAR("NAS_VERSION") 的名字在运行期命名空间里不存在（运行期现解析，indices=0 noArg=false）', 1],
    ],
  },
  'FROMEN/QOL/QOL_DETAILEDINFO.ERH': {
    s: '01b4a880f6e464',
    r: [
      [7, '', 8, 'Qol_Info_Dates_Array', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA Qol_Info_Dates_Array, Qol_Info_Dates_Size', 1],
      [7, '', 9, 'Qol_Info_World_Array', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA Qol_Info_World_Array, Qol_Info_Dates_Size ;keeps track of which NG+ it was', 1],
      [7, '', 49, 'Qol_Info_Count_Array', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA Qol_Info_Count_Array, 65', 1],
      [7, '', 113, 'Qol_Info_Dates_Str', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA Qol_Info_Dates_Str, 5', 1],
    ],
  },
  'FROMEN/QOL/QOL_MISC.ERH': {
    s: '14e1da4cc0bb81',
    r: [
      [7, '', 74, 'EVENT_CLOTHING_SET_STACK', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA EVENT_CLOTHING_SET_STACK, 10', 1],
      [7, '', 75, 'EVENT_CLOTHING_SET_SOURCE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA EVENT_CLOTHING_SET_SOURCE, 10', 1],
      [7, '', 76, 'EVENT_CLOTHING_SET_PARAM', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA EVENT_CLOTHING_SET_PARAM, 10', 1],
      [7, '', 89, 'CUSTOM_DAILY_OUTFIT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CUSTOM_DAILY_OUTFIT, 23', 1],
    ],
  },
  'FROMEN/TR_VARS.ERH': {
    s: '086814f5d9e56c',
    r: [
      [7, '', 4, 'DIALOGSTATUS', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA DIALOGSTATUS, 3', 1],
      [7, '', 25, 'CHILD_INDEPENDENT', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_INDEPENDENT, MAXCHILD + 1 ;for tracking child independence', 1],
      [7, '', 30, 'cEvent', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS SAVEDATA CHARADATA cEvent', 1],
      [7, '', 56, 'CUSTOM_CSTR', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA CUSTOM_CSTR, 10', 1],
      [7, '', 93, 'Mob_Personality', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA Mob_Personality ;replacement for first person pronoun', 1],
      [7, '', 100, 'Mob_MasterName', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA Mob_MasterName ;replacement for second person pronoun, uses pc\'s name if it defaults to just "y', 1],
    ],
  },
  'イベント関連/日記関連/DIARY.ERH': {
    s: '1d3e82e54e1cbc',
    r: [
      [7, '', 0, 'MAX_DIARY_PAGE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA MAX_DIARY_PAGE', 1],
      [7, '', 1, 'DIARY', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA DIARY, 101 ;ひとまず角色ごとに100页', 1],
      [7, '', 2, 'PAGESET', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA PAGESET, 101', 1],
    ],
  },
  'コマンド関連/COMF/依頼/一般依頼18_おなかすいた.ERH': {
    s: '0942ee8ac18f8d',
    r: [
      [7, '', 0, 'REQUEST_DISHNAME', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIMS CHARADATA SAVEDATA REQUEST_DISHNAME', 1],
    ],
  },
  'ステータス計算関連/COUNTER/COUNTER_DIM.ERH': {
    s: '026407a31fefa5',
    r: [
      [7, '', 14, 'COUNTER_SIKOU', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA COUNTER_SIKOU, 150', 1],
      [7, '', 16, 'COUNTER_派生时记录', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA COUNTER_派生时记录', 1],
    ],
  },
  '口上・メッセージ関連/個人口上/016 REMILIA [レミリア]/蕾米莉亚色情特化V1.4.1/M_KOJO_K16_5_事件系.ERB': {
    s: '10a26263c4bcaf',
    r: [
      [3, 'M_KOJO_色情特化_EVENT_K16_6', 3020, 'CFLAG:既成事實', 'CFLAG 中未定义关键字 "既成事實"', 1],
      [3, 'M_KOJO_色情特化_EVENT_K16_6', 3268, 'TALENT:風騷', 'TALENT 中未定义关键字 "風騷"', 2],
      [3, 'M_KOJO_色情特化_EVENT_K16_7', 3400, 'CFLAG:既成事實', 'CFLAG 中未定义关键字 "既成事實"', 1],
      [3, 'M_KOJO_色情特化_EVENT_K16_7', 3648, 'TALENT:風騷', 'TALENT 中未定义关键字 "風騷"', 2],
      [3, 'M_KOJO_色情特化_EVENT_K16_10', 3844, 'CFLAG:既成事實', 'CFLAG 中未定义关键字 "既成事實"', 1],
      [3, 'M_KOJO_色情特化_EVENT_K16_17', 5377, 'EX:処女喪失记号', 'EX 中未定义关键字 "処女喪失记号"', 1],
      [3, 'M_KOJO_色情特化_EVENT_K16_17', 5422, 'EX:処女喪失记号', 'EX 中未定义关键字 "処女喪失记号"', 1],
    ],
  },
  '口上・メッセージ関連/個人口上/016 REMILIA [レミリア]/蕾米莉亚色情特化V1.4.1/M_KOJO_K16_5_日常系指令.ERB': {
    s: '0ba7f1878828f1',
    r: [
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_331', 2661, 'TCVAR:催情薬', 'TCVAR 中未定义关键字 "催情薬"', 1],
    ],
  },
  '口上・メッセージ関連/個人口上/016 REMILIA [レミリア]/蕾米莉亚色情特化V1.4.1/M_KOJO_K16_5_爱抚系指令.ERB': {
    s: '049f7463b05043',
    r: [
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_3', 1935, 'TEQUIP:振動棒', 'TEQUIP 中未定义关键字 "振動棒"', 2],
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_5', 2509, 'TEQUIP:肛用振動棒', 'TEQUIP 中未定义关键字 "肛用振動棒"', 2],
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_6', 2815, 'TALENT:胸圍', 'TALENT 中未定义关键字 "胸圍"', 1],
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_6', 2817, 'TALENT:胸圍', 'TALENT 中未定义关键字 "胸圍"', 1],
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_25', 5261, 'TEQUIP:振動棒', 'TEQUIP 中未定义关键字 "振動棒"', 1],
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_25', 5261, 'TEQUIP:肛用振動棒', 'TEQUIP 中未定义关键字 "肛用振動棒"', 1],
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_25', 5262, 'TEQUIP:振動棒', 'TEQUIP 中未定义关键字 "振動棒"', 2],
      [3, 'M_KOJO_色情特化_MESSAGE_COM_K16_25', 5263, 'TEQUIP:肛用振動棒', 'TEQUIP 中未定义关键字 "肛用振動棒"', 2],
    ],
  },
  '口上・メッセージ関連/個人口上/016 REMILIA [レミリア]/蕾米莉亚色情特化V1.4.1/M_KOJO_K16_5_露出玩法.ERB': {
    s: '08c054c9abe695',
    r: [
      [3, 'M_KOJO_色情特化_露出_散步开始_K16', 161, 'TEQUIP:上半身裸露状態', 'TEQUIP 中未定义关键字 "上半身裸露状態"', 2],
      [3, 'M_KOJO_色情特化_露出_散步完成_K16', 2600, 'TEQUIP:上半身裸露状態', 'TEQUIP 中未定义关键字 "上半身裸露状態"', 2],
      [3, 'M_KOJO_色情特化_露出_散步结束_K16', 2638, 'TEQUIP:上半身裸露状態', 'TEQUIP 中未定义关键字 "上半身裸露状態"', 2],
    ],
  },
  '口上・メッセージ関連/個人口上/077 SHIZUHA [静葉]/你好秋姑娘/M_KOJO_K77_CUSTOMVARS.ERH': {
    s: '18b144fc16d51e',
    r: [
      [7, '', 4, 'K77L_MAKELOVE_JOIN', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA K77L_MAKELOVE_JOIN', 1],
    ],
  },
  '魔改内容/MODDING_VALUE.ERH': {
    s: '0f656c327655bd',
    r: [
      [7, '', 3, 'MASTER_COUNTER_RECORD', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM SAVEDATA CHARADATA MASTER_COUNTER_RECORD, 2', 1],
      [7, '', 5, 'CHILD_INTERACTABLE_HERE', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA CHILD_INTERACTABLE_HERE, 101', 1],
    ],
  },
  '魔改内容/SEMEN_MATRIX.ERH': {
    s: '12685acaac4b3e',
    r: [
      [7, '', 6, 'SEMEN_MATRIX', '#DIM 解析失败（level 2）: 非二进制存档下，SAVEDATA 不能是 CHARADATA 变量 | #DIM CHARADATA SAVEDATA SEMEN_MATRIX, キャラクタ数上限, 4', 1],
    ],
  },
} as const;
