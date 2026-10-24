/**
 * eraFL 适配器插件 —— 本包是**唯一**允许知道「eraFL / 口上 XML / Chara CSV」这些
 * 字眼的地方（架构铁律：游戏知识归 adapter，内核零游戏名词）。
 *
 * 本批只交付三件事：工程识别（`detect`）、工程装载（`loadProject`）、家族索引
 * （`functionFamilyIndex`）。`variableSchema` / `conventions` / `kojoCallProtocol`
 * 等语义层由后续批次在 adapter 对象上**追加**；本文件刻意不预置它们的 getter——
 * 空的注入位会和并行改动抢同一处代码，等真实现落地时再加才没有歧义。
 *
 * eraFL 的结构事实（`D:/Game/erafl` 实测）：
 * - 口上主形态是 **XML**，ERB 侧只有 `KOJO_DEFINE_K{n}` 之类的注册壳函数；
 * - 口上目录是 `ERB/口上/{编号}_{名称}`，5xxx 段是主角口上；
 * - 索引必须吃**整棵 `ERB`**（2,013 份）：define 壳函数按角色散在各子目录里，
 *   只扫 `ERB/口上` 会漏掉根层与 `SYSTEM/` 的公共定义。
 */

import type {
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  KojoInstructionTable,
  KojoXmlService,
  Plugin,
  VariableSchema,
} from '@kojo/plugin-api';
import { WellKnownServices, combineDigests, foldDigest, join } from '@kojo/plugin-api';
import { ERAFL } from './constants';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from './chara-csv';
import { createEraflFamilyIndex } from './family-index';
import {
  loadEraflInstructionNames,
  loadEraflVariableSchema,
} from './variable-schema';
import { createKojoXmlService, type KojoXmlServiceHandle } from './kojo-xml/service';

