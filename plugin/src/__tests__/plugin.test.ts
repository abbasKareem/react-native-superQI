import { AndroidConfig, WarningAggregator } from "expo/config-plugins";
import fs from "fs";
import path from "path";

import withSuperQi, { addCoreLibraryDesugaring, allowAppBackInvokedCallback } from "../index";

// Fixtures are the unmodified files from expo-template-bare-minimum for the lowest and highest verified SDKs.
const SDKS = ["sdk56", "sdk57"];
const fixture = (sdk: string, name: string) => path.join(__dirname, "fixtures", sdk, name);
const read = (sdk: string, name: string) => fs.readFileSync(fixture(sdk, name), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;
const packageRoot = path.resolve(__dirname, "../../..");

describe("app/build.gradle desugaring", () => {
  it.each(SDKS)("enables desugaring once on the Expo %s template", (sdk) => {
    const once = addCoreLibraryDesugaring(read(sdk, "app.build.gradle"));
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
  it.each(SDKS)("adds tools:replace once and keeps existing entries (%s template)", async (sdk) => {
    const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(fixture(sdk, "AndroidManifest.xml"));
    const app = manifest.manifest.application![0].$ as Record<string, string>;
    app["tools:replace"] = "android:allowBackup";

    allowAppBackInvokedCallback(manifest);
    allowAppBackInvokedCallback(manifest);

    expect(app["tools:replace"]).toBe("android:allowBackup,android:enableOnBackInvokedCallback");
    expect(manifest.manifest.$["xmlns:tools"]).toBe("http://schemas.android.com/tools");
  });
});

describe("plugin options", () => {
  afterEach(() => jest.restoreAllMocks());

  it("needs no options", () => {
    const warn = jest.spyOn(WarningAggregator, "addWarningForPlatform");
    expect(() => withSuperQi({ name: "app", slug: "app" })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns that the old sdkPath option is ignored", () => {
    const warn = jest.spyOn(WarningAggregator, "addWarningForPlatform").mockImplementation(() => {});
    withSuperQi({ name: "app", slug: "app" }, { sdkPath: "./qi-sdk" });
    expect(warn).toHaveBeenCalledWith("android", expect.any(String), expect.stringMatching(/sdkPath option is no longer used/));
  });
});

describe("bundled SDK binaries", () => {
  const gradle = fs.readFileSync(path.join(packageRoot, "android/build.gradle"), "utf8");
  const podspec = fs.readFileSync(path.join(packageRoot, "ios/ReactNativeSuperQi.podspec"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { files: string[] };

  it("ships every AAR that android/build.gradle links", () => {
    const aars = [...gradle.matchAll(/'(libs\/[^']+\.aar)'/g)].map((match) => match[1]);
    expect(aars).toEqual(["libs/payment-2.0.4.aar", "libs/emv-3ds-sdk-1.1.6.aar"]);
    for (const aar of aars) expect(fs.statSync(path.join(packageRoot, "android", aar)).size).toBeGreaterThan(0);
  });

  it("ships every XCFramework the podspec vendors, with all slices", () => {
    const frameworks = [...podspec.matchAll(/'(Frameworks\/[^']+\.xcframework)'/g)].map((match) => match[1]);
    expect(frameworks).toEqual(["Frameworks/payment_sdk.xcframework", "Frameworks/TdsSdkIos.xcframework"]);
    for (const framework of frameworks) {
      const dir = path.join(packageRoot, "ios", framework);
      expect(fs.existsSync(path.join(dir, "Info.plist"))).toBe(true);
      expect(fs.readdirSync(dir).filter((entry) => entry.startsWith("ios-")).sort()).toEqual(["ios-arm64", "ios-arm64_x86_64-simulator"]);
    }
  });

  it("includes the binaries in the npm files allowlist", () => {
    expect(pkg.files).toEqual(expect.arrayContaining(["android/libs/", "ios/Frameworks/"]));
  });
});
