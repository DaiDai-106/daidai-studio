import { type Static, Type } from "typebox";

export const ConversationModeSchema = Type.Literal("coding");
export type ConversationMode = Static<typeof ConversationModeSchema>;
