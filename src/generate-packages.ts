/**
 * Script to generate individual Skia binary npm packages.
 * Downloads binaries from GitHub releases and bundles them directly in the package.
 *
 * Usage:
 *   npx tsx src/generate-packages.ts --config=skia-config.json
 *   npx tsx src/generate-packages.ts --skia-version=m144c
 *   npx tsx src/generate-packages.ts --skia-version=m144c --package=android
 *   npx tsx src/generate-packages.ts --skia-version=m142b --graphite
 *
 * Options:
 *   --config        Config file path (generates all packages for both backends)
 *   --skia-version  Skia milestone version (e.g., m144c)
 *   --npm-version   NPM package version (optional, derived from skia-version)
 *                   m144 → 144.0.0, m144a → 144.1.0, m144b → 144.2.0, m144c → 144.3.0
 *   --package       Generate only a specific package (optional, generates all if omitted)
 *   --graphite      Generate Graphite packages instead of Ganesh
 *   --output-dir    Output directory (default: ./dist)
 */

import fs from "fs";
import https from "https";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");

// GitHub repository for downloading binaries
const REPO = "shopify/react-native-skia";

interface AndroidArch {
  arch: string;
  artifact: string;
  srcSubdir: string;
}

interface PackageConfig {
  name: string;
  platform: "android" | "apple" | "common";
  description: string;
  // For Android: list of architectures to include
  androidArchs?: AndroidArch[];
  // For Apple: single artifact
  artifact?: string;
  libSubdir?: string;
}

// Package configurations for Ganesh (standard Metal/OpenGL backend)
const GANESH_PACKAGES: PackageConfig[] = [
  {
    name: "android",
    platform: "android",
    description: "Skia prebuilt binaries for Android (all architectures)",
    androidArchs: [
      { arch: "armeabi-v7a", artifact: "skia-android-arm", srcSubdir: "armeabi-v7a" },
      { arch: "arm64-v8a", artifact: "skia-android-arm-64", srcSubdir: "arm64-v8a" },
      { arch: "x86", artifact: "skia-android-arm-x86", srcSubdir: "x86" },
      { arch: "x86_64", artifact: "skia-android-arm-x64", srcSubdir: "x86_64" },
    ],
  },
  {
    name: "apple-ios",
    platform: "apple",
    description: "Skia prebuilt binaries for iOS (device + simulator)",
    artifact: "skia-apple-ios-xcframeworks",
    libSubdir: "ios",
  },
  {
    name: "apple-tvos",
    platform: "apple",
    description: "Skia prebuilt binaries for tvOS (device + simulator)",
    artifact: "skia-apple-tvos-xcframeworks",
    libSubdir: "tvos",
  },
  {
    name: "apple-macos",
    platform: "apple",
    description: "Skia prebuilt binaries for macOS (arm64 + x64)",
    artifact: "skia-apple-macos-xcframeworks",
    libSubdir: "macos",
  },
];

// Package configurations for Graphite (Dawn/WebGPU backend)
const GRAPHITE_PACKAGES: PackageConfig[] = [
  {
    name: "android",
    platform: "android",
    description: "Skia Graphite prebuilt binaries for Android (all architectures)",
    androidArchs: [
      { arch: "armeabi-v7a", artifact: "skia-graphite-android-arm", srcSubdir: "arm" },
      { arch: "arm64-v8a", artifact: "skia-graphite-android-arm-64", srcSubdir: "arm64" },
      { arch: "x86", artifact: "skia-graphite-android-arm-x86", srcSubdir: "x86" },
      { arch: "x86_64", artifact: "skia-graphite-android-arm-x64", srcSubdir: "x64" },
    ],
  },
  {
    name: "apple-ios",
    platform: "apple",
    description: "Skia Graphite prebuilt binaries for iOS (device + simulator)",
    artifact: "skia-graphite-apple-ios-xcframeworks",
    libSubdir: "ios",
  },
  {
    name: "apple-macos",
    platform: "apple",
    description: "Skia Graphite prebuilt binaries for macOS (arm64 + x64)",
    artifact: "skia-graphite-apple-macos-xcframeworks",
    libSubdir: "macos",
  },
  {
    name: "headers",
    platform: "common",
    description: "Skia Graphite headers for Dawn/WebGPU",
    artifact: "skia-graphite-headers",
    libSubdir: "headers",
  },
];

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

/**
 * Derives npm version from Skia version.
 * m144 → 144.0.0
 * m144a → 144.1.0
 * m144b → 144.2.0
 * m144c → 144.3.0
 */
