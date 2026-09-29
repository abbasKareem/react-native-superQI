import { AndroidConfig } from "expo/config-plugins";
import fs from "fs";
import os from "os";
import path from "path";

import {
  addCoreLibraryDesugaring,
  addVendorPod,
  allowAppBackInvokedCallback,
  GRADLE_SDK_DIR_PROPERTY,
  IOS_FRAMEWORKS,
  resolveAndroidSdkDir,
  resolveIosSdkDir,
  setGradleProperty,
  VENDOR_POD_NAME,
  writeVendorPod,
} from "../index";

// Fixtures are the unmodified files from expo-template-bare-minimum@57.
const fixture = (name: string) => path.join(__dirname, "fixtures", name);
const read = (name: string) => fs.readFileSync(fixture(name), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "superqi-plugin-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeSdk(root: string) {
  fs.mkdirSync(path.join(root, "android"), { recursive: true });
  fs.writeFileSync(path.join(root, "android", "payment-2.0.4.aar"), "aar");
  fs.writeFileSync(path.join(root, "android", "emv-3ds-sdk-1.1.6.aar"), "aar");
  for (const name of IOS_FRAMEWORKS) {
    fs.mkdirSync(path.join(root, "ios", name, "ios-arm64"), { recursive: true });
    fs.writeFileSync(path.join(root, "ios", name, "Info.plist"), "<plist/>");
    fs.writeFileSync(path.join(root, "ios", name, "ios-arm64", "binary"), name);
  }
}

describe("app/build.gradle desugaring", () => {
  it("enables desugaring once on the Expo template", () => {
    const once = addCoreLibraryDesugaring(read("app.build.gradle"));
    expect(once).toMatch(/android \{\n {4}compileOptions \{\n {8}coreLibraryDesugaringEnabled true\n {4}\}/);
    expect(once).toMatch(/dependencies \{\n {4}coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'/);
    expect(addCoreLibraryDesugaring(once)).toBe(once);
  });

  it("reuses an existing compileOptions block", () => {
    const gradle = "android {\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n    }\n}\ndependencies {\n}\n";
    const result = addCoreLibraryDesugaring(gradle);
    expect(count(result, "compileOptions")).toBe(1);
    expect(count(result, "coreLibraryDesugaringEnabled true")).toBe(1);
    expect(addCoreLibraryDesugaring(result)).toBe(result);
  });

  it("fails loudly when the file has an unexpected shape", () => {
    expect(() => addCoreLibraryDesugaring("plugins { }\n")).toThrow(/android \{ \}/);
  });
});

describe("AndroidManifest back-invoked override", () => {
  it("adds tools:replace once and keeps existing entries", async () => {
    const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(fixture("AndroidManifest.xml"));
    const app = manifest.manifest.application![0].$ as Record<string, string>;
    app["tools:replace"] = "android:allowBackup";

    allowAppBackInvokedCallback(manifest);
    allowAppBackInvokedCallback(manifest);

    expect(app["tools:replace"]).toBe("android:allowBackup,android:enableOnBackInvokedCallback");
    expect(manifest.manifest.$["xmlns:tools"]).toBe("http://schemas.android.com/tools");
  });
});

describe("gradle.properties", () => {
  it("sets the SDK dir property once and updates it in place", () => {
    const base: AndroidConfig.Properties.PropertiesItem[] = [{ type: "property", key: "hermesEnabled", value: "true" }];
    const first = setGradleProperty(base, GRADLE_SDK_DIR_PROPERTY, "../qi-sdk/android");
    const second = setGradleProperty(first, GRADLE_SDK_DIR_PROPERTY, "../vendor/android");
    expect(setGradleProperty(first, GRADLE_SDK_DIR_PROPERTY, "../qi-sdk/android")).toEqual(first);
    expect(second.filter((item) => item.type === "property" && item.key === GRADLE_SDK_DIR_PROPERTY)).toEqual([
      { type: "property", key: GRADLE_SDK_DIR_PROPERTY, value: "../vendor/android" },
    ]);
  });
});

describe("Podfile", () => {
  it("adds the vendor pod once, right after use_expo_modules!", () => {
    const once = addVendorPod(read("Podfile"));
    expect(once).toMatch(new RegExp(`use_expo_modules!\\n.*\\n  pod '${VENDOR_POD_NAME}', :path => './${VENDOR_POD_NAME}'`));
    expect(addVendorPod(once)).toBe(once);
  });

  it("fails loudly without use_expo_modules!", () => {
    expect(() => addVendorPod("target 'App' do\nend\n")).toThrow(/use_expo_modules!/);
  });
});

describe("SDK binaries", () => {
  it("resolves both platform folders when the binaries are present", () => {
    makeSdk(path.join(tmp, "qi-sdk"));
    expect(resolveAndroidSdkDir(tmp, "./qi-sdk")).toBe(path.join(tmp, "qi-sdk", "android"));
    expect(resolveIosSdkDir(tmp, "qi-sdk")).toBe(path.join(tmp, "qi-sdk", "ios"));
  });

  it("explains where binaries come from when they are missing", () => {
    expect(() => resolveAndroidSdkDir(tmp, "./qi-sdk")).toThrow(/not included in the npm package/);
    expect(() => resolveIosSdkDir(tmp, "./qi-sdk")).toThrow(/payment_sdk\.xcframework, TdsSdkIos\.xcframework/);
  });

  it("rejects ambiguous AAR versions", () => {
    makeSdk(path.join(tmp, "qi-sdk"));
    fs.writeFileSync(path.join(tmp, "qi-sdk", "android", "payment-2.0.5.aar"), "aar");
    expect(() => resolveAndroidSdkDir(tmp, "./qi-sdk")).toThrow(/exactly one/);
  });

  it("writes the vendor pod with the same result on every run", () => {
    makeSdk(path.join(tmp, "qi-sdk"));
    const iosRoot = path.join(tmp, "ios");
    const podDir = writeVendorPod(iosRoot, path.join(tmp, "qi-sdk", "ios"));
    fs.writeFileSync(path.join(podDir, "stale.txt"), "left over");

    writeVendorPod(iosRoot, path.join(tmp, "qi-sdk", "ios"));

    expect(fs.readdirSync(podDir).sort()).toEqual([`${VENDOR_POD_NAME}.podspec`, ...IOS_FRAMEWORKS].sort());
    expect(fs.readFileSync(path.join(podDir, "payment_sdk.xcframework", "ios-arm64", "binary"), "utf8")).toBe("payment_sdk.xcframework");
    const podspec = fs.readFileSync(path.join(podDir, `${VENDOR_POD_NAME}.podspec`), "utf8");
    expect(podspec).toContain(`s.vendored_frameworks = 'payment_sdk.xcframework', 'TdsSdkIos.xcframework'`);
  });
});
