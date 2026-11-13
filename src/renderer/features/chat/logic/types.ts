import type { ConversationInfo, MessageInfo } from "../../../../contracts/application.ts";

// 聊天界面将当前订阅的消息附加到会话摘要；持久数据仍由契约定义。
export type Conversation = ConversationInfo & { messages: MessageInfo[] };
