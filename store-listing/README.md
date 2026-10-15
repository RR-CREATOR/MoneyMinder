# MoneyMinder store upload kit

Release matrix:

| Surface | Version | Upload artifact |
| --- | --- | --- |
| Google Play | `versionCode 1`, `versionName 1.0.0` | `android/app/build/outputs/bundle/release/app-release.aab` |
| Chrome Web Store | `1.1.0` | `outputs/chrome-web-store/moneyminder-1.1.0.zip` |
| Backend/PWA | `1.0.0` | production container |

## Files ready for the consoles

- Google Play copy: `google-play/listing.md`
- Google Play Data safety worksheet: `google-play/data-safety.md`
- Google Play Financial features worksheet: `google-play/financial-features.md`
- Google reviewer access instructions: `google-play/app-access.md`
- Chrome listing copy: `chrome-web-store/listing.md`
- Chrome Privacy-tab answers: `chrome-web-store/privacy-practices.md`
- Policy-sized icons, graphics, and screenshots beside those files

## Build commands

Chrome package:

```powershell
$env:MONEYMINDER_SERVER_URL = "https://REAL-PRODUCTION-HOST"
npm run package:chrome
$Version = (Get-Content extension/manifest.json -Raw | ConvertFrom-Json).version
node scripts/verify-release-artifact.mjs chrome `
  "outputs/chrome-web-store/moneyminder-$Version.zip"
```

Google Play App Bundle:

```powershell
Set-Location android
$env:MONEYMINDER_SERVER_URL = "https://REAL-PRODUCTION-HOST"
.\gradlew.bat bundleRelease "-PMONEYMINDER_SERVER_URL=$env:MONEYMINDER_SERVER_URL"
$env:BUNDLETOOL_JAR = "C:\protected-tools\bundletool-all.jar"
$env:MONEYMINDER_EXPECTED_BUNDLETOOL_SHA256 = "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29"
$env:MONEYMINDER_EXPECTED_SIGNER_SHA256 = "<KNOWN-UPLOAD-CERTIFICATE-SHA256>"
node ..\scripts\verify-release-artifact.mjs android `
  "app\build\outputs\bundle\release\app-release.aab"
```

Both builds reject missing, insecure, local, and placeholder origins. The
Android build additionally rejects missing or placeholder upload-keystore
configuration. Both exact-artifact checks print a SHA-256 to record with the
release commit. The AAB verifier also requires strict signature validation,
exact upload-certificate identity, the pinned bundletool 1.18.3 checksum, exact
compiled `string/server_url`, and `bundletool validate`. Never upload the CI
disposable-key AAB.

The current release is an invite-only controlled adult pilot. Public web and
store copy must disclose that registration is closed, while console reviewers
receive reusable synthetic credentials through private review fields.

## Required operator inputs

These values cannot be inferred or safely fabricated:

1. Legal publisher/operator name and address.
2. Public support/privacy email.
3. Real production HTTPS origin and hosting/storage processor names.
4. Final log, recovery-set, and closed-account retention periods.
5. Stable Android upload keystore and passwords.
6. Reusable production reviewer credentials.
7. Chrome item ID after the first draft upload; configure the backend
   `EXTENSION_ORIGIN=chrome-extension://<item-id>` before review.
8. Verified Organization Play developer account. MoneyMinder declares financial
   features, so this is a hard preflight and requires matching organization
   identity, website, phone, and D‑U‑N‑S details. Use a Personal account only if
   Play support supplies written contrary classification for this exact app.

References: [Play account types](https://support.google.com/googleplay/android-developer/answer/13634885),
[Play Console requirements](https://support.google.com/googleplay/android-developer/answer/10788890),
[account verification](https://support.google.com/googleplay/android-developer/answer/10840893),
and [new Personal-account testing](https://support.google.com/googleplay/android-developer/answer/14151465).

Canonical public URLs after deployment:

- Privacy: `https://<production-host>/privacy.html`
- Account deletion: `https://<production-host>/delete-account.html`
- Reviewer login: `https://<production-host>/login.html`

Do not submit either store item until the operator fields in the hosted privacy
notice are replaced and all three URLs return HTTP 200 without geoblocking.

## Name and domain gate

As checked on 26 July 2026, `moneyminder.app` is an active, unrelated finance
product and must not be used as this service's origin. The `MoneyMinder` name is
also crowded on Google Play. Confirm brand clearance and a controlled domain—or
choose a distinctive public name—before creating immutable store records. Also
confirm `com.moneyminder.app` in Play Console before the first upload because an
Android application ID cannot be changed after publication.
