#!/usr/bin/env bash
set -euo pipefail

target=${1:-}
check_packaged_app=${CHECK_PACKAGED_APP:-false}

case "$target" in
  --deb)
    dependencies=(fakeroot xz-utils)
    if [[ "$check_packaged_app" == true ]]; then
      dependencies+=(
        dbus-x11 libasound2t64 libgbm1 libgtk-3-0t64 libnotify4
        libnss3 libsecret-1-0 libxss1 libxtst6 xauth xvfb
      )
    fi
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends "${dependencies[@]}"
    ;;
  --win) ;;
  *)
    echo "Usage: bash scripts/github-build.sh --deb|--win" >&2
    exit 1
    ;;
esac

npm ci
npm run "package:${target#--}"

version=$(node -p 'require("./package.json").version')
if [[ "$target" == --deb ]]; then
  deb="release/dai-studio_${version}_amd64.deb"
  test "$(dpkg-deb -f "$deb" Package)" = dai-studio
  test "$(dpkg-deb -f "$deb" Architecture)" = amd64
  test "$(dpkg-deb -f "$deb" Version)" = "$version"
fi

if [[ "$check_packaged_app" != true ]]; then
  exit 0
fi

case "$target" in
  --deb)
    unpacked=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/dai-deb.XXXXXX")
    trap 'rm -rf -- "$unpacked"' EXIT
    dpkg-deb -x "$deb" "$unpacked"
    app="$unpacked/opt/Dai Studio"
    sudo chown root:root "$app/chrome-sandbox"
    sudo chmod 4755 "$app/chrome-sandbox"
    xvfb-run -a dbus-run-session -- node tests/integration/package_smoke.mjs "$app/dai-studio"
    ;;
  --win)
    node tests/integration/package_smoke.mjs "release/dai-studio-setup-${version}-x64.exe" --install
    ;;
esac
