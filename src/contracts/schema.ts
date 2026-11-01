import { type TSchema, Type } from "typebox";

// 跨进程契约默认拒绝未声明字段，避免不同进程对同一消息产生不同理解。
export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// 项目、对话等普通标识共用相同长度限制；资源哈希另有专门约束。
export const id = Type.String({ minLength: 1, maxLength: 200 });
