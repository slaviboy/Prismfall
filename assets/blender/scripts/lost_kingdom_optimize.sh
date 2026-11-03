#!/usr/bin/env sh
# Optimises The Lost Kingdom's Blender exports into the stage folder (run from the repository root
# after `blender -b --python assets/blender/scripts/lost_kingdom.py -- --bake --save`).
#   sh assets/blender/scripts/lost_kingdom_optimize.sh
set -e
GT="node node_modules/@gltf-transform/cli/bin/cli.js"
SRC=assets/blender/exports/lost_kingdom
DST=content/stages/lost-kingdom/models
TMP=$SRC/tmp
mkdir -p "$DST" "$TMP"
for g in pyramid floor plaza escarpment north; do
  # Baked groups: meshopt geometry, no simplification (the bake's UVs and silhouettes stay exact),
  # WebP textures (base colour = albedo + sun in alpha, emissive = sky light + glyph mask in alpha).
  $GT webp "$SRC/$g.glb" "$TMP/$g.glb" --quality 90 --effort 80
  $GT optimize "$TMP/$g.glb" "$DST/$g.glb" --compress meshopt --texture-compress false --simplify false --instance false --join false --flatten false --palette false
done
# Plants: GPU instancing for the repeated scans, simplified for distance.
$GT webp "$SRC/vegetation.glb" "$TMP/vegetation.glb" --quality 88
$GT optimize "$TMP/vegetation.glb" "$DST/vegetation.glb" --compress meshopt --texture-compress false --instance true --instance-min 2 --simplify true --simplify-ratio 0.45 --simplify-error 0.004 --join false --flatten false --palette false
rm -rf "$TMP"
# The canopy mask the game samples for the same dappled sun.
ffmpeg -hide_banner -loglevel error -y -i assets/blender/source/textures/lost_kingdom_canopy.png -vf format=gray -c:v libwebp -quality 92 content/stages/lost-kingdom/textures/canopy_dapple.webp
ls -la "$DST" content/stages/lost-kingdom/textures/canopy_dapple.webp
