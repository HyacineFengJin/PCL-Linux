# 代码结构与排查入口

这份说明面向阅读、修改和排查 PCL Linux 代码的开发者，描述当前实现。复杂事务的状态与约束放在对应 Rust 模块的开头，修改实现时应同步更新。

## 从哪里开始读

| 职责 | 入口 | 主要内容 |
| --- | --- | --- |
| 前端状态与桌面调用 | `apps/desktop/src/main.tsx` | 页面、当前目录、bootstrap、作用域 API 与响应接纳 |
| 实例管理界面 | `InstancesPanel.tsx`、`InstanceOperations.tsx`、`InstanceImport.tsx`、`InstanceTrash.tsx` | 实例资料、改名、修改、导出、ZIP 导入与删除恢复 |
| 下载与任务界面 | `DownloadPanel.tsx`、`TaskManager.tsx` | 任务轮询、完成刷新、取消后返回 |
| 在线资源界面 | `ResourceDetails.tsx`、`ResourceInstall.tsx`、`resourceInstallPlan.ts` | 版本与文件选择、作用域确认、必要依赖计划和安装提交 |
| Java 管理界面 | `JavaPanel.tsx`、`JavaSelect.tsx`、`javaManagement.ts` | 全局与实例选择、目录/修订作用域、过期响应排除 |
| 桌面命令与应用生命周期 | `apps/desktop/src-tauri/src/main.rs` | 命令参数、目标绑定、任务调度、游戏进程与关闭处理 |
| 本地实例操作命令 | `instance_commands.rs` | ZIP 导入与删除恢复的目录绑定、计划确认、任务准入与错误归类 |
| 在线资源命令 | `resource_install_commands.rs` | 目标绑定、后台任务、传输进度、提交检查与根目录恢复 |
| 改名编排 | `instance_rename_service.rs` | 组合文件/资料 revision、进度、错误归类与缓存刷新 |
| 持久设置与实例资料 | `config.rs`、`instance_meta.rs`、`export_presets.rs` | 多目录、选择与内存、元资料、导出配置 |
| Java 桌面服务 | `java_commands.rs`、`java_service.rs`、`platform.rs` | 选择器、登记请求绑定与探测前后校验 |
| 文件操作 | `resource_ops.rs`、`instance_reset.rs`、`instance_export.rs`、`instance_import.rs`、`instance_delete.rs` | 本地资源事务、组件重置、ZIP 导出/导入、实例删除恢复 |
| 任务协调 | `tasks.rs`、`downloads.rs` | 单写入任务、取消与结束语义、下载页面的任务投影 |
| Minecraft 核心 | `crates/core/src/lib.rs` | 版本识别、继承、依赖和启动参数 |
| Java 核心 | `crates/core/src/java.rs` | 有限时探测、发现、架构与版本策略、启动选择 |
| 下载与安装 | `crates/install/src/` | 网络请求、校验缓存、原版与加载器安装 |
| Modrinth 安装 | `modrinth_install/` | 官方元数据、兼容与必需依赖规划、实例快照、匿名网络暂存 |
| 资源批次提交 | `resource_ops/verified_batch/` | 不同资源类型的统一提交、所有权登记、回滚和中断恢复 |
| 账号 | `crates/auth/src/lib.rs`、桌面的 `accounts.rs` | 认证协议、密钥环、账号状态与刷新 |

表中未写目录的 Rust 文件位于 `apps/desktop/src-tauri/src/`；TSX 文件位于 `apps/desktop/src/`。现有桌面和前端 `main` 仍承担较多协调工作；新增业务应先确定职责归属，避免继续堆入页面或命令函数。

## 以实例改名为例

阅读顺序：

1. `InstancesPanel.tsx` 的检查与确认：客户端提交名称和确认 revision。
2. 桌面 `main.rs` 的 `instance_rename_prepare`、`instance_rename_start`：解析已登记目录、检查游戏/任务占用，重新准备并核对 revision，再捕获目标并启动工作线程。
3. `instance_rename_service::prepare` 和 `CheckedRename`：把物理文件计划、启动器引用和组合 revision 明确放在一起。引用载荷保留在 Rust 内部。
4. `instance_rename::execute`：验证快照、暂存 JSON、持久登记、移动核心与目录、提交文件状态。完整恢复状态表在该模块开头。
5. `instance_rename_refs::apply`：按固定目标更新设置、元资料、导出配置和撤销记录。每个目标接受预期的修改前或修改后状态，以便重启后继续完成部分迁移。
6. 服务刷新内存中的设置/元资料，命令记录最终任务结果，前端重新读取 bootstrap。

`instance_rename.rs` 管理游戏文件与事务阶段；`instance_rename_refs.rs` 管理启动器资料和项目级待恢复标记；`instance_rename_service.rs` 把两者接到应用任务与缓存。前端导航可以变化，已提交任务始终使用捕获的目标目录。

### 排查改名与恢复问题

