# PROJECT: TETRO EFFECT
## Full production implementation brief

You are acting as a complete senior game-development studio consisting of:

- Principal Game Engineer
- Senior TypeScript / React Engineer
- Senior Three.js / WebGPU Engineer
- 3D Technical Artist
- Shader and GPU Particle Specialist
- Game Physics and Gameplay Engineer
- Audio Programmer and Music Synchronization Engineer
- UI/UX Designer
- Input and Controller Engineer
- Performance Engineer
- QA and Test Automation Engineer

Your responsibility is to design, implement, test, optimize and deliver a complete, polished, immersive browser-based 3D falling-block rhythm puzzle game.

This is a serious personal game-development project, not a tutorial, technical demonstration, proof of concept or quick clone.

The requested working title is:

**TETRO EFFECT**

The application must be a fully functional, exceptionally polished web game that I can personally play regularly.

I own the Steam version of Tetris Effect and can use it as a visual and functional reference through its visible gameplay and menus.

The objective is to create an original game that captures the broad experience qualities I enjoy: immersive 3D environments, beautiful block rendering, atmospheric particle effects, music-reactive environments, exceptionally satisfying line clears, polished transitions, rich configuration, responsive gameplay and controller support.

Do not make a cheap imitation. Every feature must be implemented properly.

---
# CRITICAL: THIS MUST BE TETRIS — NO ALTERNATIVE PUZZLE GAMES

The game MUST be a genuine falling-tetromino Tetris game.

I specifically want the Tetris gameplay experience I enjoy in Tetris Effect.

This is not a general block puzzle game.

This is NOT:
- A match-three puzzle.
- A block-placement puzzle.
- A shape-matching game.
- A hexagonal puzzle.
- A polyomino puzzle with additional shapes.
- A block-building sandbox.
- A different puzzle game inspired by Tetris.

The ONLY gameplay pieces are the seven traditional Tetris tetrominoes:

- I
- O
- T
- S
- Z
- J
- L

The core gameplay must use traditional falling-block mechanics:
- Pieces fall from the top of the board.
- Move left and right.
- Rotate pieces.
- Accelerate falling.
- Hard drop.
- Lock pieces into the board.
- Complete horizontal lines.
- Clear completed lines.
- Earn points.
- Increase difficulty and level progression.
- Use next-piece previews.
- Hold and swap pieces.
- Support combos and advanced Tetris scoring mechanics.

Implement authentic, well-tested Tetris rules and rotation behavior, including SRS-style wall kicks.

All game modes must remain variations of Tetris gameplay. Marathon, Sprint, Ultra, Zen, Practice and Journey must never introduce another puzzle genre.

All environments, stages, music, particle effects, backgrounds and animations are presentation layers surrounding the actual Tetris game.

The original Tetris gameplay must always remain the heart of the experience.

**NON-NEGOTIABLE: I want to play Tetris, not another game with blocks.**
---

# 1. NON-NEGOTIABLE PROJECT REQUIREMENTS

The following requirements are mandatory.

1. The game must run in a modern web browser.
2. Use TypeScript throughout the application.
3. Use React for menus, settings, HUD, overlays and application UI.
4. Use Three.js for the 3D graphics engine.
5. Prefer WebGPU when supported, with a reliable WebGL 2 fallback.
6. Use a custom, deterministic TypeScript gameplay engine.
7. Use the Web Audio API for audio management and synchronization.
8. Support keyboard and modern game controllers.
9. Include extensive graphics, sound, gameplay and controller settings.
10. Use an extensible, data-driven level architecture.
11. Support high-quality rendering, high-resolution displays and high-refresh-rate monitors.
12. Save user settings and game progress.
13. Keep the Git repository private.
14. Do not publish the application publicly or expose private deployment URLs.
15. Do not include analytics, advertising, trackers or unnecessary third-party services.

The game should initially be a single-player experience. Do not waste time implementing multiplayer, accounts or social features.

A website hosted online must also have real access protection. A private source-code repository alone does not make a deployed website private. Never deploy publicly without explicit authorization.

# 2. REFERENCE-GAME INVESTIGATION

Before designing the game, investigate the Steam reference version using available desktop interaction tools.

If computer interaction is available:

- Open the installed Steam game.
- Launch it normally.
- Observe its title screen and menus.
- Navigate its visible settings.
- Play the available gameplay modes.
- Observe different stages and environments.
- Capture screenshots at important moments.
- Record short gameplay clips where practical.
- Observe how gameplay, music, lighting and visual effects interact.


## Produce a reference investigation document

Create:

REFERENCE_NOTES.md

Document the following:

### A. Gameplay
- Board dimensions and visible playfield.
- Piece spawning and movement.
- Rotation behavior.
- Gravity and locking.
- Soft drop and hard drop.
- Hold mechanics.
- Next-piece previews.
- Ghost-piece behavior.
- Line-clearing behavior.
- Scoring.
- Combos.
- Level progression.
- Game-over behavior.
- Pause and resume behavior.
- Stage transitions.

### B. User interface
- Title screen structure.
- Main menu organization.
- Game HUD layout.
- Score display.
- Next-piece display.
- Hold display.
- Level and progression indicators.
- Pause menu.
- Results screen.
- Stage selection.
- Settings organization.
- Controller configuration.

### C. Settings
Investigate every visible setting you can access, including:

- Graphics quality.
- Resolution and display options.
- Fullscreen.
- Sound volume and audio options.
- Music volume.
- Sound effects.
- Camera and zoom options.
- Keyboard controls.
- Controller settings.
- Gameplay preferences.
- HUD visibility.
- Accessibility options.

Create a feature-parity checklist that identifies the visible reference options and their corresponding implementation in this project.

Do not invent settings that you have not observed and then claim they match the original. Mark uncertain observations clearly.

### D. Visual feedback
Observe how the game responds to:

- A new piece spawning.
- A piece moving.
- A piece rotating.
- A piece landing.
- A line clearing.
- Multiple lines clearing.
- A combo.
- A major scoring event.
- A level transition.
- A special gameplay event.
- Music intensity changes.
- Pausing.
- Resuming.
- Game over.

Pay particular attention to timing, animation smoothness, particles, lighting, camera behavior and the visibility of the playfield.

### E. Reference deliverables

Create a reference checklist and a collection of observation screenshots.

Use the findings to guide independently designed content. Do not reproduce individual original stages frame-for-frame.

If you cannot operate the installed game or obtain a particular observation, report that limitation rather than pretending you have inspected it.

