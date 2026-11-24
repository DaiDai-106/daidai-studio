import { useEffect, useState } from "react";
import type { Results } from "../../../../contracts/application.ts";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import { dwgParserProcess } from "../../../../contracts/dwgparser.ts";
import { errorMessage } from "../../../shared/logic/error_message.ts";

type ProcessList = Results["planning.process.get"];

export function usePlanningProcess(api: ApplicationBridge, projectId: string) {
  const [{ snapshot, loadingError }, setList] = useState<{
    snapshot?: ProcessList;
    loadingError?: string;
  }>({});
  const [selectionError, setSelectionError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let revision = 0;
    async function refresh() {
      const request = ++revision;
      try {
        const snapshot = await api.getPlanningProcesses(projectId);
        if (request === revision) setList({ snapshot });
      } catch (cause) {
        if (request === revision)
          setList({ loadingError: errorMessage(cause, "无法读取工艺 MCP。") });
      }
    }

    const unsubscribe = api.subscribe((event) => {
      if (
        event.type === "mcp.process.changed" &&
        (!event.projectId || event.projectId === projectId)
      )
        void refresh();
    });
    void refresh();
    return () => {
      revision++;
      unsubscribe();
    };
  }, [api, projectId]);

  async function select(server: string) {
    setSaving(true);
    setSelectionError("");
    try {
      await api.selectPlanningProcess(projectId, server || null);
    } catch (cause) {
      setSelectionError(errorMessage(cause, "无法保存工艺 MCP 选择。"));
    } finally {
      setSaving(false);
    }
  }

  const selected = snapshot?.selected ?? "";
  const options = (snapshot?.servers ?? []).map(({ id, label, disabled }) => ({
    value: id,
    label: disabled ? `${label}（待配置）` : label,
    disabled: Boolean(disabled && id !== dwgParserProcess.id),
  }));
  if (selected) options.push({ value: "", label: "清除选择", disabled: false });

  let placeholder = "选择工艺 MCP";
  if (loadingError) placeholder = "工艺 MCP 读取失败";
  else if (!snapshot) placeholder = "正在读取工艺 MCP…";
  else if (selected) placeholder = "所选工艺 MCP 不可用";
  else if (!options.length) placeholder = "无可用工艺 MCP";

  return {
    selected,
    options,
    placeholder,
    saving,
    select,
    error: loadingError || selectionError,
    configError: snapshot?.configError,
    needsSetup: snapshot?.servers.every(({ disabled }) => disabled),
    needsDwgParserSetup: snapshot?.servers.some(
      ({ id, disabled }) => id === dwgParserProcess.id && disabled,
    ),
  };
}
