import { mkdtemp, rm, writeFile, realpath, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import type * as FileSystem from "node:fs/promises";
import contribute from "../../index.server";

const { networkProbes, spawn } = vi.hoisted(() => ({
  networkProbes: [] as string[],
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));
vi.mock("node:child_process", async (actual) => ({ ...(await actual<typeof ChildProcess>()), spawn }));
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof FileSystem>();
  return { ...fs, stat: async (path: string, ...args: unknown[]) => {
    if (/^[\\/]{2}/.test(String(path))) {
      networkProbes.push(String(path));
      throw new Error("Unexpected network filesystem probe");
    }
    return (fs.stat as (...args: unknown[]) => unknown)(path, ...args);
  } };
});

type Handler = (input: { cwd: string; path: string }) => Promise<Record<string, unknown>>;
let root = "";
let handlers: Map<string, Handler>;
let cleanup: (() => unknown) | undefined;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "better-paseo-path-")));
  await writeFile(join(root, "sample.png"), png);
  await writeFile(join(root, "notes.md"), "# notes\n");
  await writeFile(join(root, "My Notes #1.md"), "# spaced\n");
  await mkdir(join(root, "directory"));
  await symlink(join(root, "directory"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  handlers = new Map();
  const server = new Proxy({}, {
    get: (_, key) => key === "registerSettings"
      ? () => ({ read: async () => ({ status: "invalid" }), subscribe: () => () => {} })
      : key === "handle" ? (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler)
      : () => () => {},
  }) as PluginServerContext;
  cleanup = contribute(server);
}, 30_000);

afterAll(async () => {
  await cleanup?.();
  await rm(root, { recursive: true, force: true });
});

describe("local-only file RPCs", () => {
  for (const rpc of ["file.image", "file.reveal"]) {
    it(`${rpc} rejects UNC input before probing a network location`, async () => {
      networkProbes.length = 0;
      const before = spawn.mock.calls.length;
      const result = await handlers.get(rpc)!({ cwd: root, path: String.raw`\\example.invalid\share\image.png` });
      expect(result.error).toMatch(/local|network|device|unsafe/i);
      expect(networkProbes).toEqual([]);
      expect(spawn.mock.calls.length).toBe(before);
    });
    it(`${rpc} rejects an unsafe cwd and does not launch an app`, async () => {
      const before = spawn.mock.calls.length;
      const result = await handlers.get(rpc)!({ cwd: String.raw`\\example.invalid\share`, path: join(root, "sample.png") });
      expect(result.error).toMatch(/local|network|device|unsafe/i);
      expect(spawn.mock.calls.length).toBe(before);
    });
    it(`${rpc} rejects a link ancestor without falling back`, async () => {
      const before = spawn.mock.calls.length;
      const result = await handlers.get(rpc)!({ cwd: root, path: "link/sample.png:3" });
      expect(result.error).toMatch(/link|reparse/i);
      expect(spawn.mock.calls.length).toBe(before);
    }, 30_000);
  }
  it("previews the original local image bytes and dimensions", async () => {
    const result = await handlers.get("file.image")!({ cwd: root, path: "sample.png" });
    expect(result).toMatchObject({ dataUri: `data:image/png;base64,${png.toString("base64")}`, mime: "image/png", width: 1, height: 1, error: null });
  }, 30_000);
  it("reveals local files with selectors and literal spaces/hash characters", async () => {
    for (const path of ["notes.md:3", "My Notes #1.md"]) {
      const result = await handlers.get("file.reveal")!({ cwd: root, path });
      expect(result).toEqual({ revealed: join(root, path === "notes.md:3" ? "notes.md" : path), error: null });
    }
  }, 30_000);
  it("reveals ordinary local directories", async () => {
    expect(await handlers.get("file.reveal")!({ cwd: root, path: "directory" })).toEqual({ revealed: join(root, "directory"), error: null });
  }, 30_000);
});
