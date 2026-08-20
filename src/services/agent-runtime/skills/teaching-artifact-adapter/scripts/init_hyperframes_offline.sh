#!/bin/sh
set -eu

target=${1:?usage: init_hyperframes_offline.sh /workspace/tmp/project}
case "$target/" in
  /workspace/tmp/*/|/workspace/output/*/) ;;
  *) echo "target must be below /workspace/tmp or /workspace/output" >&2; exit 64 ;;
esac

skill_root=${EDU_SKILL_ROOT:-/opt/mathpilot-skills/edu-agent}
test -f "$skill_root/assets/gsap/gsap.min.js"
test -f "$skill_root/assets/katex/katex.min.js"

if [ ! -f "$target/hyperframes.json" ]; then
  HYPERFRAMES_SKIP_SKILLS=1 HYPERFRAMES_NO_TELEMETRY=1 \
    hyperframes init "$target" --non-interactive --example blank
fi

find "$target" -type f -name '*.html' -print | while IFS= read -r html; do
  html_dir=$(dirname "$html")
  mkdir -p "$html_dir/gsap" "$html_dir/katex" "$html_dir/assets/fonts"
  cp "$skill_root/assets/gsap/gsap.min.js" "$html_dir/gsap/gsap.min.js"
  cp -R "$skill_root/assets/katex/." "$html_dir/katex/"
  cp -R "$skill_root/assets/fonts/." "$html_dir/assets/fonts/"
  sed -i -E \
    's#https://cdn\.jsdelivr\.net/npm/gsap@[^\"]+/dist/gsap\.min\.js#./gsap/gsap.min.js#g' \
    "$html"
done

if rg -n 'https?://|//cdn\.' "$target" -g '*.html'; then
  echo "external URL remains in Hyperframes HTML" >&2
  exit 65
fi

echo "hyperframes_offline_ready=$target"
