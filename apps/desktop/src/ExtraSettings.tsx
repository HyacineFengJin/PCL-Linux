import { Fragment, useEffect, useState } from "react";
import {
  ChevronDown,
  Globe,
  Earth,
  GitPullRequest,
  ArrowUp,
} from "lucide-react";
import { Collapse } from "./Collapse";
import type { Api, Settings } from "./types";
import commandIcon from "./assets/game-icons/command.png";
import lampTexture from "./assets/game-icons/redstone-lamp.png";
import launcherIcon from "./assets/game-icons/launcher.png";

import ltcAvatar from "./assets/credits/ltcatt.jpg";
import communityAvatar from "./assets/credits/community.png";
import bangAvatar from "./assets/credits/bangbang93.jpg";
import pysioAvatar from "./assets/credits/pysio.jpg";
import easyTierAvatar from "./assets/credits/easytier.png";
import zAvatar from "./assets/credits/z0z0r4.jpg";
import mcmodIcon from "./assets/credits/mcmod.ico";
const avatars: Record<string, string> = {
  LTCatt: ltcAvatar,
  "PCL-Community": communityAvatar,
  bangbang93: bangAvatar,
  Pysio2007: pysioAvatar,
  EasyTier: easyTierAvatar,
  z0z0r4: zAvatar,
};

