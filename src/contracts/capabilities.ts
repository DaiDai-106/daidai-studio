import { type Static, Type } from "typebox";

export const ConversationModeSchema = Type.Union([
  Type.Literal("coding"),
  Type.Literal("scene"),
  Type.Literal("robot"),
]);
export type ConversationMode = Static<typeof ConversationModeSchema>;
