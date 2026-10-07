# 插件兼容检查与开发验证

启动器可从「插件管理 → 导入插件声明」读取 N/Nex 的 `plugin.json`。这里只显示有边界的元数据，不读取程序集或 Mixin 文件，不生成安装授权。SHA-256 标识声明内容，不证明发布者身份或签名有效。

命令行提供同样的只读检查：

```sh
node experimental/extensions/compat/inspect.mjs /path/to/plugin.json
```

报告包括服务的必需/可选声明、权限理由、依赖版本文本、入口和 Mixin 配置。N 的 `pcl.commands` 和 `pcl.notifications` 只标记为「接口验证」；该标记不意味着所选插件可以安装。版本范围没有求解，程序集、平台适配和完整上游格式没有验证。市场、`.pnp`/`.pclx` 解包、签名校验与外部插件运行尚未开放。

## N SDK ABI 验证工具

工具直接实现公开的 `IPclNPlugin`、命令服务、通知服务、双语设置页描述能力和生命周期接口。插件对象与回调留在 .NET 进程内，只输出有界文本描述。设置页描述并不是 Avalonia 控件；Dispatcher 仅在无界面的探针里同步调用，不能代表真实 UI 线程调度。宿主不提供游戏、账号、AI、原生 UI 注入或运行时补丁能力。

验证使用 [Nexa-MC/PCL-N-Plugin-SDK](https://github.com/Nexa-MC/PCL-N-Plugin-SDK/tree/abc4c0a4bec9c1ece28eba17bff2c5eba5b7fe52) 的 **0.2.5** 源码，原始 Hello 模块保持不变。SDK 程序集从该源码重建，保留 `0.2.5.0` ABI 版本；这不是官方签名发布包的加载测试。N SDK 的版本与共享 Pi SDK 的 `1.0.4` 相互独立。

需要 Linux、Bubblewrap、Python 3、Node.js 和本地 .NET 10 SDK。准备可信的上述固定提交源码和 .NET SDK，然后执行：

```sh
node experimental/extensions/compat/verify-n.mjs \
  /path/to/dotnet-sdk/dotnet /path/to/pcl-n-sdk ./work/plugin-compatibility
```

构建关闭 NuGet 来源、SDK 遥测和开发证书生成，产物、日志和结果位于指定私有工作目录。工具校验 Hello 源码指纹，重建公开 SDK 与探针，再通过 Bubblewrap 执行：只读 SDK/样例/程序集，无网络，无用户目录绑定，仅有临时可写目录。隔离环境不可用时直接失败，没有非隔离执行回退。请仅使用可信的固定 SDK 源码；构建阶段仍执行其 MSBuild 项目。

验证涵盖中文/英文描述、实际命令回调、重复初始化拒绝、未知命令拒绝、拒绝能力、初始化中途失败清理、关闭/撤销后的注册清理与旧命令拒绝。显式探针能力授权由验证脚本提供，不替代完整安装时的清单权限策略。`Program.cs` 不能单独作为通用插件执行器使用；该脚本没有生产级资源配额或恶意插件安全验证。

### 通知服务映射

`IPluginNotificationService.ShowInformation` / `ShowWarning` 通过独立服务对象输出纯文本通知，再由 `RuntimeNoticeHost` 转成现有 CE 卡片的数据形状。该映射只由开发验证脚本调用，启动器没有展示这些可执行扩展卡片或自动加载程序集的入口。原始 Hello 测试和 RH 自写的通知夹具分开记录：前者是上游原始源码的 ABI 验证，后者是源码适配/服务映射验证，均不是原签名包运行。

每个 RH 通知生命周期拥有新的随机会话 ID，明确授予通知能力后才创建。侧车只能提供递增序号、信息/警告级别和最多 1000 个 Unicode 字符的单行文本；来源与双语标题由 RH 提供。每批和待处理队列最多 16 条，单次运行最多 64 条。消息不携带 URL、HTML、按钮回调或授权字段。消息中的标记字符仍作为纯文本交给既有卡片渲染。

整个批次先验证再入队；拒绝旧会话、跳号、重复序号和非法文本。RH 拥有者在关闭、撤销或初始化失败时调用 `stop()` 清空卡片并终止通知生命周期；探针同时清空 .NET 队列并拒绝旧服务句柄。重启创建新会话，不恢复未处理通知。丢弃卡片不会重置防重放边界。取消/释放回调抛错也不能绕过注册清理。已接受的通知不属于命令事务：命令随后抛错时仍可返回它已发送的通知，但不会越过生命周期终止边界。

探针的私有 stdio 初始化请求增加必需的 `sessionId`；回复增加 `notificationBatch`，包含 `schemaVersion: 1`、会话 ID 和有界通知列表。这个协议与启动器的 `extensions_review` / `extensions_cards` 无关，没有改变普通数据插件的授权或持久格式。

## Nex 边界

检查器识别 `entryAssembly`、`pclCoreVersion`、基础和实验功能 Mixin 配置，以及插件依赖。参照 [Nex 的固定版本加载器说明](https://github.com/PCL-Nex-Developer/PCL2-Nex/blob/0606bbe354c65f28f072c2bc4ddc194993ed2da2/PCL.Core/App/Plugins/README.md)，这些入口依赖 PCL.Core/Mixin。当前不加载 Bridge，也不将 Nex 宿主补丁应用到 Rust/React。
