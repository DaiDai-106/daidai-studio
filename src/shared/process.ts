import { type Static, Type } from "typebox";
import type { ApplicationEvent, Arguments, Method } from "./application.ts";

// Private Main ↔ backend messages; these paths are never exposed by Preload.
export type ResourceRequest = {
  type: "resource";
  version: 1;
  id: string;
  importId: string;
  resourceId: string;
};
export const ResourceLocationSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 8192 }),
    mediaType: Type.String({ maxLength: 100 }),
    byteLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ResourceLocation = Static<typeof ResourceLocationSchema>;

export type BackendRequest = {
  type: "request";
  version: 1;
  id: string;
  method: Method;
  args: Arguments<Method>;
};
export type BackendResponse = { type: "response"; id: string } & (
  | { ok: true; result: unknown }
  | { ok: false; error: string }
);
export type VaultRequest = { type: "vault"; id: string; action: "read" | "write"; value?: string };
export type VaultResponse = { type: "vault-result"; id: string } & (
  | { ok: true; value: string }
  | { ok: false; error: string }
);
export type BackendMessage =
  | BackendResponse
  | VaultRequest
  | { type: "event"; event: ApplicationEvent };
