# xml-kojo —— XML 口上形态的结构样本（全部手写，不含任何真实游戏内容）

给 `tools/xml-kojo-scan.mjs` 与 `detectFlavor()` 钉判据用。四份样本各钉一条：

| 文件 | 钉住的判据 |
| --- | --- |
| `ERB/口上/9001_现行格式/KOJO_K9001_COM.xml` | 现行格式：根 `<data>`、台词在 `<contents>`；`eval` / `isFall` / `emotion` 三属性同时出现（6 条） |
| `ERB/口上/9002_旧式格式/KOJO_K9002_COM.xml` | 旧格式：根 `<kojodef>`、台词在 `<kojo>`；条目按 `<command>` 计 4 条、台词行 5 行 |
| `ERB/口上/9003_十六位编码/KOJO_K9003_COM.xml` | 字节 UTF-16LE+BOM、声明却写 `utf-8`：BOM 优先，仍读出 3 条，并记 1 份「编码声明不符」 |
| `ERB/口上/9004_坏样本/KOJO_K9004_BROKEN.xml` | `<contents>` 未闭合：记 1 份「结构错误」，但条目读数不归零（2 条） |

`FLconfig.xml` 是口味判据的一半（根下有此文件 + `ERB/口上` 是目录 → `flavor-x`），
内容为合成骨架，不含任何真实配置或密钥。合起来共 4 份口上 XML、15 条条目。

重新生成 UTF-16 样本须按字节写（`FF FE` + UTF-16LE），不能用文本编辑器另存。
