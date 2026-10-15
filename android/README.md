# MoneyMinder — Android wrapper

A thin, single-activity **Android WebView wrapper** around the MoneyMinder
PWA (the phone-first web app served by the project's Express server in
`../server`). It loads the live web app inside a full-screen `WebView` and adds
the native glue the app needs: validated receipt-image selection, UPI deep links,
WhatsApp share, and cookie-backed sessions.

## Why WebView and not a TWA?

The plan (`../BUILD-PLAN.md`, section **P6 — Android wrapper**) allows either a
Trusted Web Activity (TWA, via Bubblewrap) or a WebView project. We chose
**WebView** because:

- The app must work against a **self-hosted / dev server**, often plain `http`
  on `localhost` or a LAN IP. A TWA requires the PWA to be served over public
  **HTTPS** with a verified Digital Asset Links file — impossible against a dev
  box.
- We need fine control over the `<input type="file">` chooser result and
  **external-intent handoff** (`upi:`, `https://wa.me/...`). A
  WebView gives us `WebChromeClient` / `WebViewClient` hooks for all of these;
  a TWA hands the whole tab to Chrome and can't intercept them the same way.

See **"TWA alternative"** at the bottom for when the PWA is hosted on HTTPS.

## Project layout

```
android/
  gradlew  gradlew.bat                      (Gradle wrapper launchers)
  gradle/wrapper/gradle-wrapper.jar         (committed; Gradle 8.11.1)
  gradle/wrapper/gradle-wrapper.properties
  settings.gradle.kts
  build.gradle.kts                          (root, plugin versions; AGP 8.10.1)
  gradle.properties
  keystore.properties.example               (copy -> keystore.properties to sign)
  PRIVACY.md                                (privacy policy to host)
  RELEASE.md                                (Play Store publishing runbook)
  app/
    build.gradle.kts                        (compile/target SDK 36, signing, prod/dev URL)
    proguard-rules.pro
    src/main/AndroidManifest.xml
    src/main/java/com/moneyminder/app/MainActivity.kt
    src/main/res/values/strings.xml         (app_name only; server_url is per-build)
    src/main/res/values/colors.xml
    src/main/res/values/themes.xml          (no-action-bar theme)
    src/main/res/xml/network_security_config.xml   (release: HTTPS only)
    src/debug/res/xml/network_security_config.xml  (debug: cleartext to dev hosts)
    src/main/res/mipmap-*/                   (launcher icons from public/icons)
  README.md
```

> **Gradle wrapper is included.** `gradlew`, `gradlew.bat`, and
> `gradle/wrapper/gradle-wrapper.jar` (Gradle 8.11.1) are committed, so `./gradlew`
> works without first opening Android Studio. **Building still requires the
> Android SDK (platform 36, build-tools 35+) + JDK 17+**; create
> `local.properties` with `sdk.dir=...` (Android Studio does this on first open).
>
> **To publish to Google Play, follow [RELEASE.md](RELEASE.md)** — signing, the
> release App Bundle (`.aab`), the data-safety form, and store listing.

## Prerequisites

- **Android Studio** (Meerkat 2024.3.1 Patch 1 or newer) — easiest path, or
- Command-line **Android SDK** + **JDK 17**. The committed wrapper supplies
  Gradle 8.11.1.

## Build & run

### Option A — Android Studio (recommended)

1. Start the web server from the project root: `npm start`
   (it listens on `http://localhost:3000`).
2. Open the `android/` folder in Android Studio and let the committed wrapper
   download dependencies.
3. **Emulator:** just press Run. The default `server_url` of
   `http://10.0.2.2:3000` is the emulator's alias for your PC's `localhost`,
   so it reaches `npm start` with no extra config.
4. **Real device:** set the debug `server_url` to your PC's LAN IP (same Wi-Fi)
   in `app/build.gradle.kts` (the `debug { resValue("string", "server_url", ...) }`
   line), e.g. `http://192.168.1.50:3000`. Also replace the `192.168.1.50`
   placeholder in `app/src/debug/res/xml/network_security_config.xml` with that
   IP. Then Run on the device.

