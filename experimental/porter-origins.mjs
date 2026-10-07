/** Resource links identify a project; they never grant repository execution or
 * turn a downloaded JAR into source. Only Modrinth's fixed metadata API is read.
 * CurseForge/MC百科 links remain references until a shared provider is available. */
import { check } from "./runtime/src/errors.mjs";

export function parsePorterOrigin(text) {
  check(
    typeof text === "string" &&
      text.length <= 1000 &&
      !/[\s\x00-\x1f]/.test(text),
    "INVALID_ORIGIN",
    "Provide a supported HTTPS mod project link",
  );
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Provide a supported HTTPS mod project link");
  }
  check(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !text.includes("%"),
    "INVALID_ORIGIN",
    "Use a direct project link without credentials, query or fragment",
  );
  let match;
  if (
    ["modrinth.com", "www.modrinth.com"].includes(url.hostname) &&
    (match =
      /^\/mod\/([A-Za-z0-9_-]{1,128})(?:\/version\/([A-Za-z0-9]{8}))?\/?$/.exec(
        url.pathname,
      ))
  ) {
    return {
      provider: "modrinth",
      projectId: match[1],
      versionId: match[2] || null,
      url: `https://modrinth.com/mod/${match[1]}${match[2] ? `/version/${match[2]}` : ""}`,
      resolution: "reference-only",
    };
  }
  if (
    ["curseforge.com", "www.curseforge.com"].includes(url.hostname) &&
    (match =
      /^\/minecraft\/mc-mods\/([A-Za-z0-9_-]{1,128})(?:\/files\/([0-9]{1,12}))?\/?$/.exec(
        url.pathname,
      ))
  ) {
    return {
      provider: "curseforge",
      projectId: match[1],
      versionId: match[2] || null,
      url: `https://www.curseforge.com/minecraft/mc-mods/${match[1]}${match[2] ? `/files/${match[2]}` : ""}`,
      resolution: "reference-only",
    };
  }
  if (
    ["mcmod.cn", "www.mcmod.cn"].includes(url.hostname) &&
    (match = /^\/class\/([0-9]{1,12})\.html$/.exec(url.pathname))
  ) {
    return {
      provider: "mcmod",
      projectId: match[1],
      versionId: null,
      url: `https://www.mcmod.cn/class/${match[1]}.html`,
      resolution: "reference-only",
    };
  }
  throw new Error(
    "Supported links: Modrinth mod, CurseForge Minecraft mod, MC百科 class page",
  );
}

export async function resolvePorterOrigin(
  text,
  fetchMetadata = globalThis.fetch,
) {
  const origin = parsePorterOrigin(text);
  if (origin.provider !== "modrinth") return origin;
  const get = async (endpoint) => {
    const response = await fetchMetadata(
      `https://api.modrinth.com/v2/${endpoint}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "User-Agent":
            "PCL-RH/0.2.0 (https://github.com/HyacineFengJin/PCL-RH)",
        },
      },
    );
    check(
      response.ok &&
        Number(response.headers.get("content-length") || 0) <= 128000,
      "ORIGIN_UNAVAILABLE",
      "Modrinth metadata is unavailable or too large",
    );
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        check(
          bytes <= 128000,
          "ORIGIN_TOO_LARGE",
          "Modrinth metadata exceeds the limit",
        );
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const project = await get(`project/${origin.projectId}`);
  check(
    /^[A-Za-z0-9]{8}$/.test(project.id) &&
      project.project_type === "mod" &&
      (project.id === origin.projectId || project.slug === origin.projectId),
    "ORIGIN_MISMATCH",
    "Modrinth did not return the requested mod project",
  );
  if (origin.versionId) {
    const version = await get(`version/${origin.versionId}`);
    check(
      version.id === origin.versionId && version.project_id === project.id,
      "ORIGIN_MISMATCH",
      "The selected Modrinth version belongs to another project",
    );
  }
  let sourceUrl = null;
  try {
    const source = new URL(project.source_url);
    if (
      source.protocol === "https:" &&
      !source.username &&
      !source.password &&
      source.href.length <= 1000
    )
      sourceUrl = source.href;
  } catch {
    /* Missing source remains an explicit user action. */
  }
  return {
    ...origin,
    projectId: project.id,
    url: `https://modrinth.com/mod/${project.id}${origin.versionId ? `/version/${origin.versionId}` : ""}`,
    resolution: "metadata-resolved",
    title: String(project.title || project.id).slice(0, 160),
    sourceUrl,
    license:
      typeof project.license?.id === "string"
        ? project.license.id.slice(0, 100)
        : null,
  };
}
