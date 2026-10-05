import { t, formatNumber } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Api } from "./types";
import type {
  LauncherAction,
  LauncherPreferenceView,
  LauncherEffect,
} from "./launcherTypes";
import type { useLauncherPreferences } from "./useLauncherPreferences";

type Asset = {
  id: string;
  name: string;
  path: string;
  kind: "image" | "video" | "audio";
};
type Homepage = {
  schema_version: 1;
  title: string | null;
  sections: {
    title: string | null;
    text: string;
    links: { label: string; url: string }[];
  }[];
};
type HomeRead = { revision: string; page: Homepage };
const effects: readonly LauncherEffect[] = [
  "fonts",
  "title",
  "home",
  "background",
  "music",
  "network_proxy",
  "doh",
];
export const mediaUrl = (collection: string, id: string) =>
  convertFileSrc(`${collection}/${id}`, "pcl-media");
function preset(): Homepage {
  return {
    schema_version: 1,
    title: "PCL Linux",
    sections: [
      {
        title: t("assets.welcome"),
        text: t("assets.homeHelp"),
        links: [
          {
            label: t("assets.project"),
            url: "https://github.com/HyacineFengJin/PCL-Linux",
          },
        ],
      },
    ],
  };
}

/** Media is limited to the native catalog's owned IDs. Home content is loaded
 * only by an explicit user action: importing preferences never fetches a URL,
 * executes code, or reads the imported local-home pathname. */
