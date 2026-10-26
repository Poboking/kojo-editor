/**
 * eraAV 适配器插件 —— 本包是**唯一**允许知道「eraAV / `ERB/Lines` 口上扁平文件 /
 * `ERB/EVENT/EVENT_K.ERB` 主路由 / `CSV/Chara` / `KOJO_MESSAGE_{家族}_{裸号}`」这些字眼的
 * 地方（架构铁律：游戏知识归 adapter，内核零游戏名词）。
 *
 * 本批＝ P0 布线 + P1 识别与导航 + **P2 语义层**（`conventions` / `conventionPolicy` /
 * `search.scope` / `nameGlossary`）。仍然没有的面：`kojoFaceTemplates` / `stateLinePresets` /
 * 2.0 面——四条都还没有语料实证，宁缺毋滥。
 *
 * **本作最反常的结构**（2026-10-26 真盘实测）：eraTW / eratohoK / eratohoReverse 的
 * 「一角色一口上目录」在这里不存在——`ERB/Lines/` 下是 17 份 `EVENT_K{nn}_{角色名}.ERB`
 * 散文件。`CharaInfo.kojoDir` 的契约语义是「该角色在口上域下的**目录**」，把公共父目录
 * 塞进去会让「按角色收窄」变成「按整个 Lines 搜」＝**看着能用、其实给出错的结果**，
 * 比留空更坏。故本批一律**不设** `kojoDir`（缺省＝该角色没有独立口上目录，消费方按契约
 * 降级），口上文件名只进 `inputDigest`；导航走「文件树 + 函数家族」两条腿。
 *
 * **P2 的 `search.scope` 就是这条裁决的合法出口**（2026-10-26）：不设 `kojoDir` 不等于
 * 「这个角色没有检索范围」——契约的 `SearchScopeOption.roots` 容得下**单个文件**
 * （「文件根只产出它自己」，`plugin-api/src/slots.ts:1438-1444`），于是本作按
 * 「一个角色 = 它那一份口上文件」给范围，既收窄又是语义正好。判据与逐环节复验见
 * `./search-scope.ts`；`kojo-project-kit` 那份投影在本作**恒空**（它只认 `kojoDir`），
 * 所以本包自带贡献物，不复用 kit。
 */

import type {
  AdapterDetectResult,
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  KojoInstructionTable,
  Plugin,
  VariableSchema,
} from '@kojo/plugin-api';
import { combineDigests, foldDigest, isErbBodyPath, isErbDeclarationPath, join } from '@kojo/plugin-api';
import { ERAAV } from './constants';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoFileName,
} from './chara-csv';
import { createEraavConventions } from './conventions';
import type { EraavKojoFileEntry, EraavKojoScan } from './kojo-scan';
import { ERAAV_NAME_GLOSSARY } from './name-glossary';
import { createEraavFamilyIndex } from './family-index';
import { eraavSearchScopeOptions } from './search-scope';
import { loadEraavInstructionNames, loadEraavVariableSchema } from './variable-schema';

/** 空指令表（未加载 / 缺表时返回它；`hasTable=false`，查啥都 undefined） */
const EMPTY_INSTRUCTION_TABLE: KojoInstructionTable = {
  hasTable: false,
  lookupByName: () => undefined,
  lookupByNo: () => undefined,
  names: () => [],
};