- **检查或确认被拒绝**：先看服务的组合 revision，再分别检查文件计划与引用快照；不要通过移除校验来绕过目标变化。
- **取消被接受但结果异常**：查看任务的 `begin_finishing` 和事务的 `committing` 回调。关闭取消接纳后必须再读一次已接受的 token，第一处文件移动后按事务失败/恢复处理。
- **目录已是新名，但恢复要回旧名**：以持久 journal 状态为准。目录移动与 `FilesCommitted` 的持久登记之间存在崩溃窗口。
- **文件改名完成、资料只改了一部分**：查看 `FilesCommitted` 的引用重放。此时应继续完成引用；回滚文件会让已经迁移的引用指向不存在的名字。
- **资料保存或恢复报外部修改**：检查目录身份、文件快照和待恢复标记。保留冲突文件与备份；不直接删除标记或放宽哈希/身份比较。
- **界面重新出现旧选择或内存设置**：检查 config 的 transport revision、`save_settings` 返回值及前端响应接纳条件。保存成功后的新 revision 必须被采用；旧响应不能覆盖已经更新的 bootstrap。
- **切到另一个目录后恢复按钮不可用**：检查 bootstrap 中待恢复的根目录匹配。登记路径可以是别名，事务绑定的是规范路径和目录身份。

## Java 的数据与启动路径

`config.rs` 的 v3 保存全局 `java`、登记路径 `java_paths` 与各目录的 `java_overrides`。缺少实例覆盖表示跟随全局；显式 `Auto` 表示该实例独立自动选择。`Settings` 只投影当前目录的覆盖，启动使用捕获的 `GameRoot`，避免切换目录后读取另一个同名实例的选择。普通设置保存不能直接替换 Java 路径登记表。

添加流程从 `JavaPanel` 经 `java_commands::java_add`、`platform::pick_java` 到 `java_service::register`。目录 ID 和 transport revision 在弹窗前捕获，在执行探测前和提交登记前各检查一次。探测运行在阻塞工作线程中，期间不持有操作互斥锁。添加成功的设置由前端应用入口接纳；原页面卸载后仍需更新已提交的登记表和 revision。

`crates/core/src/java.rs` 统一列表与启动选择。每次探测限制时长和输出，自动发现限制候选数量及总时长。程序使用独立进程组，超时或退出后清理组内子进程，并等待直接子进程；不要改成持锁执行或无界管道读取。手动选择在启动时重新探测，错误不会退回自动选择。Forge/NeoForge 的主版本策略也在核心执行，前端禁用不兼容选项只是提前提示。

v2 设置在普通启动时备份并迁移。已有改名 journal 的引用载荷必须按原 v2 字段顺序重放；存在项目待恢复标记时，只在内存中规范化，保留磁盘字节。完成恢复后的首次合法设置写入再备份恢复后的原始 v2 字节并升级。排查升级与改名交叉问题时，先读 `VersionTwo`、`rename_bytes` 和 `pending_migration`，不要让新字段提前改变 journal 的预期快照。

## ZIP 导入与实例删除

`instance_commands.rs` 只负责桌面准入和任务生命周期。导入前重新创建文件计划，比较 revision 后再启动工作线程；选择器路径和序列化的计划摘要不能作为已验证文件的替代品。事务模块检查来源身份、内容与目标快照，拒绝覆盖，拥有提交和清理记录。取消请求只有在事务明确返回取消时才归为 Cancelled；其他错误使用 `TaskOutcome::Error`，避免迟来的取消掩盖冲突或校验失败。

导入将继承描述合并成独立实例，不把共享内容写回新目录之外的任意路径。公共库和素材只允许相同内容复用。排查时从 `instance_import::prepare`、`execute_checked`、`recover_pending` 开始，核对提交前的来源重检、启动器旧引用检查、暂存所有权登记和中断恢复。`archive.rs` 处理归档结构、格式和版本继承；`filesystem.rs` 处理目录描述符、文件身份与快照；主模块负责计划、持久状态和提交编排。

暂存文件先以匿名文件写入并校验，再登记所有权，最后给它发布文件名。每个文件的登记是独立小记录，完整计划只在状态切换时保存，避免文件较多的整合包反复序列化整份计划。恢复会合并这些登记，按文件身份和哈希核对后才清理；校验或清理失败不能被取消请求遮盖。

删除事务移动 `versions/<id>`，不修改启动器引用。删除 journal 保留名称 reservation，直到原文件恢复成功；安装、导入、改名、启动和资源操作必须检查 reservation。bootstrap 排除外部重新创建的同名目录，防止旧元资料附到不同实例。设置、资料和资源历史的旧引用也不能被新实例默默继承；包括已清空资料的 generation 记录，它仍用于排除旧确认 token。

删除和恢复在 settings flock 后取得恢复区锁，提交前重检 Java 依赖和实例引用。项目待恢复 marker 跨游戏目录阻止资料写入；恢复必须绑定原项目及规范目录。恢复记录仅允许已登记状态的重放或明确的空暂存清理，遇到外部修改保留文件。清理日志临时文件前也要验证恢复目录身份，不能先清理再拒绝外部替换的目录。

