#!/usr/bin/env bash
# Build a signed and NOTARIZED macOS release of Decision Notepad.
#
# Three phases:
#   1. cargo tauri build     - compiles, bundles, code-signs with a
#                              Developer ID Application certificate.
#                              The script uses APPLE_SIGNING_IDENTITY when
#                              set, otherwise it auto-detects the first
#                              Developer ID Application identity in Keychain.
#   2. xcrun notarytool      - submits the .dmg to Apple's notary service,
#                              waits for the cryptographic scan to finish,
#                              and gets back an approval ticket.
#                              Uses the "decision-notepad-notary" keychain
#                              profile so credentials aren't on the command
#                              line or in env vars.
#   3. xcrun stapler         - staples the approval ticket onto both the
#                              .dmg and the .app so they're trusted offline
#                              without phoning home to Apple every launch.
#
# Why we notarize separately from `cargo tauri build`:
# Tauri 2's bundler only triggers built-in notarization when APPLE_ID +
# APPLE_PASSWORD + APPLE_TEAM_ID env vars are set. It doesn't recognize
# the safer APPLE_KEYCHAIN_PROFILE convention. Running notarytool ourselves
# after the build lets us use keychain-stored credentials and skip having
# the app-specific password sit in a shell env or .env file.
#
# Prerequisites (one-time setup):
#   1. Apple Developer Program membership ($99/yr).
#   2. "Developer ID Application: ..." certificate installed in Keychain.
#      Verify with `security find-identity -v -p codesigning` — must show
#      "1 valid identities found" or more.
#   3. Apple Intermediate certificates installed from
#      https://www.apple.com/certificateauthority/ (needed for the trust
#      chain — without these the cert reads as "not trusted").
#   4. App-specific password generated at appleid.apple.com →
#      Sign-In and Security → App-Specific Passwords.
#   5. Credentials stored in keychain via:
#        xcrun notarytool store-credentials "decision-notepad-notary" \
#          --apple-id "<your-apple-id-email>" \
#          --team-id "<your-team-id>" \
#          --password "<app-specific-password>"

set -euo pipefail

NOTARY_PROFILE="decision-notepad-notary"

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

cd src-tauri

echo "==> Phase 1/3: cargo tauri build"
echo "    Compiles Rust in release mode, bundles, signs the .app and .dmg."
echo "    Expect ~5–10 minutes."
echo

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY="$(
    security find-identity -v -p codesigning |
      awk -F'"' '/Developer ID Application/ { print $2; exit }'
  )"
  export APPLE_SIGNING_IDENTITY
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "ERROR: no Developer ID Application signing identity found." >&2
  echo "Install the certificate in Keychain or set APPLE_SIGNING_IDENTITY." >&2
  exit 1
fi

cargo tauri build "$@"

cd "$REPO_ROOT"

# Find the freshly-built .dmg and .app. Globbing avoids hardcoding the
# version number — Tauri names it from tauri.conf.json's `version` field.
shopt -s nullglob
DMG_PATHS=(src-tauri/target/release/bundle/dmg/*.dmg)
APP_PATHS=(src-tauri/target/release/bundle/macos/*.app)
shopt -u nullglob

if [[ ${#DMG_PATHS[@]} -eq 0 ]]; then
  echo "ERROR: no .dmg found in src-tauri/target/release/bundle/dmg/" >&2
  exit 1
fi
if [[ ${#APP_PATHS[@]} -eq 0 ]]; then
  echo "ERROR: no .app found in src-tauri/target/release/bundle/macos/" >&2
  exit 1
fi

DMG_PATH="${DMG_PATHS[0]}"
APP_PATH="${APP_PATHS[0]}"

echo
echo "==> Phase 2/3: xcrun notarytool submit"
echo "    Submits the .dmg to Apple's notary service. Apple scans the"
echo "    contents and returns an approval ticket. Expect 3–15 minutes"
echo "    (occasionally longer if Apple's queue is busy)."
echo "    macOS may prompt for your login password to unlock the keychain;"
echo "    that's expected — it's not asking for your Apple ID password."
echo

xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

echo
echo "==> Phase 3/3: xcrun stapler staple"
echo "    Attaches the approval ticket to both artifacts so they're trusted"
echo "    offline (Gatekeeper sees the ticket without needing the network)."
echo

xcrun stapler staple "$DMG_PATH"
xcrun stapler staple "$APP_PATH"

echo
echo "==> Verification"
spctl --assess --type execute --verbose "$APP_PATH"

echo
echo "Build complete and notarized. Output:"
echo "  $APP_PATH"
echo "  $DMG_PATH"
echo
echo "The .dmg is ready to distribute — recipients can download, double-click,"
echo "drag the app to Applications, and launch without security warnings."