const deriveNpmVersion = (skiaVersion: string): string => {
  const match = skiaVersion.match(/^m(\d+)([a-z])?$/);
  if (!match) {
    throw new Error(
      `Invalid skia version format: ${skiaVersion}. Expected format: m144 or m144a`
    );
  }

  const major = match[1];
  const suffix = match[2];

  // Convert suffix letter to minor version: a=1, b=2, c=3, etc.
  const minor = suffix ? suffix.charCodeAt(0) - "a".charCodeAt(0) + 1 : 0;

  return `${major}.${minor}.0`;
};

// --- Download utilities ---

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runCommand = (
  command: string,
  args: string[],
  options: object = {}
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command ${command} exited with code ${code}`));
      }
    });
  });
};

interface DownloadError extends Error {
  statusCode?: number;
  code?: string;
}

const downloadToFile = (
  url: string,
  destPath: string,
  maxRetries = 5
): Promise<void> => {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const attemptDownload = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      const request = (currentUrl: string): void => {
        https
          .get(currentUrl, { headers: { "User-Agent": "node" } }, (res) => {
            if (
              res.statusCode &&
              [301, 302, 303, 307, 308].includes(res.statusCode)
            ) {
              const { location } = res.headers;
              if (location) {
                res.resume();
                request(location);
              } else {
                reject(new Error(`Redirect without location for ${currentUrl}`));
              }
              return;
            }

            if (res.statusCode !== 200) {
              const error: DownloadError = new Error(
                `Failed to download: ${res.statusCode} ${res.statusMessage}`
              );
              error.statusCode = res.statusCode;
              res.resume();
              reject(error);
              return;
            }

            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);

            fileStream.on("finish", () => {
              fileStream.close((err) => {
                if (err) {
                  fileStream.destroy();
                  fs.unlink(destPath, () => reject(err));
                } else {
                  resolve();
                }
              });
            });

            const cleanup = (error: Error): void => {
              fileStream.destroy();
              fs.unlink(destPath, () => reject(error));
            };

            res.on("error", cleanup);
            fileStream.on("error", cleanup);
          })
          .on("error", reject);
      };

      request(url);
    });
  };

  const downloadWithRetry = async (retryCount = 0): Promise<void> => {
    try {
      await attemptDownload();
    } catch (error) {
      const downloadError = error as DownloadError;
      const isRateLimit =
        downloadError.statusCode === 403 ||
        downloadError.message.includes("rate limit");
      const shouldRetry =
        retryCount < maxRetries &&
        (isRateLimit ||
          downloadError.code === "ECONNRESET" ||
          downloadError.code === "ETIMEDOUT");

      if (shouldRetry) {
        const delay = Math.pow(2, retryCount) * 1000;
        console.log(
          `      Retry ${retryCount + 1}/${maxRetries} in ${delay / 1000}s...`
        );
        await sleep(delay);
        return downloadWithRetry(retryCount + 1);
      } else {
        throw error;
      }
    }
  };

  return downloadWithRetry();
};

const extractTarGz = async (archivePath: string, destDir: string): Promise<void> => {
  fs.mkdirSync(destDir, { recursive: true });

  const args = ["-xzf", archivePath, "-C", destDir];
  const candidates =
    process.platform === "win32"
      ? [
          "tar.exe",
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "tar.exe"
          ),
        ]
      : ["tar"];

  let lastError: Error | undefined;
  for (const candidate of candidates) {
    try {
      await runCommand(candidate, args);
      return;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        lastError = new Error(`Command ${candidate} not found`);
        continue;
      }
      lastError = error;
    }
  }

  throw new Error(`Failed to extract: ${lastError?.message ?? "unknown error"}`);
};

const copyDir = (src: string, dest: string): void => {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    const stat = fs.lstatSync(srcPath);
    if (
      stat.isSocket() ||
      stat.isFIFO() ||
      stat.isCharacterDevice() ||
      stat.isBlockDevice()
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

const downloadAndExtractAsset = async (
  artifact: string,
  releaseTag: string,
  destDir: string,
  srcSubdir?: string
): Promise<void> => {
  const assetName = `${artifact}-${releaseTag}.tar.gz`;
  const downloadUrl = `https://github.com/${REPO}/releases/download/${releaseTag}/${assetName}`;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skia-download-"));
  const archivePath = path.join(tempDir, assetName);
  const extractDir = path.join(tempDir, "extracted");

  try {
    console.log(`      Downloading ${assetName}...`);
    await downloadToFile(downloadUrl, archivePath);

    console.log(`      Extracting...`);
    await extractTarGz(archivePath, extractDir);

    // Find the extracted content
    const extractedContents = fs.readdirSync(extractDir);

    if (extractedContents.length === 0) {
      throw new Error("Archive extracted but no contents found");
    }

    // Navigate to source directory
    let sourceDir = extractDir;

    // If there's a single top-level directory, descend into it
    if (
      extractedContents.length === 1 &&
      fs.statSync(path.join(extractDir, extractedContents[0])).isDirectory()
    ) {
      sourceDir = path.join(extractDir, extractedContents[0]);

      // Check if there's a subdir matching srcSubdir
      if (
        srcSubdir &&
        fs.existsSync(path.join(sourceDir, srcSubdir)) &&
        fs.statSync(path.join(sourceDir, srcSubdir)).isDirectory()
      ) {
        sourceDir = path.join(sourceDir, srcSubdir);
      }
    }

    // Copy contents to destination
    fs.mkdirSync(destDir, { recursive: true });
    const items = fs.readdirSync(sourceDir);
    for (const item of items) {
      const srcPath = path.join(sourceDir, item);
      const destPath = path.join(destDir, item);

      if (fs.statSync(srcPath).isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }

    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
};

// --- Package generation ---

interface GeneratedPackageJson {
  name: string;
  version: string;
  description: string;
  license: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  publishConfig: {
    access: string;
  };
  files: string[];
  skia: {
    version: string;
    platform: string;
    graphite: boolean;
  };
}

const getPackageName = (pkg: PackageConfig, graphite: boolean): string => {
  const prefix = graphite ? "skia-graphite" : "skia";
  return `react-native-${prefix}-${pkg.name}`;
};

const generatePackageJson = (
  pkg: PackageConfig,
  skiaVersion: string,
  npmVersion: string,
  graphite: boolean
): GeneratedPackageJson => {
  const packageName = getPackageName(pkg, graphite);

  return {
    name: packageName,
    version: npmVersion,
    description: pkg.description,
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/wcandillon/react-native-skia-binaries.git",
      directory: `dist/${packageName}`,
    },
    publishConfig: {
      access: "public",
    },
    files: ["libs/**"],
    skia: {
      version: skiaVersion,
      platform: pkg.platform,
      graphite,
    },
  };
};

const generateReadme = (
  pkg: PackageConfig,
  skiaVersion: string,
  npmVersion: string,
  graphite: boolean
): string => {
  const packageName = getPackageName(pkg, graphite);

  let architectureInfo = "";
  if (pkg.platform === "android" && pkg.androidArchs) {
    architectureInfo = `
## Included Architectures

| Architecture | Description |
|--------------|-------------|
${pkg.androidArchs.map((a) => `| \`${a.arch}\` | ${a.arch} |`).join("\n")}
`;
  }

  return `# ${packageName}

${pkg.description}

## About

This package contains prebuilt Skia libraries from [Shopify/react-native-skia](https://github.com/Shopify/react-native-skia).

- **Skia Version**: ${skiaVersion}
- **Package Version**: ${npmVersion}
- **Platform**: ${pkg.platform}
${graphite ? "- **Backend**: Graphite (Dawn/WebGPU)\n" : ""}
${architectureInfo}
## Installation

\`\`\`bash
npm install ${packageName}
\`\`\`

The binaries are included directly in this package - no postinstall download required.

## License

MIT
`;
};

const generatePackage = async (
  pkg: PackageConfig,
  outputDir: string,
  skiaVersion: string,
  npmVersion: string,
  graphite: boolean
): Promise<string> => {
  const packageName = getPackageName(pkg, graphite);
  const pkgDir = path.join(outputDir, packageName);
  const libsDir = path.join(pkgDir, "libs");

  // Create package directory
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(libsDir, { recursive: true });

  const prefix = graphite ? "skia-graphite" : "skia";
  const releaseTag = `${prefix}-${skiaVersion}`;

  console.log(`  Generating: ${packageName}@${npmVersion}`);

  // Download binaries
  if (pkg.platform === "android" && pkg.androidArchs) {
    for (const arch of pkg.androidArchs) {
      const archDir = path.join(libsDir, arch.arch);
      console.log(`    Downloading ${arch.arch}...`);
      await downloadAndExtractAsset(arch.artifact, releaseTag, archDir, arch.srcSubdir);
    }
  } else if (pkg.artifact) {
    console.log(`    Downloading ${pkg.artifact}...`);
    await downloadAndExtractAsset(pkg.artifact, releaseTag, libsDir, pkg.libSubdir);
  }

  // Generate package.json
  const packageJson = generatePackageJson(pkg, skiaVersion, npmVersion, graphite);
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n"
  );

  // Generate README.md
  const readme = generateReadme(pkg, skiaVersion, npmVersion, graphite);
  fs.writeFileSync(path.join(pkgDir, "README.md"), readme);

  console.log(`    Done!`);
  return pkgDir;
};

