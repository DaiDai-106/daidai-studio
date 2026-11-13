import { Provider as TooltipProvider } from "@radix-ui/react-tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/components/app.tsx";
import { OverlayProvider } from "./shared/logic/overlay_context.tsx";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing.");

createRoot(root).render(
  <StrictMode>
    <TooltipProvider delayDuration={350} skipDelayDuration={100}>
      <OverlayProvider>
        <App />
      </OverlayProvider>
    </TooltipProvider>
  </StrictMode>,
);
