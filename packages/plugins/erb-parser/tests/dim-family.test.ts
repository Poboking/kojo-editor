/**
 * LS-DIM · `#DIM` 族覆盖面（判据只住扫描器那一处）。
 *
 * ## 两件事，各自带数
 * 1. **族成员**：`DIM_RE` 此前只认 `DIMSTR|DIMCHAR|DIMS|DIM` ⇒ `#DEFINE`（基线语料 22 行）
 *    一条不收、`#DIMF`（契约注释早就自称含它，实现里没有 = 假文档）同样收不到。
 *    补齐依据取本仓唯一的引擎侧字面来源：`eratw-adapter/variable-schema.ts` 的
 *    `parseErhConsts` 认 `DIMS|DIMF|DIM|DEFINE`，`plugin-api/erb-ext.ts` 把 `.ERH` 说成
 *    "`#DIM`/`#DIMS`/`#DEFINE` 容器"。
 * 2. **前置关键字表**：漏一个词 = 那一行的**变量名被记成那个关键字**。基线语料实测
 *    2,866 行因此进了假名（`#DIM DYNAMIC CNT_CHARA` → 索引里的名字是 `DYNAMIC`），
 *    悬停 / `#DIM` 声明补全 / `#DIM` 引用查找都指着这条假记录。
 *
 * ## 显式不收的两种形态（负例，各带读数）
 * - **逗号多变量**：`#DIM a, b` 的第二槽是**数组尺寸**。基线语料 1,774 条带顶层逗号的声明行里
 *   第二槽是数字 1,371 条、是标识符的 158 条**全部**是尺寸常量名（`MAX_CARD_PL` /
 *   `LIST_MAX_SORT` / `MAX_COLUMN_GROUP`），其余 245 条是表达式或 `=` 初值串。
 *   一个多变量形都没有 ⇒ 按"逗号=多变量"拆就是造 1,774 条假名字，**不做**。
 * - **`#LOCALSIZE` / `#LOCALSSIZE`**（同族、量大：基线语料 8,573 + 8,536 = 17,109 行）：
 *   函数局部作用域，而 `ErbDim` 没有作用域字段 ⇒ 收进 `file.dims` 就等于宣称
 *   "这个文件里别的功能也声明了它"。要收得先给契约加作用域（跨包动作，另单）。
 */
import { describe, expect, it } from 'vitest';
import { parseDimDeclaration, parseErbText } from '../src/scanner';
import { SNAPSHOT_VERSION, coerceSnapshot, salvageSnapshot, snapshotKeyCandidatesFor, snapshotKeyFor } from '../src/snapshot';

describe('erb-parser · #DIM 族成员', () => {
  it('#DIMF / #DEFINE 现在进得了索引（此前一条不收）', () => {
    expect(parseDimDeclaration('#DIMF F, 10')).toEqual({ directive: 'DIMF', name: 'F' });
    expect(parseDimDeclaration('#DEFINE 時間帯 TIME:2')).toEqual({ directive: 'DEFINE', name: '時間帯' });
    expect(parseDimDeclaration('#DEFINE DEF_CULC_RELATION_NULL VARSIZE("TALENT") + 1')).toEqual({
      directive: 'DEFINE',
      name: 'DEF_CULC_RELATION_NULL',
    });
  });

  it('交替次序是长的在前：`#DIMF` 不许退化成 `#DIM` + 假名字', () => {
    expect(parseDimDeclaration('#DIMF 倍率')).toEqual({ directive: 'DIMF', name: '倍率' });
    // 族词必须是完整 token：`#DIMFOO x` 里既没有 `#DIM`（后跟 `F` 不是空白）也没有 `#DIMF`（后跟 `O`）
    expect(parseDimDeclaration('#DIMFOO x')).toBeNull();
    expect(parseDimDeclaration('#DIMX 假名')).toBeNull();
    expect(parseDimDeclaration('#DEFINED 假名')).toBeNull();
  });

  it('既有成员与大小写不敏感照旧（DIM / DIMS / DIMSTR / DIMCHAR）', () => {
    expect(parseDimDeclaration('#DIM 喘ぎ強度')).toEqual({ directive: 'DIM', name: '喘ぎ強度' });
    expect(parseDimDeclaration('#DIMS 名前')).toEqual({ directive: 'DIMS', name: '名前' });
    expect(parseDimDeclaration('#DIMSTR リスト, 10')).toEqual({ directive: 'DIMSTR', name: 'リスト' });
    expect(parseDimDeclaration('#dimchar 假名, 3')).toEqual({ directive: 'DIMCHAR', name: '假名' });
    expect(parseDimDeclaration('#dimf 倍率')).toEqual({ directive: 'DIMF', name: '倍率' });
    expect(parseDimDeclaration('#define 最大 100')).toEqual({ directive: 'DEFINE', name: '最大' });
  });
});

