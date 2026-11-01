import { type Static, Type } from "typebox";
import { object } from "./schema.ts";

const vector = Type.Array(Type.Number(), { minItems: 3, maxItems: 3 });
export const CaptureViewSchema = Type.Enum(
  ["current", "overview", "isometric", "+X", "-X", "+Y", "-Y", "+Z", "-Z"],
  { type: "string" },
);
export type CaptureView = Static<typeof CaptureViewSchema>;
const camera = object({
  position: vector,
  target: vector,
  up: vector,
  projection: Type.Enum(["perspective", "orthographic"], { type: "string" }),
});
export const ViewportCaptureSchema = object({
  image: object({
    mimeType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
    ]),
    data: Type.String({ minLength: 1, maxLength: 7_000_000 }),
  }),
  camera,
  views: Type.Optional(
    Type.Array(object({ view: CaptureViewSchema, camera }), { minItems: 6, maxItems: 6 }),
  ),
});
export type ViewportCapture = Static<typeof ViewportCaptureSchema>;
