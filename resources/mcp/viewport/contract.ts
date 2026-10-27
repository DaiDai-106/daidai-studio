import { type Static, Type } from "typebox";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const vector = Type.Array(Type.Number(), { minItems: 3, maxItems: 3 });
export const CaptureViewSchema = Type.Enum(
  ["current", "overview", "isometric", "+X", "-X", "+Y", "-Y", "+Z", "-Z"],
  { type: "string" },
);
export type CaptureView = Static<typeof CaptureViewSchema>;
export const CaptureInputSchema = object({
  importId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  revision: Type.Integer({ minimum: 0 }),
  view: Type.Optional(CaptureViewSchema),
});
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
export const captureRequestMethod = "dai/viewport/capture";
export const viewportTools = [
  {
    name: "viewport_capture",
    description:
      "Capture the current viewport or a standard orthographic view. Use overview for one labelled image of all six axis views, with each camera and the scene revision. Does not change the user's camera. Images may hide geometry and are not precise measurements.",
    inputSchema: { ...CaptureInputSchema, type: "object" as const },
  },
];