# 3. TECHNICAL STACK

Use the following architecture unless a demonstrated technical limitation requires a documented alternative.

## Frontend

- React.
- TypeScript.
- Vite.
- Three.js.
- WebGPU renderer where supported.
- WebGL 2 fallback.
- Modern CSS.
- A lightweight state-management solution such as Zustand for application settings and UI state.
- Vitest for unit testing.
- Playwright for browser automation and end-to-end testing.

Use the latest stable compatible releases at implementation time. Pin dependencies in the package manager lockfile.

Do not blindly upgrade dependencies during development.

## Rendering

Create a separate rendering subsystem.

It must support:

- WebGPU rendering.
- WebGL 2 fallback.
- High-DPI displays.
- Configurable render resolution.
- Dynamic or manually adjustable render scale.
- Post-processing.
- Bloom.
- Ambient lighting.
- Shadows.
- Particle systems.
- Tone mapping.
- Antialiasing where supported.
- Fullscreen.
- Camera control.

Keep renderer-specific code isolated so that the rendering implementation can evolve without rewriting gameplay.

Do not let React rerender the entire game on every animation frame.

The game engine and Three.js rendering loop should operate independently of ordinary React UI updates.

# 4. GAMEPLAY ENGINE

This must be a real, reliable falling-block puzzle engine.

Implement the game rules in pure TypeScript where practical.

Keep game logic separate from rendering.

## Core gameplay

Implement:

- A standard 10-column playfield with 20 visible rows and configurable hidden spawn rows.
- Seven distinct tetromino shapes.
- Randomized piece generation using a seven-bag system.
- Spawn logic.
- Horizontal movement.
- Left and right rotation.
- Soft drop.
- Hard drop.
- Ghost piece.
- Hold piece.
- Configurable next-piece queue.
- Gravity.
- Lock delay.
- Collision detection.
- Wall kicks.
- Line detection.
- Line clearing.
- Score calculations.
- Level progression.
- Combo tracking.
- Back-to-back scoring.
- Suitable rotation and spin recognition.
- Game-over detection.
- Pause and resume.
- Restart.
- High scores.
- Session statistics.

Provide modern, familiar rotation behavior, including an SRS-style implementation where appropriate.

Implement deterministic random seeds so that gameplay sessions and bugs can be reproduced.

## Gameplay feel

The game must feel responsive and precise.

Prioritize:

- Extremely responsive horizontal movement.
- Predictable rotation.
- Correct collision boundaries.
- Smooth gravity behavior.
- Configurable DAS and ARR.
- Accurate lock timing.
- Instant hard-drop feedback.
- Reliable input buffering.
- No dropped inputs.
- No delayed reactions caused by UI rendering.

Gameplay must not become less responsive because an elaborate visual effect is playing.

All visual events must remain independent of core gameplay timing.

## Scoring and statistics

Show:

- Current score.
- Highest score.
- Current level.
- Lines cleared.
- Time played.
- Combo count.
- Back-to-back status.
- Relevant special scoring events.

Create a configurable scoring system that can be tested independently.

# 5. ORIGINAL 3D ART DIRECTION

This is one of the most important parts of the project.

The finished game must feel like an immersive 3D audiovisual experience rather than a conventional flat puzzle game.

Build a distinct visual identity.

## 3D blocks

Blocks must be actual polished 3D objects, not flat colored squares.

Design a professional block-rendering system with:

- Beveled geometry.
- Rounded or softened edges.
- Subtle edge highlights.
- PBR-inspired materials.
- Reflective surfaces where appropriate.
- Controlled emissive elements.
- Subtle internal illumination.
- Individual piece color identities.
- Surface detail.
- Shadows and ambient occlusion effects where practical.
- Beautiful lighting responses.

The blocks should have convincing volume and depth.

Design the material system so that stage themes can change materials and effects without changing game logic.

Use instancing or other efficient GPU techniques when many objects share geometry.

## Playfield

The playfield is the primary focus.

Give it a strong spatial presence, with:

- A carefully composed camera.
- Genuine depth.
- An attractive spatial background.
- Clear separation between falling pieces and the environment.
- Subtle grid and board illumination.
- Beautiful landing and locking effects.
- Carefully controlled reflections.
- A polished frame or spatial enclosure.

The board must always remain readable.

Visual effects must never make it difficult to understand where blocks are or what the next action should be.

## Particle systems

Create a sophisticated GPU-oriented particle system.

Include independently configurable systems for:

- Floating dust.
- Distant particle fields.
- Atmospheric particles.
- Glowing particles.
- Energy trails.
- Explosive line-clear particles.
- Particle streams.
- Environmental effects.
- Stage transitions.
- Beat-synchronized visual events.

Create convincing depth using perspective, particle scaling, depth fading, layered particle fields and carefully designed motion.

Use Points, instancing, shader-based animation and GPU-friendly techniques where appropriate.

Avoid thousands of individually updated JavaScript objects.

Particles should not destroy performance.

## Background environments

The environment must be an actual 3D experience.

Create independently authored scenes containing:

- Spatial structures.
- Distant objects.
- Atmospheric layers.
- Animated geometry.
- Particle systems.
- Lighting systems.
- Environmental movement.
- Music-reactive elements.
- Smooth transitions.

Avoid static backgrounds that simply change color.

Each level should feel like entering a different place.

# 6. STAGE AND LEVEL SYSTEM

Create a modular stage architecture.

Every stage must have a data-driven definition that controls:

- Stage name.
- Description.
- Environment.
- Color palette.
- Lighting.
- Particle behavior.
- Background geometry.
- Music track.
- BPM and beat metadata.
- Animation intensity.
- Camera behavior.
- Line-clear effects.
- Special environmental events.
- Progression and unlock requirements.

Separate stage configuration from rendering and gameplay logic.

Build at least 10 distinct, original, fully playable environments for the first complete version.

Possible original themes include:

1. Luminous Tide.
2. Glass Canopy.
3. Ember Foundry.
4. Celestial Drift.
5. Deep Current.
6. Neon Rain.
7. Verdant Circuit.
8. Dust Cathedral.
9. Aurora Engine.
10. Quiet Horizon.

These are starting creative directions, not restrictions.

Each stage must feature its own coordinated audiovisual identity.

Do not simply use the same background with different colors.

Implement a stage-selection screen and a structured progression system.

Support locked and unlocked stages, progression requirements and saved completion information.

Stages must be easy to add without modifying the core engine.

# 7. MUSIC AND AUDIO REACTIVITY

Audio is central to the experience.

