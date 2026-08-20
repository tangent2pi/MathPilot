#!/bin/sh
set -eu

target=${1:-/opt/mathpilot-skills}
upstream=${2:-/opt/qwen-mm-plugins-src}
service_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

case "$target" in
  /*) ;;
  *) echo "skill target must be absolute" >&2; exit 64 ;;
esac
test -f "$upstream/src/capabilities/core/skill/SKILL.md"
test -f "$upstream/src/capabilities/search/skill/SKILL.md"
test -f "$upstream/src/capabilities/edu-agent/skill/SKILL.md"

mkdir -p "$target"
for name in ocr-routing ktq-extraction er-research teaching-card database teaching-artifact-adapter core search edu-agent; do
  rm -rf "$target/$name"
done

for source in "$service_root"/skills/*; do
  test -d "$source" || continue
  name=$(basename "$source")
  test "$name" != "edu-agent" || continue
  cp -R "$source" "$target/$name"
done

cp -R "$upstream/src/capabilities/core/skill" "$target/core"
cp -R "$upstream/src/capabilities/search/skill" "$target/search"
cp -R "$upstream/src/capabilities/edu-agent/skill" "$target/edu-agent"

for name in core search edu-agent; do
  mkdir -p "$target/$name/agents"
  cp -R "$service_root/upstream-skill-metadata/$name/." "$target/$name/"
done

revision=$(tr -d '\r\n' < "$service_root/qwen-mm-plugins.revision")
if test -d "$upstream/.git"; then
  actual_revision=$(git -C "$upstream" rev-parse HEAD)
  if test "$actual_revision" != "$revision"; then
    echo "Qwen-MM-Plugins revision mismatch: expected $revision, got $actual_revision" >&2
    exit 65
  fi
fi
printf '{"schema":"mathpilot.skill-bundle/v1","qwen_mm_plugins_revision":"%s","root":"/opt/mathpilot-skills"}\n' "$revision" \
  > "$target/.provenance.json"

find "$target" -type f -path '*/scripts/*' \( -name '*.sh' -o -name '*.py' \) -exec chmod 0755 {} +

for name in ocr-routing ktq-extraction er-research teaching-card database teaching-artifact-adapter core search edu-agent; do
  test -f "$target/$name/SKILL.md"
  test -f "$target/$name/agents/openai.yaml"
done

echo "staged_skills_root=$target"
