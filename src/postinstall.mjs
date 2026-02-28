/**
 * Postinstall script for Skia binary packages.
 * Downloads the prebuilt binary from GitHub releases and extracts it.
 *
 * This file is copied to each generated binary package.
 * Kept as .mjs to run without TypeScript compilation.
 */

import fs from "fs";
import https from "https";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read package configuration
const packageJsonPath = path.join(__dirname, "package.json");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const { repo, releaseTag, platform, androidArchs, assetName, libSubdir } = pkg.skia;
const libsDir = path.join(__dirname, "libs");

// Allow skipping download via environment variable
if (
  process.env.SKIP_SKIA_DOWNLOAD === "1" ||
  process.env.SKIP_SKIA_DOWNLOAD === "true"
) {
  console.log(`Skipping ${pkg.name} download (SKIP_SKIA_DOWNLOAD is set)`);
  process.exit(0);
}

// Check if already installed by looking for actual content
const isInstalled = () => {
  if (!fs.existsSync(libsDir)) {
    return false;
  }

  const entries = fs.readdirSync(libsDir);
  if (entries.length === 0) {
    return false;
  }

  // For Android, check for architecture directories with .a files
  if (platform === "android") {
    return androidArchs.some((arch) => {
      const archDir = path.join(libsDir, arch.arch);
      if (!fs.existsSync(archDir)) return false;
      const files = fs.readdirSync(archDir);
      return files.some((f) => f.endsWith(".a"));
    });
  }

  // For Apple, check for .xcframework directories
  if (platform === "apple") {
    return entries.some((e) => e.endsWith(".xcframework"));
  }

  // For headers/common, just check non-empty
  return entries.length > 0;
};

if (isInstalled()) {
  console.log(`${pkg.name}: Binaries already installed`);
  process.exit(0);
}

console.log(`${pkg.name}: Downloading Skia binaries...`);
console.log(`   Release: ${releaseTag}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runCommand = (command, args, options = {}) => {
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

const downloadToFile = (url, destPath, maxRetries = 5) => {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const attemptDownload = () => {
    return new Promise((resolve, reject) => {
      const request = (currentUrl) => {
        https
          .get(currentUrl, { headers: { "User-Agent": "node" } }, (res) => {
            // Handle redirects
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
              const error = new Error(
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

            const cleanup = (error) => {
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

  const downloadWithRetry = async (retryCount = 0) => {
    try {
      await attemptDownload();
    } catch (error) {
      const isRateLimit =
        error.statusCode === 403 || error.message.includes("rate limit");
      const shouldRetry =
        retryCount < maxRetries &&
        (isRateLimit ||
          error.code === "ECONNRESET" ||
          error.code === "ETIMEDOUT");

      if (shouldRetry) {
        const delay = Math.pow(2, retryCount) * 1000;
        console.log(
          `   Download failed (${error.message}), retrying in ${delay / 1000}s...`
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

const extractTarGz = async (archivePath, destDir) => {
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
          "bsdtar.exe",
          "bsdtar",
        ]
      : ["tar"];

  let lastError;
  for (const candidate of candidates) {
    try {
      await runCommand(candidate, args);
      return;
    } catch (err) {
      if (err.code === "ENOENT") {
        lastError = new Error(`Command ${candidate} not found`);
        continue;
      }
      lastError = err;
    }
  }

  throw new Error(
    `Failed to extract ${path.basename(archivePath)}. Please install a compatible tar binary. Last error: ${lastError?.message ?? "unknown error"}`
  );
};

// Copy directory recursively
const copyDir = (src, dest) => {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip sockets and special files
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

const downloadAndExtractAsset = async (assetName, destDir, srcSubdir) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skia-download-"));
  const downloadUrl = `https://github.com/${repo}/releases/download/${releaseTag}/${assetName}`;
  const archivePath = path.join(tempDir, assetName);
  const extractDir = path.join(tempDir, "extracted");

  try {
    console.log(`   Downloading ${assetName}...`);
    await downloadToFile(downloadUrl, archivePath);

    console.log(`   Extracting...`);
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

const main = async () => {
  try {
    // Clear libs directory
    if (fs.existsSync(libsDir)) {
      fs.rmSync(libsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(libsDir, { recursive: true });

    if (platform === "android" && androidArchs) {
      // Download each Android architecture
      for (const arch of androidArchs) {
        const destDir = path.join(libsDir, arch.arch);
        await downloadAndExtractAsset(arch.assetName, destDir, arch.srcSubdir);
        console.log(`   Installed ${arch.arch}`);
      }
    } else if (assetName) {
      // Download single asset (Apple/headers)
      await downloadAndExtractAsset(assetName, libsDir, libSubdir);
    }

    console.log(`${pkg.name}: Binaries installed successfully`);
  } catch (error) {
    // Cleanup on error
    fs.rmSync(libsDir, { recursive: true, force: true });

    console.error(`${pkg.name}: Failed to install binaries`);
    console.error(`   ${error.message}`);
    process.exit(1);
  }
};

main();
