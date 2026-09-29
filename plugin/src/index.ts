import {
  AndroidConfig,
  ConfigPlugin,
  createRunOncePlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withPodfile,
} from "expo/config-plugins";
import fs from "fs";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../package.json") as { name: string; version: string };

export interface SuperQiPluginProps {
  /**
   * Folder (relative to the project root) holding the Qi SDK binaries you received from Qi:
   *   <sdkPath>/android/payment-<version>.aar, <sdkPath>/android/emv-3ds-sdk-<version>.aar
   *   <sdkPath>/ios/payment_sdk.xcframework, <sdkPath>/ios/TdsSdkIos.xcframework
   * Default "./qi-sdk".
   */
  sdkPath?: string;
}

export const GRADLE_SDK_DIR_PROPERTY = "superqi.sdkDir";
export const VENDOR_POD_NAME = "SuperQiVendorSDK";
export const IOS_FRAMEWORKS = ["payment_sdk.xcframework", "TdsSdkIos.xcframework"];
const ANDROID_AAR_PATTERNS = [/^payment-.+\.aar$/, /^emv-3ds-sdk-.+\.aar$/];
const DESUGAR_DEPENDENCY = "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'";
const BACK_INVOKED_ATTRIBUTE = "android:enableOnBackInvokedCallback";

const withSuperQi: ConfigPlugin<SuperQiPluginProps | void> = (config, props) => {
  const sdkPath = (props && props.sdkPath) || "./qi-sdk";

  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = addCoreLibraryDesugaring(mod.modResults.contents);
    return mod;
  });

  config = withAndroidManifest(config, (mod) => {
    mod.modResults = allowAppBackInvokedCallback(mod.modResults);
    return mod;
  });

  config = withGradleProperties(config, (mod) => {
    const androidSdkDir = resolveAndroidSdkDir(mod.modRequest.projectRoot, sdkPath);
    const relative = path.relative(mod.modRequest.platformProjectRoot, androidSdkDir).split(path.sep).join("/");
    mod.modResults = setGradleProperty(mod.modResults, GRADLE_SDK_DIR_PROPERTY, relative);
    return mod;
  });

  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const frameworksDir = resolveIosSdkDir(mod.modRequest.projectRoot, sdkPath);
      writeVendorPod(mod.modRequest.platformProjectRoot, frameworksDir);
      return mod;
    },
  ]);

  config = withPodfile(config, (mod) => {
    mod.modResults.contents = addVendorPod(mod.modResults.contents);
    return mod;
  });

  return config;
};

export default createRunOncePlugin(withSuperQi, pkg.name, pkg.version);

