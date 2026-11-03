# Particle surface rendering

Particles that take their shape from a real model: points sampled on its actual surface, coloured by its own texture, and moved by its own skeleton. The particle cloud therefore always has the model's silhouette and anatomy, and is never an unrelated cloud.

## Sampling (`src/rendering/particles/meshSampler.ts`)

`sampleModel(root, count, rand)` samples every visible mesh under `root`:

- **Share between meshes:** each mesh gets a share of `count` proportional to its world-space surface area, scale included.
- **Triangle choice:** triangles are picked by a binary search over the cumulative triangle areas.
- **Point inside a triangle:** uniform barycentric coordinates (folded when u + v > 1), so density is even regardless of how the mesh is triangulated.

Each point carries the following:

- **Position and normal,** in the mesh's own (bind) space.
- **Colour,** from the base-colour texture at the point's UV, multiplied by the material colour and any vertex colour. Pixels are read once through an OffscreenCanvas downscaled to 256 px, with a fallback to the material colour.
- **For skinned meshes, joints and weights:** the four strongest joints, blended from the triangle's corners by barycentric weight and renormalised.

Unit tests (`meshSampler.test.ts`) check that points lie on the surface, that triangles and meshes are weighted by area, that colour comes through, and that skin weights are blended correctly.

## Rendering (`src/rendering/particles/surfaceParticles.ts`)

Each sampled mesh gets a particle mesh: one quad per point, with the four corners sharing the point's data. It is attached as a child of the source mesh.

- **Static meshes:** the particles are a `Mesh`.
- **Skinned meshes:** the particles are a `SkinnedMesh` bound to the same skeleton and bind matrix. three's node materials apply skinning before `positionNode`, so the GPU moves the particles with the animated body, with no per-particle CPU work.

The material faces each quad to the camera after skinning: the camera's right and up axes are brought into the mesh's space. It also does the following:

- **Shimmer:** each particle moves slightly along its surface normal.
- **Dissolve:** as `dissolve` goes from 0 to 1, each particle scatters outward and downwind with its own delay, then comes back.
- **Blending:** additive (with bloom and fog transmittance) or normal.

## The four render modes (`model` component)

| Mode | What it shows |
|---|---|
| `solid` | The model with its own PBR materials |
| `surface` | The model plus particles on its surface (glints, dust, glow) |
| `particles` | Only the particles: the meshes stay so their skeletons drive the particles, but are not drawn |
| `dissolve` | The model breaks into its particles and reforms, on a cycle (`dissolve.period`) and on QUADs and perfect clears; the solid fades with a dithered alpha |

## Particle shapes (`particleShapes` component)

Shapes drawn entirely with particles, with a life cycle: the particles converge from a scattered cloud into the shape, it drifts and turns, then it bursts and fades, and the next cycle forms a new one elsewhere. Everything is computed on the GPU from time and hashed per shape and per cycle.

The first shape set is snowflakes in eight crystal types: stellar dendrite, fern, sectored plate, star with tip plates, nested rings, spearhead, twelve-branched and broad-armed. Plates are filled by area and lines sampled by length. Each slot alternates between two designs every cycle. Frozen Kingdom uses them.

## Performance notes

- **No per-frame CPU work:** animation and skinning run in the vertex stage, and there is no per-frame upload.
- **Draw calls:** one per sampled mesh per instance, one per particle-shape layer.
- **Particle counts** scale with the environment-detail and particle-density settings.
