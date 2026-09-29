#!/usr/bin/env bash
# Lists classes the Qi AARs reference that are missing from a built APK.
# The AARs declare no dependencies, so a missing library only shows up at runtime as
# NoClassDefFoundError. Run this after upgrading the SDK or changing android/build.gradle.
#
#   scripts/check-android-classes.sh <app.apk> <sdk-android-dir>
#   e.g. scripts/check-android-classes.sh example/android/app/build/outputs/apk/debug/app-debug.apk example/qi-sdk/android
set -euo pipefail
apk="$1"
sdk_dir="$2"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
dexdump="$(ls -d "$ANDROID_HOME"/build-tools/*/dexdump | sort -V | tail -n 1)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Classes in the APK
unzip -q -o "$apk" 'classes*.dex' -d "$work/apk"
for dex in "$work"/apk/classes*.dex; do
  "$dexdump" "$dex" | sed -n "s/^ *Class descriptor *: *'L\(.*\);'/\1/p"
done | tr / . | sort -u > "$work/present.txt"

# Classes the AARs reference (excluding the platform and the AARs' own classes)
for aar in "$sdk_dir"/*.aar; do
  name="$(basename "$aar" .aar)"
  mkdir -p "$work/$name"
  unzip -q -o "$aar" classes.jar -d "$work/$name"
  unzip -q -o "$work/$name/classes.jar" -d "$work/$name/classes"
  (cd "$work/$name/classes" && find . -name '*.class' | sed 's#^\./##; s/\.class$//' | tr / .) > "$work/$name/own.txt"
  javap -c -p -classpath "$work/$name/classes.jar" $(cat "$work/$name/own.txt") 2>/dev/null \
    | grep -oE '// (class|Method|Field|InterfaceMethod) "?\[*L?[a-zA-Z_$][a-zA-Z0-9_$/]*' \
    | sed -E 's#^// [A-Za-z]+ "?\[*L?##' | tr / . > "$work/$name/refs.txt"
  cat "$work/$name/own.txt" >> "$work/own.txt"
  cat "$work/$name/refs.txt" >> "$work/refs.txt"
done
sort -u "$work/own.txt" -o "$work/own.txt"
grep -vE '^(java|javax|android|dalvik|kotlin\.jvm\.internal|org\.json|org\.w3c|org\.xml|sun)\.' "$work/refs.txt" \
  | grep '\.' | sort -u | comm -23 - "$work/own.txt" | comm -23 - "$work/present.txt" > "$work/missing.txt" || true

if [ -s "$work/missing.txt" ]; then
  echo "Referenced by the Qi AARs but missing from $apk:"
  cat "$work/missing.txt"
  exit 1
fi
echo "OK: every non-platform class referenced by the Qi AARs is in $apk"
