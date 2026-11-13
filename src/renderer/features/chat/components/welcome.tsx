import type { ReactNode } from "react";
import { DaiMascot } from "../../../shared/components/dai_mascot.tsx";

export function Welcome({ children }: { children?: ReactNode }) {
  return (
    <div className="welcome">
      <DaiMascot />
      <h1>今天想和呆呆完成什么？</h1>
      {children && <div className="welcome-actions">{children}</div>}
    </div>
  );
}
