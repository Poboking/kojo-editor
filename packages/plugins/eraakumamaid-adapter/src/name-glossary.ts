/**
 * eraAkumaMaid 口上包「日文名 → 中文名」对照词典（展示用；只住 adapter）。
 * 用途：导入 / 浏览日文命名的既有包时，把日文名以「日文（中文）」形式展示
 *（如 恋慕（爱慕））。**只加显示备注，不改任何实际目录/文件名**。
 * 键为**日文片段**（名字含该片段即命中，最长优先命中；名字自身已含对应中文时不重复）。
 *
 * 收录原则（宁缺勿编、绝不瞎编——表可以小，不能错）：
 * 1. 每条译名都**有把握**：要么是通用中文社区译法，要么是机械简化为公认中文词
 *    （旧字体/繁体形 → 简体形，如 処女 → 处女）；
 * 2. 词条在 eraAkumaMaid 实测名称表 / 文件名中存在，逐条注明来源；
 * 3. 口上作者可见度足够：kojo 文件按名引用 ≥ 30 次，或为文件名固定部件；
 * 4. **日汉同形词不收**（反抗的 / 屈服 / 欲情 / 好感度 / 奉仕精神 / 淫乱 /
 *    精液中毒 …——中文写法与日文逐字相同，对照无信息量）；
 * 5. **角色目录名一律不收**（75+ 个）：外来名（フェリシエル等）与汉字和名
 *    （成美 / 祥子 / 碧 …）均无通用中文社区译名可考，汉字和名更与中文同形；
 *    平假名名（さくら 等）经 CHARA CSV 证实无汉字写法可依（CHARA6 名前=さくら、
 *    CHARA16 名前=玉寄あんず、CHARA43 名前=秋月うお子 …），直观释义不属既有
 *    译名，误注风险大于收益 ⇒ 宁缺勿编。
 *
 * 条目构成（共 45 条）：变量名称表词条 37 条 + 文件/目录族片段 8 条 + 角色名 0 条。
 * 来源实测（eraAkumaMaid 日文原版，`C:\game\eraAkumaMaid`）：
 * - 变量名称表：`CSV` 下各表名称列（ABL / TALENT / PALAM / MARK / EX / BASE /
 *   EQUIP / TEQUIP / CFLAG …），kojo 频次为 EVENT_K 全树 ERB 的子串计数；
 * - 文件族：`ERB/EVENT_K/{no} {名前}/` 下 `EVENT_K{n}_DAILY / _CLOTHES / _COMM /
 *   _SELECT / _SHOP`（角色定位经各文件头注实测：挨拶・日常 / 独自衣装 / 部員同士の
 *   交流・会話 / もてなす選択肢 / 取引・買い物台詞）；
 * - 根层：`口上テンプレート` / `口上ライセンス一覧.txt` / `資料`。
 * `#Translation/Dictionary.txt` 为**英文**译名笔记，仅作语义佐证（见下），
 * 未采纳其中任何英文串充当中文译名。
 */