const unavailable = "此功能尚未开放";
function Card({
  title,
  children,
  collapse = false,
}: {
  title?: string;
  children: React.ReactNode;
  collapse?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="ce-card extra-card">
      {title &&
        (collapse ? (
          <button
            className="extra-heading"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            <h2 className="ce-card-title">{title}</h2>
            <ChevronDown
              size={17}
              className={`ce-disclosure-arrow ${open ? "is-open" : ""}`}
            />
          </button>
        ) : (
          <h2 className="ce-card-title">{title}</h2>
        ))}
      {collapse ? <Collapse open={open}>{children}</Collapse> : children}
    </section>
  );
}
function Field({
  label,
  value,
  children,
  plain = false,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
  plain?: boolean;
}) {
  return (
    <label className="extra-row">
      <span>{label}</span>
      {children ||
        (plain ? (
          <span className="extra-muted">{value}</span>
        ) : (
          <select className="ce-field" disabled title={unavailable}>
            <option>{value}</option>
          </select>
        ))}
    </label>
  );
}
function Check({
  children,
  checked = false,
}: {
  children: React.ReactNode;
  checked?: boolean;
}) {
  return (
    <label className="ce-check extra-check">
      <input
        type="checkbox"
        checked={checked}
        disabled
        readOnly
        title={unavailable}
      />
      {children}
    </label>
  );
}
function Slider({ value = 50 }: { value?: number }) {
  return (
    <input
      className="extra-range"
      style={{ "--range-fill": `${value}%` } as React.CSSProperties}
      type="range"
      min="0"
      max="100"
      value={value}
      disabled
      readOnly
      title={unavailable}
    />
  );
}
function Buttons({ items }: { items: (string | [string, string])[] }) {
  return (
    <div className="ce-actions extra-actions">
      {items.map((v) => (
        <button
          key={typeof v === "string" ? v : v[0]}
          className={"ce-button " + (typeof v === "string" ? "" : v[1])}
          disabled
          title={unavailable}
        >
          {typeof v === "string" ? v : v[0]}
        </button>
      ))}
    </div>
  );
}
function Radios({ items, value }: { items: string[]; value: string }) {
  return (
    <div className="extra-radios">
      {items.map((v) => (
        <label className="ce-memory-mode" key={v}>
          <input
            type="radio"
            checked={v === value}
            readOnly
            disabled
            title={unavailable}
          />
          {v}
        </label>
      ))}
    </div>
  );
}
function HideRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="extra-hide-row">
      <span>{label}</span>
      <div>
        {items.map((v, index) => (
          <Fragment key={v}>
            {(((label === "子页面 设置" || label === "子页面 实例设置") &&
              index === 5) ||
              (label === "子页面 实例设置" && index === 8)) && (
              <span className="extra-hide-spacer" aria-hidden="true" />
            )}
            <Check>{v}</Check>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
const project = "https://github.com/HyacineFengJin/PCL-Linux";
function LinkButton({
  children,
  url,
  api,
  primary = false,
}: {
  children: React.ReactNode;
  url: string;
  api: Api;
  primary?: boolean;
}) {
  return (
    <button
      className={"ce-button " + (primary ? "primary" : "")}
      onClick={() => api("ui_open_link", { url }).catch(() => {})}
    >
      {children}
    </button>
  );
}
export function ExtraSettings({
  section,
  settings,
  api,
  onOpen,
  onNotify,
}: {
  section: string;
  settings: Settings;
  api: Api;
  onOpen: (kind: string) => void;
  onNotify: (s: string) => void;
}) {
  const [logs, setLogs] = useState<LogRow[]>([]),
    [logText, setLogText] = useState<string | null>(null),
    [logError, setLogError] = useState("");
  const [feedback, setFeedback] = useState<Issue[]>([]),
    [feedbackError, setFeedbackError] = useState(""),
    [loading, setLoading] = useState(false);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [contributorError, setContributorError] = useState("");
  useEffect(() => {
    let live = true;
    if (section === "logs") {
      api<LogRow[]>("launcher_logs")
        .then((v) => {
          if (live) setLogs(v);
        })
        .catch((e) => {
          if (live) setLogError(String(e));
        });
    }
    if (section === "feedback") {
      setLoading(true);
      api<Issue[]>("project_feedback")
        .then((v) => {
          if (live) setFeedback(v);
        })
        .catch(() => {
          if (live) setFeedbackError("暂时无法获取反馈列表");
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }
    if (section === "about") {
      api<Contributor[]>("upstream_contributors")
        .then((v) => {
          if (live) {
            setContributors(v);
            setContributorError("");
          }
        })
        .catch(() => {
          if (live) setContributorError("暂时无法获取贡献者列表");
        });
    }
    return () => {
      live = false;
    };
  }, [section, api, settings.root]);
  if (section === "manage")
    return (
      <div className="extra-settings">
        <Card title="游戏资源获取行为">
          <div className="extra-fields">
            <Field
              label="文件下载源"
              value="优先使用官方源，在加载缓慢时换用镜像源"
            />
            <Field
              label="版本列表源"
              value="优先使用官方源，在加载缓慢时换用镜像源"
            />
            <Field label="最大线程数">
              <Slider value={25} />
            </Field>
            <Field label="速度限制">
              <Slider value={100} />
            </Field>
            <Field
              label="目标文件夹"
              plain
              value={
                "请在 启动 → 实例选择 → 文件夹列表 中更改下载目标文件夹。\n在某个文件夹或游戏实例上右键，即可选择打开对应文件夹。"
              }
            />
            <Field label="安装行为">
              <div className="extra-two">
                <Check checked>安装新实例后自动选定该实例</Check>
                <Check checked>升级部分版本的 Authlib</Check>
              </div>
            </Field>
          </div>
        </Card>
        <Card title="社区资源获取行为">
          <div className="extra-fields">
            <Field label="下载源" value="仅在官方源加载缓慢时改用镜像源" />
            <Field label="文件名格式" value="[机械动力] create-1.21.1-6.0.4" />
            <Field label="模组管理样式" value="标题显示译名，详情显示文件名" />
            <Field label="快速下载行为" value="总是询问" />
          </div>
          <Check checked>不显示 Quilt 加载器</Check>
          <Check checked>下载模组时自动检查并安装必需前置</Check>
        </Card>
        <Card title="辅助功能">
          <div className="extra-fields">
            <Field label="游戏更新提示">
              <div className="extra-two extra-update-hints">
                <Check>正式版更新提示</Check>
                <Check>测试版更新提示</Check>
              </div>
            </Field>
            <Field label="游戏语言">
              <Check checked>自动设置为启动器语言</Check>
            </Field>
          </div>
          <Check>识别跳转剪贴板中的社区资源链接</Check>
        </Card>
      </div>
    );
  if (section === "personalize")
    return (
      <div className="extra-settings extra-personalize">
        <Card title="基础">
          <Field label="不透明度">
            <Slider value={100} />
          </Field>
          <div className="extra-blue-notice">
            <p>蓝色，蓝色，还是蓝色！想要逃离蓝色困境？请使用官方快照版！</p>
            <button className="ce-button primary" disabled title={unavailable}>
              获取官方快照版
            </button>
          </div>
          <div className="extra-themes">
            <Field label="主题" value="跟随系统" />
            <Field label="浅色配色" value="龙猫蓝" />
            <Field label="深色配色" value="龙猫蓝" />
          </div>
          <Check checked>打开启动器时显示 PCL CE 图标</Check>
          <Check>锁定启动器大小</Check>
          <Check checked>在启动游戏时显示“你知道吗”</Check>
          <Check>高级材质</Check>
        </Card>
        <Card title="字体">
          <div className="extra-fields extra-font-fields">
            <Field label="全局" value="默认" />
            <Field label="MOTD" value="默认" />
          </div>
        </Card>
        <Card title="背景图片/视频">
          <Check checked>叠加彩色背景</Check>
          <Buttons items={["打开文件夹", "刷新背景内容"]} />
        </Card>
        <Card title="背景音乐">
          <Buttons items={["打开文件夹", "刷新背景音乐"]} />
        </Card>
        <Card title="标题栏">
          <Radios items={["无", "默认", "文本", "图片"]} value="默认" />
        </Card>
        <Card title="主页">
          <Radios
            items={["空白", "预设", "读取本地文件", "联网更新"]}
            value="空白"
          />
        </Card>
        <Card title="功能隐藏">
          <p className="extra-paragraph">
            你可以隐藏不需要的页面或关闭特定功能。在任意界面按 F12
            可以暂时显示被隐藏的功能。
          </p>
          <HideRow label="主页面" items={["下载", "设置", "工具"]} />
          <HideRow
            label="子页面 设置"
            items={[
              "启动",
              "Java",
              "管理",
              "联机",
              "个性化",
              "语言",
              "杂项",
              "软件更新",
              "关于",
              "反馈",
              "查看日志",
            ]}
          />
          <HideRow label="子页面 工具" items={["联机", "百宝箱"]} />
          <HideRow
            label="子页面 实例设置"
            items={[
              "修改",
              "导出",
              "存档",
              "截图",
              "Mod",
              "资源包",
              "光影包",
              "投影原理图",
              "服务器",
            ]}
          />
          <HideRow
            label="特定功能"
            items={["实例管理", "模组更新", "功能隐藏"]}
          />
        </Card>
      </div>
    );
  if (section === "language")
    return (
      <div className="extra-settings extra-language">
        <Card title="语言">
          <div className="extra-fields extra-language-fields">
            <Field label="界面语言" value="跟随系统（简体中文（中国大陆））" />
            <Field label="区域格式" value="跟随系统区域格式" />
          </div>
          <div className="extra-language-banner">
            <Earth className="extra-language-globe" />
            <h3>
              让<br />
              <strong>PCL CE</strong>
              <br />
              走向国际化。
            </h3>
            <p>在社区的共同助力下，PCL CE 正迈向国际化的新篇章。</p>
            <p>
              欢迎前往翻译平台参与本地化贡献，或向 GitHub 仓库提交 Pull
              Request，与我们一同完善多语言支持，为 PCL CE
              更好地服务全球用户的目标添砖加瓦。
            </p>
            <p>
              感谢每一位参与翻译、校对与改进的贡献者，让 PCL CE
              因你们而更加完善。
            </p>
          </div>
          <div className="extra-language-links">
            <button className="ce-text-button" disabled title={unavailable}>
              <Globe size={16} />
              前往翻译平台
            </button>
            <button
              className="ce-text-button"
              onClick={() => api("ui_open_link", { url: project + "/pulls" })}
            >
              <GitPullRequest size={16} />
              提交 Pull Request
            </button>
          </div>
        </Card>
      </div>
    );
  if (section === "misc")
    return (
      <div className="extra-settings extra-misc">
        <Card title="系统">
          <div className="extra-fields">
            <Field label="启动器公告" value="显示所有公告" />
            <Field label="最高动画帧率">
              <Slider value={100} />
            </Field>
            <Field label="实时日志行数">
              <Slider value={45} />
            </Field>
          </div>
          <div className="extra-inline-checks">
            <Check>禁用硬件加速</Check>
            <Check>启用遥测数据收集</Check>
          </div>
          <Buttons
            items={["导出设置", "导入设置", ["停止使用 PCL CE", "danger"]]}
          />
        </Card>
        <Card title="网络">
          <Check checked>使用 DoH 解析地址</Check>
          <Field label="HTTP 代理">
            <Radios
              items={["不使用代理", "使用系统代理", "自定义代理"]}
              value="使用系统代理"
            />
          </Field>
        </Card>
        <Card title="调试选项" collapse>
          <Field label="动画速度">
            <Slider value={30} />
          </Field>
          <div className="extra-debug-checks">
            <Check>禁止在下载时从其他文件夹复制文件</Check>
            <Check>调试模式</Check>
            <Check>添加延迟</Check>
          </div>
        </Card>
      </div>
    );
  if (section === "update")
    return (
      <div className="extra-settings extra-software-update">
        <Card>
          <div className="extra-fields">
            <Field label="更新通道" value="测试版 / Beta" />
            <Field label="自动更新设置" value="自动下载并提示更新" />
            <Field label="Mirror 酱 CDK">
              <div className="ce-inline">
                <input className="ce-field" disabled title={unavailable} />
                <button
                  className="ce-button primary"
                  disabled
                  title={unavailable}
                >
                  获取 CDK
                </button>
              </div>
            </Field>
          </div>
        </Card>
        <Card>
          <div className="extra-update">
            <img src={launcherIcon} alt="" />
            <div>
              <strong>PCL Linux 0.2.0</strong>
              <p>自动更新尚未开放</p>
            </div>
            <div className="extra-update-actions">
              <button
                className="ce-button primary"
                disabled
                title={unavailable}
              >
                再次检查
              </button>
              <LinkButton api={api} url={project + "/commits/master/"}>
                查看更新日志
              </LinkButton>
            </div>
          </div>
        </Card>
      </div>
    );
  if (section === "feedback")
    return (
      <div className="extra-settings">
        <Card title="提交反馈">
          <p className="extra-paragraph">
            在提交反馈之前，先查找一下是否存在重复反馈，如果有重复反馈，那么请不要再次提交反馈，这样会加剧维护者的负担……
            <br />
            注意：此页面未展示所有的反馈，如需查看更多反馈，请前往 GitHub。
          </p>
          <div className="extra-actions">
            <LinkButton primary api={api} url={project + "/issues"}>
              前往反馈
            </LinkButton>
          </div>
        </Card>
        {["正在处理", "等待处理", "等待"].map((name, i) => (
          <Card key={name} title={name} collapse>
            {loading ? (
              <p className="extra-muted">正在获取反馈…</p>
            ) : feedbackError ? (
              <p className="extra-muted">{feedbackError}</p>
            ) : feedback.filter((v) =>
                i === 0
                  ? v.labels.some((x) =>
                      ["in progress", "正在处理"].includes(x),
                    )
                  : i === 1
                    ? !v.labels.some((x) =>
                        ["in progress", "正在处理", "waiting", "等待"].includes(
                          x,
                        ),
                      )
                    : v.labels.some((x) => ["waiting", "等待"].includes(x)),
              ).length === 0 ? (
              <p className="extra-muted">暂无反馈</p>
            ) : (
              feedback
                .filter((v) =>
                  i === 0
                    ? v.labels.some((x) =>
                        ["in progress", "正在处理"].includes(x),
                      )
                    : i === 1
                      ? !v.labels.some((x) =>
                          [
                            "in progress",
                            "正在处理",
                            "waiting",
                            "等待",
                          ].includes(x),
                        )
                      : v.labels.some((x) => ["waiting", "等待"].includes(x)),
                )
                .map((v) => (
                  <button
                    className="extra-issue"
                    key={v.url}
                    onClick={() => api("ui_open_link", { url: v.url })}
                  >
                    <FeedbackIcon active={i === 0} />
                    <div>
                      {v.title}
                      <small>
                        {v.labels.join("　")}　{v.author} |{" "}
                        {new Date(v.created_at).toLocaleString("zh-CN")}
                      </small>
                    </div>
                  </button>
                ))
            )}
          </Card>
        ))}
      </div>
    );
  if (section === "logs")
    return (
      <div className="extra-settings">
        <Card title="日志操作">
          <div className="ce-actions extra-log-actions">
            <button className="ce-button primary" disabled title={unavailable}>
              导出日志
            </button>
            <button className="ce-button" disabled title={unavailable}>
              导出全部日志
            </button>
            <button className="ce-button" onClick={() => onOpen("logs")}>
              打开日志目录
            </button>
            <button className="ce-button danger" disabled title={unavailable}>
              清理历史日志
            </button>
          </div>
        </Card>
        <Card title="所有日志">
          {logError ? (
            <p className="extra-muted">{logError}</p>
          ) : !logs.length ? (
            <p className="extra-muted">暂无游戏启动日志</p>
          ) : (
            logs.map((v) => (
              <button
                className="extra-log-row"
                key={v.path}
                onClick={() =>
                  api<string>("launcher_read_log", { name: v.name })
                    .then(setLogText)
                    .catch((e) => onNotify(String(e)))
                }
              >
                {new Date(v.modified * 1000).toLocaleString("zh-CN")}
                {v.current ? " (当前)" : ""}
                <small>{v.path}</small>
              </button>
            ))
          )}
        </Card>
        {logText !== null && (
          <Card title="日志内容" collapse>
            <pre className="log-view">{logText}</pre>
          </Card>
        )}
      </div>
    );
  if (section === "about")
    return (
      <div className="extra-settings">
        <Card title="关于">
          <Credit
            name="龙腾猫跃"
            description="Plain Craft Launcher 的原作者！"
            avatar="LTCatt"
            action="赞助原作者"
          />
          <Credit
            name="PCL Community"
            description="Plain Craft Launcher Community Edition 的开发团队！"
            avatar="PCL-Community"
            action="GitHub 主页"
            api={api}
            url="https://github.com/PCL-Community"
          />
          <Credit
            name="PCL Linux"
            description="当前版本: 0.2.0（Linux 原生实验版）"
            image={launcherIcon}
            action="查看源代码"
            api={api}
            url={project}
          />
        </Card>
        <Card title="特别鸣谢">
          <Credit
            name="bangbang93"
            description="提供 BMCLAPI 镜像源和 Forge 安装工具，详见 https://bmclapi.bangbang93.com"
            avatar="bangbang93"
            action="赞助镜像源"
          />
          <Credit
            name="MC 百科"
            image={mcmodIcon}
            description="提供了模组名称的中文翻译和更多模组相关信息！"
            action="打开百科"
            api={api}
            url="https://www.mcmod.cn/"
          />
          <Credit
            name="Pysio @ Akaere Network"
            description="提供了 PCL CE 的相关云服务"
            avatar="Pysio2007"
            action="转到博客"
          />
          <Credit
            name="云默安 @ 至远光辉"
            description="提供了 PCL CE 的相关云服务"
            action="打开网站"
          />
          <Credit
            name="EasyTier"
            description="提供了上游联机模块"
            avatar="EasyTier"
            action="打开网站"
          />
          <Credit
            name="z0z0r4"
            description="提供了 MCIM 中国模组下载镜像源和帮助库图床！"
            avatar="z0z0r4"
          />
          <Credit
            name="Emperornummy"
            description="设计并制作了 PCL CE 的图标"
            image={launcherIcon}
          />
        </Card>
        <Card title="贡献者们">
          {contributorError && (
            <p className="extra-muted">{contributorError}</p>
          )}
          <div className="extra-contributors">
            {contributors.map((v) => (
              <button
                key={v.login}
                title={v.login}
                onClick={() => api("ui_open_link", { url: v.url })}
              >
                <img src={v.avatar} alt="" />
                <span>{v.login}</span>
              </button>
            ))}
          </div>
          <div className="extra-more">
            <LinkButton
              api={api}
              url="https://github.com/PCL-Community/PCL-CE/graphs/contributors"
            >
              查看更多
            </LinkButton>
          </div>
        </Card>
        <Card title="版权声明与法律信息" collapse>
          <div className="extra-legal">
            <h3>隐私说明</h3>
            <p>
              请求头中的 User Agent
              包含启动器版本号。正版登录、资源下载和项目查询会向对应服务发送所需请求。
            </p>
            <h3>其他信息</h3>
            <p>
              PCL Linux 是独立的 Linux 原生实现，界面参照 Plain Craft Launcher
              Community Edition。
              <br />非 MINECRAFT 官方产品。未经 MOJANG 或 MICROSOFT 批准，也不与
              MOJANG 或 MICROSOFT 关联。
            </p>
          </div>
          <Buttons
            items={[
              "PCL CE 开源代码",
              "PCL CE 联机大厅隐私政策",
              "Natayark OpenID 服务条款",
            ]}
          />
        </Card>
        <Card title="上游版权与法律信息" collapse>
          <div className="extra-legal">
            <h3>其他信息</h3>
            <p>
              Copyright © 龙腾猫跃 2016. All Rights Reserved.
              <br />
              计算机软件著作权登记号: 2020SR0875133
              <br />非 MINECRAFT 官方产品。未经 MOJANG 或 MICROSOFT 批准，也不与
              MOJANG 或 MICROSOFT 关联。
            </p>
          </div>
          <Buttons items={["用户协议与免责声明", "开源代码"]} />
        </Card>
        <Card title="许可与版权声明" collapse>
          {[
            [
              "Noto Sans CJK SC",
              "Copyright © Google / Adobe",
              "SIL Open Font License 1.1",
            ],
            [
              "HMCL 图像资源",
              "Copyright © HMCL contributors",
              "GNU General Public License v3",
            ],
            ["Minecraft 图像资源", "Copyright © Mojang", ""],
            [
              "React",
              "Copyright © Meta Platforms, Inc. and affiliates.",
              "MIT",
            ],
            ["Tauri", "Copyright © Tauri contributors", "MIT / Apache-2.0"],
          ].map((v) => (
            <div className="extra-license" key={v[0]}>
              <strong>{v[0]}</strong>
              <div>
                {v[1]}
                <br />
                {v[2]}
                <Buttons items={["查看来源网站", "查看许可文档"]} />
              </div>
            </div>
          ))}
        </Card>
        <button
          className="extra-back-top"
          aria-label="返回顶部"
          onClick={() =>
            document
              .querySelector(".content")
              ?.scrollTo({ top: 0, behavior: "smooth" })
          }
        >
          <ArrowUp size={20} />
        </button>
      </div>
    );
  return null;
}
function Credit({
  name,
  description,
  avatar,
  image,
  action,
  api,
  url,
}: {
  name: string;
  description: string;
  avatar?: string;
  image?: string;
  action?: string;
  api?: Api;
  url?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="extra-credit">
      {(image || avatar) && !failed ? (
        <img
          src={image || avatars[avatar!]}
          onError={() => setFailed(true)}
          alt=""
        />
      ) : (
        <span className="extra-credit-fallback">{name.slice(0, 2)}</span>
      )}
      <div>
        <span>{name}</span>
        <small>{description}</small>
      </div>
      {action &&
        (api && url ? (
          <LinkButton api={api} url={url}>
            {action}
          </LinkButton>
        ) : (
          <button className="ce-button" disabled title={unavailable}>
            {action}
          </button>
        ))}
    </div>
  );
}
type LogRow = {
  name: string;
  path: string;
  modified: number;
  current: boolean;
};
type Issue = {
  title: string;
  url: string;
  labels: string[];
  author: string;
  created_at: string;
};
type Contributor = { login: string; avatar: string; url: string };

function FeedbackIcon({ active }: { active: boolean }) {
  return active ? (
    <img className="extra-issue-mark" src={commandIcon} alt="" />
  ) : (
    <svg className="extra-issue-mark" viewBox="0 0 32 32" aria-hidden="true">
      <image
        href={lampTexture}
        width="16"
        height="16"
        transform="matrix(1,-.5,1,.5,0,8)"
      />
      <image
        href={lampTexture}
        width="16"
        height="16"
        transform="matrix(1,.5,0,1,0,8)"
      />
      <image
        href={lampTexture}
        width="16"
        height="16"
        transform="matrix(1,-.5,0,1,16,16)"
        style={{ filter: "brightness(.8)" }}
      />
    </svg>
  );
}
