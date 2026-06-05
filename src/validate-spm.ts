/**
 * Validates the generated SwiftPM manifests (Package.swift) in the dist/
 * directory. The manifests are produced by scanning the extracted xcframeworks,
 * so the failure modes are drift between the manifest, the binaries on disk, and
 * the npm package.json. This script cross-checks all three.
 *
 * It performs only fast, toolchain-free filesystem checks so it can run in CI
 * before publishing and gate it. For a deeper check that SwiftPM can actually
 * parse and evaluate the manifest, run `swift package dump-package` in each
 * package directory on a macOS runner (see the CI workflow).
 *
 * Usage:
 *   npx tsx src/validate-spm.ts                 # validates ./dist
 *   npx tsx src/validate-spm.ts --dist=./dist
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");

interface Args {
  [key: string]: string | boolean;
}

const parseArgs = (): Args => {
  const args: Args = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      args[key] = value ?? true;
    }
  }
  return args;
};

/** Extracts the `name:` argument of the Package(...) manifest. */
const parsePackageName = (manifest: string): string | null => {
  const match = manifest.match(/Package\(\s*name:\s*"([^"]+)"/);
  return match ? match[1] : null;
};

/** Extracts every `path: "..."` from `.binaryTarget(...)` declarations. */
const parseBinaryTargetPaths = (manifest: string): string[] => {
  const paths: string[] = [];
  const regex = /\.binaryTarget\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(manifest)) !== null) {
    const pathMatch = match[1].match(/path:\s*"([^"]+)"/);
    if (pathMatch) {
      paths.push(pathMatch[1]);
    }
  }
  return paths;
};

/** Extracts every `name: "..."` from `.binaryTarget(...)` declarations. */
const parseBinaryTargetNames = (manifest: string): string[] => {
  const names: string[] = [];
  const regex = /\.binaryTarget\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(manifest)) !== null) {
    const nameMatch = match[1].match(/name:\s*"([^"]+)"/);
    if (nameMatch) {
      names.push(nameMatch[1]);
    }
  }
  return names;
};

/** Extracts the target names listed in the `.library(... targets: [...])`. */
const parseProductTargets = (manifest: string): string[] => {
  const productMatch = manifest.match(
    /\.library\(([\s\S]*?targets:\s*\[)([\s\S]*?)\]/
  );
  if (!productMatch) {
    return [];
  }
  return [...productMatch[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

const validatePackage = (pkgDir: string, errors: string[]): boolean => {
  const name = path.basename(pkgDir);
  const manifestPath = path.join(pkgDir, "Package.swift");

  // Only Apple packages carry a manifest; others are skipped silently.
  if (!fs.existsSync(manifestPath)) {
    return false;
  }

  const fail = (msg: string): void => {
    errors.push(`[${name}] ${msg}`);
  };

  const manifest = fs.readFileSync(manifestPath, "utf8");
  const libsDir = path.join(pkgDir, "libs");

  // 1. Manifest name matches the npm package name.
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    const manifestName = parsePackageName(manifest);
    if (manifestName !== pkgJson.name) {
      fail(
        `Package.swift name "${manifestName}" does not match package.json name "${pkgJson.name}"`
      );
    }
    // 2. Package.swift is whitelisted in package.json files so it ships in the tarball.
    const files: string[] = pkgJson.files ?? [];
    if (!files.includes("Package.swift")) {
      fail(`package.json "files" does not include "Package.swift"`);
    }
  } else {
    fail("package.json not found");
  }

  // 3. Every binaryTarget path resolves to an xcframework directory with an Info.plist.
  const referenced = new Set<string>();
  for (const relPath of parseBinaryTargetPaths(manifest)) {
    const abs = path.join(pkgDir, relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      fail(`binaryTarget path does not exist: ${relPath}`);
      continue;
    }
    if (!fs.existsSync(path.join(abs, "Info.plist"))) {
      fail(`xcframework is missing Info.plist: ${relPath}`);
    }
    referenced.add(path.basename(relPath));
  }

  // 4. No orphan frameworks: every xcframework on disk is referenced.
  if (fs.existsSync(libsDir)) {
    const onDisk = fs
      .readdirSync(libsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.endsWith(".xcframework"))
      .map((e) => e.name);
    for (const fw of onDisk) {
      if (!referenced.has(fw)) {
        fail(`xcframework not referenced by any binaryTarget: ${fw}`);
      }
    }
  }

  // 5. Product targets are closed over declared binaryTargets.
  const targetNames = new Set(parseBinaryTargetNames(manifest));
  const productTargets = parseProductTargets(manifest);
  if (productTargets.length === 0) {
    fail("library product declares no targets");
  }
  for (const t of productTargets) {
    if (!targetNames.has(t)) {
      fail(`product references unknown target: ${t}`);
    }
  }

  return true;
};

const main = (): void => {
  const args = parseArgs();
  const distDir = path.resolve(
    (args.dist as string) || path.join(ROOT_DIR, "dist")
  );

  if (!fs.existsSync(distDir)) {
    console.error(`Error: dist directory not found: ${distDir}`);
    process.exit(1);
  }

  const errors: string[] = [];
  let validated = 0;

  const entries = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  for (const entry of entries) {
    const pkgDir = path.join(distDir, entry.name);
    if (validatePackage(pkgDir, errors)) {
      validated++;
      console.log(`  Validated SwiftPM manifest: ${entry.name}`);
    }
  }

  console.log("");
  if (errors.length > 0) {
    console.error(`SwiftPM validation failed with ${errors.length} error(s):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  if (validated === 0) {
    console.warn("No SwiftPM manifests found to validate.");
    return;
  }

  console.log(`SwiftPM validation passed for ${validated} package(s).`);
};

main();