export const ERAAKUMA_MAID_NAME_GLOSSARY: Readonly<Record<string, string>> = Object.freeze({
  // ---- 变量名称表词条（CSV/*.csv 名称列；括注来源与 kojo 可见频次）----
  恋慕: '爱慕', // TALENT.csv #150；kojo 31509
  ふたなり: '扶她', // TALENT.csv #1；626
  男の娘: '伪娘', // TALENT.csv #3；220
  早漏: '早泄', // TALENT.csv #42；96
  小悪魔: '小恶魔', // TALENT.csv #109；249
  清楚: '清纯', // TALENT.csv #103；33（日汉 false friend：中文「清楚」= clear，必须对照）
  恥じらい: '羞涩', // TALENT.csv #84；678
  しっぽ: '尾巴', // TALENT.csv #181；146
  処女: '处女', // TALENT.csv #20；1501
  処女喪失: '处女丧失', // EX.csv #40；370
  貧乳: '贫乳', // TALENT.csv #33；334
  母乳体質: '母乳体质', // TALENT.csv #54；125
  避妊の護符: '避孕护符', // TALENT.csv #209；461
  出産経験: '出产经验', // TALENT.csv #22（EXP.csv 同族）；510
  押し倒し: '推倒', // TEQUIP.csv #30；4656
  バイブ: '振动棒', // TEQUIP.csv #11；2698
  アナルバイブ: '肛门振动棒', // TEQUIP.csv #13；347
  口枷: '口球', // TEQUIP.csv #45；387
  浣腸: '灌肠', // TEQUIP.csv #46；1007
  アイマスク: '眼罩', // TEQUIP.csv #43；207
  パンツ: '内裤', // EQUIP.csv #40；4319
  ブラ: '胸罩', // EQUIP.csv #41；922
  コンドーム: '避孕套', // EQUIP.csv #27；1316
  マゾっ気: '受虐倾向', // ABL.csv #20；488
  サドっ気: '施虐倾向', // ABL.csv #21；251
  露出癖: '暴露癖', // ABL.csv #6；354
  信頼: '信赖', // ABL.csv #0；461
  恭順: '恭顺', // PALAM.csv #0；61（JUEL:恭順 36 处正文使用）
  淫紋: '淫纹', // MARK.csv #8；1336
  絶頂: '绝顶', // BASE.csv #2 / EX.csv 系；5164
  欲求不満: '欲求不满', // BASE.csv #14；450
  寸止め: '寸止', // EX.csv #20~32 系；912
  中出し: '中出', // EX.csv #41/42、CFLAG.csv #56~59；1595
  噴乳: '喷乳', // EX.csv #8；226
  ピル: '避孕药', // CFLAG.csv #49 / ITEM.csv #61；1477（Dictionary.txt "Birth-Control Pill" 佐证）
  甘い言葉: '甜言蜜语', // TALENT.csv #139 / CFLAG.csv #27 / TEQUIP.csv #33；550（Dictionary.txt "Sweet Words" 佐证）
  呼び名: '称呼', // CSV/CHARA/*.csv「呼び名」行；317

  // ---- 文件/目录族片段（日文 → 中文；按实际形态收，逐个说明见头注）----
  テンプレート: '模板', // 工程根目录 口上テンプレート（eratw 同款先例）
  ライセンス: '授权信息', // 工程根文件 口上ライセンス一覧.txt（eratw 同款先例）
  資料: '资料', // 工程根目录 資料
  DAILY: '日常', // EVENT_K{n}_DAILY.ERB：各種挨拶・日常イベント口上
  CLOTHES: '服装', // EVENT_K{n}_CLOTHES.ERB：キャラ独自の衣装設定
  COMM: '会话', // EVENT_K{n}_COMM.ERB：部員同士での交流・会話口上（头注实测）
  SELECT: '选择', // EVENT_K{n}_SELECT.ERB：もてなすコマンドの選択肢追加
  SHOP: '商店', // EVENT_K{n}_SHOP.ERB：取引画面・お買い物の際の台詞
});

/** 词典键按**长度降序**（同长保序）——最长片段优先命中，避免「処女喪失」只命中短键「処女」。 */
const GLOSSARY_KEYS: readonly string[] = Object.keys(ERAAKUMA_MAID_NAME_GLOSSARY).sort(
  (a, b) => b.length - a.length,
);

/**
 * 给日文名加「（中文）」对照后缀（纯函数）。
 * - 取**最长**命中的日文键（避免「処女喪失」只命中短键「処女」）；
 * - 命中中文片段已在 name 里 → 原样返回（不重复添加）；
 * - 无命中 → 原样返回（fail-visible，绝不猜）。
 */
export function glossName(name: string): string {
  if (!name) return name;
  for (const key of GLOSSARY_KEYS) {
    if (name.includes(key)) {
      const zh = ERAAKUMA_MAID_NAME_GLOSSARY[key]!;
      if (name.includes(zh)) return name;
      return `${name}（${zh}）`;
    }
  }
  return name;
}
