import { lstat } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { checkWindowsLocalPaths } from "./windows-local-path";

function reject(reason: string): never {
  throw new Error(`Only local filesystem paths are allowed: ${reason}`);
}

/** Lexical checks must run before even a missing-file probe. */
function checkSyntax(path: string): void {
  if (/[\u0000-\u001f]/.test(path)) reject("control characters");
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(path)) reject("network or device namespace");
  if (process.platform !== "win32") return;
  if (/^[a-z]:(?![\\/])/i.test(path)) reject("drive-relative path");
  const body = path.replace(/^[a-z]:[\\/]/i, "");
  if (/:|[?*<>"|]/.test(body)) reject("device, stream or invalid Windows path");
  for (const part of body.split(/[\\/]/)) {
    if (part === "." || part === "..") continue;
    if (/[ .]$/.test(part)) reject("ambiguous Windows path component");
    const base = part.split(".", 1)[0]!.replace(/[ .]+$/, "");
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(base)) reject("reserved Windows device name");
  }
}

function stripSelector(path: string): string {
  const windowsDrive = /^[a-z]:[\\/]/i.test(path);
  const head = windowsDrive ? path.slice(0, 3) : "";
  const tail = windowsDrive ? path.slice(3) : path;
  const cut = tail.search(/[\s:?#]/);
  return cut === -1 ? path : head + tail.slice(0, cut);
}

/** Never realpath a supplied path: that would follow links before checking them. */
async function checkComponents(path: string, checked: Set<string>): Promise<void> {
  const root = parse(path).root;
  let current = root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i]!);
    if (checked.has(current)) continue;
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) reject("links and junctions are not supported");
    if (!entry.isFile() && !entry.isDirectory()) reject("special filesystem object");
    if (i < parts.length - 1 && !entry.isDirectory()) throw Object.assign(new Error("A path ancestor is not a directory"), { code: "ENOTDIR" });
    checked.add(current);
  }
}

/**
 * Return a validated absolute path, preserving literal filenames before trying
 * tool selectors. Links/reparse points are denied rather than resolved. This
 * protects against untrusted path content, not hostile concurrent local writes.
 */
export async function resolveLocalPath(path: string, cwd: string): Promise<string> {
  const raw = path.trim();
  const directory = cwd.trim();
  checkSyntax(directory);
  if (!isAbsolute(directory) || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(directory))) reject("cwd must be an absolute local path");
  // A numeric suffix on Windows means a tool selector, never an NTFS stream.
  // Validate drive-relative syntax first so C:12 cannot turn into local file C.
  if (process.platform === "win32" && /^[a-z]:(?![\\/])/i.test(raw)) reject("drive-relative path");
  const whole = process.platform === "win32" ? raw.replace(/:\d+(?:-\d+)?$/, "") : raw;
  checkSyntax(whole);
  if (!whole) return "";
  const checked = new Set<string>();
  const base = resolve(directory);
  async function candidate(value: string): Promise<string> {
    checkSyntax(value);
    const target = resolve(base, value);
    checkSyntax(target);
    if (process.platform === "win32") {
      try { await checkWindowsLocalPaths([base, target]); }
      catch (error) { reject(error instanceof Error ? error.message : "Windows locality check failed"); }
    }
    await checkComponents(base, checked);
    await checkComponents(target, checked);
    return target;
  }
  try {
    return await candidate(whole);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
    const numeric = whole.replace(/:\d+(?:-\d+)?$/, "");
    const fallback = numeric !== whole ? numeric : stripSelector(whole);
    if (!fallback || fallback === whole) throw error;
    return candidate(fallback);
  }
}
