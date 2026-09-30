This is the example app for `@morabaasoftwaresolutions/react-native-superqi` (Expo SDK 57). It is a single screen with no navigation on purpose: it shows that the package works without Expo Router.

## Expo has changed — do not trust your training data

Before writing code that touches an Expo, EAS, or React Native API, read the `expo` major version in `package.json` and check the matching docs at `https://docs.expo.dev/versions/v<major>.0.0/` (index: https://docs.expo.dev/llms.txt).

## Commands

```bash
../scripts/install-example.sh  # pack the package and install the tarball (the example never links the source tree)
npx expo install <package>     # add dependencies with SDK-compatible versions
npx expo prebuild --clean      # regenerate ios/ and android/ (the Qi binaries come from the package)
npx expo run:ios | run:android # build and run a development build
npx tsc --noEmit               # typecheck
```

## Rules

- `ios/` and `android/` are generated (Continuous Native Generation). Never edit them by hand; configure native behavior in `app.json` and the package's config plugin.
- Expo Go cannot load this app's native module. Use a development build.
- The Qi SDK binaries are bundled in the package (`../android/libs`, `../ios/Frameworks`). Don't add copies here, and never commit `.env.local` or gateway credentials.