`instance_delete/filesystem.rs` 负责目录描述符、内容树快照、锁、移动与空目录清理；主模块负责依赖检查、计划、日志状态和删除/恢复。文件事务回归分别在 `instance_import/tests.rs` 和 `instance_delete/tests.rs`；bootstrap、旧资料及外部重建的组合行为在 `main.rs` 的应用集成用例中。桌面命令在大型归档/内容树的只读校验期间释放 `operations`，返回方案或准入任务前再检查占用、目录绑定和待恢复状态。

## Modrinth 规划、下载与提交

`ResourceDetails` 只选择项目、版本和精确文件名；`ResourceInstall` 读取并确认绑定实例的方案。客户端提交的 URL、哈希或加载器不能取得写入权限。`resource_install_commands` 在后台重读权威方案并比较 revision；网络和大型本地哈希检查不持有 `operations`。任务从信息获取开始就占有单写入准入，页面导航与目录浏览不改变捕获目标。

`modrinth_install/provider.rs` 处理官方 API、响应限额和请求取消；`plan.rs` 处理必要依赖、兼容与本地哈希冲突；`target.rs` 固定实例继承描述、资源目录身份及文件快照；`transfer.rs` 接收并校验文件。取消会丢弃正在等待的请求和匿名文件描述符。计时与取消等待使用既有 Tokio runtime；网络字节仅来自收到的响应，不把复用或磁盘复制计为速度。

所有新文件验证后才交给 `resource_ops::import_verified_batch`。它把模组、资源包和光影当作一个事务，提交前只写自己的暂存区，避免提前改变规划中的资源目录。桌面提交回调关闭取消接纳，再重读已接纳的取消标记，检查目标与旧资源事务；不能使用包含当前批次的 guard 拒绝自己的 journal。

持久状态为 Staging → Prepared → Committed。提交前的恢复只清理仍匹配登记 inode 与内容的本次输出；提交后保留安装结果并清理暂存。根目录级恢复入口不依赖所选实例或某一个资源类型，使跨类型的部分提交仍能恢复。冲突和清理失败保持 Error 与记录，不被迟来的取消掩盖。排查入口为 `modrinth_install/tests.rs`、`resource_ops/verified_batch/tests.rs` 及资源命令的任务集成用例。

## 修改时维持的约束

- **明确目标和所有权**：命令捕获 `root_id`、规范目录和实例 ID；后台任务不随当前页面重新选择目标。删除或清理只处理已登记且仍匹配的文件。
- **文件操作与资料同步分清提交边界**：改变 journal 状态顺序、fsync、原子发布或 marker 清理顺序时，必须重新检查各崩溃窗口的恢复行为。反例用例放在改名模块的 `tests.rs` 中。
- **进程与文件锁的生命周期**：Java 探测可能与后台文件操作并行。`flock` 由打开的文件描述共享，复制或 fork 后仅关闭父进程的描述符不足以保证解锁；锁守卫应在工作结束时显式 `LOCK_UN`，仍保留非阻塞互斥。见 [Linux flock 文档](https://man7.org/linux/man-pages/man2/flock.2.html)。重置与改名的重复描述符用例覆盖这一边界，避免只依赖线程调度复现偶发占用。
- **注释说明原因**：记录不可破坏的约束、锁顺序、失败/恢复策略以及不明显的平台限制。普通语句用清楚的命名表达；过长流程先按职责提取函数。
- **避免含糊的组合值**：有关联的计划、引用和 revision 使用具名结构；错误和副作用应在调用处可见。
- **变更说明和回归用例一起维护**：深层 bug 的用例应覆盖导致故障的时序或数据状态；仅复述实现步骤的测试不能证明恢复正确。

## 验证入口

```sh
# 完整 Rust 工作区，包含桌面命令与应用集成。
cargo test --workspace --locked --features pcl-desktop/custom-protocol

# 改名文件事务及引用迁移的定向用例。
cargo test --locked -p pcl-desktop --features custom-protocol instance_rename

# Java 探测、策略及登记边界。
cargo test --locked -p pcl-core -p pcl-desktop --features pcl-desktop/custom-protocol java

# 类型检查与前端生产构建。
npm run build --prefix apps/desktop

# 格式检查。
cargo fmt --all -- --check
```

改名文件事务用例在 `apps/desktop/src-tauri/src/instance_rename/tests.rs`，引用迁移用例在 `instance_rename_refs/tests.rs`，设置迁移用例在 `config/tests.rs`，Java 核心用例在 `crates/core/src/java_tests.rs`，应用集成用例在桌面 `main.rs`。它们使用独立样例目录；不要把个人实例路径或账号数据写入公开测试。

Rust 测试不能证明真实桌面选择器、网络授权页面或 Minecraft 启动正常。涉及这些边界时，还需要按[使用指南](USAGE.md)在专用实例中手动验证。