interface SkiaConfig {
  version: string;
  checksums?: Record<string, string>;
}

interface ConfigFile {
  skia?: SkiaConfig;
  "skia-graphite"?: SkiaConfig;
}

const generateAllFromConfig = async (
  configPath: string,
  outputDir: string
): Promise<string[]> => {
  const configFullPath = path.resolve(configPath);
  if (!fs.existsSync(configFullPath)) {
    throw new Error(`Config file not found: ${configFullPath}`);
  }

  const config: ConfigFile = JSON.parse(fs.readFileSync(configFullPath, "utf8"));
  const generatedDirs: string[] = [];

  // Generate Ganesh packages
  if (config.skia?.version) {
    const skiaVersion = config.skia.version;
    const npmVersion = deriveNpmVersion(skiaVersion);

    console.log("Generating Ganesh binary packages...");
    console.log(`  Skia version: ${skiaVersion}`);
    console.log(`  NPM version: ${npmVersion}`);
    console.log("");

    for (const pkg of GANESH_PACKAGES) {
      const pkgDir = await generatePackage(pkg, outputDir, skiaVersion, npmVersion, false);
      generatedDirs.push(pkgDir);
      console.log("");
    }
  }

  // Generate Graphite packages
  if (config["skia-graphite"]?.version) {
    const skiaVersion = config["skia-graphite"].version;
    const npmVersion = deriveNpmVersion(skiaVersion);

    console.log("Generating Graphite binary packages...");
    console.log(`  Skia version: ${skiaVersion}`);
    console.log(`  NPM version: ${npmVersion}`);
    console.log("");

    for (const pkg of GRAPHITE_PACKAGES) {
      const pkgDir = await generatePackage(pkg, outputDir, skiaVersion, npmVersion, true);
      generatedDirs.push(pkgDir);
      console.log("");
    }
  }

  return generatedDirs;
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const outputDir = (args["output-dir"] as string) || path.join(ROOT_DIR, "dist");

  // Config mode: generate all packages from config file
  if (args.config) {
    try {
      const generatedDirs = await generateAllFromConfig(args.config as string, outputDir);
      console.log(`Generated ${generatedDirs.length} package(s)`);

      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `packages=${generatedDirs.join("\n")}\n`);
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Single version mode
  if (!args["skia-version"]) {
    console.error("Error: --skia-version or --config is required");
    console.error(
      "Usage: npx tsx src/generate-packages.ts --skia-version=m144c"
    );
    console.error(
      "       npx tsx src/generate-packages.ts --config=skia-config.json"
    );
    process.exit(1);
  }

  const skiaVersion = args["skia-version"] as string;

  // Derive npm version from skia version if not provided
  let npmVersion: string;
  if (args["npm-version"]) {
    npmVersion = args["npm-version"] as string;
  } else {
    try {
      npmVersion = deriveNpmVersion(skiaVersion);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  }
  const graphite = args.graphite === true;
  const specificPackage = args.package as string | undefined;

  const packages = graphite ? GRAPHITE_PACKAGES : GANESH_PACKAGES;
  const packagesToGenerate = specificPackage
    ? packages.filter((p) => p.name === specificPackage)
    : packages;

  if (specificPackage && packagesToGenerate.length === 0) {
    console.error(`Error: Package "${specificPackage}" not found`);
    console.error(
      `Available packages: ${packages.map((p) => p.name).join(", ")}`
    );
    process.exit(1);
  }

  console.log(
    `Generating ${graphite ? "Graphite" : "Ganesh"} binary packages...`
  );
  console.log(`  Skia version: ${skiaVersion}`);
  console.log(`  NPM version: ${npmVersion}`);
  console.log(`  Output: ${outputDir}`);
  console.log("");

  const generatedDirs: string[] = [];
  for (const pkg of packagesToGenerate) {
    try {
      const pkgDir = await generatePackage(
        pkg,
        outputDir,
        skiaVersion,
        npmVersion,
        graphite
      );
      generatedDirs.push(pkgDir);
      console.log("");
    } catch (error) {
      console.error(`  Failed to generate ${pkg.name}: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  console.log(`Generated ${generatedDirs.length} package(s)`);

  // Output generated directories for use in CI
  if (process.env.GITHUB_OUTPUT) {
    const output = generatedDirs.join("\n");
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `packages=${output}\n`);
  }
};

main();