/** 创建 eraAV 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createEraavAdapterPlugin(): Plugin {
  return {
    id: 'eraav-adapter',
    version: '0.1.0',
    requires: ['kernel.io'],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');
      /** 变量字典（每次 `loadProject` 按当前工程 CSV/ERH 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 指令名表（同上；未加载 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable = EMPTY_INSTRUCTION_TABLE;
      /**
       * 口上域的**目录级事实**（角色号→文件、域内非 ERB 文件），由 `loadProject` 那一次
       * `listDir` 备好；约定规则以闭包取用（约定上下文没有 IO，见 `./kojo-scan.ts`）。
       */
      let kojoScan: EraavKojoScan | undefined;

      const adapter: GameAdapter = {
        gameId: ERAAV.gameId,
        displayName: ERAAV.displayName,
        functionFamilyIndex: createEraavFamilyIndex(),
        /** 四条规则的真盘命中清单与已否决规则的理由，全部写在 `./conventions.ts` 头注 */
        conventions: createEraavConventions(() => kojoScan),
        /**
         * 内置 `erb.duplicate-function` 在本盘发 **71 条** info，而它们几乎全是本作的**成对写法**：
         * 每份角色口上文件先写一条带 `#PRI`/`#LATER` 的存在判定、再写正体（`constants.ts` 的
         * 覆盖率读数同一事实）。真盘逐名量到的形状：`EVENTTRAIN` 18/35 处带 `#PRI`、
         * `EVENTEND` 19/36 处带 `#LATER`、`EVENTSHOP` 1/2 处——`EVENTSHOP` 那两处复验过就是同一形状
         * （`ERB/EVENT/EVENT_K.ERB:16` 是 `#PRI`＋`SIF FLAG:7 == 0 / FLAG:7 = 2` 的存在判定，
         * 正体在 `ERB/SYSTEM/SHOP_MAIN.ERB:13`）。按名字收敛后剩下的**才是**真重复
         * （实测 `@MISSION_RECEIVE_150` 两处、整组无判定，归本包 `chara-duplicate-shadow` 报 warning）。
         */
        conventionPolicy: [
          {
            ruleId: 'erb.duplicate-function',
            names: ['EVENTTRAIN', 'EVENTEND'],
            reason:
              '每份 ERB/Lines 角色文件各写一对「#PRI/#LATER 存在判定 + 正体」（真盘 EVENTTRAIN 18/35、EVENTEND 19/36 处带判定；TRAIN_MAIN.ERB:11/:304 与 EVENT_NEXTDAY.ERB:4 同形）——成对是引擎语义，不是作者写错',
          },
          {
            ruleId: 'erb.duplicate-function',
            names: ['EVENTSHOP'],
            reason:
              'EVENT_K.ERB:16 是 #PRI 存在判定（SIF FLAG:7 == 0 → FLAG:7 = 2），正体在 SHOP_MAIN.ERB:13 —— 与 EVENTTRAIN/EVENTEND 同一形状',
          },
        ],
        /** 日文名→中文名对照（展示用；整表由真盘 CSV/Chara 生成，生成口径见 `./name-glossary.ts` 头注） */
        nameGlossary: ERAAV_NAME_GLOSSARY,
        get variableSchema() {
          return currentSchema;
        },
        get kojoInstructionTable() {
          return currentInstructionTable;
        },

        async detect(rootDir: string): Promise<AdapterDetectResult> {
          // 1) 口上域必须是**目录**：本作住在 `ERB/Lines/`，只有同名散文件的半截工程不算成局。
          const linesStat = await io.stat(join(rootDir, ...ERAAV.detect.linesDir));
          if (linesStat?.isDirectory !== true) return { matched: false };
          // 2) 主路由必须**连父目录一起钉**：eraAkumaMaid 的主路由**同名** `EVENT_K.ERB`，
          //    只是住在 `ERB/EVENT_K/` 而非 `ERB/EVENT/`——只比文件名会把两盘认成同一个游戏。
          if (!(await io.exists(join(rootDir, ...ERAAV.detect.routerErb)))) return { matched: false };
          // 3) 自述表标题：`CSV/GameBase.csv:4` 原文 `タイトル,Erav优化整合版`，
          //    `README.md:11` 又写作 `eraAV` ⇒ 两种拼写都要认。
          const gameBase = join(rootDir, ...ERAAV.detect.gameBaseCsv);
          if (!(await io.exists(gameBase))) return { matched: false };
          try {
            const tf = await io.readText(gameBase);
            if (!ERAAV.detect.titlePattern.test(tf.text)) return { matched: false };
          } catch (err) {
            ctx.log.debug(`GameBase 读取失败（按不命中处理）：${gameBase} — ${String(err)}`);
            return { matched: false };
          }
          // evidence 是「多命中时报错说不出是谁撞的」的唯一解药（内核把它带上屏）
          return {
            matched: true,
            evidence: [
              'ERB/Lines 是目录',
              'ERB/EVENT/EVENT_K.ERB 在位（父目录与 eraAkumaMaid 的 ERB/EVENT_K 互斥）',
              `GameBase 标题匹配 ${ERAAV.detect.titlePattern.source}`,
            ],
          };
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERAAV.paths.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERAAV.paths.kojoRoot);
          const csvDir = join(rootDir, ...ERAAV.paths.csvDir);
          const erbRoot = join(rootDir, ...ERAAV.paths.erbRoot);

          const charaIndex = new Map<number, CharaInfo>();
          // 非 ERB 输入的摘要素材（Chara CSV 正文 + 口上文件名）：派生缓存的产出依赖它们，
          // 而 ERB 体量指纹覆盖不到 ⇒ 必须折进 inputDigest。
          const inputParts: string[] = [];

          // ---- 1. CSV/Chara/Chara{no}_{名前}.csv → 编号 / 名前 / 呼び名（实测 120 份）----
          let csvEntries: Awaited<ReturnType<FileIO['listDir']>>;
          try {
            csvEntries = await io.listDir(charaDir);
          } catch (err) {
            csvEntries = [];
            ctx.log.warn(`角色 CSV 目录不可读（角色索引为空）：${charaDir} — ${String(err)}`);
          }
          for (const entry of csvEntries) {
            if (entry.isDirectory) continue;
            if (!ERAAV.charaCsvPattern.test(entry.name)) continue;
            const noFromName = parseCharaNoFromFileName(entry.name);
            let parsed: ReturnType<typeof parseCharaCsv> = { no: null, name: null, callName: null };
            try {
              const tf = await io.readText(entry.path);
              parsed = parseCharaCsv(tf.text);
              inputParts.push(`chara\u0000${entry.path}\u0000${tf.text}`);
            } catch (err) {
              inputParts.push(`chara\u0000${entry.path}\u0000!unreadable`);
              ctx.log.warn(`Chara CSV 读取失败（跳过该文件）：${entry.path} — ${String(err)}`);
            }
            const no = parsed.no ?? noFromName;
            if (no === null) {
              ctx.log.warn(`无法确定角色编号（跳过）：${entry.name}`);
              continue;
            }
            // 名称回退链：名前 行 → 文件名名称段 → `Chara{no}`
            const info: CharaInfo = {
              no,
              name: parsed.name ?? charaNameFromFileName(entry.name) ?? `Chara${no}`,
            };
            if (parsed.callName) info.callName = parsed.callName;
            // 真盘实测 120/120 号**全局唯一**，所以这里的 warn 不是记账，而是防御面：
            // 汉化包/整合版若塞进第二份同号 CSV，必须在这一轮现形，而不是静默覆盖。
            if (charaIndex.has(no)) {
              ctx.log.warn(`角色编号重号（后读到的覆盖前者）：${no} ← ${entry.name}`);
            }
            charaIndex.set(no, info);
          }

          // ---- 2. 口上域是扁平文件：只登记文件名进摘要，不建 kojoDir（见文件头）----
          let kojoEntries: Awaited<ReturnType<FileIO['listDir']>>;
          try {
            kojoEntries = await io.listDir(kojoRoot);
          } catch (err) {
            kojoEntries = [];
            ctx.log.warn(`口上目录不可读（口上文件清单为空）：${kojoRoot} — ${String(err)}`);
          }
          /**
           * 口上域是扁平文件：登记文件名进摘要 + 备下**目录级事实**（角色号→文件、域内非 ERB
           * 文件），不给 `kojoDir`（见文件头）。这一份 `kojoScan` 同时喂两处消费方：
           * `search.scope` 的角色候选与 `conventions` 的两条目录级规则。
           */
          const kojoFileEntries: EraavKojoFileEntry[] = [];
          const nonErbFiles: string[] = [];
          for (const entry of kojoEntries) {
            if (entry.isDirectory) continue;
            inputParts.push(`kojoFile\u0000${entry.name}`);
            // 计数走解析函数（内含 `isErbBodyPath` 的扩展名真源），不在这里再判一次文件名
            const parsed = parseKojoFileName(entry.name);
            if (parsed !== null) {
              kojoFileEntries.push({ no: parsed.no, path: entry.path, label: parsed.label });
              continue;
            }
            // 解析不出口上文件名 ≠ 该当"外来文件"：`.ERB/.ERH/.ERM` 都是域内合法文件
            //（实测本域只有 17 份 `.ERB` + 1 份 `.txt`，域内无 `.ERH`）
            // 扩展名一律走契约谓词，本包不抄字面量（副本闸：plugin-api/tests/erb-ext.test.ts）
            if (!isErbBodyPath(entry.name) && !isErbDeclarationPath(entry.name)) {
              nonErbFiles.push(entry.path);
            }
          }
          kojoScan = { kojoFiles: kojoFileEntries, nonErbFiles };
          const kojoFiles = kojoFileEntries.length;

          // ---- 3. 变量字典（CSV 主表 + .ERH 作者自定名表；缺 CFLAG 四表是常态）----
          // 字典失败**不阻断**工程加载：没字典只是补全少名字，口上照常能读能改。
          try {
            currentSchema = await loadEraavVariableSchema({ io, csvDir, erbDir: erbRoot, log: ctx.log });
          } catch (err) {
            currentSchema = undefined;
            ctx.log.warn(`变量字典加载失败（本次不带字典，工程照常打开）：${String(err)}`);
          }

          // ---- 4. 指令名表（CSV/Train.csv，实测 181 行 / 105 条）----
          try {
            currentInstructionTable = await loadEraavInstructionNames({ io, csvDir, log: ctx.log });
          } catch (err) {
            currentInstructionTable = EMPTY_INSTRUCTION_TABLE;
            ctx.log.warn(`指令名表加载失败（本次不带指令表，工程照常打开）：${String(err)}`);
          }

          ctx.log.info(
            `eraAV 工程加载完成：${charaIndex.size} 个角色（口上扁平文件 ${kojoFiles} 份，` +
              `本作无角色口上目录 ⇒ 角色级检索范围按**文件根**给，覆盖 ${kojoFiles} 个角色；` +
              `域内非 ERB 文件 ${nonErbFiles.length} 份），口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERAAV.gameId,
            // 索引吃整棵 ERB：路由与公共函数都在根层（`附件/` 天然在外）
            kojoPaths: [erbRoot],
            // 可写面 = 口上域 `ERB/Lines`；其余只读
            writablePaths: [kojoRoot],
            charaIndex,
            inputDigest:
              combineDigests([
                foldDigest(inputParts),
                ...(currentSchema?.inputDigest ? [currentSchema.inputDigest] : []),
              ]) ?? undefined,
          };
        },
      };

      ctx.slots.register('game.adapter', { id: `${ERAAV.gameId}-adapter`, adapter });

      /**
       * 检索范围：角色级收窄，但**根是那一份口上文件**（不是目录）——本作没有角色口上目录，
       * `CharaInfo.kojoDir` 一律不设（见文件头与 `docs/PITFALLS.md` 229），故**不走** kit 的
       * `charaSearchScopeOptions`（它只认 `kojoDir`，在本作恒空），本包按同一种标签口径自己给。
       * `provide` 零 IO：`no → path` 由 `loadProject` 备好的 `kojoScan` 以闭包递进来
       * （契约「纯函数纪律」`plugin-api/src/slots.ts:1454-1456`）；没有口上文件的角色
       * **不产候选**（实测 120 个角色里 17 个有文件 ⇒ 103 个不出现）。
       * 注册形态与 eratohoReverse 同（`eratohoreverse-adapter/src/plugin.ts:235-242`）：
       * 只认本项目，`order: 10` 与其它 adapter 同值——同时在场按项目归属过滤，不靠 order 分胜负。
       */
      ctx.slots.register('search.scope', {
        id: `${ERAAV.gameId}-chara-scope`,
        order: 10,
        provide: (project) =>
          project !== null && project.adapterId === ERAAV.gameId
            ? eraavSearchScopeOptions(project.charaIndex.values(), kojoScan?.kojoFiles ?? [])
            : [],
      });
    },
  };
}
