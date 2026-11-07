#!/usr/bin/env bash
# Save the secrets the desktop release workflow (.github/workflows/release.yml) signs with,
# as GitHub Actions secrets of this repository. Run it yourself: it asks for each value,
# hides passwords as you type, and never prints a secret.
#
#   bash scripts/set-release-secrets.sh            # both parts
#   bash scripts/set-release-secrets.sh updater    # only the update-signing key
#   bash scripts/set-release-secrets.sh apple      # only macOS signing + notarization
#
# Update signing: the key pair from `pnpm tauri signer generate` (its public half is in
# apps/desktop/src-tauri/tauri.conf.json). Keep a backup: losing it means installed apps
# can't update themselves any more.
#
# macOS: a "Developer ID Application" certificate exported as .p12 (Keychain Access →
# right-click the certificate → Export), its password, your Apple ID and an app-specific
# password for it (appleid.apple.com → Sign-In and Security → App-Specific Passwords).
# "Apple Distribution" certificates are for the App Store and can't sign this download.
set -euo pipefail

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
part=${1:-all}
echo "Saving release secrets to $repo"

ask() { local prompt=$1 default=${2:-} answer; read -r -p "$prompt${default:+ [$default]}: " answer; printf '%s' "${answer:-$default}"; }
ask_hidden() { local answer; read -r -s -p "$1: " answer; echo >&2; printf '%s' "$answer"; }
unquote() { local p=$1; p=${p#\"}; p=${p%\"}; p=${p#\'}; p=${p%\'}; printf '%s' "${p/#\~/$HOME}"; }

if [[ $part == all || $part == updater ]]; then
  key=$(unquote "$(ask "Update-signing private key file" "$HOME/.tauri/lemonlime-updater.key")")
  [[ -f $key ]] || { echo "No file at $key" >&2; exit 1; }
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$repo" <"$key"
  pw_file="${key%.key}.password"
  if [[ -f $pw_file ]]; then
    tr -d '\n' <"$pw_file" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$repo"
  else
    ask_hidden "Its password" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$repo"
  fi
fi

if [[ $part == all || $part == apple ]]; then
  p12=$(unquote "$(ask "Developer ID Application certificate (.p12)")")
  [[ -f $p12 ]] || { echo "No file at $p12" >&2; exit 1; }
  p12_pw=$(ask_hidden "The .p12's password")
  # Read the certificate's name from the file; it is the signing identity, and ends in the team id.
  subject=$(openssl pkcs12 -in "$p12" -nokeys -passin "pass:$p12_pw" -legacy 2>/dev/null || openssl pkcs12 -in "$p12" -nokeys -passin "pass:$p12_pw" 2>/dev/null)
  identity=$(printf '%s\n' "$subject" | sed -n 's/^subject=.*CN *= *\([^,/]*\).*/\1/p' | grep -m1 'Developer ID Application' || true)
  if [[ -z $identity ]]; then
    echo "That .p12 has no \"Developer ID Application\" certificate (or the password is wrong)." >&2
    echo "Create one at developer.apple.com → Certificates, then export it from Keychain Access." >&2
    exit 1
  fi
  team=$(printf '%s' "$identity" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')
  echo "Signing as: $identity"
  base64 <"$p12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE --repo "$repo"
  printf '%s' "$p12_pw" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$repo"
  printf '%s' "$identity" | gh secret set APPLE_SIGNING_IDENTITY --repo "$repo"
  printf '%s' "$team" | gh secret set APPLE_TEAM_ID --repo "$repo"
  ask "Apple ID (email)" | gh secret set APPLE_ID --repo "$repo"
  ask_hidden "App-specific password for that Apple ID" | gh secret set APPLE_PASSWORD --repo "$repo"
fi

echo "Done. Secrets now in $repo:"
gh secret list --repo "$repo"
