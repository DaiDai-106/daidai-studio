import { type Static, Type } from "typebox";

// Project-relative identity survives chat changes and application restarts.
export const StepSourceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    projectId: Type.String({ minLength: 1, maxLength: 200 }),
    relativePath: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: false },
);
export type StepSourceInfo = Static<typeof StepSourceSchema>;