Implement an independent audio engine using the Web Audio API.

## Audio functionality

Include:

- Main music channel.
- Sound effects channel.
- Environmental audio channel.
- Master volume.
- Individual volume controls.
- Mute.
- Audio enable and disable.
- Track selection.
- Looping.
- Audio fade-in and fade-out.
- Transition management.
- Proper pause and resume behavior.

Use original compositions, original synthesizer-generated music, or assets with suitable licenses.

Do not extract music or sound effects from the Steam game.

Build an architecture that allows me to add my own legally usable audio files in the future.

## Music synchronization

This requires special attention.

Implement beat-aware synchronization using explicit track metadata:

- BPM.
- Beat duration.
- Bar duration.
- Beat position.
- Musical sections.
- Intensity.
- Section-transition cues.

Also implement audio-reactive environmental effects using an audio analyser when appropriate.

React to music through:

- Background lighting.
- Particle behavior.
- Environmental movement.
- Emissive intensity.
- Light pulses.
- Atmospheric effects.
- Camera emphasis.
- Background animation.
- Line-clear animations.
- Combo feedback.
- Major scoring events.

The environment should feel alive and musically connected.

Do not make every object flash randomly.

Visual changes must feel intentional and coordinated with the soundtrack.

Gameplay input and gravity must not depend on the current audio-analysis performance.

Build a reusable Music Director that controls track progression and communicates timing events to the environment.

# 8. SATISFYING GAMEPLAY FEEDBACK

This is critical.

Every meaningful game action should have an appropriate visual and audio response.

## Individual events

Piece spawn:
- Smooth entrance.
- Subtle illumination.
- Clear visual distinction.

Piece movement:
- Immediate response.
- Subtle motion feedback where appropriate.

Piece rotation:
- Polished movement feedback.
- Optional subtle rotation effect.

Piece landing:
- Impact feedback.
- Small controlled particle response.
- Appropriate sound effect.

Single line clear:
- Clear visual recognition.
- Polished disappearance animation.
- Particle response.
- Audio response.
- Score update.

Double, triple and four-line clears:
- Increasingly satisfying effects.
- Appropriate intensity differences.
- More substantial environmental response.

Combos:
- Stronger visual feedback as combos increase.
- Clear combo indicators.
- Coordinated sounds and animations.

Major scoring events:
- Appropriate screen feedback.
- Environmental pulse.
- Particle burst.
- Score emphasis.

Level transition:
- Distinct transition effect.
- Smooth environment transition.
- Music and lighting transition.

Keep animations performant and avoid blocking gameplay.

# 9. UI, HUD AND GAME MENUS

Design a professional interface that feels like a complete game.

Do not use generic dashboard styling.

Do not fill the screen with unnecessary boxes and cards.

## HUD

Include:

- Main playfield.
- Next-piece preview.
- Hold-piece display.
- Score.
- Level.
- Lines.
- Combo.
- Timer.
- Pause control.
- Relevant gameplay feedback.

The HUD must be customizable.

Allow next-piece previews to be turned on and off.

Allow the number of upcoming pieces to be configured.

Provide clean, readable typography and careful visual hierarchy.

## Menus

Implement:

- Main menu.
- Game mode selection.
- Journey or campaign selection.
- Stage selection.
- Gameplay.
- Pause menu.
- Results screen.
- High scores.
- Settings.
- Controls configuration.
- Audio configuration.
- Graphics configuration.
- Controller configuration.
- Accessibility configuration.

Every menu must work.

No decorative buttons with no functionality.

Support keyboard and controller navigation throughout the menus.

Provide smooth but responsive menu transitions.

# 10. GAME MODES

Create a modular game-mode system.

Include at minimum:

### Journey / Campaign
A progression-based experience with multiple original stages, different environments and unlockable content.

### Marathon
Traditional continuous gameplay with progressively increasing difficulty.

### Sprint
A configurable line-clear challenge, including a 40-line target.

### Ultra
A timed high-score challenge.

### Zen
Relaxed gameplay without pressure, with configurable difficulty and visual atmosphere.

### Practice
Configurable gameplay for testing pieces, controls, speed and scoring.

Each mode must have a clearly defined rule configuration.

Do not duplicate gameplay implementations for every mode. Reuse the core engine with mode-specific rules.

# 11. COMPLETE SETTINGS SYSTEM

The settings system must be fully functional and persistent.

Create a settings manager with typed configuration, validation, defaults and versioned migrations.

Save preferences locally using IndexedDB or another appropriate browser storage mechanism.

## A. Graphics settings

Provide:

- Low quality.
- Medium quality.
- High quality.
- Ultra quality.
- Custom quality.

Custom controls should include:

- Render resolution scale.
- Display resolution information.
- Fullscreen.
- Frame-rate limit.
- Antialiasing.
- Bloom intensity.
- Shadow quality.
- Particle density.
- Environmental detail.
- Reflection quality.
- Ambient lighting quality.
- Post-processing.
- Motion blur.
- Depth of field.
- Camera field of view, where useful.
- Camera zoom.
- Screen-space effects.
- Dynamic resolution, where supported.

Provide a setting to restore recommended graphics defaults.

Explain browser-controlled features such as VSync instead of pretending the application can always force them.

Do not confuse render resolution with the monitor's native resolution.

Include a live performance indicator with FPS and renderer information.

## B. Audio settings

Provide:

- Master volume.
- Music volume.
- Sound-effects volume.
- Environment volume.
- Mute.
- Audio enable/disable.
- Audio-reactive effects enable/disable.
- Audio latency calibration if practical.

## C. Camera settings

Provide:

- Zoom in/out.
- Zoom sensitivity.
- Camera distance.
- Camera FOV.
- Camera shake enable/disable.
- Camera movement intensity.

Never let camera settings compromise playfield visibility.

## D. Gameplay settings

Provide:

- Show next pieces.
- Number of next pieces.
- Show hold piece.
- Enable/disable ghost piece.
- Show playfield grid.
- DAS.
- ARR.
- Soft-drop behavior.
- Input repeat configuration.
- Gameplay effects intensity.
- Reduced-motion option.
- Alternative high-contrast block colors.

## E. Keyboard settings

Implement a complete key-remapping interface.

Allow the player to assign their own keys for:

- Move left.
- Move right.
- Soft drop.
- Hard drop.
- Rotate clockwise.
- Rotate counterclockwise.
- Rotate 180 degrees, if enabled.
- Hold.
- Pause.
- Confirm.
- Back.

Include:

