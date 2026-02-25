import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("memory-braid plugin", () => {
  it("registers tools, hooks, and service", async () => {
    const tools: Array<{ factory: unknown; options?: unknown }> = [];
    const hooks: Array<{ name: string; handler: unknown }> = [];
    const services: Array<{ id: string; start: (ctx: unknown) => Promise<void> | void }> = [];

    const api = {
      pluginConfig: {},
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      config: {
        agents: {
          defaults: {
            workspace: "/tmp",
          },
        },
      },
      runtime: {
        state: {
          resolveStateDir: () => "/tmp/.openclaw",
        },
        tools: {
          createMemorySearchTool: () => ({
            name: "memory_search",
            parameters: {},
            execute: async () => ({
              details: { results: [] },
              content: [{ type: "text", text: "{}" }],
            }),
          }),
          createMemoryGetTool: () => ({
            name: "memory_get",
            execute: async () => ({
              details: { path: "", text: "" },
              content: [{ type: "text", text: "{}" }],
            }),
          }),
        },
      },
      registerTool: (factory: unknown, options?: unknown) => {
        tools.push({ factory, options });
      },
      on: (name: string, handler: unknown) => {
        hooks.push({ name, handler });
      },
      registerService: (service: { id: string; start: (ctx: unknown) => Promise<void> | void }) => {
        services.push(service);
      },
    };

    await plugin.register(api as never);

    expect(tools).toHaveLength(1);
    expect(hooks.map((item) => item.name)).toEqual(
      expect.arrayContaining(["before_agent_start", "agent_end"]),
    );
    expect(services.map((service) => service.id)).toContain("memory-braid-service");
  });
});
