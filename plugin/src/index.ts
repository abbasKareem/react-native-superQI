import { AndroidConfig, ConfigPlugin, createRunOncePlugin, WarningAggregator, withAndroidManifest, withAppBuildGradle } from "expo/config-plugins";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../package.json") as { name: string; version: string };

const DESUGAR_DEPENDENCY = "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'";
const BACK_INVOKED_ATTRIBUTE = "android:enableOnBackInvokedCallback";

/**
 * App-level Android build settings the bundled Qi SDK needs. The SDK binaries themselves ship inside this
 * package and are linked by its own android/build.gradle and iOS podspec, so iOS needs no changes here.
 */
const withSuperQi: ConfigPlugin<Record<string, unknown> | void> = (config, props) => {
  if (props && "sdkPath" in props) {
    WarningAggregator.addWarningForPlatform(
      "android",
      pkg.name,
      "The sdkPath option is no longer used: the Qi SDK binaries are bundled with the package. Remove it from your app config.",
    );
  }

  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = addCoreLibraryDesugaring(mod.modResults.contents);
    return mod;
  });

  config = withAndroidManifest(config, (mod) => {
    mod.modResults = allowAppBackInvokedCallback(mod.modResults);
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