- Current bindings.
- Key capture.
- Conflict warnings.
- Duplicate-binding handling.
- Restore defaults.
- Keyboard navigation.
- Persistent settings.

## F. Controller settings

Implement real browser gamepad support.

Use the Gamepad API.

Support common standard gamepads and provide custom remapping for unusual layouts.

Specifically design for:

- PlayStation DualShock 4.
- PlayStation DualSense.
- Xbox controllers.
- Generic standard gamepads.

Features:

- Controller connection detection.
- Controller disconnection handling.
- Button mapping.
- Analog-stick mapping.
- D-pad support.
- Dead-zone configuration.
- Input sensitivity.
- Button remapping.
- Vibration/haptic support where the browser and device expose it.
- Controller navigation in menus.
- Controller navigation in settings.
- Controller gameplay.

Do not assume all PlayStation connections expose identical button mappings.

Detect and expose available controls, and allow the player to configure them.

Show controller connection status.

Allow testing individual buttons from the settings screen.

# 12. INPUT ARCHITECTURE

Build a dedicated input abstraction.

Do not scatter raw keyboard and gamepad event handling across React components.

Create a unified action system:

Input device -> action mapping -> gameplay action.

This architecture should make future input devices easy to add.

Handle:

- Key repeat.
- Controller polling.
- Input buffering.
- Simultaneous inputs.
- Focus loss.
- Window visibility changes.
- Pause behavior.
- Controller disconnects.
- Input remapping.

Menus and gameplay should use separate configurable action contexts.

# 13. PERFORMANCE AND GPU ENGINEERING

My graphics card is an AMD Radeon RX 9070 XT.

Design for a high-performance desktop with a powerful modern GPU.

Target a visually impressive experience at:

- 2560 × 1440.
- 3840 × 2160.
- High-refresh-rate displays.
- 60 FPS and above.
- 120 FPS and above where the complete system allows it.

These are performance targets to measure, not guaranteed results.

Aim for 4K at 60 FPS and 1440p at 120 FPS on the target hardware under the highest practical quality settings.

Create quality presets that scale correctly.

Use:

- GPU-efficient particle rendering.
- Geometry instancing.
- Resource reuse.
- Texture and geometry memory management.
- Efficient shaders.
- Avoidance of unnecessary draw calls.
- Animation-frame delta time.
- Fixed-step gameplay updates.
- Efficient input processing.
- Proper Three.js disposal.
- Lazy loading of nonessential stage assets.
- Asset caching.
- Controlled post-processing.

Do not create thousands of individual meshes when instanced rendering would be better.

Do not allocate large numbers of objects every frame.

Monitor:

- FPS.
- Frame time.
- Renderer information.
- Draw calls.
- GPU memory where available.
- CPU performance.
- Loading times.

Provide graceful degradation on weaker devices.

A user should be able to select visual quality without changing the underlying gameplay behavior.

# 14. GAME ENGINE ARCHITECTURE

Maintain a clean, expandable project architecture.

Suggested organization:

src/
  app/
  components/
  ui/
    menus/
    hud/
    settings/
    controls/
  game/
    core/
    rules/
    board/
    pieces/
    scoring/
    modes/
    progression/
    simulation/
  rendering/
    renderer/
    camera/
    materials/
    shaders/
    lighting/
    particles/
    postprocessing/
    environments/
  audio/
    engine/
    mixer/
    music-director/
    beat-sync/
    sound-effects/
  input/
    keyboard/
    gamepad/
    mappings/
  stages/
    manifests/
    environments/
    progression/
  storage/
  config/
  utils/
  tests/

You may adjust the structure when there is a real architectural reason.

Keep these systems independent:

1. Gameplay engine.
2. Rendering engine.
3. Audio engine.
4. Input manager.
5. UI system.
6. Settings manager.
7. Stage manager.
8. Persistence system.

Use strongly typed interfaces.

Avoid excessive coupling.

Avoid giant components and files.

Avoid unnecessary abstractions.

Do not use TypeScript any as an easy way to bypass type checking.

Keep the code readable and maintainable.

# 15. PRIVATE WEB APPLICATION AND DATA

The project is intended exclusively for my personal use.

Requirements:

- Private Git repository.
- No public source repository.
- No user-registration system.
- No analytics.
- No advertising.
- No unnecessary external API calls.
- No collection of personal information.
- Local save data for progress and preferences.
- No embedded third-party music or copied commercial assets.
- No exposed secrets.
- No public deployment without permission.

Develop locally first.

Make the application deployable to a private hosting environment later.

If private online access is configured, implement actual server-side access protection or a trusted access gateway.

Do not rely on a secret URL or a client-side password screen as security.

Create deployment instructions, but do not publish anything automatically.

# 16. ACCESSIBILITY AND COMFORT

Implement:

- Reduced motion.
- Adjustable particle intensity.
- Adjustable screen effects.
- Adjustable camera shake.
- High-contrast block colors.
- Clear visual distinction between pieces.
- Adjustable HUD scale.
- Configurable input repeat.
- Keyboard-only usability.
- Gamepad-only usability.
- Sound-effect volume control.
- Optional visual indicators for important audio events.

Accessibility settings must actually affect the application.

# 17. TESTING AND QUALITY ASSURANCE

Do not consider the project complete merely because the application opens.

Write real tests.

## Gameplay tests

Test:

- Piece generation.
- All piece rotations.
- Movement boundaries.
- Collision detection.
- Locking.
- Hard drop.
- Soft drop.
- Hold.
- Next queue.
- Single line clear.
- Multiple line clear.
- Scoring.
- Combos.
- Level changes.
- Game over.
- Restart.
- Pause and resume.

## Input tests

Test:

- Keyboard remapping.
- Gamepad recognition.
- Button mapping.
- Multiple input events.
- Controller disconnection.
- Input focus.
- Rebinding conflicts.

## Rendering tests

Test:

- WebGPU startup.
- WebGL 2 fallback.
- Screen resizing.
- Fullscreen transitions.
- High-DPI rendering.
- Post-processing toggles.
- Stage loading and disposal.
- Long-running gameplay.
- Particle performance.

## Audio tests

Test:

- Audio initialization.
- Audio unlocking.
- Volume control.
- Mute.
- Pause and resume.
- Music transition.
- Beat synchronization.
- Audio-reactive effects.

## End-to-end tests

Use Playwright to verify:

- Application startup.
- Menu navigation.
- Starting a game.
- Playing a complete session.
- Pausing.
- Changing settings.
- Saving settings.
- Restarting.
- Viewing results.

