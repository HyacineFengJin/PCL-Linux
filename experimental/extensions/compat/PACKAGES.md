# N / Nex 包清单检查范围

包检查仅返回 `compatibility-report`。没有安装授权、程序集加载、原生库加载、Mixin 应用或文件提取。报告中的 SHA-256 仍标识规范化后的清单 JSON；没有计算整个包或程序集的校验和。

## 固定公开格式依据

- N SDK **0.2.5**，提交 `abc4c0a4bec9c1ece28eba17bff2c5eba5b7fe52`：[包生成器](https://github.com/Nexa-MC/PCL-N-Plugin-SDK/blob/abc4c0a4bec9c1ece28eba17bff2c5eba5b7fe52/src/PCL.N.Plugin.Sdk.Build/Program.cs) 将 `plugin.json`、载荷、文件表、签名声明写入 ZIP；[签名器](https://github.com/Nexa-MC/PCL-N-Plugin-SDK/blob/abc4c0a4bec9c1ece28eba17bff2c5eba5b7fe52/src/PCL.N.Plugin.Sdk.Build/GpgSigner.cs) 添加签名与公钥项。检查器仅支持清单、包、签名及文件表的 **版本 1**。检查清单/文件表字节哈希和签名声明中的插件身份是否一致，以及文件表路径、大小是否对应 ZIP 目录。公钥、签名和载荷根仅检查声明及目录存在性，不读取或验证其内容，不判断密钥身份、信任、撤销或开发签名状态。
- Nex 提交 `0606bbe354c65f28f072c2bc4ddc194993ed2da2`：[本地安装器](https://github.com/PCL-Nex-Developer/PCL2-Nex/blob/0606bbe354c65f28f072c2bc4ddc194993ed2da2/PCL.Core/App/Plugins/PluginLocalInstallService.cs) 将 `.pclx` 当作 ZIP；[清单服务](https://github.com/PCL-Nex-Developer/PCL2-Nex/blob/0606bbe354c65f28f072c2bc4ddc194993ed2da2/PCL.Core/App/Plugins/PluginPackageService.cs) 读取 `plugin.json`，入口依赖程序集与 Mixin。该格式没有独立包版本字段；检查器拒绝显式版本字段和旧脚本/生命周期入口，不能据此判断实际 PCL.Core 兼容性。

这只是上述格式的受限检查子集，不是完整上游校验。Nex 上游还接受嵌套插件目录；RH 当前只接受包根部唯一的 `plugin.json`。不自动选取嵌套清单或尝试其他封装。

## 读取与限额

生产入口按位置读取 ZIP 目录、本地头、数据描述符及固定 JSON 元数据，不读取程序集、Mixin、签名或公钥数据流，也不写入安装目录。文件以非跟随链接、非阻塞方式打开，拒绝非普通文件；读取前后检查大小和修改时间，检测到变更就拒绝报告。

| 项目 | 上限或支持范围 |
| --- | --- |
| 整个包的文件大小 | 32 MiB |
| ZIP 条目数，含目录 | 128 |
| ZIP 中央目录 | 128 KiB |
| 单条目声明的未压缩大小 | 16 MiB |
| 总声明的未压缩大小 | 64 MiB |
| 每条目声明的压缩比 | 100:1 |
| 每份 JSON 实际解压输出 | 64 KiB，最多读取 3 份 |
| 每份 JSON 的压缩输入 | 128 KiB |
| 路径 | UTF-8 或 ASCII，NFC，最多 240 字节 |
| ZIP | 单卷 ZIP32，Stored 或 Deflate，版本需求 1.0 或 2.0；Deflate 仅接受 2.0 |
| 签名声明数 | 最多 8；不验证签名 |

拒绝加密、ZIP64、其他压缩方法、未知标志、额外字段、包尾注释、自解压前缀、附加数据、重叠条目、大小/头不一致、链接或特殊文件。路径拒绝绝对路径、反斜杠、`.`/`..`、控制字符、设备名称、重复、大小写冲突及文件/目录冲突。所读取 JSON 要通过输出上限、CRC、实际长度、完整 Deflate 消耗及现有严格 JSON 检查；拒绝重复键和复杂度超限。

程序集入口和 Mixin 仅检查目录中存在相应普通文件。其他载荷的压缩数据、CRC、实际展开大小、哈希和行为均未验证；目录里的容量与压缩比是声明值。`loadable`、`codeExecuted`、`signatureVerified`、`archive.payloadVerified` 始终为 `false`。超限或不支持的包直接拒绝，没有自动解包、降级执行或安装回退。
