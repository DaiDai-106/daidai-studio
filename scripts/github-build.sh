#!/usr/bin/env bash
set -euo pipefail

target=${1:-}
check_packaged_app=${CHECK_PACKAGED_APP:-false}

linux_gui_dependencies=(
  dbus-x11 libasound2t64 libgbm1 libgtk-3-0t64 libnotify4
  libnss3 libsecret-1-0 libxss1 libxtst6 xauth xvfb
)

install_linux_dependencies() {
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends "$@"
}

configure_chromium_sandbox() {
  sudo chown root:root "$1"
  sudo chmod 4755 "$1"
}

case "$target" in
  --deb)
    dependencies=(fakeroot xz-utils)
    if [[ "$check_packaged_app" == true ]]; then
      dependencies+=("${linux_gui_dependencies[@]}")
    fi
    install_linux_dependencies "${dependencies[@]}"
    ;;
  --win) ;;
  *)
    echo "Usage: bash scripts/github-build.sh --deb|--win" >&2
    exit 1
    ;;
esac

npm ci
npm run build
node --experimental-strip-types electron.package.ts "$target"

if [[ "$target" == --deb ]]; then
  version=$(node -p 'require("./package.json").version')
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
    configure_chromium_sandbox release/linux-unpacked/chrome-sandbox
    xvfb-run -a dbus-run-session -- node tests/integration/package_smoke.mjs \
      release/linux-unpacked/dai-studio
    ;;
  --win)
    node tests/integration/package_smoke.mjs "release/win-unpacked/Dai Studio.exe"
    ;;
esac