/** The Qi SDK uses java.time, so the app module needs core-library desugaring (not exposed by expo-build-properties). */
export function addCoreLibraryDesugaring(gradle: string): string {
  let result = gradle;
  if (!/coreLibraryDesugaringEnabled\s*(=\s*)?true/.test(result)) {
    if (/compileOptions\s*\{/.test(result)) {
      result = result.replace(/compileOptions\s*\{/, "compileOptions {\n        coreLibraryDesugaringEnabled true");
    } else if (/^android\s*\{/m.test(result)) {
      result = result.replace(/^android\s*\{/m, "android {\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n    }");
    } else {
      throw new Error(`[${pkg.name}] Could not find the android { } block in app/build.gradle to enable desugaring.`);
    }
  }
  if (!result.includes(DESUGAR_DEPENDENCY)) {
    if (!/^dependencies\s*\{/m.test(result)) {
      throw new Error(`[${pkg.name}] Could not find the top-level dependencies { } block in app/build.gradle.`);
    }
    result = result.replace(/^dependencies\s*\{/m, `dependencies {\n    ${DESUGAR_DEPENDENCY}`);
  }
  return result;
}

/**
 * payment-2.0.4.aar sets android:enableOnBackInvokedCallback="true" on <application>, while Expo writes
 * the app's own value, and the manifest merger fails on the mismatch. Let the app's value win; the
 * SDK's PaymentActivity keeps its own activity-level flag.
 */
export function allowAppBackInvokedCallback(manifest: AndroidConfig.Manifest.AndroidManifest): AndroidConfig.Manifest.AndroidManifest {
  const root = manifest.manifest;
  root.$["xmlns:tools"] = root.$["xmlns:tools"] || "http://schemas.android.com/tools";
  const application = root.application?.[0];
  if (application) {
    const attributes = application.$ as Record<string, string | undefined>;
    const replaced = (attributes["tools:replace"] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!replaced.includes(BACK_INVOKED_ATTRIBUTE)) replaced.push(BACK_INVOKED_ATTRIBUTE);
    attributes["tools:replace"] = replaced.join(",");
  }
  return manifest;
}

export function setGradleProperty(
  properties: AndroidConfig.Properties.PropertiesItem[],
  key: string,
  value: string,
): AndroidConfig.Properties.PropertiesItem[] {
  const others = properties.filter((item) => !(item.type === "property" && item.key === key));
  return [...others, { type: "property", key, value }];
}

/** Adds the generated vendor pod right after use_expo_modules! so the module's podspec dependency resolves. */
export function addVendorPod(podfile: string): string {
  if (podfile.includes(`pod '${VENDOR_POD_NAME}'`)) return podfile;
  const anchor = /^(\s*)use_expo_modules!.*$/m;
  const match = podfile.match(anchor);
  if (!match) {
    throw new Error(`[${pkg.name}] Could not find use_expo_modules! in ios/Podfile to add ${VENDOR_POD_NAME}.`);
  }
  const indent = match[1];
  const line = `${match[0]}\n${indent}# Qi SDK binaries supplied by the app (added by ${pkg.name})\n${indent}pod '${VENDOR_POD_NAME}', :path => './${VENDOR_POD_NAME}'`;
  return podfile.replace(anchor, line);
}

export function vendorPodspec(): string {
  return `# Generated by ${pkg.name}. Do not edit; re-run \`npx expo prebuild\` instead.
Pod::Spec.new do |s|
  s.name             = '${VENDOR_POD_NAME}'
  s.version          = '1.0.0'
  s.summary          = 'Qi payment SDK binaries supplied by the app owner'
  s.homepage         = 'https://developers-gate.qi.iq'
  s.license          = { :type => 'Commercial', :text => 'Qi payment SDK binaries supplied by Qi to the app owner.' }
  s.author           = 'Qi'
  s.platforms        = { :ios => '16.4' }
  s.source           = { :git => '' }
  s.vendored_frameworks = ${IOS_FRAMEWORKS.map((name) => `'${name}'`).join(", ")}
  s.preserve_paths   = '*.xcframework/**/*'
  # System frameworks the two binaries import.
  s.frameworks       = 'PassKit', 'WebKit', 'CoreData', 'QuickLook', 'CryptoKit', 'LocalAuthentication', 'CoreLocation', 'AdSupport', 'SystemConfiguration'
end
`;
}

/** Replaces ios/SuperQiVendorSDK with fresh copies of the frameworks and its podspec (same result on every run). */
export function writeVendorPod(iosProjectRoot: string, frameworksDir: string): string {
  const podDir = path.join(iosProjectRoot, VENDOR_POD_NAME);
  fs.rmSync(podDir, { recursive: true, force: true });
  fs.mkdirSync(podDir, { recursive: true });
  for (const name of IOS_FRAMEWORKS) {
    fs.cpSync(path.join(frameworksDir, name), path.join(podDir, name), { recursive: true, verbatimSymlinks: true });
  }
  fs.writeFileSync(path.join(podDir, `${VENDOR_POD_NAME}.podspec`), vendorPodspec());
  return podDir;
}

export function resolveAndroidSdkDir(projectRoot: string, sdkPath: string): string {
  const dir = path.resolve(projectRoot, sdkPath, "android");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const missing = ANDROID_AAR_PATTERNS.filter((pattern) => files.filter((file) => pattern.test(file)).length !== 1);
  if (missing.length) {
    throw new Error(
      `[${pkg.name}] Expected exactly one payment-<version>.aar and one emv-3ds-sdk-<version>.aar in ${dir}. ` +
        `These binaries come from Qi and are not included in the npm package (see the README, "SDK binaries").`,
    );
  }
  return dir;
}

export function resolveIosSdkDir(projectRoot: string, sdkPath: string): string {
  const dir = path.resolve(projectRoot, sdkPath, "ios");
  const missing = IOS_FRAMEWORKS.filter((name) => !fs.existsSync(path.join(dir, name, "Info.plist")));
  if (missing.length) {
    throw new Error(
      `[${pkg.name}] Missing ${missing.join(", ")} in ${dir}. Unzip the XCFrameworks you received from Qi there ` +
        `(they are not included in the npm package; see the README, "SDK binaries").`,
    );
  }
  return dir;
}
