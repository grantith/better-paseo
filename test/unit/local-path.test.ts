import { mkdtemp, mkdir, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLocalPath } from "../../server/local-path";
import { checkWindowsLocalPaths } from "../../server/windows-local-path";

const execute = promisify(execFile);
let root = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "local-path-policy-")));
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "sample.png"), "image");
  await writeFile(join(root, "My Notes #1.md"), "notes");
  await symlink(join(root, "folder"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  if (process.platform === "win32") {
    await symlink(String.raw`\\example.invalid\share`, join(root, "network-link"), "junction");
  }
  if (process.platform !== "win32") await writeFile(join(root, "file:sample.png"), "local colon filename");
}, 30_000);
afterAll(async () => {
  if (process.platform === "win32") await rmdir(join(root, "network-link"));
  await rm(root, { recursive: true, force: true });
});

const unsafe = [
  String.raw`\\example.invalid\share\image.png`, "//example.invalid/share/image.png",
  String.raw`\/example.invalid\share\image.png`, String.raw`/\example.invalid/share/image.png`,
  String.raw`\\?\C:\image.png`, String.raw`\\.\pipe\paseo`, String.raw`\??\C:\image.png`,
  "image\u0000.png",
];

describe("local path policy", () => {
  for (const path of unsafe) {
    it(`rejects unsafe input ${JSON.stringify(path)} in path and cwd`, async () => {
      await expect(resolveLocalPath(path, root)).rejects.toThrow(/local filesystem paths/i);
      await expect(resolveLocalPath("image.png", path)).rejects.toThrow(/local filesystem paths/i);
    });
  }
  it("preserves regular local files, directories and numeric selectors", async () => {
    expect(await resolveLocalPath("folder/sample.png", root)).toBe(join(root, "folder", "sample.png"));
    expect(await resolveLocalPath("folder", root)).toBe(join(root, "folder"));
    expect(await resolveLocalPath("folder/sample.png:4-9", root)).toBe(join(root, "folder", "sample.png"));
    expect(await resolveLocalPath("My Notes #1.md", root)).toBe(join(root, "My Notes #1.md"));
    expect(await resolveLocalPath("My Notes #1.md:3", root)).toBe(join(root, "My Notes #1.md"));
  }, 30_000);
  it("rejects a junction/symlink as a leaf, ancestor or cwd", async () => {
    for (const [path, cwd] of [["link", root], ["link/sample.png", root], ["sample.png", join(root, "link")]] as const) {
      await expect(resolveLocalPath(path, cwd)).rejects.toThrow(/link|reparse/i);
    }
  }, 30_000);
  it("does not turn a denied link into a selector fallback", async () => {
    await expect(resolveLocalPath("link/sample.png:4", root)).rejects.toThrow(/link|reparse/i);
  }, 30_000);
  it("keeps missing files as errors", async () => {
    await expect(resolveLocalPath("missing.png", root)).rejects.toThrow();
  }, 30_000);
});

it.runIf(process.platform !== "win32")("preserves local POSIX filenames containing a scheme-like colon", async () => {
  expect(await resolveLocalPath("file:sample.png", root)).toBe(join(root, "file:sample.png"));
});

describe.runIf(process.platform === "win32")("Windows path policy", () => {
  for (const path of ["file://example.invalid/share/image.png", "smb://example.invalid/share/image.png", "C:image.png", "C:12", "NUL", "NUL.png", "con", "conout$", "COM1.jpg", "LPT².png", "image.png:payload", "image.png::$DATA", "folder./image.png", "folder /image.png"]) {
    it(`rejects Windows device/ambiguous input ${JSON.stringify(path)}`, async () => {
      await expect(resolveLocalPath(path, root)).rejects.toThrow(/local filesystem paths/i);
      await expect(resolveLocalPath("image.png", join(root, path))).rejects.toThrow(/local filesystem paths/i);
    });
  }
  it("rejects a junction to a network share before following its destination", async () => {
    await expect(resolveLocalPath("network-link/image.png", root)).rejects.toThrow(/link|reparse/i);
    await expect(resolveLocalPath("image.png", join(root, "network-link"))).rejects.toThrow(/link|reparse/i);
  }, 30_000);
  it("fails closed for an unmapped drive before inspecting its contents", async () => {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetLogicalDrives()"]);
    const used = new Set(stdout.toUpperCase().match(/[A-Z]:/g));
    const letter = Array.from("ZYXWVUTSRQPONMLKJIHGFEDCBA").find((value) => !used.has(`${value}:`));
    expect(letter).toBeDefined();
    await expect(checkWindowsLocalPaths([`${letter}:\\paseo-image.png`])).rejects.toThrow(/network|unverified/i);
  }, 30_000);
  it("checks a real local drive without touching another root", async () => {
    await expect(checkWindowsLocalPaths([parse(root).root])).resolves.toBeUndefined();
  }, 30_000);
});