Run tests and fix failures before declaring a milestone complete.

# 18. DEVELOPMENT PROCESS

Do not attempt to generate the entire application as one enormous untested code dump.

Work in deliberate milestones.

However, do not stop after writing architecture documents or scaffolding an empty application. You must implement the actual game.

## Milestone 1: Investigation and planning

- Inspect the repository.
- Inspect the available reference game.
- Create REFERENCE_NOTES.md.
- Create a feature checklist.
- Create architecture documentation.
- Identify significant technical risks.
- Define implementation milestones.

## Milestone 2: Gameplay foundation

- Create the React application.
- Create the TypeScript game engine.
- Implement the board.
- Implement all pieces.
- Implement movement and rotation.
- Implement collision and locking.
- Implement line clearing.
- Implement scoring.
- Implement next queue and hold.
- Implement complete basic gameplay.

The game must already be playable at the end of this milestone.

## Milestone 3: 3D rendering foundation

- Build the Three.js renderer.
- Implement WebGPU/WebGL 2 initialization.
- Build the playfield.
- Build 3D blocks.
- Implement the camera.
- Implement lighting.
- Implement initial post-processing.

## Milestone 4: Effects and environments

- Implement particle systems.
- Build original 3D environments.
- Build stage configurations.
- Implement line-clear effects.
- Implement stage transitions.
- Implement environmental animations.

## Milestone 5: Audio engine

- Implement music playback.
- Implement audio mixing.
- Implement sound effects.
- Implement music metadata.
- Implement beat synchronization.
- Connect audio events to the rendering system.

## Milestone 6: Complete game interface

- Build menus.
- Build HUD.
- Build mode selection.
- Build campaign progression.
- Build pause screen.
- Build results screen.
- Build settings interface.

## Milestone 7: Controller and customization

- Complete keyboard remapping.
- Implement Gamepad API.
- Support PlayStation controller mappings.
- Implement controller testing.
- Implement all settings.
- Implement persistence.

## Milestone 8: Final content

- Create at least 10 original stages.
- Add original soundtrack content or properly licensed music.
- Add appropriate sound effects.
- Implement progression and unlocks.
- Polish transitions and animations.

## Milestone 9: Optimization and verification

- Profile rendering.
- Profile gameplay.
- Fix performance bottlenecks.
- Verify fallback rendering.
- Test the complete experience.
- Run automated tests.
- Fix bugs.
- Document remaining limitations.

# 19. QUALITY BAR AND ACCEPTANCE CRITERIA

The finished application must satisfy all of these conditions.

### Gameplay

- Fully playable from beginning to end.
- Correct and predictable mechanics.
- Responsive keyboard controls.
- Working controller controls.
- No broken state transitions.
- No disappearing or duplicated pieces.
- No corrupted board state.
- Correct scoring.
- Reliable save data.

### Graphics

- Real 3D blocks.
- Visually impressive environments.
- Independent stage themes.
- Sophisticated particles.
- Good lighting and materials.
- Smooth animations.
- Meaningful music-reactive visuals.
- Configurable visual quality.
- No obvious visual placeholders.

### Audio

- Functional music engine.
- Functional sound effects.
- Independent volume controls.
- Proper music transitions.
- Beat-aware effects.
- Original or properly licensed content.

### User experience

- Functional menus.
- Complete settings.
- Keyboard remapping.
- Gamepad remapping.
- Stage selection.
- Multiple game modes.
- Persistent progress and settings.
- Professional-looking UI.

### Performance

- No unnecessarily expensive rendering techniques.
- No continuous React rerendering for every game frame.
- No obvious memory leaks.
- No progressively worsening performance.
- Working WebGPU/WebGL 2 strategy.
- Measured performance on the target system when available.

### Project quality

- Strict TypeScript.
- Clear source structure.
- No major console errors.
- No broken buttons.
- No empty menu options pretending to be features.
- No placeholder functionality represented as completed.
- Documented setup and deployment.

# 20. REQUIRED DELIVERABLES

At completion, provide:

1. Fully working web game.
2. Complete TypeScript source code.
3. All original game environments.
4. All implemented game modes.
5. Complete settings system.
6. Keyboard and controller support.
7. Audio and synchronization system.
8. Automated test suite.
9. README.md.
10. ARCHITECTURE.md.
11. REFERENCE_NOTES.md.
12. PERFORMANCE.md.
13. ASSET_LICENSES.md.
14. DEPLOYMENT.md.
15. A list of tested features.
16. A list of known limitations, if any.

Include exact commands to:

- Install dependencies.
- Start development.
- Run tests.
- Build production.
- Preview production.

# 21. HOW YOU SHOULD WORK

Work like an experienced professional game-development team.

Be proactive.

Investigate before making assumptions.

Make architectural decisions for legitimate technical reasons, not because they are easier to generate.

Implement actual functionality.

When a system is incomplete, say so.

When a visual effect is only a temporary placeholder, label it clearly and replace it before the final milestone.

Do not claim high performance without measurements.

Do not claim a feature is supported unless it has actually been tested.

Do not sacrifice gameplay responsiveness for graphics.

Do not sacrifice the visual quality of the game for a simplistic implementation.

Do not make arbitrary shortcuts that compromise future scalability.

Use your available computer interaction, development tools, browser and testing capabilities where appropriate.

After each milestone:

1. Run the application.
2. Verify the changes.
3. Run relevant tests.
4. Fix identified problems.
5. Report what was completed.
6. Record what remains.

Do not automatically deploy, publish the repository, delete user data or modify the installed reference game.

If you encounter an issue requiring my physical interaction, explain exactly what I need to do.

# 22. SCALABLE STAGE, ENVIRONMENT AND CONTENT EXPANSION SYSTEM

This is a fundamental architectural requirement.

Tetro Effect must be designed as an expandable game platform, not a game with a fixed collection of levels.

I want to continuously add completely new Tetris stages in the future.

The architecture must support adding:
- New levels and stages.
- New 3D environments.
- New visual themes.
- New block designs and materials.
- New particle systems.
- New lighting configurations.
- New background animations.
- New music tracks.
- New sound effects.
- New beat-synchronization profiles.
- New stage transitions.
- New environmental interactions.
- New stage-specific gameplay presentation effects.

## A. Modular stage architecture

Every stage must be an independent, self-contained content module.

Create a standard stage structure, for example:

stages/
  luminous-tide/
    stage.json
    environment/
    models/
    textures/
    materials/
    shaders/
    particles/
    audio/
      music/
      effects/
    previews/

  celestial-drift/
    stage.json
    environment/
    models/
    textures/
    materials/
    shaders/
    particles/
    audio/
      music/
      effects/
    previews/

  ember-foundry/
    stage.json
    environment/
    models/
    textures/
    materials/
    shaders/
    particles/
    audio/
      music/
      effects/
    previews/

The actual structure may be optimized, but every stage must follow a consistent, documented content format.

## B. Stage configuration system

Each stage must have a typed, validated manifest describing:

- Unique stage ID.
- Stage name.
- Description.
- Stage thumbnail.
- Preview image.
- Environment configuration.
- Environment assets.
- 3D models.
- Background animation.
- Lighting configuration.
- Particle configuration.
- Block appearance and material configuration.
- Music tracks.
- Music metadata.
- BPM and beat synchronization.
- Sound effects.
- Visual intensity.
- Camera configuration.
- Stage transition effects.
- Line-clear effects.
- Combo effects.
- Progression and unlock requirements.
- Recommended graphics settings.

Use versioned schemas and validate stage definitions before loading them.

Do not hardcode individual stage names or behavior throughout the game engine.

## C. Every level must look and feel different

I do not want 20 stages that simply change their background color.

Each stage should have its own visual identity.

For example:

- An underwater world with volumetric light, floating particles and deep blue environments.
- A futuristic neon city with animated architecture and light trails.
- A cosmic environment with stars, nebulae and distant planets.
- An ancient atmospheric environment with monumental structures and floating dust.
- A beautiful natural environment with vegetation, atmospheric light and organic movement.
- A mechanical environment with moving machinery, sparks and industrial lighting.

These are examples of original artistic directions, not limitations.

Each stage should feel like an entirely different world.

## D. Independent audiovisual identity

Each stage must be capable of controlling its entire audiovisual presentation independently.

I should be able to add a new stage with:
- Completely different music.
- Different musical tempo.
- Different particle behavior.
- Different environmental animations.
- Different block materials.
- Different lighting.
- Different line-clear effects.
- Different ambient sound.
- Different environmental reactions to music.

The Music Director must support individual track metadata and beat synchronization for every stage.

Music and environmental effects should work together as a coordinated experience.

## E. Dynamic content loading

Build a stage manager that can:

- Discover available stage manifests.
- Validate stage content.
- Load stages on demand.
- Display stage previews.
- Cache commonly used assets.
- Unload unused stages.
- Dispose of Three.js resources correctly.
- Handle loading errors gracefully.
- Show loading progress.
- Preload the next stage when appropriate.

Do not load the assets of every stage into GPU memory simultaneously.

Optimize memory and loading times.

A stage should be loadable without restarting the entire application.

## F. Future expansion without core-engine modifications

This requirement is especially important.

Adding a new stage should primarily involve:

1. Creating a new stage folder.
2. Adding its configuration manifest.
3. Adding original visual assets.
4. Adding its music and audio assets.
5. Configuring its environment, effects and synchronization.
6. Registering it with the content system.

The existing gameplay engine, rendering engine, menu system and scoring system should not need to be rewritten.

Build reusable environment components, material presets, particle emitters, lighting profiles and animation systems so new stages can combine them while still looking unique.

Support both reusable components and completely custom stage-specific effects.

Do not create an architecture in which every new stage requires a new hardcoded React component.

## G. Stage selection and progression

The game must automatically populate its stage-selection interface from the available stage manifests.

Provide:
- Stage artwork.
- Stage name.
- Stage description.
- Music preview.
- Environment preview.
- Locked/unlocked state.
- Completion information.
- Loading state.

Keep stage progression separate from the underlying Tetris rules.

Adding a new stage must not break existing saved progress.

## H. Custom content and future expansion

Design the content system so I can eventually add additional stages and content without changing the gameplay engine.

Support documented local content packs.

Keep original game content and third-party assets separate from the game engine, and maintain an asset-license record.

Use versioned manifests, dependency validation and clear compatibility checks.

The system should be ready for future expansion, even if there is no public mod marketplace or content browser in the initial release.

## I. Scalability acceptance test

Before declaring the architecture complete, perform this test:

Create an additional completely new stage using the documented content format.

Give it:
- A different environment.
- Different lighting.
- Different particles.
- A different block material.
- A new original music track.
- Its own beat synchronization.
- Different line-clear effects.

Add it without modifying the core Tetris gameplay engine or creating a dedicated stage-specific menu component.

Confirm that:
- The stage appears automatically in stage selection.
- Its assets load correctly.
- Music and effects synchronize.
- It can be played normally.
- It can be unloaded safely.
- Existing stages continue working.

This is the proof that the architecture is genuinely expandable.

**The long-term vision:** Tetro Effect should be a continuously expandable personal Tetris experience where I can keep introducing entirely new worlds, visual identities and music while preserving the same excellent core Tetris gameplay.

# 23. BLENDER INTEGRATION — PROFESSIONAL 3D ASSET PRODUCTION

I have Blender installed on my computer.

You have permission to use Blender as part of the Tetro Effect development process.

Blender should be considered an available professional 3D production tool, not a mandatory requirement for every visual element.

Your responsibility is to decide when Blender is the best solution and when native Three.js geometry, shaders or procedural GPU rendering are more appropriate.

## A. Inspect Blender availability

At the beginning of development:

- Check whether Blender is installed.
- Determine its executable location and version.
- Verify whether it can be launched.
- Check whether command-line background rendering and Python scripting are available.
- Test whether you can create and export a simple original 3D asset.

Use Blender's Python API for repeatable asset creation and automation where appropriate.

You may use Blender's graphical interface when necessary and when desktop interaction is available.

Do not pretend to have successfully operated Blender if access is unavailable.

## B. What Blender should create

Use Blender where it provides a meaningful quality advantage.

Examples include:

- Detailed stage environments.
- Buildings and architecture.
- Complex environmental geometry.
- Futuristic structures.
- Decorative objects.
- Original 3D block designs.
- Complex models.
- Animated background objects.
- Special environmental elements.
- Stage-specific 3D assets.
- Cinematic scene elements.

Create original artistic content with a consistent visual identity.

Do not reproduce proprietary assets from the reference game.

## C. Blender and Three.js asset pipeline

Establish a professional asset pipeline.

Blender should be the source authoring application.

Three.js should be responsible for real-time browser rendering.

Preferred delivery formats:

- GLB / glTF for 3D models and scenes.
- PNG or other appropriate formats for textures.
- WebP or compressed texture formats where appropriate.
- Optimized animation exports.

