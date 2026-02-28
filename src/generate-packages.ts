/**
 * Script to generate individual Skia binary npm packages.
 *
 * Usage:
 *   npx tsx src/generate-packages.ts --skia-version=m144b --npm-version=144.2.0
 *   npx tsx src/generate-packages.ts --package=android --skia-version=m144b --npm-version=144.2.0
 *
 * Options:
 *   --package       Generate only a specific package (optional, generates all if omitted)
 *   --skia-version  Skia milestone version (e.g., m144b)
 *   --npm-version   NPM package version (e.g., 144.2.0)
 *   --graphite      Generate Graphite packages instead of Ganesh
 *   --output-dir    Output directory (default: ./dist)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");

// GitHub repository for downloading binaries
const REPO = "shopify/react-native-skia";

interface PackageConfig {
  name: string;
  platform: "android" | "apple" | "common";
  description: string;
  // For Android: list of architectures to include
  androidArchs?: Array<{
    arch: string;
    artifact: string;
    srcSubdir: string;
  }>;
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

interface SkiaMetadata {
  repo: string;
  platform: string;
  releaseTag: string;
  graphite: boolean;
  // For Android packages
  androidArchs?: Array<{
    arch: string;
    assetName: string;
    srcSubdir: string;
  }>;
  // For Apple packages
  assetName?: string;
  libSubdir?: string;
}

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
    provenance: boolean;
  };
  files: string[];
  scripts: {
    postinstall: string;
  };
  skia: SkiaMetadata;
}

const generatePackageJson = (
  pkg: PackageConfig,
  skiaVersion: string,
  npmVersion: string,
  graphite: boolean
): GeneratedPackageJson => {
  const prefix = graphite ? "skia-graphite" : "skia";
  const releaseTag = graphite
    ? `skia-graphite-${skiaVersion}`
    : `skia-${skiaVersion}`;

  const skiaMetadata: SkiaMetadata = {
    repo: REPO,
    platform: pkg.platform,
    releaseTag,
    graphite,
  };

  if (pkg.platform === "android" && pkg.androidArchs) {
    skiaMetadata.androidArchs = pkg.androidArchs.map((arch) => ({
      arch: arch.arch,
      assetName: `${arch.artifact}-${releaseTag}.tar.gz`,
      srcSubdir: arch.srcSubdir,
    }));
  } else if (pkg.artifact) {
    skiaMetadata.assetName = `${pkg.artifact}-${releaseTag}.tar.gz`;
    skiaMetadata.libSubdir = pkg.libSubdir;
  }

  return {
    name: `react-native-${prefix}-${pkg.name}`,
    version: npmVersion,
    description: pkg.description,
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/wcandillon/react-native-skia-binaries.git",
      directory: `dist/${graphite ? "graphite" : "ganesh"}/${pkg.name}`,
    },
    publishConfig: {
      access: "public",
      provenance: true,
    },
    files: ["libs/**", "postinstall.mjs"],
    scripts: {
      postinstall: "node postinstall.mjs",
    },
    skia: skiaMetadata,
  };
};

const generateReadme = (
  pkg: PackageConfig,
  skiaVersion: string,
  npmVersion: string,
  graphite: boolean
): string => {
  const prefix = graphite ? "skia-graphite" : "skia";
  const packageName = `react-native-${prefix}-${pkg.name}`;

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

This package contains prebuilt Skia libraries downloaded from the [Shopify/react-native-skia](https://github.com/Shopify/react-native-skia) GitHub releases.

- **Skia Version**: ${skiaVersion}
- **Package Version**: ${npmVersion}
- **Platform**: ${pkg.platform}
${graphite ? "- **Backend**: Graphite (Dawn/WebGPU)\n" : ""}
${architectureInfo}
## Installation

This package is typically installed automatically as a dependency of \`@shopify/react-native-skia\`.

\`\`\`bash
npm install ${packageName}
\`\`\`

## Postinstall

On installation, this package downloads the binary from GitHub releases:
- Repository: \`${REPO}\`
- Release Tag: \`${graphite ? "skia-graphite-" : "skia-"}${skiaVersion}\`

## License

MIT
`;
};

const generatePackage = (
  pkg: PackageConfig,
  outputDir: string,
  skiaVersion: string,
  npmVersion: string,
  graphite: boolean
): string => {
  const pkgDir = path.join(
    outputDir,
    graphite ? "graphite" : "ganesh",
    pkg.name
  );

  // Create package directory
  fs.mkdirSync(pkgDir, { recursive: true });

  // Generate package.json
  const packageJson = generatePackageJson(pkg, skiaVersion, npmVersion, graphite);
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n"
  );

  // Generate README.md
  const readme = generateReadme(pkg, skiaVersion, npmVersion, graphite);
  fs.writeFileSync(path.join(pkgDir, "README.md"), readme);

  // Copy postinstall script
  const postinstallSrc = path.join(ROOT_DIR, "src", "postinstall.mjs");
  const postinstallDest = path.join(pkgDir, "postinstall.mjs");
  fs.copyFileSync(postinstallSrc, postinstallDest);

  // Create empty libs directory (will be populated by postinstall)
  fs.mkdirSync(path.join(pkgDir, "libs"), { recursive: true });

  console.log(`  Generated: ${packageJson.name}@${npmVersion}`);
  return pkgDir;
};

const main = (): void => {
  const args = parseArgs();

  if (!args["skia-version"]) {
    console.error("Error: --skia-version is required");
    console.error(
      "Usage: npx tsx src/generate-packages.ts --skia-version=m144b --npm-version=144.2.0"
    );
    process.exit(1);
  }

  if (!args["npm-version"]) {
    console.error("Error: --npm-version is required");
    console.error(
      "Usage: npx tsx src/generate-packages.ts --skia-version=m144b --npm-version=144.2.0"
    );
    process.exit(1);
  }

  const skiaVersion = args["skia-version"] as string;
  const npmVersion = args["npm-version"] as string;
  const graphite = args.graphite === true;
  const outputDir = (args["output-dir"] as string) || path.join(ROOT_DIR, "dist");
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
    const pkgDir = generatePackage(
      pkg,
      outputDir,
      skiaVersion,
      npmVersion,
      graphite
    );
    generatedDirs.push(pkgDir);
  }

  console.log("");
  console.log(`Generated ${generatedDirs.length} package(s)`);

  // Output generated directories for use in CI
  if (process.env.GITHUB_OUTPUT) {
    const output = generatedDirs.join("\n");
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `packages=${output}\n`);
  }
};

main();