/** 创建 eraFL 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createEraflAdapterPlugin(): Plugin {
  return {
    id: 'erafl-adapter',
    version: '0.1.0',
    // 本批只读盘（detect / loadProject），不依赖项目服务与工作区服务
    requires: ['kernel.io'],
    // 装载时对外提供口上 XML 服务（下面 `ctx.provide` 那行）——内核按 provides[] 做依赖排序与
    // 冲突检测，漏声明会在 activate 当场抛错（真壳实测：面板读「插件 (21/22 运行中)」+
    // `Plugin 'erafl-adapter' called provide('kojo.xml') but did not declare it in provides[]`）。
    provides: [WellKnownServices.KojoXml],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');

      /** 变量字典（每次 `loadProject` 按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 指令名表（同上；未加载 = 空表） */
      let currentInstructionTable: KojoInstructionTable = {
        hasTable: false,
        lookupByName: () => undefined,
        lookupByNo: () => undefined,
        names: () => [],
      };
      /** 口上 XML 的搜索根（`loadProject` 填；未加载 = 空数组 ⇒ 服务不扫盘） */
      let kojoXmlRoots: string[] = [];
      /** `com` 数字表（`CSV/Train.csv` → 编号 / 名称；装载时填） */
      let comTable: Array<{ code: string; label: string }> = [];

      const kojoXml: KojoXmlServiceHandle = createKojoXmlService({
        io,
        log: ctx.log,
        roots: () => kojoXmlRoots,
        comTable: () => comTable,
      });
      ctx.provide(WellKnownServices.KojoXml, kojoXml as KojoXmlService);
      ctx.onDispose(() => kojoXml.dispose());

      const adapter: GameAdapter = {
        gameId: ERAFL.gameId,
        displayName: ERAFL.displayName,
        functionFamilyIndex: createEraflFamilyIndex(),
        get variableSchema() {
          return currentSchema;
        },
        // 指令名表（`CSV/Train.csv`）——糖层「时机 指令 …」查表用；未加载 = 空表实例
        get kojoInstructionTable() {
          return currentInstructionTable;
        },

        async detect(rootDir: string): Promise<boolean> {
          // 三者**同时**成立才算 eraFL 工程：
          // 1) FLconfig.xml —— eraFL 独有（普通 Emuera 没有这份外部服务配置）；
          // 2) ERB/口上 是**目录** —— 排除只留了一个同名散文件的半截工程；
          // 3) CSV/CFLAG.CSV —— 证明这是可玩的工程而不是只有配置的空壳。
          if (!(await io.exists(join(rootDir, ...ERAFL.detect.configFile)))) return false;
          if (!(await io.exists(join(rootDir, ...ERAFL.detect.charaFlagCsv)))) return false;
          const kojoStat = await io.stat(join(rootDir, ...ERAFL.detect.kojoDir));
          return kojoStat?.isDirectory === true;
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaCsvDir = join(rootDir, ...ERAFL.paths.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERAFL.paths.kojoRoot);

          const charaIndex = new Map<number, CharaInfo>();
          /**
           * 非 ERB 输入的摘要素材（CSV 正文 + 口上目录名）。
           * 派生缓存（条件抽取 / 约定校验）的产出依赖这些文件，而 ERB 体量指纹
           * 覆盖不到 ⇒ 必须折进 `GameProject.inputDigest`（见契约注释）。
           */
          const inputParts: string[] = [];

          // ---- 1. CSV/Chara → 编号 / 名前 / 呼び名 ----
          for (const entry of await io.listDir(charaCsvDir)) {
            if (entry.isDirectory) continue;
            if (!/\.csv$/i.test(entry.name)) continue;
            // 目录里还有 `parts_info.txt` 这类非角色文件；文件名不带 Chara{no} 一律跳过
            const noFromName = parseCharaNoFromFileName(entry.name, ERAFL.charaCsvPattern);
            if (noFromName === null) continue;

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
            // 名称回退链：名前 行 → 文件名名称段 → `Chara{no}`（显式回退，绝不静默丢弃）
            const info: CharaInfo = {
              no,
              name: parsed.name ?? charaNameFromFileName(entry.name) ?? `Chara${no}`,
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. ERB/口上 角色目录 → 绑定 kojoDir / 补 CSV 里没有的条目 ----
          let dirOnly = 0;
          for (const entry of await io.listDir(kojoRoot)) {
            if (!entry.isDirectory) continue;
            inputParts.push(`kojoDir\u0000${entry.name}`);

            const parsed = parseKojoDirName(entry.name);
            if (parsed === null) {
              // 根层公共文件（`_KOJO_SYSTEM.ERB` 等）不会走到这里（已过滤非目录），
              // 但魔改可能塞进不带编号的目录 ⇒ 跳过并留痕，不猜编号
              ctx.log.warn(`口上目录名不符合「{编号}_{名称}」约定（跳过）：${entry.name}`);
              continue;
            }

            const info = charaIndex.get(parsed.no);
            if (info) {
              info.kojoDir = entry.path;
            } else {
              // CSV 里没有该编号（5xxx 主角口上全部如此）：用目录名补最小条目。
              // 不猜「更漂亮的显示名」——目录名是作者自己写的，改它等于替作者命名。
              charaIndex.set(parsed.no, { no: parsed.no, name: parsed.label, kojoDir: entry.path });
              dirOnly++;
            }
          }

          // ---- 3. 变量字典（CSV 主表 + .ERH 作者自定名表，两层） ----
          // 字典失败**不阻断**工程加载：没有字典只是补全少了名字，口上照常能读能改。
          try {
            currentSchema = await loadEraflVariableSchema({
              io,
              csvDir: join(rootDir, ...ERAFL.paths.csvDir),
              erbDir: join(rootDir, ...ERAFL.paths.erbRoot),
              log: ctx.log,
            });
          } catch (err) {
            currentSchema = undefined;
            ctx.log.warn(`变量字典加载失败（本次不带字典，工程照常打开）：${String(err)}`);
          }

          // ---- 4. `com` 数字表（CSV/Train.csv）：口上 XML 的 com 补全靠它 ----
          try {
            const table = await loadEraflInstructionNames({
              io,
              csvDir: join(rootDir, ...ERAFL.paths.csvDir),
              log: ctx.log,
            });
            currentInstructionTable = table;
            // `names()` 只给名字、`lookupByName` 才给编号 ⇒ 两者配对成 com 规格。
            // 两者在契约里都是**可选能力**（`KojoInstructionTable` 允许只实现查名）
            // ⇒ 缺席即空表，绝不猜编号。
            const names = table.names?.() ?? [];
            comTable = names.flatMap((name) => {
              const no = table.lookupByName?.(name);
              return no === undefined ? [] : [{ code: String(no), label: name }];
            });
          } catch (err) {
            comTable = [];
            ctx.log.warn(`指令名表加载失败（com 补全退化为符号表）：${String(err)}`);
          }

          // ---- 5. 口上 XML 索引：根先落地，再异步扫（不挡进项目） ----
          // 293 份读+解析约 1.2s；进项目的主链不该等它。面板订阅服务，扫完自己刷新。
          kojoXmlRoots = [kojoRoot];
          void kojoXml.refresh().catch((err: unknown) => {
            ctx.log.warn(`口上 XML 索引构建失败（面板会显示为空）：${String(err)}`);
          });

          ctx.log.info(
            `eraFL 工程加载完成：${charaIndex.size} 个角色（${dirOnly} 个仅见于口上目录），` +
              `口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERAFL.gameId,
            // 索引吃整棵 ERB：define 壳函数散在根层与各子目录，只扫口上域会漏定义
            kojoPaths: [join(rootDir, ...ERAFL.paths.erbRoot)],
            // 可写面只批口上域：XML 与 define 壳都在这里，别的一律视为游戏只读区
            writablePaths: [kojoRoot],
            charaIndex,
            // 派生缓存判据的一部分：本次加载实际吃进的非 ERB 输入（含变量字典读过的 CSV 正文）
            inputDigest:
              combineDigests([
                foldDigest(inputParts),
                ...(currentSchema?.inputDigest ? [currentSchema.inputDigest] : []),
              ]) ?? undefined,
          };
        },

        // `scaffold`（生成新角色口上骨架）本批不实现，留 undefined：
        // eraFL 的产物是「define 壳 ERB + XML 模板」两件套，模板形态要等 XML 语义层
        // 落地后才有权威来源；先写一套只会产出作者还得手改的骨架。
      };

      ctx.slots.register('game.adapter', { id: `${ERAFL.gameId}-adapter`, adapter });
    },
  };
}
