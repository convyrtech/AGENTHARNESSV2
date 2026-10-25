import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  buildRuntimeIsolationEnv,
  ensureIsolationDirs,
  ensureProvisionedRuntimes,
  extractRuntimeArchives,
  isolationBinDirs,
  isProvisionStampCurrent,
  listVendorArchiveNames,
  npmPrefixDir,
  planProvisionedRuntimes,
  provisionRuntimesAsync,
  provisionStampPath,
  pythonVenvDir,
  readProvisionStamp,
  resolveTarBinary,
  resolveVendorRuntimeLayout,
  userRuntimesRoot,
} from "./runtime-provision.ts";
import { rootsFromRuntimeRoot } from "./bundled-runtimes.ts";

function makeVendorWithArchives(): {
  vendorRoot: string;
  userData: string;
  nodeBin: string;
} {
  const root = mkdtempSync(join(tmpdir(), "zeno-vendor-"));
  const userData = mkdtempSync(join(tmpdir(), "zeno-userdata-"));
  const nodeDir = join(root, "node", "bin");
  const pyDir = join(root, "python", "bin");
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(pyDir, { recursive: true });
  const nodeBin = join(nodeDir, "node");
  const pyBin = join(pyDir, "python3");
  writeFileSync(nodeBin, "#!/bin/sh\necho v22.19.0\n", { mode: 0o755 });
  writeFileSync(pyBin, "#!/bin/sh\necho Python 3.12.13\n", { mode: 0o755 });
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      node: "22.19.0",
      python: "3.12.13",
      pythonReleaseTag: "20260807",
      key: "test",
    }),
  );

  const archives = join(root, "archives");
  mkdirSync(archives, { recursive: true });
  execFileSync("tar", ["-czf", join(archives, "node.tar.gz"), "-C", root, "node"]);
  execFileSync("tar", ["-czf", join(archives, "python.tar.gz"), "-C", root, "python"]);

  // Vendor for packaged layout has only archives + manifest (no expanded trees required).
  // Keep expanded too so resolveVendor finds either.

  return { vendorRoot: root, userData, nodeBin };
}

