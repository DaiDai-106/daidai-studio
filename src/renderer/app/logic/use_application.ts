import { useEffect, useState, useSyncExternalStore } from "react";
import { createApplicationClient } from "./application_client.ts";

export function useApplication() {
  const [client] = useState(() => createApplicationClient(window.desktop.application));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => client.connect(), [client]);
  return {
    ...state,
    api: client.api,
    refresh: client.refresh,
    report: client.report,
    activate: client.activate,
    updateConversation: client.updateConversation,
    deleteConversation: client.deleteConversation,
    run: client.run,
    loadMore: client.loadMore,
  };
}
export type ApplicationState = ReturnType<typeof useApplication>;
