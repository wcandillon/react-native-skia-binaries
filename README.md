# React Native Skia Binaries

This repository generates and publishes prebuilt Skia binary packages for [React Native Skia](https://github.com/Shopify/react-native-skia).

## Overview

Instead of bundling large binary files directly in the main `@shopify/react-native-skia` package, this repository downloads binaries from GitHub releases and publishes them as separate npm packages. This allows:

- Smaller initial package size
- Platform-specific installations (only download what you need)
- Easy versioning and caching

## Packages

### Ganesh (Standard Metal/OpenGL backend)

| Package | Platform | Description |
|---------|----------|-------------|
| `react-native-skia-android` | Android | All architectures (armeabi-v7a, arm64-v8a, x86, x86_64) |
| `react-native-skia-apple-ios` | Apple | iOS (device + simulator) |
| `react-native-skia-apple-tvos` | Apple | tvOS (device + simulator) |
| `react-native-skia-apple-macos` | Apple | macOS (arm64 + x64) |

### Graphite (Dawn/WebGPU backend)

| Package | Platform | Description |
|---------|----------|-------------|
| `react-native-skia-graphite-android` | Android | All architectures (armeabi-v7a, arm64-v8a, x86, x86_64) |
| `react-native-skia-graphite-apple-ios` | Apple | iOS (device + simulator) |
| `react-native-skia-graphite-apple-macos` | Apple | macOS (arm64 + x64) |
| `react-native-skia-graphite-headers` | Common | Graphite headers |

## Usage

### Manual Installation

```bash
# Install a specific platform package
npm install react-native-skia-apple-ios

# The postinstall script automatically downloads binaries from GitHub releases
```

### As Dependencies

These packages are typically installed as optional dependencies of `@shopify/react-native-skia`:

```json
{
  "optionalDependencies": {
    "react-native-skia-android": "^144.0.0",
    "react-native-skia-apple-ios": "^144.0.0"
  }
}
```

## Publishing New Versions

### Via GitHub Actions

1. Go to **Actions** > **Publish Skia Binary Packages**
2. Click **Run workflow**
3. Fill in:
   - **Skia version**: e.g., `m144b`
   - **NPM version**: e.g., `144.2.0`
   - **Graphite**: Check for Graphite packages
   - **Dry run**: Uncheck to actually publish

### Local Development

```bash
# Install dependencies
npm install

# Generate all Ganesh packages
npx tsx src/generate-packages.ts --skia-version=m144b --npm-version=144.2.0

# Generate a specific package
npx tsx src/generate-packages.ts --package=apple-ios --skia-version=m144b --npm-version=144.2.0

# Generate Graphite packages
npx tsx src/generate-packages.ts --graphite --skia-version=m142a --npm-version=142.1.0

# Download binaries locally for testing
npx tsx src/download-binaries.ts --skia-version=m144c

# Test postinstall
cd dist/ganesh/apple-ios
node postinstall.mjs
```

## Configuration

The packages download binaries from GitHub releases. The source configuration:

```json
{
  "skia": {
    "version": "m144c",
    "checksums": {
      "android-armeabi-v7a": "e406c3e8103a2efb6a514ac91346d7f9f81adbae14dc2d0e302e84fb8c5f80f7",
      "android-arm64-v8a": "75069b0f7c66ad3382553e947d583265de033cc856c394110243da098306955f",
      "android-x86": "714b93a7bdf005a23699f47e6255e4e690086c52a1998c20196a46f95b709b09",
      "android-x86_64": "5bd2972d13293b09b35e2c0149b7d103dc4fb0f2837c3dd169ce06795b812714",
      "apple-ios-xcframeworks": "43f62ea742c55ecc57864505ff752a517fd2c31412a19914032d044ac4f987ee",
      "apple-tvos-xcframeworks": "0f6b5c75b4e686e72f5cc8508e60074463f757ca7a0dcbd07e095c055a537c58",
      "apple-macos-xcframeworks": "31f57bcf6caff1c268984609b0e4a2abd966bfa8ddcf074331d94e0f988f93d3"
    }
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SKIP_SKIA_DOWNLOAD` | Set to `1` or `true` to skip downloading binaries |

## License

MIT License - see [LICENSE](LICENSE) for details.
