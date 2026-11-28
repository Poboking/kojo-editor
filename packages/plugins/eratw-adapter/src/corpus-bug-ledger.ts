/**
 * P3-10 · CB 规则库（eratw `specs/corpus-bugs.md` 36 案 → kojo 判据库映射）。
 *
 * 台账口径（照 corpus-bugs.md §2 判定纪律）：CB 案是**随包语料内容缺陷**，eratw 侧
 * 走编译期内容补丁修（真语料零改动）；kojo 编辑器侧的价值 = 把其中**可静态判的模式**
 * 变成判据（consumed），或认领到已有的判据面（covered-by），其余逐案写明判据缺口
 * （not-covered）——「暂不支持」空话不许入账。平台适配补丁（触屏）不构成判据（platform-na）。
 *
 * 状态语义：
 * - `consumed`：kojo 侧有对应判据在产诊断（where 指到落点文件）；
 * - `covered-by`：该案的模式已被既有判据面覆盖（where 指到规则 id 与判据点）；
 * - `not-covered`：尚无判据，where 必须具体到缺的能力（数据流/表解析/建模）；
 * - `platform-na`：平台适配或非代码判据（素材像素取证），编辑器无从立判。
 */

export type CorpusBugStatus = 'consumed' | 'covered-by' | 'not-covered' | 'platform-na';

export interface CorpusBugLedgerEntry {
  readonly id: string;
  readonly status: CorpusBugStatus;
  /** consumed/covered-by = 落点（文件/规则 id）；not-covered = 缺什么能力；platform-na = 为何无从立判 */
  readonly where: string;
  /** 锚：specs/corpus-bugs.md 案号 + C# 或语料 文件:行号 */
  readonly anchor: string;
}

