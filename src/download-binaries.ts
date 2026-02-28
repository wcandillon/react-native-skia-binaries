/**
 * Script to download Skia binaries from GitHub releases.
 *
 * Usage:
 *   npx tsx src/download-binaries.ts --skia-version=m144c
 *   npx tsx src/download-binaries.ts --skia-version=m144c --platform=android
 *   npx tsx src/download-binaries.ts --skia-version=m142b --graphite
 *
 * Options:
 *   --skia-version  Skia version (e.g., m144c)
 *   --platform      Specific platform to download (optional, downloads all if omitted)
 *   --graphite      Download Graphite binaries instead of Ganesh
 *   --output-dir    Output directory (default: ./libs)
 */

import fs from "fs";
import https from "https";
import path from "path";
import os from "os";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");

const REPO = "shopify/react-native-skia";

interface ArchConfig {
  artifact: string;
  destSubdir: string;
  srcSubdir: string;
}

interface PlatformConfig {
  artifacts: ArchConfig[];
}

// Platform configurations for merged Android package
const GANESH_PLATFORMS: Record<string, PlatformConfig> = {
  android: {
    artifacts: [
      { artifact: "skia-android-arm", destSubdir: "armeabi-v7a", srcSubdir: "armeabi-v7a" },
      { artifact: "skia-android-arm-64", destSubdir: "arm64-v8a", srcSubdir: "arm64-v8a" },
      { artifact: "skia-android-arm-x86", destSubdir: "x86", srcSubdir: "x86" },
      { artifact: "skia-android-arm-x64", destSubdir: "x86_64", srcSubdir: "x86_64" },
    ],
  },
  "apple-ios": {
    artifacts: [
      { artifact: "skia-apple-ios-xcframeworks", destSubdir: "", srcSubdir: "ios" },
    ],
  },
  "apple-tvos": {
    artifacts: [
      { artifact: "skia-apple-tvos-xcframeworks", destSubdir: "", srcSubdir: "tvos" },
    ],
  },
  "apple-macos": {
    artifacts: [
      { artifact: "skia-apple-macos-xcframeworks", destSubdir: "", srcSubdir: "macos" },
    ],
  },
};

const GRAPHITE_PLATFORMS: Record<string, PlatformConfig> = {
  android: {
    artifacts: [
      { artifact: "skia-graphite-android-arm", destSubdir: "armeabi-v7a", srcSubdir: "arm" },
      { artifact: "skia-graphite-android-arm-64", destSubdir: "arm64-v8a", srcSubdir: "arm64" },
      { artifact: "skia-graphite-android-arm-x86", destSubdir: "x86", srcSubdir: "x86" },
      { artifact: "skia-graphite-android-arm-x64", destSubdir: "x86_64", srcSubdir: "x64" },
    ],
  },
  "apple-ios": {
    artifacts: [
      { artifact: "skia-graphite-apple-ios-xcframeworks", destSubdir: "", srcSubdir: "ios" },
    ],
  },
  "apple-macos": {
    artifacts: [
      { artifact: "skia-graphite-apple-macos-xcframeworks", destSubdir: "", srcSubdir: "macos" },
    ],
  },
  headers: {
    artifacts: [
      { artifact: "skia-graphite-headers", destSubdir: "", srcSubdir: "" },
    ],
  },
};

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runCommand = (
  command: string,
  args: string[],
  options: object = {}
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, {
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
          `   Download failed (${downloadError.message}), retrying in ${delay / 1000}s...`
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

const downloadArtifact = async (
  archConfig: ArchConfig,
  skiaVersion: string,
  outputDir: string,
  graphite: boolean
): Promise<void> => {
  const releaseTag = graphite
    ? `skia-graphite-${skiaVersion}`
    : `skia-${skiaVersion}`;
  const assetName = `${archConfig.artifact}-${releaseTag}.tar.gz`;
  const downloadUrl = `https://github.com/${REPO}/releases/download/${releaseTag}/${assetName}`;

  const destDir = archConfig.destSubdir
    ? path.join(outputDir, archConfig.destSubdir)
    : outputDir;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skia-download-"));
  const archivePath = path.join(tempDir, assetName);
  const extractDir = path.join(tempDir, "extracted");

  console.log(`  Downloading ${assetName}...`);

  try {
    await downloadToFile(downloadUrl, archivePath);
    console.log(`  Extracting...`);
    await extractTarGz(archivePath, extractDir);

    // Find source directory
    const extractedContents = fs.readdirSync(extractDir);
    let sourceDir = extractDir;

    if (
      extractedContents.length === 1 &&
      fs.statSync(path.join(extractDir, extractedContents[0])).isDirectory()
    ) {
      sourceDir = path.join(extractDir, extractedContents[0]);

      if (
        archConfig.srcSubdir &&
        fs.existsSync(path.join(sourceDir, archConfig.srcSubdir))
      ) {
        sourceDir = path.join(sourceDir, archConfig.srcSubdir);
      }
    }

    // Copy to destination
    console.log(`  Installing to ${destDir}...`);
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

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`  Done!`);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs();

  if (!args["skia-version"]) {
    console.error("Error: --skia-version is required");
    console.error("Usage: npx tsx src/download-binaries.ts --skia-version=m144c");
    process.exit(1);
  }

  const skiaVersion = args["skia-version"] as string;
  const graphite = args.graphite === true;
  const outputDir = (args["output-dir"] as string) || path.join(ROOT_DIR, "libs");
  const specificPlatform = args.platform as string | undefined;

  const platforms = graphite ? GRAPHITE_PLATFORMS : GANESH_PLATFORMS;

  if (specificPlatform && !platforms[specificPlatform]) {
    console.error(`Error: Unknown platform "${specificPlatform}"`);
    console.error(`Available platforms: ${Object.keys(platforms).join(", ")}`);
    process.exit(1);
  }

  const platformsToDownload = specificPlatform
    ? { [specificPlatform]: platforms[specificPlatform] }
    : platforms;

  console.log(`Downloading ${graphite ? "Graphite" : "Ganesh"} binaries...`);
  console.log(`  Skia version: ${skiaVersion}`);
  console.log(`  Output: ${outputDir}`);
  console.log("");

  for (const [name, config] of Object.entries(platformsToDownload)) {
    console.log(`Platform: ${name}`);
    const platformDir = path.join(outputDir, name);

    try {
      for (const archConfig of config.artifacts) {
        await downloadArtifact(archConfig, skiaVersion, platformDir, graphite);
      }
      console.log("");
    } catch (error) {
      console.error(`  Failed: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  console.log("All downloads complete!");
};

main();
