#!/bin/sh
# Builds the .dmg without `hdiutil create -srcfolder`, whose internal unmount fails
# with "Resource busy" when antivirus (e.g. Sophos) scans the temp volume.
set -e
BUNDLE=src-tauri/target/release/bundle
APP=$BUNDLE/macos/ecoservices.app
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
OUT=$BUNDLE/dmg/ecoservices_${VERSION}_$(uname -m | sed 's/x86_64/x64/').dmg
RW=$(mktemp -d)/rw.dmg

mkdir -p "$BUNDLE/dmg"
hdiutil create -size $(( $(du -sm "$APP" | cut -f1) + 20 ))m -fs HFS+ -volname ecoservices "$RW" >/dev/null
DEV=$(hdiutil attach "$RW" -nobrowse -noverify -noautoopen | awk '/Apple_HFS/{print $1}')
MNT=$(hdiutil info | awk -v d="$DEV" '$1==d{print $3}')
ditto "$APP" "$MNT/ecoservices.app"
ln -s /Applications "$MNT/Applications"
hdiutil detach "$DEV" -force >/dev/null
hdiutil convert "$RW" -format UDZO -o "$OUT" -ov >/dev/null
rm -f "$RW"
echo "Built $OUT"
