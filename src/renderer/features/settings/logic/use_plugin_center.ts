import { useCallback, useEffect, useRef, useState } from "react";
import type { Arguments } from "../../../../contracts/application.ts";
import type {
  CatalogDetail,
  CatalogEntry,
  CatalogGroup,
  CatalogInstalled,
  CatalogSourceId,
  CatalogTask,
  PluginModule,
} from "../../../../contracts/catalog.ts";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { mergePluginTasks } from "./plugin_tasks.ts";

// 加载前只需身份与摘要；完整的安装信息必须来自详情接口，避免伪造空字段。
export type PluginSelection = Pick<
  CatalogEntry,
  "sourceId" | "id" | "host" | "name" | "description"
> & { publisher?: string };

const api = () => window.desktop.application;
export function usePluginCenter(moduleId: PluginModule = "coding") {
  const [tab, setTab] = useState<"discover" | "installed" | "skills" | "builtins">("discover");
  const [source, setSource] = useState<CatalogSourceId | "all">("all");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [installed, setInstalled] = useState<CatalogInstalled[]>([]);
  const [tasks, setTasks] = useState<CatalogTask[]>([]);
  const [companyUrl, setCompanyUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailState, setDetailState] = useState<{
    entry: PluginSelection;
    data: CatalogDetail | null;
    error: string;
    loading: boolean;
  } | null>(null);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const connection = useRef(0);
  const installedGeneration = useRef(0);
  const refreshInstalled = useCallback(
    async (clearError = false) => {
      if (clearError) setError("");
      const request = ++installedGeneration.current;
      const current = () => request === installedGeneration.current;
      try {
        const values = await api().installedPlugins(moduleId);
        if (current()) {
          setInstalled(values);
        }
      } catch (error) {
        if (current()) setError(errorMessage(error));
      }
    },
    [moduleId],
  );
  useEffect(() => {
    const life = ++connection.current;
    setInstalled([]);
    void refreshInstalled();
    void api()
      .catalogSources()
      .then((c) => {
        if (life === connection.current) setCompanyUrl(c.companyUrl);
      })
      .catch((e) => {
        if (life === connection.current) setError(errorMessage(e));
      });
    void api()
      .catalogTasks()
      .then(
        (snapshot) => {
          if (life === connection.current)
            setTasks((current) => mergePluginTasks(current, snapshot));
        },
        (error) => {
          if (life === connection.current) setError(errorMessage(error));
        },
      );
    const unsubscribe = api().subscribe((event) => {
      if (life !== connection.current || event.type !== "catalog.task") return;
      setTasks((current) => mergePluginTasks([event.task], current));
      if (event.task.state !== "running") void refreshInstalled();
    });
    return () => {
      connection.current++;
      installedGeneration.current++;
      detailGeneration.current++;
      unsubscribe();
    };
  }, [refreshInstalled]);
  const search = useCallback(
    async (refresh = false, more?: CatalogGroup) => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const values = await api().searchCatalog({
          query,
          offset: more?.nextOffset ?? 0,
          refresh,
          ...(more ? { sourceId: more.sourceId } : source !== "all" ? { sourceId: source } : {}),
        });
        if (request !== generation.current) return;
        setGroups((current) =>
          more
            ? current.map((g) => {
                const next = values.find((v) => v.sourceId === g.sourceId);
                return next
                  ? {
                      ...next,
                      entries: [
                        ...new Map([...g.entries, ...next.entries].map((e) => [e.id, e])).values(),
                      ],
                    }
                  : g;
              })
            : values,
        );
      } catch (e) {
        if (request === generation.current) setError(errorMessage(e));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [query, source],
  );
  useEffect(() => {
    generation.current++;
    setGroups([]);
    const timeout = setTimeout(() => {
      void search();
    }, 300);
    return () => {
      clearTimeout(timeout);
      generation.current++;
    };
  }, [search]);
  function closeDetail() {
    detailGeneration.current++;
    setDetailState(null);
  }

  async function openDetail(entry: PluginSelection, refresh = false) {
    const request = ++detailGeneration.current;
    setDetailState((current) => ({
      entry,
      data:
        current?.entry.id === entry.id && current.entry.sourceId === entry.sourceId
          ? current.data
          : null,
      error: "",
      loading: true,
    }));
    try {
      const data = await api().catalogDetail({ sourceId: entry.sourceId, id: entry.id, refresh });
      if (request === detailGeneration.current)
        setDetailState({ entry, data, error: "", loading: false });
    } catch (error) {
      if (request === detailGeneration.current)
        setDetailState(
          (current) => current && { ...current, error: errorMessage(error), loading: false },
        );
    }
  }

  async function submit(action: () => Promise<CatalogTask>) {
    const life = connection.current;
    setError("");
    try {
      const task = await action();
      if (life !== connection.current) return false;
      setTasks((current) => mergePluginTasks(current, [task]));
      return true;
    } catch (error) {
      if (life === connection.current) setError(errorMessage(error));
      return false;
    }
  }
  const operation = (input: Arguments<"catalog.packageAction">) =>
    submit(() => api().packageAction(input));
  const install = (input: Arguments<"catalog.install">) =>
    submit(() => api().installCatalog(input));
  async function configure(url: string) {
    await api().configureCatalog({ url });
    const config = await api().catalogSources();
    setCompanyUrl(config.companyUrl);
    await search(true);
  }
  return {
    tab,
    setTab,
    source,
    setSource,
    query,
    setQuery,
    groups,
    installed,
    tasks,
    companyUrl,
    error,
    loading,
    detailState,
    closeDetail,
    openDetail,
    search,
    operation,
    install,
    configure,
    refreshInstalled,
    busy: tasks.some((t) => t.state === "running"),
  };
}