describe('erb-parser · #DIM 前置关键字（假名修复）', () => {
  it('LOCAL / STATIC / DYNAMIC / OUT / CHARADATA 不再被当成变量名', () => {
    // 基线语料实测 2,866 行走的就是这条形状（修复前 name 就是那个关键字）
    expect(parseDimDeclaration('#DIM DYNAMIC CNT_CHARA')).toEqual({ directive: 'DIM', name: 'CNT_CHARA' });
    expect(parseDimDeclaration('#DIMS DYNAMIC strImgSet1')).toEqual({ directive: 'DIMS', name: 'strImgSet1' });
    expect(parseDimDeclaration('#DIM LOCAL i')).toEqual({ directive: 'DIM', name: 'i' });
    expect(parseDimDeclaration('#DIM STATIC 表, 10')).toEqual({ directive: 'DIM', name: '表' });
    expect(parseDimDeclaration('#DIMS OUT 结果')).toEqual({ directive: 'DIMS', name: '结果' });
    // 关键字链（`CHARADATA` 打头共 85 行，其中 `#DIM CHARADATA SAVEDATA …` 这种两词链 53 行；
    // 本盘用**旧**表就能剥掉多重修饰词的行是 24 行 ⇒ 链式剥离这条判据照旧成立）
    expect(parseDimDeclaration('#DIM CHARADATA SAVEDATA STcvar, 10')).toEqual({ directive: 'DIM', name: 'STcvar' });
  });

  it('既有修饰词一个不回归（CONST / SAVEDATA / GLOBAL / REF / NOINIT / CHARA）', () => {
    expect(parseDimDeclaration('#DIM CONST 省略前括号 = 1')).toEqual({ directive: 'DIM', name: '省略前括号' });
    expect(parseDimDeclaration('#DIM SAVEDATA 记录')).toEqual({ directive: 'DIM', name: '记录' });
    expect(parseDimDeclaration('#DIM GLOBAL 计数')).toEqual({ directive: 'DIM', name: '计数' });
    expect(parseDimDeclaration('#DIM REF     TALKER')).toEqual({ directive: 'DIM', name: 'TALKER' });
    expect(parseDimDeclaration('#DIM NOINIT 初值')).toEqual({ directive: 'DIM', name: '初值' });
    expect(parseDimDeclaration('#DIM CHARA 角色槽')).toEqual({ directive: 'DIM', name: '角色槽' });
  });

  it('关键字**后跟空白**才算修饰词：真名叫 CHARA / out 的行不许被吃穿', () => {
    // 真语料形态 `#DIM DYNAMIC CHARA, 人物数量上限`（33 行）：DYNAMIC 是修饰词、CHARA 是变量名
    expect(parseDimDeclaration('#DIM DYNAMIC CHARA, 人物数量上限')).toEqual({ directive: 'DIM', name: 'CHARA' });
    // 真语料形态 `#DIM DYNAMIC out`（2 行）：变量就叫 out，行尾没有下一个 token
    expect(parseDimDeclaration('#DIM DYNAMIC out')).toEqual({ directive: 'DIM', name: 'out' });
    expect(parseDimDeclaration('#DIM CHARA, 10')).toEqual({ directive: 'DIM', name: 'CHARA' });
    // `TEMP` **不在**引擎前置关键字表里（真语料 41 行 `#DIM TEMP, …` 声明的变量名就叫 TEMP）⇒ 不吃
    expect(parseDimDeclaration('#DIM TEMP, 10')).toEqual({ directive: 'DIM', name: 'TEMP' });
    expect(parseDimDeclaration('#DIM DYNAMIC')).toEqual({ directive: 'DIM', name: 'DYNAMIC' }); // 畸形行（声明没有变量）：留原样，本盘 0 行（见提交信息）
  });

  it('负例：逗号槽是尺寸不是第二个变量（按多变量拆会造 1,774 条假名）', () => {
    expect(parseDimDeclaration('#DIM a, b')).toEqual({ directive: 'DIM', name: 'a' });
    expect(parseDimDeclaration('#DIMS SORT_TARGET , LIST_MAX_SORT')).toEqual({ directive: 'DIMS', name: 'SORT_TARGET' });
    expect(parseDimDeclaration('#DIMS 賭け = "丁", "半"')).toEqual({ directive: 'DIMS', name: '賭け' });
    const file = parseErbText('#DIM a, b\n@F\n\tRETURN 1\n', '/a.ERB');
    expect(file.dims.map((d) => d.name)).toEqual(['a']);
  });
});