### Option B — command line

```bash
cd android
./gradlew :app:testAndroidPlatformContracts
./gradlew assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
```

Install the APK with `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
The platform contract also runs automatically before every debug or release
build; it rejects dangerous picker permissions, unvalidated chooser wiring, and
missing four-edge target-36 inset handling.
For a release build (signed `.aab` for the Play Store), see [RELEASE.md](RELEASE.md).

## Pointing at a hosted server

Every release build requires `MONEYMINDER_SERVER_URL`, supplied as either a
Gradle property or an environment variable. The Gradle property takes
precedence:

```bash
./gradlew bundleRelease \
  -PMONEYMINDER_SERVER_URL=https://money.your-real-domain.com
```

PowerShell environment-variable form:

```powershell
$env:MONEYMINDER_SERVER_URL = "https://money.your-real-domain.com"
.\gradlew.bat bundleRelease
```

Replace the example hostname with the deployed backend; the validator
intentionally rejects `your-real-domain` placeholders.

The value is baked into the release-only `server_url` resource. Gradle rejects a
missing value, non-HTTPS or relative URL, embedded credentials, invalid port,
and placeholder, local/private, reserved, or ambiguous numeric hosts.
`src/main/res/xml/network_security_config.xml` also forbids cleartext, while the
dev exceptions live only in `src/debug/`.

## Features that work through the wrapper

| Feature | How the wrapper supports it |
| --- | --- |
| **Receipt image selection** | `<input type="file">` on `scan.html` triggers `WebChromeClient.onShowFileChooser`, which opens Android's single-item content picker. Only one readable `content:` URI whose MIME type is JPEG or PNG reaches the page. The wrapper requests neither CAMERA nor broad media-library permission and does not promise live camera capture. |
| **UPI settle-up** | The household "Pay via UPI" button navigates to `upi://pay?pa=...`. A user-initiated main-frame navigation is handed to an external app with a browsable `Intent(ACTION_VIEW)`, opening GPay / PhonePe / any UPI app. |
| **Share on WhatsApp** | The "Share on WhatsApp" button opens `https://wa.me/?text=...`. A user-initiated main-frame navigation away from the trusted server origin is handed to an external app via a browsable `ACTION_VIEW`. |
| **Cookies / sessions** | `CookieManager` accepts first-party cookies; third-party cookies stay disabled. Login sessions persist. |
| **Web storage** | `domStorageEnabled` keeps the app's `localStorage` state available. |
| **Back button** | Hardware Back walks WebView history, then exits. |
| **Target-36 window support** | The native container applies system-bar and display-cutout insets on all four edges, then zeroes the handled values before dispatch to WebView to prevent duplicate CSS safe-area padding. The activity has no orientation lock and explicitly supports resizable/large-screen windows. |

The external allowlist is exactly `https:`, `upi:`, `tel:`, `sms:`, `mailto:`,
and `whatsapp:`. Same-origin HTTP(S) stays inside the WebView. An allowlisted
off-origin link launches only from a user gesture in the main frame and every
`ACTION_VIEW` intent carries `CATEGORY_BROWSABLE`. Script-initiated, subframe,
cleartext external HTTP, `intent:`, `market:`, malformed, and unknown-scheme
navigations are consumed without dispatch. Android 11+ package visibility is
declared for every allowlisted external scheme in the manifest.

## TWA alternative (Bubblewrap) — for a hosted HTTPS PWA

If/when MoneyMinder is deployed on public HTTPS, a Trusted Web Activity is the
lighter-weight, no-Chrome-chrome option:

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://your-host/manifest.webmanifest
bubblewrap build        # produces a signed APK/AAB
```

You must host `/.well-known/assetlinks.json` (Digital Asset Links) with your
app's SHA-256 signing-key fingerprint so Chrome verifies the association and
hides the URL bar. A TWA cannot run against a plain-http dev server and offers
less control over the receipt file-chooser / external-intent flow — which is why
this scaffold uses the WebView approach for development.