export const ERB_CORPUS_BUG_LEDGER: readonly CorpusBugLedgerEntry[] = [
  {
    id: 'CB-001',
    status: 'not-covered',
    where:
      '「零参声明带实参调用」在 snake 4.981 是静默丢弃（ConvertArg 删了 TooManyFuncArgs 硬判），' +
      '照实报「实参被丢弃」会与官方语义打架、按 1.824 报「参数过多」则与复刻目标相反——' +
      '需要先立「按方言档选口径」的用户函数 arity 闸（P1-6 的四档面已就位，差消费判据），另案',
    anchor: 'specs/corpus-bugs.md CB-001；reference/emuera-skia-4.981 Process.CalledFunction.cs:212-357',
  },
  {
    id: 'CB-002',
    status: 'covered-by',
    where:
      '`plugins/eratw-adapter/src/variable-bounds-impl.ts`（`erb.variable-bounds`，P1-4）：' +
      '尺寸先读游戏 CSV/VariableSize.csv 覆盖出厂值，正是本案「混装包 ITEMNAME 1000 vs 1200」的判据根',
    anchor: 'specs/corpus-bugs.md CB-002；ConstantData.cs:309-551',
  },
  {
    id: 'CB-003',
    status: 'not-covered',
    where:
      '报错串「未找到 ERD 表」在官方全库零命中、病灶形态证据不足——判据无从立起，' +
      '先要端点/复现侧把「裸名 vs 维度」定案（corpus-bugs.md 判定栏原文）',
    anchor: 'specs/corpus-bugs.md CB-003；ConstantData.cs:1193/:1199/:1201',
  },
  {
    id: 'CB-004',
    status: 'consumed',
    where:
      '`packages/plugins/eratw-adapter/src/engine-line-checks-impl.ts`（`erb.engine-line-checks`，(h)）：' +
      'GETBIT/SETBIT/CLEARBIT/BITXOR 第 2 参字面 ∉ 0..63 报引擎键 `ArgIsOoRBit` 原话；' +
      '本案病灶（GETBIT(STAIN:ARG:2,64)）在 [SKIPSTART] 死区内——可见行尺天然豁免，不误报',
    anchor: 'specs/corpus-bugs.md CB-004；FunctionMethodCreator.cs:4783-4786',
  },
  {
    id: 'CB-005',
    status: 'not-covered',
    where:
      '「[[旧译名]] 键不在改名表」需解析项目 CSV/_Rename.csv + CSV 名字表（多根/代差），' +
      '且 `[[…]]` 是装载期替换、编辑器需复刻同一替换序（EraStreamReader.cs:106-119）才有零误报口径，另案',
    anchor: 'specs/corpus-bugs.md CB-005；EraStreamReader.cs:106-119；LexicalAnalyzer.cs:811-813',
  },
  {
    id: 'CB-006',
    status: 'not-covered',
    where:
      '「GOTO 路径漏清局部变量」是跨语句状态残留（同帧多路径汇入 + 下一帧 THROW），' +
      '需要函数内控制流/数据流分析（GOTO 不建帧、CALL 建帧的生命周期建模），静态行级判据不可证',
    anchor: 'specs/corpus-bugs.md CB-006；VariableEvaluator.cs:1339；Process.cs:1796-1797',
  },
  {
    id: 'CB-007',
    status: 'covered-by',
    where:
      '`plugins/eratw-adapter/src/variable-bounds-impl.ts`（`erb.variable-bounds`，P1-4）：' +
      '#DIM CONST 用户尺寸（MAXPANTS=34）+ 字面 35 越界，CB-007 正是 P1-4 的自证三例之一',
    anchor: 'specs/corpus-bugs.md CB-007；CharaVariableToken.cs:56-70',
  },
  {
    id: 'CB-008',
    status: 'not-covered',
    where: '同 CB-006 的跨语句状态残留（表单编辑删列路径漏清三个局部），数据流建模另案',
    anchor: 'specs/corpus-bugs.md CB-008；TEMP_CHARA_LIST_BY_DT_FUNC.ERB:1410-1453',
  },
  {
    id: 'CB-009',
    status: 'not-covered',
    where:
      '「特殊ワープ到达不清道中计数」是语料级玩法状态机缺陷（三条复位链对照），' +
      '判据需要跨函数的标志位生命周期建模，编辑器静态面不可证',
    anchor: 'specs/corpus-bugs.md CB-009；SET_CMN.ERB:268/:331-332；EVENTCOMEND2.ERB:62-79',
  },
  {
    id: 'CB-010',
    status: 'not-covered',
    where:
      '「LOCAL 跨 CALL 持久 + 入口未归零」依赖 LOCAL 的持久语义本身是官方设计（ENGFIX-1 已按反编译拆除引擎侧门控），' +
      '编辑器判「哪个 LOCAL 该入口归零」需语义级意图推断，不可静态判——宁可漏报',
    anchor: 'specs/corpus-bugs.md CB-010；VariableEvaluator.cs:1737/:2816/:2992（蛇版）',
  },
  {
    id: 'CB-011',
    status: 'not-covered',
    where:
      '「SIF argCanselNo || (…) 恒真」是参数名当布尔用的笔误——通用化 = 「左操作数是变量名恒真」判定，' +
      '需要对「取消号非 0」的值域建模，误报面大，另案',
    anchor: 'specs/corpus-bugs.md CB-011；verify-notes.md §22.1:1864-1877',
  },
  {
    id: 'CB-012',
    status: 'platform-na',
    where: '颜绘素材错位（效果层登记与 base 切换的演出歧义）是像素取证面，非代码判据，编辑器无从立判',
    anchor: 'specs/corpus-bugs.md CB-012；resources/EN_IMG/327/327 Res.csv:1680-1681',
  },
  {
    id: 'CB-013',
    status: 'consumed',
    where:
      '`packages/plugins/eratw-adapter/src/engine-line-checks-impl.ts`（`erb.engine-line-checks`，(h)）：' +
      'GETBIT 字面位域越界（本案 150 = SHOP 按钮值串进位参）——字面判据同 CB-004，动态值（残留 INPUT 值）漏报按「宁可漏报」接受',
    anchor: 'specs/corpus-bugs.md CB-013；Creator.Method.cs:5238-5247（蛇版）；FunctionMethodCreator.cs:4783-4786',
  },
  {
    id: 'CB-014',
    status: 'not-covered',
    where:
      '「SPLIT 只写容量段却报全量段数」+ FOR 读越界，需要 SPLIT 写面、容量声明（VARSIZE）与循环上界的跨语句数据流建模，另案',
    anchor: 'specs/corpus-bugs.md CB-014；Process.ScriptProc.cs:549-565（蛇版）',
  },
  {
    id: 'CB-015',
    status: 'not-covered',
    where:
      '硬编码角色号（CFLAG:139:998）越界需 CHARANUM 守卫建模（P1-4 已留账同款：存档角色数是运行期事实，' +
      '静态只能判「字面 ≥ 当前 CSV 装载序上界」一类弱口径，误报风险高），另案',
    anchor: 'specs/corpus-bugs.md CB-015；VariableToken.cs:308-309（蛇版）',
  },
  {
    id: 'CB-016',
    status: 'not-covered',
    where: '数值失衡（SQRT(信赖度)/8 无上限）是玩法语义级缺陷，静态判据无法区分「设计如此」与「失衡」，不立',
    anchor: 'specs/corpus-bugs.md CB-016；EVENTTURNEND.ERB:22-31；NASIKUZUSI.ERB:582-592',
  },
  {
    id: 'CB-017',
    status: 'not-covered',
    where: '同 CB-016 的另一半（正反馈倍率无衰减），玩法语义级，不立',
    anchor: 'specs/corpus-bugs.md CB-017；SOURCE_1.ERB:443-447/:456-487/:649-654',
  },
  {
    id: 'CB-018',
    status: 'platform-na',
    where: '动态立绘触屏适配（悬停帧代换入口），平台适配补丁，非判据',
    anchor: 'specs/corpus-bugs.md CB-018；ConsoleImagePart.cs:249-255',
  },
  {
    id: 'CB-019',
    status: 'platform-na',
    where: 'CB-018 的配套声明位补丁，平台适配，非判据',
    anchor: 'specs/corpus-bugs.md CB-019；ErbLoader.cs:413-423；Process.cs:309/:313',
  },
  {
    id: 'CB-020',
    status: 'not-covered',
    where:
      '「显示号 = 400+CHARANUM 幻影号」越界需 CHARANUM 建模 + 跨函数（QOL_DISH_DISPLAY_TOP 开闭区间口径）数据流，同 CB-015 族另案',
    anchor: 'specs/corpus-bugs.md CB-020；CharaVariableToken.cs:56-70',
  },
  {
    id: 'CB-021',
    status: 'not-covered',
    where: '反解析幻影号边界网（owner 域判定需 CHARANUM + 槽位映射语义），同 CB-015 族另案',
    anchor: 'specs/corpus-bugs.md CB-021；DISHDATA.ERB:29-37/:85-86',
  },
  {
    id: 'CB-022',
    status: 'not-covered',
    where: '「显示号非法性只能由 owner 域判定，不能由 INRANGE 上界判定」——判据本身写在台账里，静态面需 owner 域建模，另案',
    anchor: 'specs/corpus-bugs.md CB-022；SHOP.ERB:850-870',
  },
  {
    id: 'CB-023',
    status: 'not-covered',
    where:
      '「`CFLAG:既成事實` 关键字不在 CSV/别名表」是 CB 族里编辑器价值最高的一块（改名未留别名 = 261111 发行回归），' +
      '判据需解析项目 29 槽 CSV 主名表 + .als 别名 + #DEFINE 宏 fail-open——判据能力不在位，另案优先排',
    anchor: 'specs/corpus-bugs.md CB-023；ConstantData.cs:1834-1841/:711-737；VariableRegistry.kt:646',
  },
  {
    id: 'CB-024',
    status: 'not-covered',
    where: '同 CB-023（FLAG.als 60 键丢失），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-024；ConstantData.cs:711-737',
  },
  {
    id: 'CB-025',
    status: 'not-covered',
    where: '同 CB-023（Talent.als 26 键丢失），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-025；ConstantData.cs:711-737',
  },
  {
    id: 'CB-026',
    status: 'not-covered',
    where: '同 CB-023（exp.als 16 键丢失），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-026；ConstantData.cs:711-737',
  },
  {
    id: 'CB-027',
    status: 'not-covered',
    where: '同 CB-023（TCVAR.als 7 键丢失），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-027；ConstantData.cs:711-737',
  },
  {
    id: 'CB-028',
    status: 'not-covered',
    where: '同 CB-023（TFLAG.als 3 键丢失），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-028；ConstantData.cs:711-737',
  },
  {
    id: 'CB-029',
    status: 'not-covered',
    where: '同 CB-023（Abl.als 2 键丢失），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-029；ConstantData.cs:711-737',
  },
  {
    id: 'CB-030',
    status: 'not-covered',
    where: '同 CB-023（改名未留别名 ITEM 催情薬），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-030；CSV/Item.als',
  },
  {
    id: 'CB-031',
    status: 'not-covered',
    where: '同 CB-023（改名未留别名 TEQUIP 振動棒/肛用振動棒），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-031；CSV/Tequip.als',
  },
  {
    id: 'CB-032',
    status: 'not-covered',
    where: '同 CB-023（改名未留别名 EX 処女喪失记号），待 CSV 表解析判据另案',
    anchor: 'specs/corpus-bugs.md CB-032；CSV/ex.als',
  },
  {
    id: 'CB-033',
    status: 'consumed',
    where:
      '`packages/plugins/eratw-adapter/src/variable-bounds-impl.ts`（`erb.variable-bounds`，P1-4 扩判）：' +
      '全局数组**负字面下标**（ITEM:-1）必然越界，报 `OoRVarArg` 原话——与本案玩家屏上文案逐字同形；' +
      '调用方把哨兵值存变量后动态用（SELECT_ING=-1 → ITEM:SELECT_ING）不在此判（动态 fail-open，宁可漏报）',
    anchor: 'specs/corpus-bugs.md CB-033；VariableToken.cs:1326（Int1D 负下标抛）',
  },
  {
    id: 'CB-034',
    status: 'platform-na',
    where: '触屏「选完子选单立即执行」适配（声明位），平台适配补丁，非判据',
    anchor: 'specs/corpus-bugs.md CB-034；ErbLoader.cs:413-423；Process.cs:309/:313',
  },
  {
    id: 'CB-035',
    status: 'platform-na',
    where: '触屏适配信号位置位补丁（@COM_OPTION_BODY 选中分支置 COM_OPTION_SELECTED=1），平台适配，非判据',
    anchor: 'specs/corpus-bugs.md CB-035；QOL_USERCOM.ERB:291-302',
  },
  {
    id: 'CB-036',
    status: 'platform-na',
    where: '触屏适配重派发补丁（GOTO 落点在入口守卫之前），平台适配，非判据',
    anchor: 'specs/corpus-bugs.md CB-036；USERCOM.ERB:388-392/:93-134',
  },
];
