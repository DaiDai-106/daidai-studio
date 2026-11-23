import type { ReactNode } from "react";
import { sceneJointTypes } from "../../../../contracts/scene.ts";

export function SceneNewLinkFields({ children }: { children?: ReactNode }) {
  return (
    <>
      <label>
        新连杆名称
        <input name="linkName" required maxLength={200} />
      </label>
      <label>
        新关节名称
        <input name="jointName" required maxLength={200} />
      </label>
      {children}
      <label>
        新关节类型
        <select aria-label="新关节类型" name="jointType">
          {sceneJointTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
    </>
  );
}
