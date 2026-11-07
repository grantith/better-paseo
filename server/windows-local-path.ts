import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Only metadata for a local component is inspected. In particular, never use
// GetFinalPathNameByHandle/realpath: resolving a reparse point may contact SMB.
const CHECK = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class BetterPaseoLocalPaths {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint QueryDosDeviceW(string name, StringBuilder target, int length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFileAttributesW(string path);

  public static void Check(string[] paths) {
    var drives = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var checkedPaths = new HashSet<string>(StringComparer.Ordinal);
    foreach (var path in paths) {
      if (path.Length < 3 || !Char.IsLetter(path[0]) || path[1] != ':' || path[2] != '\\')
        throw new InvalidOperationException("Only absolute local drive paths are supported");
      var root = path.Substring(0, 3);
      if (drives.Add(root)) {
        var type = GetDriveTypeW(root);
        if (type != 2 && type != 3 && type != 5 && type != 6)
          throw new InvalidOperationException("Network or unverified drives are not allowed");
        var device = new StringBuilder(32768);
        if (QueryDosDeviceW(root.Substring(0, 2), device, device.Capacity) == 0)
          throw new InvalidOperationException("Could not verify local drive mapping");
        // SUBST/DefineDosDevice aliases can hide UNC or device paths. Fail
        // closed for aliases and redirectors instead of resolving their target.
        if (!System.Text.RegularExpressions.Regex.IsMatch(device.ToString(), @"^\\Device\\(?:HarddiskVolume[0-9]+|CdRom[0-9]+)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
          throw new InvalidOperationException("Redirected or unverified drives are not allowed");
      }
      var parts = path.Substring(3).Split(new char[] {'\\'}, StringSplitOptions.RemoveEmptyEntries);
      var current = root;
      for (int i = -1; i < parts.Length; i++) {
        if (i >= 0) current = current.TrimEnd('\\') + "\\" + parts[i];
        if (!checkedPaths.Add(current)) continue;
        // GetFileAttributes returns the final link's attributes, not those of
        // its destination. Earlier components were checked before this call.
        var attributes = GetFileAttributesW(current);
        if (attributes == 0xffffffff) {
          var error = Marshal.GetLastWin32Error();
          if (error == 2 || error == 3) break;
          throw new Win32Exception(error);
        }
        if ((attributes & 0x400) != 0)
          throw new InvalidOperationException("Links and reparse points are not allowed");
        if ((attributes & 0x40) != 0)
          throw new InvalidOperationException("Device paths are not allowed");
        if (i < parts.Length - 1 && (attributes & 0x10) == 0)
          throw new InvalidOperationException("A path ancestor is not a directory");
      }
    }
  }
}
'@
try {
  [BetterPaseoLocalPaths]::Check([string[]](ConvertFrom-Json $env:BETTER_PASEO_LOCAL_PATHS))
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
`;
const ENCODED_CHECK = Buffer.from(CHECK, "utf16le").toString("base64");

/** Verify drive mappings and all reparse points without following them. */
export async function checkWindowsLocalPaths(paths: readonly string[]): Promise<void> {
  try {
    await execute(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_CHECK], {
        env: { ...process.env, BETTER_PASEO_LOCAL_PATHS: JSON.stringify(paths) },
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim() : "";
    throw new Error(`Local path verification failed: ${stderr || "Windows drive/reparse-point check unavailable"}`);
  }
}
