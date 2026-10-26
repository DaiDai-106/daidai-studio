import { type Static, Type } from "typebox";

// Trusted launch configuration. Source files are always explicit tool arguments.
export const ServerConfigSchema = Type.Object(
  {
    executable: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    projectRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    stagingRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    limits: Type.Optional(
      Type.Object(
        {
          maxFileBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          maxObjects: Type.Optional(Type.Integer({ minimum: 1 })),
          maxTriangles: Type.Optional(Type.Integer({ minimum: 1 })),
          maxResourceBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          maxTotalResourceBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          maxRetainedJobs: Type.Optional(Type.Integer({ minimum: 1 })),
          jobTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
          queryTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ServerConfig = Static<typeof ServerConfigSchema>;
export type WorkerConfig = ServerConfig & { outputRoot: string };
