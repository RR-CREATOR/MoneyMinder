# Google Play upload and publishing guide

This runbook takes the MoneyMinder Android source in this repository to a
reviewable Google Play release. It is specific to the current WebView wrapper,
backend, listing copy, assets, and release checks. It does not invent the
publisher identity, production hostname, credentials, or signing secrets.

## Release facts

| Item | Current value |
| --- | --- |
| Android module | `android/app` |
| Application ID | `com.moneyminder.app` |
| Namespace | `com.moneyminder.app` |
| Minimum Android version | API 24 |
| Compile/target Android version | API 36 |
| First version | `versionCode 1`, `versionName 1.0.0` |
| Release format | Signed Android App Bundle (`.aab`) |
| Release output | `android/app/build/outputs/bundle/release/app-release.aab` |
| Production client | One-activity Android WebView wrapper |
| Backend setting | `MONEYMINDER_SERVER_URL=https://<controlled-host>` |
| Default listing locale | English (India), `en-IN` |
| Suggested category | Finance |
| Sponsored offers | Source capability present; disabled by default with `PROMOTIONS_ENABLED=false` |
| Intended audience in current listing | 18 and over |

Google Play treats package names as unique and permanent. A package name cannot
be deleted and reused after it is attached to an app, so settle the brand and
package before the first upload ([Google: create and set up an
app](https://support.google.com/googleplay/android-developer/answer/9859152)).

## Stop conditions

Do not create the final Play app record or upload a release until all of these
are true:

- The public brand is cleared. `MoneyMinder` is crowded, so do not assume the
  current name is available or legally safe.
- The operator controls a production HTTPS domain. Do **not** use
  `moneyminder.app`; the project readiness review identified it as an unrelated
  active product.
- Play Console accepts `com.moneyminder.app`, or the application ID is changed
  in the codebase before the first app record is created.
- The backend and privacy/deletion pages are live at that controlled origin.
- A verified Organization publisher account and matching legal identity are
  ready, or Play support has provided a written exception for this exact app.
- A permanent upload key exists, is backed up, and is not in Git.
- A reusable, non-expiring review account is available.
- Every unresolved value in [Unresolved operator inputs](#unresolved-operator-inputs)
  is filled with a real value.

If the public package must change, do it before creating the Play record. The
current value appears in `android/app/build.gradle.kts`, the Kotlin package
declaration, and the source path under
`android/app/src/main/java/com/moneyminder/app/`. Treat that as a code change:
update it consistently and rerun the complete release gate.

## 1. Create or verify the developer account

1. Open [Google Play Console](https://play.google.com/console).
2. Use a verified **Organization** account for this release. Do not begin
   onboarding under a Personal account unless Play support has provided written
   classification for this exact publisher and app.
3. Complete identity, contact-email, phone, and payments-profile verification.
4. Turn on 2-Step Verification for the owner and every account with Console
   access.
5. Add teammates as separate users with only the permissions they need; never
   share the owner password.

Google's Play Console requirements state that publishers providing financial
products or services must register as an Organization. MoneyMinder is listed as
Finance and declares budgeting and user-directed UPI financial features, so
Organization is a hard preflight unless Play support gives written contrary
classification for this exact app. An Organization account requires a D-U-N-S
number
([account-type guidance](https://support.google.com/googleplay/android-developer/answer/13634885),
[Play Console requirements](https://support.google.com/googleplay/android-developer/answer/10788890),
[required account information](https://support.google.com/googleplay/android-developer/answer/13628312)).
Do not select Personal to bypass organization verification.

Obtain and verify the correct legal entity's
D-U-N-S record before registration. Google notes that an organization may have
multiple D-U-N-S records and that the record must match the entity being
published.

### New Personal-account testing rule

This path is non-default and applies only if Play support gives written
confirmation that this exact app may use a Personal developer account. If that
documented exception applies and the Personal account was created after
13 November 2023, production access requires a closed test with at least 12
testers continuously opted in for the last 14 days, plus any real-device
verification shown in Console. After that period, apply for production access
from the Dashboard and answer the testing/readiness questions. Internal testing
does not count toward this requirement
([official testing requirement](https://support.google.com/googleplay/android-developer/answer/14151465)).

Organization accounts do not use that specific 12-tester/14-day gate. An older
Personal account is relevant only under the same written-exception condition.
A real closed test remains the safe release path in either case.

## 2. Finalize the public identity and package

Before clicking **Create app**, record the approved values:

```text
Public app name:              <FINAL_PUBLIC_APP_NAME>
Developer/publisher name:     <LEGAL_OR_VERIFIED_PUBLISHER_NAME>
Android application ID:       <CONFIRMED_APPLICATION_ID>
Production origin:            https://<CONTROLLED_PRODUCTION_HOST>
Public support email:         <PUBLIC_SUPPORT_EMAIL>
Privacy/grievance contact:    <PRIVACY_CONTACT>
Initial countries/regions:    <COUNTRY_LIST>
```

If keeping the current source unchanged, the confirmed application ID must be
`com.moneyminder.app`. From 30 September 2026, Play packages also fall under
Android developer package-name registration requirements; inspect the
developer-verification notice in Console rather than ignoring it
([Google package-name registration](https://support.google.com/googleplay/android-developer/answer/16984799)).

## 3. Deploy the production backend first

The Android app is not a standalone copy of the website. It loads the live
MoneyMinder service in a WebView, so the exact backend used during review must
remain reachable.

Configure the production host with values described in
[`docs/PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md):

```text
NODE_ENV=production
APP_ORIGIN=https://<CONTROLLED_PRODUCTION_HOST>
SESSION_SECRET=<AT_LEAST_32_RANDOM_BYTES>
DATA_DIR=<ABSOLUTE_DURABLE_SQLITE_AND_UPLOAD_PATH>
LISTEN_HOST=127.0.0.1
TRUST_PROXY=loopback
REGISTRATION_ENABLED=false
PROMOTIONS_ENABLED=false
APP_TIME_ZONE=Asia/Kolkata
```

Production requires `TRUST_PROXY=loopback`: a same-host reverse proxy must
terminate public TLS and connect to the private Node listener over loopback.
Production rejects `0`, numeric hop counts, and every other value; never expose
the Node port directly.

Also set the documented state and upload ceilings for the
production capacity plan. Do not use an ephemeral filesystem for `DATA_DIR`.
Back up SQLite and uploads as one `DATA_DIR` recovery set, then complete a
restore rehearsal.

Before deploying, run the repository gate from the project root:

```powershell
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=low
npm run verify
```

```bash
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=low
npm run verify
```

The CI workflow currently uses a disposable Android key and
`https://github.com` only to prove compilation. Its AAB is **not** a store
artifact. The repository's CI also deliberately blocks the current Node pin
after 26 July 2026; follow `docs/PRODUCTION-READINESS.md`, repin to the patched
Node 24.x release, and rerun the full gate before a later deployment.

After deployment, confirm:

```powershell
$origin = "https://<CONTROLLED_PRODUCTION_HOST>"
Invoke-WebRequest "$origin/readyz" -UseBasicParsing
Invoke-WebRequest "$origin/login.html" -UseBasicParsing
Invoke-WebRequest "$origin/privacy.html" -UseBasicParsing
Invoke-WebRequest "$origin/delete-account.html" -UseBasicParsing
```

```bash
origin='https://<CONTROLLED_PRODUCTION_HOST>'
curl --fail --show-error --silent "$origin/readyz"
curl --fail --show-error --silent "$origin/login.html" >/dev/null
curl --fail --show-error --silent "$origin/privacy.html" >/dev/null
curl --fail --show-error --silent "$origin/delete-account.html" >/dev/null
```

Then complete these flows against the hosted service in a normal browser:

1. Sign in.
2. View the budget and shared household ledger.
3. Upload and review a receipt.
4. Create and confirm a settlement.
5. Export account data.
6. Reach the in-app account-deletion action.
7. Cancel receipt-image selection and confirm the scan form remains usable.
8. Confirm no sponsored card or promotion event appears while
   `PROMOTIONS_ENABLED=false`.

Keep the reviewed backend revision deployed while the app is in review.

## 4. Publish the privacy and deletion resources

The tracked starting points are:

- `public/privacy.html`
- `public/delete-account.html`
- `android/PRIVACY.md`

Before upload, replace the public-release gaps in `public/privacy.html` with:

- legal operator/publisher name and address;
- public privacy and grievance contact;
- hosting location and every production processor;
- log, reverse-proxy log, recovery-set, and closed-account retention periods;
- incident-response contact or mechanism;
- an accurate explanation of retained pseudonymized shared-ledger rows.

The policy must match the deployed system and the Data safety answers. Google
requires all apps to link a comprehensive privacy policy in Play Console and
make it available inside the app. The URL must be active, public, non-geofenced,
non-editable, and not a PDF
([Google User Data policy](https://support.google.com/googleplay/android-developer/answer/17105854)).

MoneyMinder supports accounts, so both deletion paths are required:

- In app: **Profile → Your data → Delete account**
- Outside app: `https://<CONTROLLED_PRODUCTION_HOST>/delete-account.html`

The web resource must let a user initiate deletion without reinstalling the
app, must clearly identify the app/developer, and must disclose any legitimately
retained data
([account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)).
Test the external route while signed out, including its support fallback.

## 5. Install the Android release toolchain

The project uses:

- JDK 17;
- Gradle 8.11.1 from the committed wrapper;
- Android Gradle Plugin 8.10.1;
- Android SDK platform 36;
- Android Build Tools 35.0.0 or newer compatible tooling.

Check Java:

```powershell
java -version
keytool -help
```

```bash
java -version
keytool -help
```

Install SDK components through Android Studio's SDK Manager, or:

```powershell
sdkmanager "platforms;android-36" "build-tools;35.0.0" "platform-tools"
```

```bash
sdkmanager "platforms;android-36" "build-tools;35.0.0" "platform-tools"
```

Open the `android/` directory in Android Studio once, or create the gitignored
`android/local.properties`:

```properties
sdk.dir=C:/Users/<operator>/AppData/Local/Android/Sdk
```

```properties
sdk.dir=/home/<operator>/Android/Sdk
```

Use forward slashes in the Windows properties path. Do not commit
`local.properties`.

The current `targetSdk = 36` already meets Google's announced Android 16/API 36
requirement beginning 31 August 2026
([target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878)).
Recheck that page at every release because the required target changes over
time.

## 6. Generate the permanent upload key

Google Play App Signing separates:

- the **upload key**, held by the publisher and used to sign the uploaded AAB;
- the **app signing key**, held by Google and used to sign APKs delivered to
  users.

Google requires the upload key to be RSA 2048 bits or stronger and recommends
keeping it distinct from the app signing key
([Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)).

Generate the upload key exactly once on a trusted offline or controlled machine.
The interactive command avoids putting passwords in shell history.

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "C:\Secure\MoneyMinder" | Out-Null
keytool -genkeypair -v `
  -keystore "C:\Secure\MoneyMinder\moneyminder-upload.jks" `
  -alias "moneyminder-upload" `
  -keyalg RSA `
  -keysize 4096 `
  -validity 10000
```

macOS/Linux:

```bash
install -d -m 700 "$HOME/.secrets/moneyminder"
keytool -genkeypair -v \
  -keystore "$HOME/.secrets/moneyminder/moneyminder-upload.jks" \
  -alias "moneyminder-upload" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
chmod 600 "$HOME/.secrets/moneyminder/moneyminder-upload.jks"
```

Use the final verified legal publisher details in the certificate prompts.
Store the keystore and passwords in separate protected systems:

1. Working copy with access limited to the release operator.
2. Encrypted offline backup in a separate physical/cloud location.
3. Password and alias in an organizational password manager.
4. Documented recovery owner and access test.

Never commit, email, attach to a ticket, or include the key in a project ZIP.
Do not reuse the disposable one-day CI key.

Export a non-secret public certificate for records:

```powershell
keytool -exportcert -rfc `
  -keystore "C:\Secure\MoneyMinder\moneyminder-upload.jks" `
  -alias "moneyminder-upload" `
  -file "C:\Secure\MoneyMinder\moneyminder-upload-certificate.pem"
```

```bash
keytool -exportcert -rfc \
  -keystore "$HOME/.secrets/moneyminder/moneyminder-upload.jks" \
  -alias "moneyminder-upload" \
  -file "$HOME/.secrets/moneyminder/moneyminder-upload-certificate.pem"
```

If the upload key is later lost or compromised, Play App Signing supports an
upload-key reset. Do not create a second key and silently start signing uploads
with it; request the reset through **Play Store protection → Manage Play app
signing** using the exported new certificate
([official reset procedure](https://support.google.com/googleplay/android-developer/answer/9842756)).

## 7. Configure release signing

From the repository root, copy the template:

```powershell
Copy-Item "android\keystore.properties.example" "android\keystore.properties"
```

```bash
cp android/keystore.properties.example android/keystore.properties
chmod 600 android/keystore.properties
```

Fill `android/keystore.properties` with real values. Use an absolute path;
Windows paths should use forward slashes:

```properties
storeFile=C:/Secure/MoneyMinder/moneyminder-upload.jks
storePassword=<REAL_KEYSTORE_PASSWORD>
keyAlias=moneyminder-upload
keyPassword=<REAL_KEY_PASSWORD>
```

```properties
storeFile=/home/<operator>/.secrets/moneyminder/moneyminder-upload.jks
storePassword=<REAL_KEYSTORE_PASSWORD>
keyAlias=moneyminder-upload
keyPassword=<REAL_KEY_PASSWORD>
```

`android/keystore.properties`, `android/*.jks`, and `android/*.keystore` are
gitignored. Confirm before building:

```powershell
git check-ignore android/keystore.properties
git status --short
```

```bash
git check-ignore android/keystore.properties
git status --short
```

The Gradle release gate rejects:

- a missing `keystore.properties`;
- missing or `CHANGE_ME` values;
- a nonexistent keystore path;
- a missing, insecure, local, reserved, IP-literal, or placeholder backend
  origin.

## 8. Build the signed release AAB

Use the exact production origin, with no path, query, credentials, or fragment.

Windows PowerShell:

```powershell
Set-Location "C:\path\to\MoneyMinder\android"
$backend = "https://<CONTROLLED_PRODUCTION_HOST>"

.\gradlew.bat --no-daemon --dependency-verification=strict `
  :app:testReleaseServerUrlValidation `
  :app:testReleaseSigningValidation `
  :app:testAndroidPlatformContracts `
  :app:validateReleaseServerUrl `
  :app:lintRelease `
  :app:bundleRelease `
  "-PMONEYMINDER_SERVER_URL=$backend"
```

macOS/Linux:

```bash
cd /path/to/MoneyMinder/android
backend='https://<CONTROLLED_PRODUCTION_HOST>'

./gradlew --no-daemon --dependency-verification=strict \
  :app:testReleaseServerUrlValidation \
  :app:testReleaseSigningValidation \
  :app:testAndroidPlatformContracts \
  :app:validateReleaseServerUrl \
  :app:lintRelease \
  :app:bundleRelease \
  "-PMONEYMINDER_SERVER_URL=$backend"
```

Successful output:

```text
android/app/build/outputs/bundle/release/app-release.aab
```

The release is minified with R8. Preserve the matching mapping file if Gradle
creates it:

```text
android/app/build/outputs/mapping/release/mapping.txt
```

Never upload an AAB compiled with the CI-only `https://github.com` origin.

## 9. Validate and archive the AAB

### Exact artifact, signer, and bundle validation

Use the pinned official `bundletool` 1.18.3 asset
`bundletool-all-1.18.3.jar`; its GitHub release-asset SHA-256 is
`a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29`.
If the version changes, obtain the new checksum from the official release
metadata, review the change, and update this runbook before execution. Obtain the
SHA-256 fingerprint of the permanent **upload certificate** from the protected
release record or Play Console; do not guess it and do not substitute the Play
app-signing certificate. From `android/`, run
([bundletool](https://developer.android.com/tools/bundletool)):

```powershell
$aab = "app\build\outputs\bundle\release\app-release.aab"
$env:BUNDLETOOL_JAR = Read-Host 'Absolute path to bundletool-all-1.18.3.jar'
$env:MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256 = "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29"
$env:MONEYMINDER_SERVER_URL = Read-Host 'Exact production HTTPS origin compiled into this AAB'
$env:MONEYMINDER_EXPECTED_SIGNER_SHA256 = Read-Host 'Expected upload-certificate SHA-256 fingerprint'
node ..\scripts\verify-release-artifact.mjs android $aab
```

```bash
aab='app/build/outputs/bundle/release/app-release.aab'
export BUNDLETOOL_JAR='/absolute/path/to/bundletool-all-1.18.3.jar'
export MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256='a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29'
read -r -p 'Exact production HTTPS origin compiled into this AAB: ' MONEYMINDER_SERVER_URL
export MONEYMINDER_SERVER_URL
read -r -p 'Expected upload-certificate SHA-256 fingerprint: ' \
  MONEYMINDER_EXPECTED_SIGNER_SHA256
export MONEYMINDER_EXPECTED_SIGNER_SHA256
node ../scripts/verify-release-artifact.mjs android "$aab"
```

The verifier computes and prints the AAB SHA-256, then executes these strict,
argument-separated checks:

```text
keytool -J-Duser.language=en -printcert -jarfile <AAB>
keytool -J-Duser.language=en -printcert -rfc -jarfile <AAB>
keytool -importcert -noprompt -alias moneyminder-artifact-signer -file <EPHEMERAL_CERT> -keystore <EPHEMERAL_PKCS12_TRUSTSTORE> -storetype PKCS12 -storepass <EPHEMERAL_RANDOM_PASSWORD>
jarsigner -J-Duser.language=en -verify -strict -verbose -certs -keystore <EPHEMERAL_PKCS12_TRUSTSTORE> -storepass <EPHEMERAL_RANDOM_PASSWORD> <AAB>
java -jar <BUNDLETOOL_JAR> validate --bundle=<AAB>
java -jar <BUNDLETOOL_JAR> dump resources --bundle=<AAB> --resource=string/server_url --values
```

Before either Java invocation, it fails unless `BUNDLETOOL_JAR` matches
`MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256`. It also fails unless `keytool` reports
exactly one signer matching `MONEYMINDER_EXPECTED_SIGNER_SHA256`. Only after
that exact signer match does the verifier import the extracted public
certificate into a fresh ephemeral PKCS12 truststore and run strict
`jarsigner` verification against it. The truststore contains the public
certificate only; it never contains the upload private key. The verifier removes
the temporary certificate and truststore even if a later check fails.

The compiled `string/server_url` value must exactly match
`MONEYMINDER_SERVER_URL`. To reverify an archived binary, also set
`MONEYMINDER_EXPECTED_AAB_SHA256` to its recorded digest; a changed byte then
fails before any platform validation. The fingerprint and digest are public
identifiers, not signing secrets. The upload keystore and its passwords never
enter the command or release record; the verifier generates and removes its
public-certificate truststore and random password internally.

Record the printed SHA-256 with the release commit, build timestamp, controlled
backend origin, and version. The script uses `bundletool validate`; it does not
create or sign a disposable APK set that could be confused with the Play
artifact.

For the safest install check, upload this same AAB to Internal testing and
install the Play-generated build from the tester link. That verifies Play's
split generation and signing path, not merely a locally assembled APK.

### Release-device acceptance

On at least one physical phone and one additional supported API/device profile:

1. Install from Play Internal testing.
2. Confirm the installed app opens the production HTTPS origin.
3. Sign in with a non-personal test account.
4. Cancel the receipt picker and confirm the scan form remains usable.
5. Select one existing JPEG receipt, review OCR, and save it.
6. Repeat with PNG; confirm non-image/unreadable selections never reach WebView.
7. Exercise household balances and recipient-confirmed settlement.
8. Trigger a UPI handoff and cancel before payment.
9. Trigger WhatsApp sharing and cancel before sending.
10. Export data and verify the deletion route is reachable.
11. If the submitted deployment enables sponsored offers, confirm the exact
    **Sponsored** label, dismiss action, non-interruption of core UI, safe
    external HTTPS handoff, and aggregate event behavior. If disabled, confirm
    the card stays absent.
12. Test Back navigation, portrait/landscape rotation, split-screen resizing,
    a large-screen profile, offline/error behavior, and relaunch.
13. On API 35/36 cutout profiles with gesture and three-button navigation,
    confirm no WebView control is obscured at the top, right, bottom, or left.
14. Tap each supported external link type (`https`, `upi`, `tel`, `sms`,
    `mailto`, and `whatsapp`) and confirm it opens through an appropriate app.
15. Confirm script-initiated and subframe external links do not launch another
    app. Also confirm cleartext external HTTP, `intent:`, `market:`, malformed,
    and unknown schemes are blocked.

Do not delete the reusable Play reviewer account during this test.

## 10. Create the Play Console app

Google's current sequence is documented in
[Create and set up your app](https://support.google.com/googleplay/android-developer/answer/9859152).

1. In Play Console, select **Home → Create app**.
2. Default language: **English (India) – en-IN**.
3. App name: use `<FINAL_PUBLIC_APP_NAME>`; use `MoneyMinder` only after
   clearance.
4. Select **App**, not Game.
5. Choose Free/Paid according to the approved business model. The current
   release kit assumes a free app with no in-app billing.
6. Enter `<PUBLIC_SUPPORT_EMAIL>`.
7. Accept the required declarations and Play App Signing terms.
8. Select **Create app**.
9. On **Dashboard**, complete every setup task before attempting production.

The first AAB upload binds the Play app to its package. Verify that Console
shows the approved application ID before continuing.

## 11. Configure Play App Signing

For a new app, keep the default Play App Signing enrollment and let Google
generate/manage the app signing key. The local permanent key remains the upload
key. Google currently enrolls new apps in its generated signing-key flow when
the first bundle is uploaded
([Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)).

After enrollment:

1. Open **Protected with Play → Play Store protection → Manage Play app
   signing**.
2. Record the upload certificate and Google-managed app-signing certificate
   fingerprints.
3. If a future Google/Facebook/OAuth/Maps/App Links integration validates
   certificate fingerprints, register the **app signing** fingerprint delivered
   by Play, not only the local upload fingerprint.
4. Restrict Console permissions for key-management actions.

## 12. Complete the store presence

Open **Grow users → Store presence → Main store listing** and copy from
[`store-listing/google-play/listing.md`](../../store-listing/google-play/listing.md).
Google's current limits are 30 characters for app name, 80 for short
description, and 4,000 for full description
([listing requirements](https://support.google.com/googleplay/android-developer/answer/9859152)).

Use:

- Final app name: `<FINAL_PUBLIC_APP_NAME>`
- Short description: `Track receipts, budgets and shared bills with roommates.`
- Full description: the reviewed text in `store-listing/google-play/listing.md`
- Category: **Finance**
- Support email: `<PUBLIC_SUPPORT_EMAIL>`
- Website: `https://<CONTROLLED_PRODUCTION_HOST>/`
- Privacy policy: `https://<CONTROLLED_PRODUCTION_HOST>/privacy.html`

Upload the tracked assets:

| Console asset | Repository file |
| --- | --- |
| 512 × 512 app icon | `store-listing/google-play/icon-512.png` |
| 1024 × 500 feature graphic | `store-listing/google-play/feature-graphic-1024x500.jpg` |
| Phone screenshot 1 | `store-listing/google-play/screenshots/phone-dashboard-1080x1920.jpg` |
| Phone screenshot 2 | `store-listing/google-play/screenshots/phone-scan-1080x1920.jpg` |

Google requires a 512 × 512, maximum 1,024 KB PNG icon and a 1024 × 500 JPEG
or non-alpha PNG feature graphic. Screenshots and metadata must accurately
represent the shipped experience
([preview-asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151)).

Check every screenshot after upload for cropping, legibility, and consistency
with the final public name. Do not add rankings, prices, awards, testimonials,
or functionality that is not in the reviewed build.

Under **Store settings**:

- App category: Finance
- Contact email: `<PUBLIC_SUPPORT_EMAIL>`
- Contact website: `https://<CONTROLLED_PRODUCTION_HOST>/`
- Contact phone: `<PUBLIC_SUPPORT_PHONE>` if required/approved
- Countries/regions: `<APPROVED_COUNTRY_LIST>`

An India-only first scope is operationally simpler for a UPI-centered pilot,
but it is a publisher decision, not a value to fabricate in this guide.

## 13. Complete every App content declaration

Open **Policy and programs → App content**. Do not send for review while any
item is incomplete or inconsistent with the deployed build.

### Privacy policy

Enter:

```text
https://<CONTROLLED_PRODUCTION_HOST>/privacy.html
```

Open it in a signed-out/incognito browser and from a different network.

### App access

MoneyMinder requires authentication and production registration is closed.
Select that some or all functionality is restricted and enter the values from
[`store-listing/google-play/app-access.md`](../../store-listing/google-play/app-access.md):

```text
Instruction name: MoneyMinder review account
Username:         <REVIEW_USERNAME>
Password:         <REVIEW_PASSWORD>
Additional auth:  None
```

The account must:

- remain active for the entire review;
- work from Google's reviewer locations without OTP, expiring links, VPN,
  geoblocking, or IP allowlists;
- contain representative receipts, a household, recurring bill, and balance;
- be isolated from real user or employee data;
- let reviewers reach Profile, privacy, export, and deletion controls.

Tell reviewers not to complete deletion because the account is reusable.
Google requires accurate access instructions and permits multiple instruction
sets when an app has different login paths
([prepare for review](https://support.google.com/googleplay/android-developer/answer/9859455)).

### Ads

The source contains a server-controlled sponsored dashboard card but keeps it
disabled by default. It uses no third-party advertising SDK or advertising
network. Choose the Console answer from the exact reviewed deployment:

- With `PROMOTIONS_ENABLED=false`, verify that no offer is served and select
  **No, my app does not contain ads**. Disclose the disabled capability in
  reviewer notes because it can be activated server-side.
- If sponsored offers will be enabled before or during this release, first
  complete every promotion gate in
  [`docs/PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md), update the hosted
  privacy notice, listing, Data safety form, content rating, and reviewer notes,
  then select **Yes** and confirm Play displays **Contains ads**.

Never switch the server flag from false to true after approval while Console
still says No. Update the declarations and complete the applicable Play review
first. Ads and associated offers are app content, including server-provided
content
([Ads policy](https://support.google.com/googleplay/android-developer/answer/9857753),
[prepare for review](https://support.google.com/googleplay/android-developer/answer/9859455),
[behavior transparency](https://support.google.com/googleplay/android-developer/answer/13323374)).

Before activation, verify the merchant's legal identity and control of the
destination and manually review the exact public HTTPS URL, redirects, offer
copy, schedule, and age/content suitability. The application has no
user-supplied campaign write or campaign-admin HTTP API. Use a controlled,
reviewed database change. Aggregate impression/click telemetry is approximate,
non-billing data; merchant-confirmed redemption/conversion is required for any
commercial outcome claim. Opportunistic event-key cleanup and the undefined
daily-aggregate retention period are enablement blockers, not acceptable
submission placeholders.

### Data safety

Use
[`store-listing/google-play/data-safety.md`](../../store-listing/google-play/data-safety.md)
as the code-based worksheet, then reconcile it against the real hosting,
SQLite storage, proxy logs, backups, support process, and processor contracts.

Current high-level answer:

- Data collected: **Yes**
- Data shared: expected **No** under service-provider and user-action
  treatment, but confirm the real processor contracts and Play definitions.
- Encryption in transit: **Yes**, only after the final HTTPS deployment has
  been verified.
- Account deletion available: **Yes**
- External deletion URL:
  `https://<CONTROLLED_PRODUCTION_HOST>/delete-account.html`

Declare every applicable type in the worksheet: account identifiers and contact
details, optional UPI/payment information, receipt and other financial records,
receipt photos, household/user-generated text, interactions/diagnostics, and
ephemeral IP processing for security/rate limiting. Accurately mark required
versus optional, purposes, retention, and deletion. If aggregate pilot
reporting continues, include Analytics as a purpose for the data used to
produce it.

If sponsored offers are enabled, also declare the impression/click events as
App interactions used for Advertising or marketing and Analytics. The
implementation stores no user/IP with those promotion records, but the
idempotency-hash and daily-aggregate lifecycle must still be finite, enforced,
and disclosed before activation.

The Data safety form is required on closed, open, and production tracks; an
internal-test-only app is the limited exception
([Data safety requirements](https://support.google.com/googleplay/android-developer/answer/10787469)).

### Account deletion

Answer that the app supports account deletion and enter:

```text
https://<CONTROLLED_PRODUCTION_HOST>/delete-account.html
```

Disclose that credentials, active sessions, extension tokens, personal
receipts, and uploaded images are deleted. Disclose that shared expenses,
recurring bills, and settlements remain under a non-login deleted-member
identifier so other members' ledgers remain correct, and state final backup/log
expiry periods.

### Financial features

Use
[`store-listing/google-play/financial-features.md`](../../store-listing/google-play/financial-features.md).
Do **not** select “My app doesn't provide any financial features.”

The current implementation:

- budgets and records expenses;
- calculates shared balances;
- creates a user-directed UPI payment intent;
- does not hold funds, request a UPI PIN, issue credit, lend, invest, exchange
  cryptocurrency, or execute the transfer.

The worksheet currently recommends **Money transfer and wire services** plus
**Other**. Reconcile those choices with the final countries and the exact
wording Console presents. If Play Console or qualified regional counsel
classifies the UPI handoff as **Mobile payments and digital wallets**, add that
selection. Google requires every published app, including apps on closed/open
testing tracks, to complete the declaration
([Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271)).

### Content rating

Start the IARC questionnaire and answer from the final build, not from an
assumed rating. For the current code:

- app type is a finance/productivity utility;
- sponsored offers are disabled by default; answer the advertising questions
  from the exact deployed flag and reviewed merchant content;
- there is no gambling, simulated gambling, lending, sexual content, violence,
  controlled-substance content, or public social feed;
- household names/descriptions and shared expenses are visible only within the
  user's household;
- UPI payments are handed to an external installed payment app.

Submit the generated ratings and save the IARC certificate. If features later
change an answer, retake the questionnaire. Google requires every app to have
an accurate content rating
([content-rating requirements](https://support.google.com/googleplay/android-developer/answer/9859655)).

### Target audience and content

Select only adult age groups consistent with the approved product scope; the
prepared listing says **18 and over** and the pilot privacy text restricts the
pilot to adults. Do not include children merely to broaden reach. Selecting
child age groups invokes Families requirements
([target-audience guidance](https://support.google.com/googleplay/android-developer/answer/9859655)).

Complete Ads, App access, and Privacy policy first because Play uses them when
evaluating the target-audience section.

### Permissions

The current manifest requests:

- `INTERNET`
- `ACCESS_NETWORK_STATE`

Neither permission is dangerous or runtime-gated. The Android wrapper selects
one existing JPEG or PNG receipt through the system content picker. It requests
neither `CAMERA` nor broad `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` access and
does not promise live camera capture. Picker output is accepted only when it is
one readable `content:` URI with an allowed MIME type. The manifest's
`<queries>` entries support the allowlisted `https`, `upi`, `tel`, `sms`,
`mailto`, and `whatsapp` handoffs; they are not runtime data-access permissions.
Handoffs require a user gesture in the main frame and use browsable
`ACTION_VIEW` intents. Script/subframe navigation and unlisted schemes are
blocked.

If Console presents a Permissions Declaration after the AAB is uploaded,
complete it accurately before publishing. Google surfaces required declaration
forms based on permissions detected in the uploaded artifact
([permission declarations](https://support.google.com/googleplay/android-developer/answer/9214102)).

### Other declarations

Complete every additional card Console presents, including:

- News app: No
- Government app: No
- Health apps: no health features in the current build
- COVID-19 contact/status: No, if presented
- Data deletion: as documented above

Re-evaluate instead of copying these answers if the product scope changes.

## 14. Upload to Internal testing

Google uses App Bundles to generate optimized APKs for each device
([App Bundle workflow](https://support.google.com/googleplay/android-developer/answer/9859152)).

1. Open **Test and release → Testing → Internal testing**.
2. Create a tester email list with trusted project members.
3. Select **Create new release**.
4. Keep Play App Signing enabled.
5. Upload `android/app/build/outputs/bundle/release/app-release.aab`.
6. Confirm Console reports:
   - package `com.moneyminder.app` or the approved replacement;
   - `versionCode 1`;
   - target API 36;
   - no unexpected permission or policy errors.
7. Add the release notes from
   `store-listing/google-play/listing.md`.
8. Save, review, resolve every error, and roll out to Internal testing.
9. Install from the Play tester link and execute the release-device acceptance
   list in [Validate and archive the AAB](#9-validate-and-archive-the-aab).
10. Review Android vitals and the generated pre-launch report.

## 15. Use the pre-launch report

Play normally generates a pre-launch report after an AAB upload, subject to
device-lab capacity. It checks stability, Android compatibility, performance,
and accessibility
([pre-launch reports](https://support.google.com/googleplay/android-developer/answer/9842757)).

Open **Test and release → Testing → Pre-launch report → Overview** and inspect:

- Stability: crashes, ANRs, startup failures
- Performance: slow rendering/startup and resource problems
- Accessibility: labels, contrast, touch targets, traversal
- Screenshots: login/server/TLS failures and unexpected external navigation

Because MoneyMinder is login-gated, configure the dedicated reviewer/test
credentials in the available test settings. Never provide real production-user
credentials. Do not advance while there is an unexplained crash, ANR, blocked
login, blank WebView, certificate error, or inaccessible critical action.

The report is evidence, not complete coverage. Physical testing must still
cover picker cancellation/selection, guarded external-link handoff, account
deletion, portrait/landscape and split-screen resizing, four-edge safe areas,
and production-network behavior.

## 16. Run Closed testing

1. Open **Testing → Closed testing**.
2. Create a track such as `closed-production-candidate`.
3. Add testers through an email list or Google Group.
4. Promote the proven Internal release or create a release using the same AAB
   from the artifact library.
5. Publish the opt-in link and give testers a focused checklist.
6. Collect device model, Android version, steps, expected/actual result, and
   screenshots for every defect.
7. Keep the production backend, reviewer account, privacy page, and deletion
   page available throughout.
8. Fix defects in source, increment `versionCode`, rebuild, and upload a new AAB.
9. Keep at least one complete picker-to-receipt and household-settlement journey
   green on the final candidate.

Only under a written Play-support exception allowing this finance app to use a
qualifying new Personal account, maintain at least 12 continuously opted-in
testers for 14 consecutive days and then apply for production access. Do not
ask testers to opt out during the window
([official testing requirement](https://support.google.com/googleplay/android-developer/answer/14151465)).

## 17. Submit the first production release

Before submission:

- All Dashboard and App content items show complete.
- The listing and hosted policy use the final cleared name.
- The exact uploaded AAB passed Internal and Closed testing.
- The production backend and reviewer account are healthy.
- Data safety matches deployed logging, backups, processors, and retention.
- Pre-launch findings are fixed or explicitly accepted by the release owner.
- The AAB checksum, upload certificate, release commit, and operator approval
  are recorded.

Optional but recommended: turn on **Managed publishing** from **Publishing
overview** so approval and go-live are separate actions. With managed
publishing, submit the changes for review, wait until they appear under
**Changes ready to publish**, and publish at the controlled launch time
([managed publishing](https://support.google.com/googleplay/android-developer/answer/9859654)).

Create the release:

1. Open **Test and release → Production**.
2. Select the approved countries/regions.
3. Select **Create new release**.
4. Add the already-tested AAB from the library, or upload the exact archived
   AAB.
5. Enter the reviewed release notes.
6. Select **Next**.
7. Resolve every item in **Errors summary**; investigate warnings rather than
   clicking through blindly.
8. Confirm listing, App content, countries, version, package, and permissions.
9. Select **Start rollout to production**, or **Send for review** when managed
   publishing is enabled.

Google does not offer a rollout-percentage control for the first production
release; the first rollout publishes to users in the selected countries after
approval. Use Closed testing and narrow country availability to control first
release risk. Percentage-based staged rollout is for updates
([prepare and roll out a release](https://support.google.com/googleplay/android-developer/answer/9859348),
[staged rollouts](https://support.google.com/googleplay/android-developer/answer/6346149)).

## 18. Monitor launch

For at least the first 24–72 hours, assign an owner to watch:

- Play review and Policy status;
- Android vitals: crashes, ANRs, excessive startup/render failures;
- backend `/readyz`, latency, 5xx rate, capacity, disk, database connections;
- authentication failures and CSRF/origin errors;
- receipt OCR failures and durable-volume ceilings;
- support inbox, reviews, tester reports, and deletion requests;
- backup completion and restore alerts.

Never log or paste passwords, session cookies, bearer tokens, UPI IDs, receipt
images, or personal financial records into an incident ticket.

## 19. Publish updates safely

For every new Android upload:

1. Keep the same approved application ID and upload key.
2. Increment `versionCode` in `android/app/build.gradle.kts`. Play requires a
   greater code on every update.
3. Update `versionName` for the human-readable release.
4. Update store/declaration answers if functionality, data handling,
   permissions, audience, ads, or financial features changed.
5. Run the complete root and Android release gates.
6. Build against the production origin.
7. Validate, hash, archive, Internal-test, Closed-test, and inspect pre-launch.
8. Upload the R8 `mapping.txt` with the release when available.
9. Use a staged production rollout for updates, for example
   `10% → 25% → 50% → 100%`, advancing only after the release owner reviews
   vitals and backend health at each stage.

The percentages and observation windows are an operator risk decision, not a
Google requirement. Play does not increase the percentage automatically.
Updates must retain the package name, use a higher version code, and use the
correct signing identity
([update requirements](https://support.google.com/googleplay/android-developer/answer/9859350)).

## 20. Rollback and incident checklist

### Backend incident

1. Halt deployments.
2. Preserve evidence without copying personal data into tickets.
3. Roll the backend back to the last compatible image/configuration.
4. Verify SQLite migrations are backward-compatible before rollback.
5. Check `/readyz`, login, receipt access, and the Android WebView journey.
6. Communicate through the public support/incident channel.

The WebView loads the live service, so a safe server rollback can restore app
function without waiting for a store update. Never change response contracts
in a way that strands an already-installed client.

### Bad staged app update

1. Open the track's **Releases** tab.
2. Select **Manage rollout → Halt rollout**.
3. Diagnose from vitals, pre-launch evidence, and backend logs.
4. Build a fixed AAB with a greater `versionCode`.
5. Test and start a new controlled rollout.

Halting prevents additional users from receiving the update but does not
downgrade users who already installed it
([staged-rollout behavior](https://support.google.com/googleplay/android-developer/answer/6346149)).

### Bad fully rolled-out update

Play can halt an eligible fully rolled-out release and serve a prior eligible
release to users who do not already have the halted version. It cannot halt the
first release on a track because there is no previous release
([fully rolled-out release halt](https://support.google.com/googleplay/android-developer/answer/16285429)).
Users already on the bad version still need a fixed, higher-version update.

### Bad first production release

There is no prior production release to restore. Stabilize or roll back the
backend if that safely resolves the incident; otherwise build, test, and submit
a corrected AAB with a higher `versionCode`. Restrict new distribution through
the available Console controls while following Play policy and support
guidance.

## 21. Rejection troubleshooting

1. Read the complete rejection email and **Policy and programs → Policy
   status** entry.
2. Record the submission ID, affected artifact/version, cited policy, and exact
   reviewer evidence.
3. Reproduce the reviewer path using the listed credentials and a clean device
   outside the operator network.
4. Fix the underlying source, deployment, listing, or declaration. Do not hide
   a feature or falsify a form to bypass review.
5. Update all affected tracks; a rejected/non-compliant bundle on another track
   can keep the app blocked.
6. Increment `versionCode` when uploading a replacement AAB.
7. Update reviewer instructions and the policy/declaration if behavior changed.
8. Rerun tests and send the changes for review from **Publishing overview**.
9. Appeal only when the rejection is factually wrong, with concise evidence
   tied to the cited requirement.

Common MoneyMinder-specific failure checks:

| Symptom | Check |
| --- | --- |
| Reviewer cannot sign in | Review account active, correct password, no OTP/IP/geoblock, backend healthy |
| Blank/failed WebView | AAB contains the real HTTPS origin; TLS chain and DNS valid |
| Privacy rejection | Final legal identity/contact/processors/retention present; URL public and in-app |
| Data safety mismatch | Receipt photos, finance data, logs, IP processing, backups, and processors declared |
| Deletion rejection | In-app action and signed-out web request path both work; retention is disclosed |
| Financial declaration rejection | UPI handoff and budgeting categories declared accurately |
| Permission concern | No dangerous runtime permission; picker returns one validated JPEG/PNG content URI; no CAMERA or broad media permission |
| Unsafe external navigation | Only user-initiated main-frame links on the six-scheme allowlist launch browsable external intents |
| Large-screen/orientation failure | No portrait lock; activity is explicitly resizable and all four system/cutout inset edges are handled |
| Metadata rejection | Name cleared; screenshots match app; no unsupported claims or promotional/ranking text |
| Access/minimum functionality concern | Seeded reviewer data; receipt picker, UPI/WhatsApp handoff, export, deletion, and household flows work |
| Version/signing failure | Higher `versionCode`, same package, correct permanent upload key |
| Target API failure | `targetSdk` still meets the current policy |

A WebView that only republishes a website can face minimum-functionality
scrutiny. This wrapper currently adds validated receipt-picker handling,
trusted-origin navigation, external UPI/WhatsApp handoff, cookie-backed
sessions, and Android Back integration. Ensure those real user flows work in
the submitted build; their existence does not guarantee approval.

## Unresolved operator inputs

Every item below is a hard external input. None should be guessed by an agent:

- `<FINAL_PUBLIC_APP_NAME>` and evidence of brand/trademark clearance
- `<LEGAL_OR_VERIFIED_PUBLISHER_NAME>`
- `<LEGAL_PUBLISHER_ADDRESS>`
- Verified Organization Play developer account, matching D-U-N-S record, and
  legal entity details; or written Play-support evidence allowing an exception
- `<CONFIRMED_APPLICATION_ID>` and Play Console availability
- `<CONTROLLED_PRODUCTION_HOST>`; explicitly not `moneyminder.app`
- Durable production `DATA_DIR`, TLS/proxy configuration, and secret values
- Hosting/storage processor names and hosting/data locations
- Final application, reverse-proxy, security-log, recovery-point, and
  closed-account retention periods
- Decision to keep `PROMOTIONS_ENABLED=false` or approve an enabled
  sponsored-offer deployment; an enabled release additionally needs verified
  merchant identity/control, reviewed public HTTPS destination/content,
  guaranteed event-key cleanup, finite daily-aggregate retention, and
  reconciled Play/privacy declarations
- `<PUBLIC_SUPPORT_EMAIL>`
- `<PUBLIC_SUPPORT_PHONE>` if used or required
- `<PRIVACY_CONTACT>` and grievance/incident-response channel
- `<REVIEW_USERNAME>` and `<REVIEW_PASSWORD>` for an isolated seeded account
- Permanent upload keystore, alias, passwords, backups, and recovery owner
- Approved launch countries/regions
- Confirmation that Data safety “shared” treatment matches actual processor
  contracts
- Confirmation of the Financial features selections for the launch countries
- Production monitoring owner, rollback owner, and completed database plus
  receipt-volume restore rehearsal
- Required 12-tester/14-day evidence only if a written Play-support exception
  allows a qualifying new Personal account
- Patched Node 24.x pin and a green exact-release CI run for releases after the
  repository's 26 July 2026 security cutoff

## Final upload checklist

- [ ] Public name and package are cleared and final.
- [ ] Verified Organization account and matching D-U-N-S details are active, or
  a written Play-support exception is retained.
- [ ] Production HTTPS backend is healthy and restore-tested.
- [ ] Privacy and deletion URLs are public, final, and accurate.
- [ ] Permanent upload key is backed up and `keystore.properties` is untracked.
- [ ] Root verification, audit, Android validation, lint, and bundle tasks pass.
- [ ] AAB is signed, bundletool-valid, hashed, and archived with the release.
- [ ] Exact AAB passes Play Internal and Closed testing on real devices.
- [ ] Reviewer account and access instructions work outside the operator network.
- [ ] Listing copy and all four tracked asset groups are uploaded.
- [ ] Data safety, deletion, financial, ads, audience, rating, and permission
  declarations match the deployed build.
- [ ] `PROMOTIONS_ENABLED`, the Play Ads answer, listing, privacy notice, Data
  safety, content rating, reviewer notes, and tested dashboard behavior all
  describe the same deployment.
- [ ] Pre-launch report has no unexplained critical findings.
- [ ] Under a written Personal-account exception, 12 testers remain opted in for
  14 continuous days and production access is approved.
- [ ] Countries, release notes, monitoring owner, and rollback owner are approved.
- [ ] Final Publishing overview contains no unintended changes.
- [ ] Release is sent for review; go-live is controlled with managed publishing
  when appropriate.
