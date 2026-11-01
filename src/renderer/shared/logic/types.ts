// 界面类型复用应用契约，避免维护第二套数据定义。
export type { Theme } from "../../../contracts/desktop.ts";
export type { Mode } from "../../features/chat/logic/modes.ts";
export type Project = import("../../../contracts/application.ts").ProjectInfo;
export type Model = import("../../../contracts/application.ts").ModelChoice;
export type Message = import("../../../contracts/application.ts").MessageInfo;
export type Conversation = import("../../../contracts/application.ts").ConversationInfo & {
  messages: Message[];
};
