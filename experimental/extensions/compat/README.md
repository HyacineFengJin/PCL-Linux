# 插件兼容检查与开发验证

启动器可从「插件管理 → 导入插件声明」读取 N/Nex 的 `plugin.json`。这里只显示有边界的元数据，不读取程序集或 Mixin 文件，不生成安装授权。SHA-256 标识声明内容，不证明发布者身份或签名有效。

命令行提供同样的只读检查：

```sh
node experimental/extensions/compat/inspect.mjs /path/to/plugin.json
```

报告包括服务的必需/可选声明、权限理由、依赖版本文本、入口和 Mixin 配置。N 的 `pcl.commands` 只标记为「接口验证」；该标记不意味着所选插件可以安装。版本范围没有求解，程序集、平台适配和完整上游格式没有验证。市场、`.pnp`/`.pclx` 解包、签名校验与外部插件运行尚未开放。

## N SDK ABI 验证工具

工具直接实现公开的 `IPclNPlugin`、命令服务、双语设置页描述能力和生命周期接口。插件对象与回调留在 .NET 进程内，只输出有界文本描述。设置页描述并不是 Avalonia 控件；Dispatcher 仅在无界面的探针里同步调用，不能代表真实 UI 线程调度。宿主不提供游戏、账号、AI、原生 UI 注入或运行时补丁能力。

验证使用 [Nexa-MC/PCL-N-Plugin-SDK](https://github.com/Nexa-MC/PCL-N-Plugin-SDK/tree/abc4c0a4bec9c1ece28eba17bff2c5eba5b7fe52) 的 **0.2.5** 源码，原始 Hello 模块保持不变。SDK 程序集从该源码重建，保留 `0.2.5.0` ABI 版本；这不是官方签名发布包的加载测试。N SDK 的版本与共享 Pi SDK 的 `1.0.4` 相互独立。

需要 Linux、Bubblewrap、Python 3、Node.js 和本地 .NET 10 SDK。准备可信的上述固定提交源码和 .NET SDK，然后执行：

```sh
node experimental/extensions/compat/verify-n.mjs \
  /path/to/dotnet-sdk/dotnet /path/to/pcl-n-sdk ./work/plugin-compatibility
```

构建关闭 NuGet 来源、SDK 遥测和开发证书生成，产物、日志和结果位于指定私有工作目录。工具校验 Hello 源码指纹，重建公开 SDK 与探针，再通过 Bubblewrap 执行：只读 SDK/样例/程序集，无网络，无用户目录绑定，仅有临时可写目录。隔离环境不可用时直接失败，没有非隔离执行回退。请仅使用可信的固定 SDK 源码；构建阶段仍执行其 MSBuild 项目。

验证涵盖中文/英文描述、实际命令回调、重复初始化拒绝、未知命令拒绝、拒绝能力、初始化中途失败清理、关闭/撤销后的注册清理与旧命令拒绝。显式探针能力授权由验证脚本提供，不替代完整安装时的清单权限策略。`Program.cs` 不能单独作为通用插件执行器使用；该脚本没有生产级资源配额或恶意插件安全验证。

## Nex 边界

检查器识别 `entryAssembly`、`pclCoreVersion`、基础和实验功能 Mixin 配置，以及插件依赖。参照 [Nex 的固定版本加载器说明](https://github.com/PCL-Nex-Developer/PCL2-Nex/blob/0606bbe354c65f28f072c2bc4ddc194993ed2da2/PCL.Core/App/Plugins/README.md)，这些入口依赖 PCL.Core/Mixin。当前不加载 Bridge，也不将 Nex 宿主补丁应用到 Rust/React。