Maintain editable Blender source files for authored assets.

Example structure:

assets/
  blender/
    source/
      environments/
      blocks/
      props/
      animations/
    exports/
      glb/
      textures/
    previews/

  stages/
    luminous-tide/
    celestial-drift/
    ember-foundry/

Optimize exported assets for browser rendering.

Where beneficial, use:
- Mesh optimization.
- Texture compression.
- Texture atlases.
- Level of detail.
- Efficient materials.
- Geometry instancing.
- Proper UV mapping.
- Efficient polygon counts.

Avoid loading excessively detailed Blender models into the game when they do not provide meaningful visual improvements.

## D. Original block design

Use Blender to explore high-quality original 3D block designs.

Create a reusable block asset library that can support:

- Different surface treatments.
- Beveled geometry.
- Different material types.
- Emissive details.
- Reflective surfaces.
- Subtle metallic finishes.
- Transparent or translucent materials where appropriate.
- Stage-specific block appearances.

Maintain precise dimensions and consistent geometry so that the blocks fit the actual Tetris board.

The seven traditional tetrominoes must remain the only playable pieces.

## E. Stage production

Every stage must be capable of combining Blender-authored assets with procedural Three.js environments.

For example:

- Blender creates the detailed architectural environment.
- Three.js renders animated background elements.
- GPU shaders control atmospheric effects.
- GPU particles create floating dust and energy effects.
- The Music Director synchronizes environmental animations.
- Three.js handles real-time lighting and post-processing.

This hybrid approach should provide beautiful environments without unnecessarily increasing rendering costs.

## F. Reusable asset library

Build an expandable library of reusable assets.

Organize assets by category, visual theme, material and intended purpose.

New environments should be able to reuse individual assets without copying entire Blender scenes.

Create documented naming conventions, asset metadata and export settings.

## G. Visual quality and optimization

Do not prioritize polygon count over visual quality.

Create assets appropriate to their screen size and visual importance.

Use high-detail models for prominent objects and efficient geometry for distant environmental objects.

Avoid unnecessary textures and materials.

Profile assets in the actual browser game, not just Blender's viewport.

## H. Acceptance requirements

For the first complete release:

- Produce original Blender-authored 3D assets for the game.
- Produce at least one complete stage environment using Blender assets.
- Import and render those assets in Three.js.
- Verify materials, lighting, scale and performance.
- Confirm that stage assets can be loaded and unloaded correctly.
- Preserve editable Blender source files.

Document the Blender workflow so new assets and environments can be added in the future.

**Important:** Blender is a production tool. The final game must remain a fast, self-contained browser application and must never require Blender to be installed on the player's computer.

# 24. ADVANCED MUSIC ANALYSIS AND VLC-INSPIRED AUDIO REACTIVITY

Music visualization is one of the most important systems in Tetro Effect.

I want an intelligent, sophisticated music-reactive environment where the entire 3D world feels connected to the music.

Do not implement simple volume detection that makes everything pulse together.

Study how VLC implements audio visualization and investigate the underlying signal-processing approaches.

## A. VLC source-code investigation

Inspect the official VLC source code:

https://github.com/videolan/vlc

Pay particular attention to:

1. modules/visualization/glspectrum.c
2. modules/visualization/visual/visual.c
3. modules/visualization/goom.c
4. Related FFT implementation and windowing code used by these modules.

Investigate:

- How audio samples are collected.
- How audio channels are handled.
- How FFT processing is performed.
- How frequency bins are calculated.
- How frequency ranges are grouped into bands.
- How amplitudes are normalized.
- How smoothing is applied.
- How frequency peaks are maintained.
- How animations react to changes in frequency.
- How procedural visual effects react to music.

Understand the underlying signal-processing techniques.

Use these implementations as technical research and inspiration.

IMPORTANT: Do not blindly copy VLC's visualizations or import its rendering system into the game. Some VLC modules have GPL licensing requirements. Implement an independent audio-analysis system using browser-native technology and independently authored visual effects. Record any source code examined and review licenses before considering reuse.

## B. Browser audio-analysis architecture

Build an independent Music Analysis Engine using:

- Web Audio API.
- AudioContext.
- AnalyserNode.
- FFT-based frequency analysis.
- Time-domain waveform analysis.
- Custom signal smoothing.
- Spectral analysis.
- Beat and onset detection.
- AudioWorklet where custom processing is justified.

The analyser must process the actual audio signal being played by Tetro Effect.

Connect the audio source to an appropriate audio graph so audio playback remains unchanged while visualization data is extracted.

Use getFloatFrequencyData() and getFloatTimeDomainData() where appropriate.

Support configurable FFT sizes, including 2048 and 4096, and profile their performance and responsiveness.

Do not rely on overall volume alone.

## C. Frequency analysis

Analyze the soundtrack across multiple frequency ranges.

Create at least these independent frequency bands:

1. Sub-bass: approximately 20–60 Hz.
2. Bass: approximately 60–250 Hz.
3. Low-mid: approximately 250–500 Hz.
4. Midrange: approximately 500–2,000 Hz.
5. Upper-midrange: approximately 2,000–6,000 Hz.
6. High frequencies: approximately 6,000–16,000 Hz.

Use configurable logarithmic frequency grouping rather than dividing the FFT bins into equal-sized groups.

Calculate independent energy and amplitude information for every band.

Create normalized values that can be mapped to visual effects.

Provide:

- Raw frequency information.
- Normalized frequency energy.
- Smoothed frequency energy.
- Peak values.
- Waveform amplitude.
- Overall RMS energy.
- Transient intensity.

Handle silence, very quiet passages and high-volume passages correctly.

Avoid unstable visual output when audio levels change.

## D. Advanced audio analysis

Go beyond frequency bands.

Where beneficial, implement:

### Spectral flux
Detect sudden changes in the frequency spectrum.

Use this information to identify musical attacks and energetic events.

### Onset detection
Identify significant musical events such as drum hits, impacts and instrumental attacks.

### Beat detection
Estimate musical beat timing when track metadata is unavailable.

### BPM synchronization
Use known BPM and beat metadata whenever available.

### Beat phase
Track the current position within a musical beat.

### Spectral centroid
Estimate whether the current sound is relatively dark or bright.

### Spectral energy
Detect changes in the overall energy distribution.

### Dynamic range
Distinguish quiet passages from high-energy passages.

### Peak tracking
Maintain controlled peak values for animations.

Do not confuse a loud sound with a musical beat.