export function useLauncherAssets(
  api: Api,
  native: boolean,
  launcher: ReturnType<typeof useLauncherPreferences>,
  notify: (message: string) => void,
) {
  const [backgrounds, setBackgrounds] = useState<Asset[]>([]),
    [music, setMusic] = useState<Asset[]>([]);
  const [title, setTitle] = useState<Asset | null>(null),
    [fonts, setFonts] = useState<string[]>([]);
  const [home, setHome] = useState<{ key: string; page: Homepage } | null>(
    null,
  );
  const [track, setTrack] = useState(0);
  const prefs = launcher.prefs;
  const homeKey = JSON.stringify(prefs.home) + `:${launcher.importEpoch}`;
  const current = useRef({ launcher, homeKey, notify });
  current.current = { launcher, homeKey, notify };
  useEffect(() => {
    if (!native) return;
    let live = true;
    for (const collection of ["backgrounds", "music"] as const) {
      void api<Asset[]>("launcher_assets", { collection })
        .then((rows) => {
          if (live)
            collection === "backgrounds"
              ? setBackgrounds(rows)
              : setMusic(rows);
        })
        .catch((error) => {
          if (live) current.current.notify(String(error));
        });
    }
    void api<string[]>("launcher_fonts")
      .then((rows) => {
        if (live) setFonts(rows);
      })
      .catch((error) => {
        if (live) current.current.notify(String(error));
      });
    return () => {
      live = false;
    };
  }, [api, native]);
  useEffect(() => {
    if (!native || prefs.title.mode !== "image") {
      setTitle(null);
      return;
    }
    let live = true;
    void api<Asset | null>("launcher_title_asset")
      .then((value) => {
        if (live) setTitle(value);
      })
      .catch((error) => {
        if (live) {
          setTitle(null);
          current.current.notify(String(error));
        }
      });
    return () => {
      live = false;
    };
  }, [api, native, prefs.title.mode, prefs.title.image_path]);
  useEffect(() => {
    // Font names were validated as one family, never arbitrary CSS syntax.
    const style = document.documentElement.style;
    for (const [key, family] of [
      ["--ce-font", prefs.appearance.global_font],
      ["--ce-motd-font", prefs.appearance.motd_font],
    ]) {
      if (family) style.setProperty(key, `"${family}", "PCL UI", sans-serif`);
      else style.removeProperty(key);
    }
  }, [prefs.appearance.global_font, prefs.appearance.motd_font]);
  useEffect(() => {
    const initial = music.findIndex(
      (value) => value.id === prefs.background.music_asset_id,
    );
    setTrack(Math.max(0, initial));
  }, [music, prefs.background.music_asset_id]);
  async function action(action: LauncherAction) {
    await launcher.run(async () => {
      const currentLauncher = current.current.launcher;
      const revision = currentLauncher.view.revision;
      if (
        action === "open_background_folder" ||
        action === "open_music_folder"
      ) {
        await api("launcher_open_media_folder", {
          collection: action === "open_music_folder" ? "music" : "backgrounds",
        });
      } else if (
        action === "refresh_background" ||
        action === "refresh_music"
      ) {
        const collection = action === "refresh_music" ? "music" : "backgrounds";
        const rows = await api<Asset[]>("launcher_assets", { collection });
        const key =
          collection === "music" ? "music_asset_id" : "background_asset_id";
        const selection =
          rows.find(
            (row) => row.id === currentLauncher.prefs.background[key],
          ) || rows[0];
        const view = await api<LauncherPreferenceView>(
          "launcher_preferences_update",
          { revision, patch: { background: { [key]: selection?.id || "" } } },
        );
        currentLauncher.adopt(view);
        if (collection === "music") setMusic(rows);
        else setBackgrounds(rows);
        current.current.notify(
          rows.length
            ? t("assets.refreshed", { count: formatNumber(rows.length) })
            : t("assets.empty"),
        );
      } else if (action === "pick_title_image") {
        const result = await api<{
          view: LauncherPreferenceView;
          asset: Asset;
        } | null>("launcher_title_pick", { revision });
        if (result) {
          currentLauncher.adopt(result.view);
          setTitle(result.asset);
        }
      } else if (action === "pick_home_file") {
        const result = await api<{
          view: LauncherPreferenceView;
          home: HomeRead;
        } | null>("launcher_home_pick", { revision });
        if (result) {
          currentLauncher.adopt(result.view);
          setHome({
            key:
              JSON.stringify(result.view.preferences.home) +
              `:${currentLauncher.importEpoch}`,
            page: result.home.page,
          });
        }
      } else if (action === "refresh_home") {
        const key = current.current.homeKey;
        const result = await api<HomeRead | null>("launcher_home_refresh");
        if (current.current.homeKey === key)
          setHome(result ? { key, page: result.page } : null);
      } else throw new Error(t("assets.unknown"));
    });
  }
  const handles = (action: LauncherAction) =>
    [
      "open_background_folder",
      "refresh_background",
      "open_music_folder",
      "refresh_music",
      "pick_title_image",
      "pick_home_file",
      "refresh_home",
    ].includes(action);
  const background =
    backgrounds.find(
      (row) => row.id === prefs.background.background_asset_id,
    ) || null;
  const activeMusic = prefs.background.music_asset_id
    ? music[track] || null
    : null;
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = audio.current;
    if (!element || !activeMusic) return;
    let live = true;
    const retry = () => {
      void element.play().catch(() => {
        if (live) current.current.notify(t("assets.musicError"));
      });
    };
    void element.play().catch(() => {
      if (live) {
        current.current.notify(t("assets.musicClick"));
        window.addEventListener("pointerdown", retry, { once: true });
      }
    });
    return () => {
      live = false;
      window.removeEventListener("pointerdown", retry);
      element.pause();
    };
  }, [activeMusic?.id]);
  const backgroundUi = background ? (
    <div className="launcher-background">
      {background.kind === "video" ? (
        <video
          src={mediaUrl("backgrounds", background.id)}
          autoPlay
          muted
          loop
          playsInline
          onError={() => notify(t("assets.videoError"))}
        />
      ) : (
        <img
          src={mediaUrl("backgrounds", background.id)}
          alt=""
          onError={() => notify(t("assets.imageError"))}
        />
      )}
    </div>
  ) : null;
  const musicUi = activeMusic ? (
    <audio
      ref={audio}
      src={mediaUrl("music", activeMusic.id)}
      onEnded={() => setTrack((value) => (value + 1) % music.length)}
      onError={() => notify(t("assets.audioError"))}
    />
  ) : null;
  const page =
    prefs.home.mode === "preset"
      ? preset()
      : home?.key === homeKey
        ? home.page
        : null;
  const homeUi =
    prefs.home.mode === "blank" ? null : (
      <div className="launcher-home">
        {page ? (
          <>
            {page.title && <h2>{page.title}</h2>}
            {page.sections.map((section, index) => (
              <section className="ce-card" key={index}>
                {section.title && (
                  <h3 className="ce-card-title">{section.title}</h3>
                )}
                <p>{section.text}</p>
                {!!section.links.length && (
                  <div className="ce-actions">
                    {section.links.map((link, linkIndex) => (
                      <button
                        className="ce-button"
                        key={linkIndex}
                        onClick={() =>
                          void api("launcher_home_open_link", {
                            url: link.url,
                          }).catch((error) => notify(String(error)))
                        }
                      >
                        {link.label}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </>
        ) : (
          <section className="ce-card">
            <p>{t("assets.homeUnread")}</p>
            <button
              className="ce-button"
              disabled={!native || launcher.busy}
              onClick={() =>
                void action("refresh_home").catch((error) =>
                  notify(String(error)),
                )
              }
            >
              {t("assets.readHome")}
            </button>
          </section>
        )}
      </div>
    );
  return {
    action,
    handles,
    effects,
    background,
    title,
    fonts,
    backgroundUi,
    musicUi,
    homeUi,
  };
}
