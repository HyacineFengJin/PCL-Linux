# PCL Linux 实验版

面向 Linux 的 Minecraft: Java Edition 启动器，采用 **Rust + Tauri 2 + React / TypeScript**，参考 PCL CE 的界面布局与交互理念。无需 .NET，运行时无需 Node 服务。本项目独立开发，非 PCL CE 官方发行。

## 功能

- Minecraft 原版版本目录、搜索、自定义实例名称，以及 Fabric、Forge、NeoForge 自动安装。
- 分步安装进度、任务取消与未完成文件清理，完整文件缓存复用及 SHA-1 校验。
- 模组加载器安装包目录，以及 Modrinth 模组、整合包、数据包、资源包和光影包搜索、版本详情与依赖浏览。
- 游戏版本扫描、搜索、选择与实例设置。
- 实例描述、内置图标、列表分类与收藏管理。
- 本地模组单个／批量启禁，模组、资源包与光影包导入，以及可撤销的删除。
- 多游戏目录登记、切换、排序与显示名称管理，使用系统文件夹选择器。
- Java 自动匹配、全局和单实例内存设置。
- 版本继承、依赖库与 Linux 原生库解析。
- 游戏进程管理、退出状态与日志查看。
- PCL CE 风格导航、账号侧栏、实例修改／导出表单、资源详情及任务管理界面。

项目仍在开发中，目前支持游戏与上述加载器安装、已有游戏启动与本地资源管理。OptiFine、LabyMod 自动安装、在线资源下载和模组更新尚未提供；部分早期版本暂不支持自动安装。Microsoft 正版登录暂未开放，服务接入由项目维护者完成。

## 构建与运行

需要 Rust/Cargo、Node/npm、GTK 3、WebKitGTK 4.1 及相关开发依赖。构建脚本还使用 Python 3 和 curl。

```sh
git clone https://github.com/HyacineFengJin/PCL-Linux.git
cd PCL-Linux
./build-native.sh
./start-native.sh
```

首次使用时，在「启动 → 实例选择」中添加已有的游戏文件夹，然后从「下载」安装原版，或选择目录中已有的版本。支持管理多个目录，各目录分别记住所选实例与实例内存设置。Java 会根据版本要求自动选择。详细步骤见[使用指南](docs/USAGE.md)。安装桌面应用入口需提供 `desktop-file-validate` 命令：

```sh
./install-desktop.sh
```

## 开发

- `apps/desktop/`：React 界面和 Tauri 桌面宿主。
- `crates/core/`：版本、依赖和启动核心。
- `crates/install/`：官方版本目录、文件下载、校验和安装。
- `crates/auth/`：Microsoft 认证和系统密钥环。
- `crates/cli/`：命令行入口。

```sh
cargo test --locked -p pcl-core -p pcl-install -p pcl-cli -p pcl-auth -p pcl-desktop --features pcl-desktop/custom-protocol
npm run preview:data --prefix apps/desktop
npm run dev --prefix apps/desktop
```

浏览器预览展示界面；启动游戏等桌面功能通过 Tauri 调用 Rust。Tauri 开发模式可在 `apps/desktop` 中运行 `npm run tauri -- dev`。

## 文档

- [使用指南](docs/USAGE.md)
- [账号与登录](docs/AUTHENTICATION.md)
- [CLI 使用](crates/cli/README.md)

## English

PCL Linux is an experimental native Linux launcher for Minecraft: Java Edition, built with Rust, Tauri 2, React, and TypeScript. It downloads and installs vanilla versions, launches existing game installations, selects Java runtimes, resolves launch dependencies, and displays game logs. Downloads support cancellation, verified file reuse, and SHA-1 validation. Local resource management supports mod toggling, importing mods/resource packs/shader packs, and recoverable removal. Some legacy versions are unsupported. Mod loader installation, online resource downloads, and mod updates are not yet available.

Microsoft sign-in is not yet available. The project maintainers are responsible for completing the service integration.

## 致谢

界面理念参考 [PCL CE](https://github.com/PCL-Community/PCL-CE)，认证流程参考 [HMCL](https://github.com/HMCL-dev/HMCL)。Linux 平台与服务分层参考 [PCL N Edition](https://github.com/PCL-N-Edition/PCL-N)。界面和 Rust 认证代码独立编写。本地桌面图标来源见[上游图标](https://github.com/PCL-Community/PCL-CE/blob/19805c446cfd17e92749124e3ab1c1832a291736/Plain%20Craft%20Launcher%202/Images/icon.ico)。
