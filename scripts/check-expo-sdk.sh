#!/usr/bin/env bash
# Builds a throwaway Expo app on a given SDK with the packed package, to check compatibility.
#
#   scripts/check-expo-sdk.sh <sdk-major> [work-dir]
#   e.g. scripts/check-expo-sdk.sh 56
#
# Steps: create-expo-app (blank-typescript@sdk-<N>) -> install the npm-packed tarball -> copy the example
# screen -> expo prebuild twice (must be identical) -> pod install + iOS simulator build -> Android assembleDebug
# -> check-android-classes.sh. Nothing is installed or run on a device; see TESTING.md for runtime checks.
set -euo pipefail
sdk="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="${2:-$(mktemp -d)}"
app="$work/sdk$sdk"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CI=1

step() { printf '\n==> %s\n' "$*"; }

step "Scaffold Expo SDK $sdk app in $app"
rm -rf "$app"
mkdir -p "$work"
(cd "$work" && npx --yes create-expo-app@latest "sdk$sdk" --template "blank-typescript@sdk-$sdk" --no-install < /dev/null > /dev/null)
rm -rf "$app/.git"

step "Install the packed package"
tarball="$(cd "$root" && npm pack --silent --pack-destination "$app" | tail -n 1)"
cp "$root/example/App.tsx" "$app/"
# Keep the template's own app.json (asset names differ per SDK) and add what the example needs.
node -e '
  const fs = require("fs");
  const [appJson, exampleJson] = process.argv.slice(1);
  const app = JSON.parse(fs.readFileSync(appJson, "utf8"));
  const { expo: example } = JSON.parse(fs.readFileSync(exampleJson, "utf8"));
  app.expo.scheme = example.scheme;
  app.expo.ios = { ...app.expo.ios, bundleIdentifier: example.ios.bundleIdentifier };
  app.expo.android = { ...app.expo.android, package: example.android.package };
  app.expo.plugins = example.plugins; // no options: the Qi binaries are bundled in the package
  fs.writeFileSync(appJson, JSON.stringify(app, null, 2));
' "$app/app.json" "$root/example/app.json"
(cd "$app" && npm install --no-audit --no-fund > /dev/null && npm install --no-audit --no-fund "./$tarball" > /dev/null)
(cd "$app" && node -e 'for (const p of ["expo","react-native"]) console.log(p, require(p + "/package.json").version)')

step "Type-check"
(cd "$app" && npx tsc --noEmit)

step "Prebuild twice (must be identical)"
(cd "$app" && npx expo prebuild --clean --no-install > /dev/null)
cp -R "$app/android" "$work/android-first" && cp -R "$app/ios" "$work/ios-first"
(cd "$app" && npx expo prebuild --no-install > /dev/null)
diff -r -q "$work/android-first" "$app/android" && diff -r -q "$work/ios-first" "$app/ios"
rm -rf "$work/android-first" "$work/ios-first"
echo "identical"

step "iOS: pod install + simulator build"
(cd "$app/ios" && pod install > "$work/pod-install-$sdk.log" 2>&1)
workspace="$(cd "$app/ios" && ls -d *.xcworkspace | head -n 1)"
scheme="${workspace%.xcworkspace}"
(cd "$app/ios" && xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO build \
  > "$work/ios-build-$sdk.log" 2>&1) || { tail -n 40 "$work/ios-build-$sdk.log"; exit 1; }
echo "iOS build succeeded"

step "Android: assembleDebug"
(cd "$app/android" && ./gradlew :app:assembleDebug --console=plain > "$work/android-build-$sdk.log" 2>&1) \
  || { grep -E '^e: |What went wrong' -A4 "$work/android-build-$sdk.log" | head -n 40; exit 1; }
"$root/scripts/check-android-classes.sh" "$app/android/app/build/outputs/apk/debug/app-debug.apk" \
  "$app/node_modules/react-native-superqi/android/libs"

step "Expo SDK $sdk: all checks passed (app kept at $app)"