Combine audio analysis with track metadata to achieve reliable synchronization.

## E. Intelligent smoothing and response

This is critical for visual quality.

Raw FFT data is not suitable for directly controlling every 3D object.

Implement a professional audio-reactivity layer with:

- Configurable attack time.
- Configurable release time.
- Different smoothing for different frequency bands.
- Peak hold and decay.
- Adaptive normalization.
- Noise suppression.
- Sensitivity adjustment.
- Response curves.
- Minimum and maximum limits.

Bass should be able to create powerful, smooth environmental movement.

High frequencies should create delicate details rather than uncontrolled flickering.

Transient events should create immediate visual responses.

Ensure animations remain smooth between audio-analysis updates.

Use time-based smoothing rather than arbitrary frame-count-based smoothing.

## F. Music-to-world mapping system

Create a central Audio Features API.

The audio engine must publish structured data such as:

- subBass
- bass
- lowMid
- mid
- highMid
- treble
- overallEnergy
- waveformRms
- spectralFlux
- spectralCentroid
- transientIntensity
- beatDetected
- beatPhase
- beatConfidence
- estimatedBpm

The rendering engine must consume this information without accessing the audio engine's internal implementation.

Do not couple individual environment objects directly to AnalyserNode.

Build reusable mapping profiles that allow every stage to configure how the music controls its environment.

## G. Music-reactive 3D environment

Connect the analyzed music to different environmental systems.

Examples:

### Bass response
- Large environmental structures subtly expand and contract.
- Distant geometry moves.
- Atmospheric illumination changes.
- Large particle systems respond to low-frequency energy.
- Spatial energy waves travel through the environment.

### Midrange response
- Architectural details animate.
- Environmental objects move.
- Energy lines become more active.
- Floating structures respond to musical intensity.

### High-frequency response
- Fine particles become more active.
- Small lights and decorative elements react.
- Sparkling effects appear.
- Fine geometric details illuminate.

### Beat response
- Environmental lighting pulses at musical beats.
- Energy waves travel across the scene.
- Particles react to important beats.
- Selected objects perform synchronized movements.

### Transient response
- Percussion creates sharper environmental events.
- Sudden musical attacks trigger short-lived effects.
- Major transitions can activate larger visual responses.

These are examples of reusable capabilities, not mandatory effects for every stage.

Every environment should have its own artistic mapping.

Do not simply attach every frequency band to a different flashing light.

## H. Music-reactive GPU particles

Integrate audio analysis with the GPU particle engine.

Support:
- Bass-controlled particle movement.
- Beat-triggered particle bursts.
- Frequency-controlled particle velocity.
- High-frequency particle sparkle.
- Spectral-flux-driven turbulence.
- Music-driven particle density variations.
- Energy waves.
- Particle streams.
- Spatial transitions.

Make effects visually beautiful and controlled.

Avoid excessive random movement.

Use efficient shader uniforms or GPU-friendly data transfer instead of uploading large buffers unnecessarily.

## I. Music synchronization and stage metadata

Every music track should support optional metadata:

- BPM.
- Time signature.
- Beat offset.
- Bar position.
- Intro duration.
- Section markers.
- Build-up markers.
- Drop markers.
- Break markers.
- Outro markers.
- Intensity curve.

Prefer curated musical metadata for authored stage soundtracks.

For unknown music, use automatic analysis as a fallback.

When a known musical event is approaching, allow the environment to prepare an animation before the event occurs.

Make synchronization stable even when the browser frame rate fluctuates.

Use the audio clock as the timing reference, not ordinary JavaScript intervals.

## J. Music reaction presets

Create multiple configurable reactivity styles:

- Cinematic.
- Subtle.
- Energetic.
- Ambient.
- Hypnotic.
- Intense.
- Custom.

These should control sensitivity, attack, release, frequency response, particle behavior and environmental animation intensity.

Provide master controls for:

- Audio-reactivity enable/disable.
- Reactivity strength.
- Bass sensitivity.
- Treble sensitivity.
- Beat sensitivity.
- Particle response.
- Environment response.
- Lighting response.

Settings must work in real time.

## K. Music analysis debugging tool

Create an optional developer-only audio analysis dashboard.

Display:

- Live frequency spectrum.
- Six frequency-band meters.
- Waveform.
- Overall RMS.
- Spectral flux.
- Transient detection.
- BPM estimate.
- Beat phase.
- Beat confidence.
- Current stage response profile.

Include controls for adjusting sensitivity and smoothing.

This tool is essential for testing the audio system and tuning the experience.

It must not be visible in ordinary gameplay unless explicitly enabled.

## L. Performance

Audio analysis must not block the gameplay engine or the Three.js rendering loop.

Avoid unnecessary memory allocations.

Reuse typed arrays.

Analyze only as frequently as necessary.

Use AudioWorklet for custom audio processing where it provides a measurable advantage.

Keep audio processing independent of React rendering.

Gracefully handle browsers that suspend or interrupt AudioContext.

## M. Audio input limitations

The primary source of music analysis must be Tetro Effect's own audio engine.

Also architect the system to support future user-selected music files.

Do not assume a browser can automatically inspect arbitrary audio from another desktop application such as VLC.

External system audio requires explicit user-mediated capture and browser permission where supported.

## N. Acceptance testing

Test the system using multiple different music styles:

- Electronic.
- Ambient.
- Orchestral.
- Cinematic.
- Percussion-heavy.
- Bass-heavy.
- Slow music.
- Fast music.
- Music with significant quiet passages.

Verify that the system reacts appropriately to each.

Confirm that bass, midrange and treble produce distinguishable visual responses.

Confirm that beat-triggered effects are synchronized and do not drift.

Confirm that the environment remains visually attractive during quiet passages.

Confirm that visual effects remain smooth at high refresh rates.

**The final objective:** Music should feel like the living force behind each stage. The world should breathe, move, illuminate, expand and transform in response to the actual musical content, with sophisticated frequency analysis rather than basic volume-based animation.

## FINAL INSTRUCTION

I do not want a quick Tetris clone.

I want a complete, beautiful, responsive, immersive 3D rhythm-puzzle game that is enjoyable enough to become a regular part of my daily gaming.

Give the greatest attention to gameplay feel, beautiful 3D block design, immersive environments, sophisticated particles, music synchronization, line-clear feedback, controller support, configuration and performance.

Think like a professional game studio.

Build it properly.

Begin with repository inspection and the reference-game investigation. Then implement the project milestone by milestone, testing the actual application throughout development.