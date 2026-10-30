#!/usr/bin/env bash
# Fetches Google's nightly Tensor dispatch bridge (libLiteRtDispatch_GoogleTensor.so, Android
# arm64) from LiteRT's nightly binaries into app/nightly-jni/arm64-v8a/ (ignored by git), checked
# against the bucket's own MD5, for builds with -PtensorBridge=nightly (workspace decision 0068).
# LiteRT-LM 0.19.0 calls the bridge's LiteRtDispatchQueryInterface, which the published
# litert-npu-runtime-google-tensor 2.3.2 lacks. The nightly changes every day: the script prints
# the build's date and MD5, which a report should name.
set -euo pipefail

OBJECT=binaries/nightly/android_arm64/libLiteRtDispatch_GoogleTensor.so
META="https://storage.googleapis.com/storage/v1/b/litert/o/${OBJECT//\//%2F}"
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/app/nightly-jni/arm64-v8a"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -sSfL -o "$work/meta.json" "$META"
md5="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["md5Hash"])' "$work/meta.json")"
updated="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["updated"])' "$work/meta.json")"
curl -sSfL -o "$work/lib.so" "https://storage.googleapis.com/litert/$OBJECT"
got="$(openssl dgst -md5 -binary "$work/lib.so" | base64)"
if [ "$got" != "$md5" ]; then
  echo "MD5 mismatch: $got, expected $md5" >&2
  exit 1
fi
mkdir -p "$dest"
cp "$work/lib.so" "$dest/libLiteRtDispatch_GoogleTensor.so"
echo "nightly Tensor bridge built $updated, md5 $md5, in $dest"
