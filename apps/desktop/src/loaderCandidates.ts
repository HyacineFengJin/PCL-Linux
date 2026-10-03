import type { Api } from "./types";
const cache = new Map<string, { time: number; versions: string[] }>();
const requests = new Map<string, Promise<string[]>>();
export function loaderCandidates(
  api: Api,
  loader: string,
  minecraft: string,
  refresh = false,
): Promise<string[]> {
  const key = `${loader}:${minecraft}`;
  if (refresh) cache.delete(key);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < 300_000)
    return Promise.resolve([...cached.versions]);
  let request = requests.get(key);
  if (!request) {
    request = api<string[]>("loader_candidates", { loader, minecraft })
      .then((versions) => {
        const clean = [...new Set(versions)];
        cache.set(key, { time: Date.now(), versions: clean });
        return clean;
      })
      .finally(() => requests.delete(key));
    requests.set(key, request);
  }
  return request.then((versions) => [...versions]);
}
