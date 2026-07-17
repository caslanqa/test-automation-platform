# Mobile Cheat Sheet

Quick command reference for the mobile (Maestro) layer. Full guide:
[docs/MOBILE_TESTING.md](MOBILE_TESTING.md).

> **Android tools on PATH:** the framework auto-detects the SDK, but for the raw `adb`/`emulator`
> commands below, export it once:
>
> ```bash
> export ANDROID_HOME="$HOME/Library/Android/sdk"   # Linux: ~/Android/Sdk · Windows: %LOCALAPPDATA%\Android\Sdk
> export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin"
> ```
>
> iOS tools (`xcrun simctl`) come with Xcode — no setup. Use `booted` in place of `<udid>` to target
> the single booted simulator.

## This framework

```bash
npm run test:mobile                     # run the mobile project (up to 3 workers; per-device lock)
npm run test:mobile -- --grep Android   # filter by describe/title
npm run mobile:create-device            # interactive: create an AVD / iOS sim + add it to the catalog
```

```ts
// select a device per describe/file (mobile/devices.ts is the catalog)
test.use({ mobile: devices.pixel9 }); // catalogued device
test.use({ mobile: { platform: 'android', device: 'pixel9' } }); // inline
test.use({ mobile: { ...devices.iphone16, headless: false } }); // show the device
test.use({ mobile: { ...devices.pixel9, app: 'builds/app.apk' } }); // install your build first
```

Env knobs (`env/environments.json`): `MOBILE_PLATFORM`, `MOBILE_DEVICE`, `MOBILE_HEADLESS`,
`MOBILE_APP_ANDROID`, `MOBILE_APP_IOS`, `MOBILE_KEEP_DEVICES`.

## Devices — list & get IDs

**Android**

```bash
emulator -list-avds                 # installed AVD names → use as `device`
adb devices                         # running devices/emulators + serials (e.g. emulator-5554, RZ8N…)
adb -s emulator-5554 emu avd name   # which AVD is behind a running emulator serial
```

**iOS**

```bash
xcrun simctl list devices           # all simulators: name · UDID · state
xcrun simctl list devices booted    # only booted ones
```

## Boot / shut down a device (manual)

**Android**

```bash
emulator -avd <name>                # boot (add -no-window for headless)
adb wait-for-device                 # wait until it connects
adb -s <serial> emu kill            # shut down
```

**iOS**

```bash
xcrun simctl boot <udid> && open -a Simulator   # boot + show the window
xcrun simctl bootstatus <udid> -b               # block until fully booted
xcrun simctl shutdown <udid>                    # shut down (app stays installed)
```

> The framework auto-boots a catalogued `device` and shuts down what it booted at the end of the run
> (`MOBILE_KEEP_DEVICES=1` to keep). You rarely need these by hand.

## App IDs (package / bundle id)

**Android**

```bash
adb shell pm list packages                # all installed packages
adb shell pm list packages -3             # third-party only (your apps)
# package of the app currently in the foreground:
adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'
adb shell dumpsys window | grep -E 'mCurrentFocus'
# appId straight from an APK file (no install needed):
"$ANDROID_HOME"/build-tools/*/aapt dump badging app.apk | grep "package:"
```

**iOS**

```bash
xcrun simctl listapps booted | grep CFBundleIdentifier   # bundle ids of installed apps
# bundle ids of apps currently running:
xcrun simctl spawn booted launchctl list | grep UIKitApplication
# bundle id from a .app bundle:
plutil -extract CFBundleIdentifier raw App.app/Info.plist
```

The value you find is the `appId` your Maestro flow launches: `appId: com.example.app`.

## Install / manage an app

**Android**

```bash
adb install -r app.apk              # install or replace
adb uninstall <package>
adb shell pm clear <package>        # wipe app data (reset state)
```

**iOS**

```bash
xcrun simctl install booted App.app
xcrun simctl uninstall booted <bundleId>
```

> The framework installs `MOBILE_APP_*` / the `app` option for you before the flow. Reset state per
> test inside the flow with `launchApp: { clearState: true }`.

## Maestro (authoring & debugging)

```bash
maestro test flow.yaml                    # run a flow on the booted device
maestro --device <id> test flow.yaml      # target a specific device
maestro studio                            # interactive inspector — find element ids/text (best tool)
maestro hierarchy                         # dump the current screen's view tree
maestro record flow.yaml                  # record a demo video of the flow
maestro start-device --platform android   # start a fresh managed device
```

`maestro studio` and `maestro hierarchy` are the quickest way to find selectors (text, id,
accessibility label) for `tapOn` / `assertVisible`.

## Troubleshooting

- **Test skips ("no device"):** the catalog `device` doesn't match a running/creatable one. Compare
  `mobile/devices.ts` against `adb devices` / `emulator -list-avds` (Android) or
  `xcrun simctl list devices` (iOS). Create one with `npm run mobile:create-device`.
- **Device won't show (or won't hide):** default is hidden; set `headless: false` to watch it. A
  running device is switched to the requested mode — Android restarts, iOS toggles the Simulator app.
- **First Android run fails during app install:** the emulator wasn't fully ready. The framework waits
  for the package manager; just re-run. Manually: wait until `adb shell getprop sys.boot_completed` is
  `1` **and** `adb shell pm path android` returns a path.
- **`adb` / `emulator` "command not found":** export `ANDROID_HOME` + PATH (see the top of this file).
- **Real Android device:** plug it in with USB debugging on, confirm `adb devices` lists it, then
  target it by serial: `test.use({ mobile: { platform: 'android', device: '<serial>' } })`.