describe('erb-parser · #DIM 族的索引面与快照面', () => {
  it('端到端：三种族的声明都进 `dims`，行号与指令一一对应', () => {
    const file = parseErbText('#DIM DYNAMIC CNT\n#DEFINE 時間帯 TIME:2\n#DIMF 倍率, 4\n@F\n\tRETURN 1\n', '/a.ERB');
    expect(file.dims).toEqual([
      { name: 'CNT', directive: 'DIM', line: 1 },
      { name: '時間帯', directive: 'DEFINE', line: 2 },
      { name: '倍率', directive: 'DIMF', line: 3 },
    ]);
  });

  it('口径变了 ⇒ 版本必须抬、上一代必须出表（这条判据是唯一挡住假名的东西）', () => {
    // 上一代盘上形态：`#DIM DYNAMIC CNT` 被记成 name=`DYNAMIC`（本批判为假事实的 2,866 行之一）。
    // 它的**元组结构与当前版本逐字相符**——结构校验挡不住陈旧值，只有版本判据挡得住。
    const legacyEntries: Record<string, unknown[]> = {
      '/a.ERB': [1000, 12, 12, 1, 0, [], [['DYNAMIC', 'DIM', 1]], [], [], null],
    };
    const currentShape = { version: SNAPSHOT_VERSION, rootDir: 'D:/p', savedAt: 1, entries: legacyEntries };
    // ① 结构本身是合法的当前形态 ⇒ 证明"拒它"靠的绝不是结构（假名条目照样能过结构校验）
    expect(coerceSnapshot(currentShape, 'D:/p')).not.toBeNull();
    // ② 于是本批必须抬版本：9 是 LS-DIM 之前的那一代（`dims.name` 还是关键字）
    expect(SNAPSHOT_VERSION, 'LS-DIM 改了 dims.name 的值语义 ⇒ 版本必须高于 9').toBeGreaterThan(9);
    // ③ 且 9 永远不进准入表：条目键是绝对路径、值是陈旧假名 ⇒ 复用 = 索引脏数据
    expect(snapshotKeyCandidatesFor('D:/p')).not.toContain(snapshotKeyFor('D:/p', 9));
    expect(salvageSnapshot({ ...currentShape, version: 9 }, { rootDir: 'D:/p', key: snapshotKeyFor('D:/p', 9) })).toBeNull();
    expect(coerceSnapshot({ ...currentShape, version: 9 }, 'D:/p')).toBeNull();
    expect(snapshotKeyCandidatesFor('D:/p')).toContain(snapshotKeyFor('D:/p'));
  });
});