describe("resolveVendorRuntimeLayout", () => {
  it("finds archives and expanded trees under vendor root", () => {
    const { vendorRoot } = makeVendorWithArchives();
    try {
      const layout = resolveVendorRuntimeLayout({ explicitVendorRoot: vendorRoot });
      expect(layout).toBeDefined();
      expect(layout?.archives?.node).toContain("node.tar.gz");
      expect(layout?.archives?.python).toContain("python.tar.gz");
      expect(layout?.expanded?.root).toBe(vendorRoot);
      expect(listVendorArchiveNames(vendorRoot).sort()).toEqual(["node.tar.gz", "python.tar.gz"]);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveTarBinary", () => {
  it("prefers Windows System32 tar so Git GNU tar never sees drive letters", () => {
    expect(resolveTarBinary("linux")).toBe("tar");
    const win = resolveTarBinary("win32", { SystemRoot: "C:\\Windows" });
    expect(win === "C:\\Windows\\System32\\tar.exe" || win === "tar").toBe(true);
  });
});

describe("extractRuntimeArchives", () => {
  it("extracts node and python into dest root", () => {
    const { vendorRoot } = makeVendorWithArchives();
    const dest = mkdtempSync(join(tmpdir(), "zeno-extract-"));
    try {
      extractRuntimeArchives(
        {
          node: join(vendorRoot, "archives", "node.tar.gz"),
          python: join(vendorRoot, "archives", "python.tar.gz"),
        },
        dest,
      );
      expect(existsSync(join(dest, "node", "bin", "node"))).toBe(true);
      expect(existsSync(join(dest, "python", "bin", "python3"))).toBe(true);
      const roots = rootsFromRuntimeRoot(dest);
      expect(roots?.nodeRoot).toBe(join(dest, "node"));
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("ensureProvisionedRuntimes", () => {
  it("extracts archives into userData and creates isolation dirs", () => {
    const { vendorRoot, userData } = makeVendorWithArchives();
    try {
      // Packaged-like vendor: only archives + manifest (remove expanded to force extract path)
      // Actually keep expanded — provision prefers stamp/archives when archives present.
      // Remove expanded node/python so we only have archives.
      rmSync(join(vendorRoot, "node"), { recursive: true, force: true });
      rmSync(join(vendorRoot, "python"), { recursive: true, force: true });

      const layout = ensureProvisionedRuntimes({
        userDataPath: userData,
        explicitVendorRoot: vendorRoot,
        skipVenv: true,
      });
      expect(layout).toBeDefined();
      expect(layout?.source).toBe("userData");
      expect(layout?.provisioned).toBe(true);
      expect(existsSync(join(userRuntimesRoot(userData), "node", "bin", "node"))).toBe(true);
      expect(existsSync(npmPrefixDir(userData))).toBe(true);
      expect(layout?.npmPrefix).toBe(npmPrefixDir(userData));

      // Second call should hit stamp fast path
      const again = ensureProvisionedRuntimes({
        userDataPath: userData,
        explicitVendorRoot: vendorRoot,
        skipVenv: true,
      });
      expect(again?.source).toBe("userData");
      expect(again?.roots.root).toBe(userRuntimesRoot(userData));
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });

  it("uses expanded vendor in-place when no archives (dev)", () => {
    const root = mkdtempSync(join(tmpdir(), "zeno-dev-vendor-"));
    const userData = mkdtempSync(join(tmpdir(), "zeno-dev-ud-"));
    try {
      mkdirSync(join(root, "node", "bin"), { recursive: true });
      writeFileSync(join(root, "node", "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(root, "manifest.json"), JSON.stringify({ node: "22.19.0" }));

      const layout = ensureProvisionedRuntimes({
        userDataPath: userData,
        explicitVendorRoot: root,
        skipVenv: true,
      });
      expect(layout?.source).toBe("vendor-expanded");
      expect(layout?.provisioned).toBe(false);
      expect(layout?.roots.root).toBe(root);
      // Isolation dirs still created under userData
      expect(existsSync(npmPrefixDir(userData))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

describe("isolation env", () => {
  it("sets NPM_CONFIG_PREFIX and PATH dirs for venv/npm-prefix", () => {
    const userData = mkdtempSync(join(tmpdir(), "zeno-iso-"));
    try {
      const root = join(userData, "runtimes");
      mkdirSync(join(root, "node", "bin"), { recursive: true });
      writeFileSync(join(root, "node", "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      const roots = rootsFromRuntimeRoot(root);
      expect(roots).toBeDefined();
      if (!roots) return;

      const dirs = ensureIsolationDirs({ userDataPath: userData });
      mkdirSync(join(dirs.pythonVenv, "bin"), { recursive: true });
      writeFileSync(join(dirs.pythonVenv, "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });

      const layout = {
        roots,
        npmPrefix: dirs.npmPrefix,
        pythonVenv: dirs.pythonVenv,
        provisioned: true as const,
        source: "userData" as const,
      };
      const env = buildRuntimeIsolationEnv(layout);
      expect(env.NPM_CONFIG_PREFIX).toBe(npmPrefixDir(userData));
      expect(env.VIRTUAL_ENV).toBe(pythonVenvDir(userData));

      const bins = isolationBinDirs(layout);
      expect(bins.some((d) => d.includes("npm-prefix"))).toBe(true);
      expect(bins.some((d) => d.includes("python-venv"))).toBe(true);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

describe("isProvisionStampCurrent", () => {
  it("returns false when versions mismatch", () => {
    const { vendorRoot, userData } = makeVendorWithArchives();
    try {
      const userRoot = userRuntimesRoot(userData);
      mkdirSync(join(userRoot, "node", "bin"), { recursive: true });
      writeFileSync(join(userRoot, "node", "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      const vendor = resolveVendorRuntimeLayout({ explicitVendorRoot: vendorRoot });
      expect(vendor).toBeDefined();
      if (!vendor) return;
      expect(
        isProvisionStampCurrent(
          { node: "0.0.1", python: "3.12.13", provisionedAt: new Date().toISOString() },
          vendor,
          userRoot,
        ),
      ).toBe(false);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

describe("PRSLOY: tools archive + PortableGit SFX (Windows layout)", () => {
  function addWindowsArchives(vendorRoot: string): void {
    mkdirSync(join(vendorRoot, "tools"), { recursive: true });
    writeFileSync(join(vendorRoot, "tools", "rg.exe"), "x");
    const archives = join(vendorRoot, "archives");
    execFileSync("tar", ["-czf", join(archives, "tools.tar.gz"), "-C", vendorRoot, "tools"]);
    writeFileSync(join(archives, "git.7z.exe"), "sfx");
    writeFileSync(
      join(vendorRoot, "manifest.json"),
      JSON.stringify({ node: "22.19.0", python: "3.12.13", git: "2.51.0", key: "test" }),
    );
  }

  it("extracts tools/ synchronously and only locates git.7z.exe", () => {
    const { vendorRoot, userData } = makeVendorWithArchives();
    try {
      addWindowsArchives(vendorRoot);
      const vendor = resolveVendorRuntimeLayout({ explicitVendorRoot: vendorRoot })!;
      expect(vendor.archives?.git).toBe(join(vendorRoot, "archives", "git.7z.exe"));
      const layout = ensureProvisionedRuntimes({
        userDataPath: userData,
        explicitVendorRoot: vendorRoot,
        skipVenv: true,
      });
      expect(layout?.source).toBe("userData");
      const userRoot = userRuntimesRoot(userData);
      expect(existsSync(join(userRoot, "tools", "rg.exe"))).toBe(true);
      // Git is unpacked in the background (runtime-git.ts), never by the sync path.
      expect(existsSync(join(userRoot, "git"))).toBe(false);
      expect(
        isProvisionStampCurrent(
          { node: "22.19.0", python: "3.12.13", provisionedAt: "" },
          vendor,
          userRoot,
        ),
      ).toBe(true);
      rmSync(join(userRoot, "tools"), { recursive: true, force: true });
      // tools/ missing (install older than tools) → re-extract.
      expect(
        isProvisionStampCurrent(
          { node: "22.19.0", python: "3.12.13", provisionedAt: "" },
          vendor,
          userRoot,
        ),
      ).toBe(false);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

describe("PRSLOY window first: plan + background unpack", () => {
  it("plans extract on first launch, unpacks async with progress, then plans ready", async () => {
    const { vendorRoot, userData } = makeVendorWithArchives();
    try {
      rmSync(join(vendorRoot, "node"), { recursive: true, force: true });
      rmSync(join(vendorRoot, "python"), { recursive: true, force: true });
      const options = { userDataPath: userData, explicitVendorRoot: vendorRoot, skipVenv: true };
      const plan = planProvisionedRuntimes(options);
      expect(plan.kind).toBe("extract");
      if (plan.kind !== "extract") return;
      // Planning never touches the disk beyond reads.
      expect(existsSync(join(userRuntimesRoot(userData), "node"))).toBe(false);

      // An interrupted earlier unpack (app closed mid-way) left a staging dir behind.
      mkdirSync(join(userRuntimesRoot(userData), ".staging-99999", "node"), { recursive: true });
      const progress: number[] = [];
      const layout = await provisionRuntimesAsync({
        ...options,
        plan,
        pollMs: 5,
        onProgress: (done) => progress.push(done),
      });
      expect(layout?.source).toBe("userData");
      expect(existsSync(join(userRuntimesRoot(userData), "node", "bin", "node"))).toBe(true);
      expect(progress.length).toBeGreaterThan(0);
      expect(readProvisionStamp(userData)?.node).toBe("22.19.0");
      // No staging leftovers.
      const leftovers = readdirSync(userRuntimesRoot(userData)).filter((n) =>
        n.startsWith(".staging"),
      );
      expect(leftovers).toEqual([]);

      expect(planProvisionedRuntimes(options).kind).toBe("ready");
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });

  it("a failed unpack leaves no stamp, so the next launch extracts again", async () => {
    const { vendorRoot, userData } = makeVendorWithArchives();
    try {
      rmSync(join(vendorRoot, "node"), { recursive: true, force: true });
      rmSync(join(vendorRoot, "python"), { recursive: true, force: true });
      const options = { userDataPath: userData, explicitVendorRoot: vendorRoot, skipVenv: true };
      mkdirSync(userRuntimesRoot(userData), { recursive: true });
      writeFileSync(provisionStampPath(userData), JSON.stringify({ node: "old" }));
      writeFileSync(join(vendorRoot, "archives", "python.tar.gz"), "not a tarball");
      const plan = planProvisionedRuntimes(options);
      if (plan.kind !== "extract") throw new Error(`expected extract, got ${plan.kind}`);
      await expect(provisionRuntimesAsync({ ...options, plan })).rejects.toThrow();
      expect(existsSync(provisionStampPath(userData))).toBe(false);
      expect(planProvisionedRuntimes(options).kind).toBe("extract");
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
