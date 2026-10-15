# Publishing MoneyMinder to Google Play

This is the end-to-end runbook to take the `android/` WebView wrapper from source
to a live Play Store listing. Follow it top to bottom.

## 0. Prerequisites only you can do

1. **Host the backend on public HTTPS.** This app is a WebView client of the
   MoneyMinder Express server. A published app **cannot** point at `localhost`
   or `10.0.2.2` — those only exist on your dev machine. Deploy `../server`
   somewhere public with TLS (Render, Railway, Fly.io, a VPS behind Caddy/Nginx,
   etc.) and confirm `https://<your-host>` serves the app.
   - Choose the real HTTPS backend URL for `MONEYMINDER_SERVER_URL`. Supply it
     as a Gradle property (`-PMONEYMINDER_SERVER_URL=https://...`) or an
     environment variable when building; do not edit
     [app/build.gradle.kts](app/build.gradle.kts) per deployment.
   - Set `SESSION_SECRET` and run the server over HTTPS in production (see the
     repo root `.env.example`). Cookies are already `secure` in production.

2. **Create and safeguard an upload keystore.** This is your app's permanent
   identity. See step 2 below. Losing it (without Play App Signing key reset)
   means you can never update the app.

3. **Verify the publisher as an Organization.** MoneyMinder declares financial
   features, so treat a verified Organization developer account, matching legal
   details, and a D-U-N-S number as a hard preflight. Do not create the app under
   a Personal account unless Play support provides written classification for
   this exact publisher and app
   ([Play Console requirements](https://support.google.com/googleplay/android-developer/answer/10788890)).

## 1. Install the build tools

- **JDK 17+** (JDK 21 works). `java -version`.
- **Android SDK** — easiest via Android Studio, or command-line tools + then:
  ```
  sdkmanager "platforms;android-36" "build-tools;35.0.0" "platform-tools"
  ```
- Tell Gradle where the SDK is — create `android/local.properties` (gitignored):
  ```
  sdk.dir=/absolute/path/to/Android/Sdk
  ```
  (Android Studio writes this for you on first open.)

The Gradle wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`)
is committed, so no separate Gradle install is needed.

## 2. Create the upload keystore

From `android/`:
```
keytool -genkeypair -v \
  -keystore moneyminder-release.jks \
  -alias moneyminder \
  -keyalg RSA -keysize 2048 -validity 10000
```
Then copy `keystore.properties.example` → `keystore.properties` and fill in the
store path, passwords, and alias. Both `*.jks` and `keystore.properties` are
gitignored — keep them out of version control and backed up privately.

## 3. Build the release App Bundle

Play requires an **`.aab`** (App Bundle), not an APK:
```
cd android
./gradlew bundleRelease \
  -PMONEYMINDER_SERVER_URL=https://money.your-real-domain.com
```
Windows PowerShell:
```powershell
.\gradlew.bat bundleRelease `
  -PMONEYMINDER_SERVER_URL=https://money.your-real-domain.com
```
Replace the example hostname with the deployed backend; the validator
intentionally rejects `your-real-domain` placeholders.

The Gradle property takes precedence if the same-named environment variable is
also set. Before a full Android build, you can validate the URL without compiling:
```
./gradlew :app:validateReleaseServerUrl \
  -PMONEYMINDER_SERVER_URL=https://money.your-real-domain.com
./gradlew :app:testAndroidPlatformContracts
```
Release validation rejects missing, relative, non-HTTPS, credential-bearing,
invalid-port, placeholder, local/private, reserved, and ambiguous numeric URLs.
The platform contract fails if CAMERA/media permissions or generic unvalidated
WebView chooser handling return; if external navigation loses its
main-frame/user-gesture, scheme-allowlist, or browsable-intent guards; or if
target-36 four-edge inset, orientation, and resizable-window handling regress.

Output: `app/build/outputs/bundle/release/app-release.aab` (signed with your
upload key). Before upload, require the expected SHA-256 fingerprint of that
permanent upload certificate and validate the exact AAB:

```powershell
$aab = "app\build\outputs\bundle\release\app-release.aab"
$env:BUNDLETOOL_JAR = Read-Host 'Absolute path to bundletool-all-1.18.3.jar'
$env:MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256 = "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29"
$env:MONEYMINDER_SERVER_URL = Read-Host 'Exact production HTTPS origin compiled into this AAB'
$env:MONEYMINDER_EXPECTED_SIGNER_SHA256 = Read-Host 'Expected upload-certificate SHA-256 fingerprint'
node ..\scripts\verify-release-artifact.mjs android $aab
```

The verifier computes the artifact digest and runs:

```text
keytool -J-Duser.language=en -printcert -jarfile <AAB>
keytool -J-Duser.language=en -printcert -rfc -jarfile <AAB>
keytool -importcert -noprompt -alias moneyminder-artifact-signer -file <EPHEMERAL_CERT> -keystore <EPHEMERAL_PKCS12_TRUSTSTORE> -storetype PKCS12 -storepass <EPHEMERAL_RANDOM_PASSWORD>
jarsigner -J-Duser.language=en -verify -strict -verbose -certs -keystore <EPHEMERAL_PKCS12_TRUSTSTORE> -storepass <EPHEMERAL_RANDOM_PASSWORD> <AAB>
java -jar <BUNDLETOOL_JAR> validate --bundle=<AAB>
java -jar <BUNDLETOOL_JAR> dump resources --bundle=<AAB> --resource=string/server_url --values
```

The pinned `bundletool` 1.18.3 SHA-256 above is
`a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29`;
the verifier checks it before executing the JAR. It fails unless exactly one
signer matches `MONEYMINDER_EXPECTED_SIGNER_SHA256`. Only after that exact
signer match does the verifier import the extracted public certificate into a
fresh ephemeral PKCS12 truststore and run strict `jarsigner` verification
against it. The truststore contains the public certificate only; it never
contains the upload private key. The verifier removes the temporary certificate
and truststore even when a later check fails.

The compiled `string/server_url` must exactly match
`MONEYMINDER_SERVER_URL`. Set
`MONEYMINDER_EXPECTED_AAB_SHA256` as well when reverifying an archived release.
Never embed a keystore path, password, private key, or guessed fingerprint in
source. The CI AAB uses a disposable key and placeholder backend only to prove
compilation; it is never publishable.

To test the exact release binary on a device, run `assembleRelease` with the same
property or environment variable; it makes a signed APK at
`app/build/outputs/apk/release/app-release.apk`.

## 4. Play Console setup

1. Create the app in the [Play Console](https://play.google.com/console)
   (one-time $25 developer registration).
2. **App signing:** keep **Play App Signing** enabled (default). You upload with
   your upload key; Google manages the final signing key.
3. **Privacy policy:** deploy `../public/privacy.html` and
   `../public/delete-account.html` at the final HTTPS origin. Replace every
   operator/retention placeholder first, then enter both public URLs in Play
   Console.
4. **Data safety:** complete the full, required/optional data-type matrix in
   `../store-listing/google-play/data-safety.md`. Reconcile it against the
   deployed log, backup, hosting, and database configuration before submitting;
   do not copy a smaller generic finance-app declaration.
5. **Financial features:** complete
   `../store-listing/google-play/financial-features.md`; do not certify that the
   app has no financial features.
6. **Permissions:** the wrapper requests no dangerous runtime permission. It
   selects one existing JPEG or PNG receipt through Android's system content
   picker and requests neither CAMERA nor broad media-library access. Do not
   submit a camera-permission declaration or claim that this build offers live
   camera capture.
7. **Device compatibility:** test portrait, landscape, split-screen, and a
   large-screen profile. Confirm all four safe-area edges remain usable.
8. **External navigation:** confirm user-tapped `https`, `upi`, `tel`, `sms`,
   `mailto`, and `whatsapp` links open externally, while scripted/subframe,
   cleartext external HTTP, `intent:`, `market:`, malformed, and unknown
   schemes do not launch another app.
9. **Content rating:** complete the questionnaire (finance app, no objectionable
   content → typically Everyone / PEGI 3).
10. **Target audience:** not directed at children.

## 5. Store listing assets

The upload-ready text and asset inventory live in
`../store-listing/google-play/`. Use those tracked files rather than local
`.shots/` captures. The listing copy accurately describes receipt OCR as
server-side processing with bundled Tesseract data.

## 6. Submit

Upload the `.aab` to a **Closed testing** track first, validate on real devices,
then promote to **Production**. New apps go through Play review (often a few
days), which may include device testing — having the backend reachable over HTTPS
is required for reviewers to use the app.

Only under that documented Play-support exception, a Personal account created
after 13 November 2023 also requires at least 12 testers continuously opted in
to a closed test for 14 days.

## Versioning for updates

Bump both in [app/build.gradle.kts](app/build.gradle.kts) for every upload:
- `versionCode` — integer, must increase each upload (1 → 2 → 3 …).
- `versionName` — human string ("1.0.0" → "1.0.1").

---

### Note on Play's "minimum functionality" policy
A WebView that merely wraps a website can be rejected as low-value. MoneyMinder
adds real native integration — validated receipt-image selection, UPI payment intents,
WhatsApp share handoff, and offline PWA caching — which strengthens the review
case but does not guarantee acceptance. Validate the signed bundle on Play's
pre-launch report before production rollout. If you'd rather ship a Trusted Web
Activity (TWA) once the PWA is on HTTPS, see the TWA section in
[README.md](README.md).
