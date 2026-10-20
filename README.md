# React Native Skia Binaries

> **Status: archived (October 2026).** This repository is no longer maintained and is kept read-only for reference.
>
> It produced the prebuilt Skia binary packages used by React Native Skia v2 (`react-native-skia-android`, `react-native-skia-apple-ios`, `react-native-skia-apple-tvos`, `react-native-skia-apple-macos`), the first `react-native-skia-graphite-*` packages, and a remote Swift package resolving to the release assets of this repository.
>
> - The v2 packages stay published on npm and keep working. Nothing is unpublished.
> - Starting with React Native Skia v3, the binaries (`react-native-skia-graphite-*` and `react-native-webgpu-dawn`) are built and published directly from the [react-native-skia](https://github.com/wcandillon/react-native-skia) repository by its "Build and publish binaries" workflow. New Skia milestones are released there, not here.
> - The GitHub releases, and the remote Swift package in `Package.swift` that points at them, remain downloadable from this archived repository.
>
> This repository would only be revived if a new set of Ganesh binaries for the v2 line were ever needed.

This repository generates and publishes prebuilt Skia binary packages for [React Native Skia](https://github.com/Shopify/react-native-skia).

## Overview

The binaries are downloaded from GitHub releases and bundled directly into npm packages. No postinstall scripts - the binaries are included in the package and ready to use immediately upon installation.

## Packages

### Ganesh (Standard Metal/OpenGL backend)

| Package | Platform | Description |
|---------|----------|-------------|
| `react-native-skia-android` | Android | All architectures (armeabi-v7a, arm64-v8a, x86, x86_64) |
| `react-native-skia-apple-ios` | Apple | iOS (device + simulator + Mac Catalyst) |
| `react-native-skia-apple-tvos` | Apple | tvOS (device + simulator) |
| `react-native-skia-apple-macos` | Apple | macOS (arm64 + x64) |

### Graphite (Dawn/WebGPU backend)

| Package | Platform | Description |
|---------|----------|-------------|
| `react-native-skia-graphite-android` | Android | All architectures (armeabi-v7a, arm64-v8a, x86, x86_64) |
| `react-native-skia-graphite-apple-ios` | Apple | iOS (device + simulator) |
| `react-native-skia-graphite-apple-macos` | Apple | macOS (arm64 + x64) |
| `react-native-skia-graphite-headers` | Common | Graphite headers |

The Apple packages declare `"os": ["darwin"]`: their xcframeworks are only consumed by Xcode, so package managers skip them on Linux and Windows once they are listed as optional dependencies.

## Usage

```bash
# Install a specific platform package (Apple packages install on macOS only)
npm install react-native-skia-apple-ios
```

The binaries are included directly - no download happens at install time.

## Configuration

The `skia-config.json` file contains the current Skia versions and checksums:

```json
{
  "skia": {
    "version": "m144c",
    "checksums": {
      "android-armeabi-v7a": "...",
      "apple-ios-xcframeworks": "...",
      ...
    }
  },
  "skia-graphite": {
    "version": "m142b",
    "checksums": { ... }
  }
}
```

## Publishing New Versions

### Via GitHub Actions

1. Go to **Actions** > **Publish Skia Binary Packages**
2. Click **Run workflow**
3. Fill in:
   - **Skia version**: e.g., `m144c`
   - **NPM version**: (optional) derived automatically: `m144c` → `144.3.0`
   - **Graphite**: Check for Graphite packages
   - **Dry run**: Uncheck to actually publish

### Local Development

```bash
# Install dependencies
npm install

# Generate ALL packages (Ganesh + Graphite) from config file
npx tsx src/generate-packages.ts --config=skia-config.json

# Generate all Ganesh packages (npm version derived: m144c → 144.3.0)
npx tsx src/generate-packages.ts --skia-version=m144c

# Generate a specific package
npx tsx src/generate-packages.ts --skia-version=m144c --package=apple-ios

# Generate Graphite packages
npx tsx src/generate-packages.ts --skia-version=m142b --graphite

# Override npm version if needed
npx tsx src/generate-packages.ts --skia-version=m144c --npm-version=144.3.1

# Verify checksums against skia-config.json
npx tsx src/verify-checksums.ts --config=skia-config.json

# Publish (from generated package directory)
cd dist/react-native-skia-apple-ios
npm publish --access public
```

## Generated Package Structure

```
dist/
├── react-native-skia-android/
│   ├── package.json
│   ├── README.md
│   └── libs/
│       ├── armeabi-v7a/*.a
│       ├── arm64-v8a/*.a
│       ├── x86/*.a
│       └── x86_64/*.a
├── react-native-skia-apple-ios/
│   ├── package.json
│   ├── README.md
│   └── libs/
│       ├── libskia.xcframework/
│       └── ...
├── react-native-skia-graphite-android/
│   └── ...
└── ...
```

## License

MIT License - see [LICENSE](LICENSE) for details.
