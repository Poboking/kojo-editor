/**
 * eraAkumaMaid 适配器插件 —— 本包是**唯一**允许知道「eraAkumaMaid / EVENT_K /
 * CHARA CSV」这些字眼的地方（架构文档 §5.1 / §5.7「游戏知识归 adapter」）。
 *
 * 落地形态照 eratw-adapter（packages/plugins/eratw-adapter）裁剪：
 * - detect / loadProject / 语义层提供方（family-index / variableSchema /
 *   conventions / kojoCallProtocol / kojoInstructionTable / kojoFaceTemplates /
 *   nameGlossary）；
 * - 「我的口上项目」面板与向导族**不在本版**（P4：先抽取共享骨架、两适配器共用，
 *   见 docs/PLAN-eraAkumaMaid-adapter.md 决策②——不复制一份 eratw 向导代码）。
 *
 * 与 eraTW 的核心差异（命名体系）：eraTW 是中缀 `M_KOJO_K{n}_{家族}`，本游戏是
 * **后缀式 `{家族}_K{n}`**；主路由 = `ERB/EVENT_K/EVENT_K.ERB`（= eraTW 的
 * `KOJO_MESSAGE.ERB` 等价物）；无静态 sav/ 目录（故不提议 savDir）。
 */

import type {
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  KojoInstructionTable,
  MarketService,
  Plugin,
  VariableSchema,
} from '@kojo/plugin-api';
import { MARKET_SERVICE_KEY, combineDigests, foldDigest, join } from '@kojo/plugin-api';
import { ERAAKUMA_MAID } from './constants';
import {
  deriveCharaNoFromFileNames,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from './chara-csv';
import { clearKojoFamilyMemo, createErakumamaidFamilyIndex } from './family-index';
import { createErakumamaidConventions } from './conventions';
import { loadErakumamaidVariableSchema } from './variable-schema';
import { loadErakumamaidCallProtocol, type ErakumamaidCallProtocol } from './call-protocol';
import { EMPTY_INSTRUCTION_TABLE, loadErakumamaidInstructionTable } from './instruction-table';
import { createErakumamaidFaceTable } from './face-templates';
import { ERAAKUMA_MAID_NAME_GLOSSARY } from './name-glossary';

/** 创建 eraAkumaMaid 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createErakumamaidAdapterPlugin(): Plugin {
  return {
    id: 'eraakumamaid-adapter',
    version: '0.1.0',
    // 适配器核心只依赖内核 io（面板/向导族属 P4 共享骨架，届时再扩 requires）
    requires: ['kernel.io'],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');

      /**
       * 市场服务（**惰性取**；字典包追加名表 KM-15 用）。
       * `kojo-market` 可能比本插件晚激活 ⇒ 用到的那一刻才 tryInject；
       * 取出失败 ⇒ null（调用方按"没有市场"降级，绝不让项目加载挂掉）。
       */
      const tryMarket = (): MarketService | null => {
        try {
          return ctx.tryInject<MarketService>(MARKET_SERVICE_KEY) ?? null;
        } catch (err) {
          // 测试壳等未实现 tryInject 的上下文：与"市场缺席"同义
          ctx.log.warn(`市场服务获取失败（按未安装处理）：${String(err)}`);
          return null;
        }
      };

      /** 变量字典（每次 loadProject 时按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 口上调用协议（loadProject 时解析路由表，失败 → undefined 优雅降级） */
      let currentProtocol: ErakumamaidCallProtocol | undefined;
      /** 指令名表（loadProject 时读 `CSV/Train.csv`，缺表 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable | undefined;

      const adapter: GameAdapter = {
        gameId: ERAAKUMA_MAID.gameId,
        displayName: ERAAKUMA_MAID.displayName,
        functionFamilyIndex: createErakumamaidFamilyIndex(),
        // 覆盖规则消费已解析的路由协议（loadProject 时填充；缺省 → 规则降级）
        conventions: createErakumamaidConventions(() => currentProtocol),
        get variableSchema() {
          return currentSchema;
        },
        get kojoCallProtocol() {
          return currentProtocol;
        },
        // 指令名表——读当前项目表；未加载 = 空表实例（糖层查表恒有其一枚）
        get kojoInstructionTable(): KojoInstructionTable {
          return currentInstructionTable ?? EMPTY_INSTRUCTION_TABLE;
        },
        // 时机分野模板表——纯数据、无 IO：转译器转译时经槽位取用，恒可用
        kojoFaceTemplates: createErakumamaidFaceTable(),
        // 日文名 → 中文名对照词典（只加显示备注，不改任何实际目录/文件名）
        nameGlossary: ERAAKUMA_MAID_NAME_GLOSSARY,

        async detect(rootDir: string): Promise<boolean> {
          // 特征组合：口上域主路由文件 + CHARA CSV 目录（同时存在才成局）
          const routeFile = join(rootDir, ...ERAAKUMA_MAID.detect.kojoRouteFile);
          if (!(await io.exists(routeFile))) return false;
          const charaDir = join(rootDir, ...ERAAKUMA_MAID.detect.charaCsvDir);
          return io.exists(charaDir);
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERAAKUMA_MAID.detect.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERAAKUMA_MAID.paths.kojoRoot);

          const charaIndex = new Map<number, CharaInfo>();
          /**
           * 非 ERB 输入的摘要素材（CHARA 表正文 + 角色目录名 + 变量名称表摘要）。
           * 下游派生缓存（条件抽取 / 约定校验）的产出依赖它们，而 ERB 体量指纹
           * 覆盖不到 ⇒ 必须折进判据（见 `GameProject.inputDigest`）。
           */
          const inputParts: string[] = [];

          // ---- 1. CHARA CSV → 编号 / 名前 / 呼び名 ----
          const csvEntries = await io.listDir(charaDir);
          const csvFiles = csvEntries.filter(
            (e) => !e.isDirectory && /\.csv$/i.test(e.name) && ERAAKUMA_MAID.charaCsvPattern.test(e.name),
          );

          for (const entry of csvFiles) {
            const noFromName = parseCharaNoFromFileName(entry.name, ERAAKUMA_MAID.charaCsvPattern);
            let parsed: ReturnType<typeof parseCharaCsv> = { no: null, name: null, callName: null };
            try {
              const tf = await io.readText(entry.path);
              parsed = parseCharaCsv(tf.text);
              inputParts.push(`chara\u0000${entry.path}\u0000${tf.text}`);
            } catch (err) {
              inputParts.push(`chara\u0000${entry.path}\u0000!unreadable`);
              ctx.log.warn(`CHARA CSV 读取失败（跳过该文件）：${entry.path} — ${String(err)}`);
            }
            const no = parsed.no ?? noFromName;
            if (no === null) {
              ctx.log.warn(`无法确定角色编号（跳过）：${entry.name}`);
              continue;
            }
            // 名称回退链：名前 行 → 文件名剩余部分 → `CHARA{n}`（显式回退，绝不静默丢弃）。
            // AM 文件名是 `CHARA{n}.csv`——编号后直接结尾、**无「空格+名称」段**
            // （eraTW 的 `Chara{n} {名前}.csv` 形态不适用）⇒ 实测 nameFromFile 恒为
            // ''，回退按游戏自有命名给 `CHARA{n}`；`\s*` 保留给将来带名称段的文件名兜底。
            const nameFromFile = entry.name.replace(/\.csv$/i, '').replace(/^CHARA\d+\s*/i, '').trim();
            const info: CharaInfo = {
              no,
              name: parsed.name ?? (nameFromFile.length > 0 ? nameFromFile : `CHARA${no}`),
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. 口上域角色目录 → 绑定 kojoDir ----
          const kojoEntries = await io.listDir(kojoRoot);
          let bound = 0;
          for (const e of kojoEntries) {
            if (!e.isDirectory) continue;
            inputParts.push(`kojoDir\u0000${e.name}`);
            const parsed = parseKojoDirName(e.name);
            let no: number | null = parsed?.no ?? null;
            // 命名回退：目录名不带编号（纯角色名目录）时，按目录内
            // `EVENT_K{n}*.ERB` 文件名反推编号（与路由 `_K{NO:TARGET}` 同口径）
            const label = parsed?.label ?? e.name;
            if (parsed === null) {
              let names: string[] = [];
              try {
                const inner = await io.listDir(e.path);
                names = inner.filter((d) => !d.isDirectory).map((d) => d.name);
              } catch (err) {
                ctx.log.debug(`口上角色目录列举失败（按无编号处理）：${e.path} — ${String(err)}`);
              }
              no = deriveCharaNoFromFileNames(names);
            }
            if (no === null) {
              ctx.log.warn(`口上角色目录名不符合「{编号} {名称}」约定（跳过）：${e.name}`);
              continue;
            }
            const info = charaIndex.get(no);
            if (info) {
              info.kojoDir = e.path;
            } else {
              // 口上目录存在但 CSV 中无该编号：补最小条目（不猜测显示名，用目录 label）
              charaIndex.set(no, { no, name: label, kojoDir: e.path });
            }
            bound++;
          }

          // ---- 3. 变量字典（CSV 主表 + .als 追加 + .ERH 作者自定，三层） ----
          // 市场字典包（KM-15）：第三轮追加名表。市场缺席 / 读取失败 / 无字典包
          // ⇒ 空列表，与"无市场"逐字一致；项目加载不因市场出声而挂。
          const marketAppendDirs: string[] = [];
          try {
            const market = tryMarket();
            if (market !== null) {
              for (const rec of await market.installed()) {
                if (rec.kind !== 'dict-pack') continue;
                marketAppendDirs.push(await market.contentDir(rec.kind, rec.id, rec.version));
              }
            }
          } catch (err) {
            marketAppendDirs.length = 0;
            ctx.log.warn(`市场字典包目录收集失败（本次不并入市场名表，字典照常加载）：${String(err)}`);
          }
          currentSchema = await loadErakumamaidVariableSchema({
            io,
            csvDir: join(rootDir, ...ERAAKUMA_MAID.csvDir),
            // 作者自定名表（FT-1）：从整个 ERB 根递归扫 `.ERH`
            erbDir: join(rootDir, ...ERAAKUMA_MAID.erbDir),
            // 市场字典包追加名表（空 = 连这个键都不带）
            ...(marketAppendDirs.length > 0 ? { marketAppendDirs } : {}),
            log: ctx.log,
          });

          // ---- 4. 口上调用协议（路由表 → 槽位语义表；失败降级 undefined） ----
          currentProtocol = await loadErakumamaidCallProtocol({
            io,
            routeFile: join(rootDir, ...ERAAKUMA_MAID.paths.kojoMessageRoute),
            log: ctx.log,
          });

          // ---- 5. 指令名表（CSV/TRAIN.csv → 名 ↔ 编号；缺表/读失败 = 空表，不抛） ----
          currentInstructionTable = await loadErakumamaidInstructionTable({
            io,
            csvDir: join(rootDir, ...ERAAKUMA_MAID.csvDir),
            log: ctx.log,
          });

          ctx.log.info(
            `eraAkumaMaid 工程加载完成：${charaIndex.size} 个角色（${bound} 个有口上目录），` +
              `口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERAAKUMA_MAID.gameId,
            kojoPaths: [kojoRoot],
            // eraAkumaMaid 无静态 sav/ 目录（运行期才生成）⇒ 不提议 savDir 及其可写
            writablePaths: [kojoRoot],
            charaIndex,
            // 派生缓存判据的一部分：本次加载实际吃进的非 ERB 输入
            inputDigest: combineDigests([foldDigest(inputParts), currentSchema.inputDigest]) ?? undefined,
          };
        },
      };

      ctx.slots.register('game.adapter', { id: `${ERAAKUMA_MAID.gameId}-adapter`, adapter });

      /**
       * 名称解析 memo 随项目关闭清空（§5.73）。
       * 纯函数缓存，清空不改变任何判定，只是下一遍重新解析。
       */
      ctx.onDispose(ctx.bus.on('project.closed', () => clearKojoFamilyMemo()));
    },
  };
}
