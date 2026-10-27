if (process.env.DAI_TEST_SECRET !== "mock-mcp-credential-not-for-database") process.exit(20);
await import("./mcp-stdio.ts");
