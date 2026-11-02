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

# 25. WORLD-CLASS 3D STAGES, UNIQUE WORLDS AND LIVING ENVIRONMENTS

## THE CREATIVE VISION

I want Tetro Effect to deliver a breathtaking, premium-quality 3D audiovisual experience.

Every stage must feel like entering a completely different world.

I do not want ordinary Tetris backgrounds, flat illustrations, simple skyboxes or generic particle effects.

I want genuinely beautiful and immersive 3D environments containing:

- Detailed 3D architecture.
- Beautifully designed landscapes.
- Unique environmental objects.
- Animated 3D creatures.
- Procedural particle formations.
- Volumetric-looking atmospheric effects.
- Floating particles and dust.
- Carefully designed lighting.
- Environmental animations.
- Unique block materials.
- Stage-specific music.
- Music-reactive environmental behavior.
- Cinematic stage transitions.

Each world should feel alive even when the player is not moving any pieces.

The visual quality must be comparable to a professionally produced modern 3D game.

Use Blender, Three.js, custom shaders, GPU particle systems and procedural animation together.

The environments and artistic content must be original. Use the general themes below as creative direction, not as instructions to reproduce proprietary scenes, models, effects or compositions from another game.

---

# 1. ICE WORLD — FROZEN KINGDOM

Create an extraordinarily beautiful frozen environment.

### Environment
- Huge frozen mountains in the distance.
- Giant translucent ice formations.
- Frozen architectural structures.
- Crystalline formations.
- Frozen lakes.
- Snow-covered landscapes.
- Floating ice fragments.
- Beautiful blue and cyan atmospheric lighting.
- Aurora-like illumination in the sky.
- Slowly moving icy particles.

### Animated objects
- Ice crystals forming and dissolving.
- Small floating ice fragments.
- Frozen structures with subtle internal illumination.
- Snowstorms moving through the environment.
- Original particle-based arctic creatures moving in the distance.

### Tetris blocks
Create special ice-themed versions of all seven tetrominoes.

The blocks should look like actual three-dimensional ice cubes.

Features:
- Translucent icy surfaces where rendering allows.
- Frosted glass appearance.
- Internal crystalline structures.
- Frozen edges.
- Subtle blue illumination.
- Refraction-inspired visual treatment.
- Surface imperfections.
- Snow-like details.

Maintain strong visual distinction between all seven tetromino colors.

### Line-clear effects
- Blocks dissolve into thousands of tiny ice particles.
- Small crystalline fragments scatter.
- A cold energy wave travels through the environment.
- Beautiful frost and snow effects.
- Stronger crystalline explosions for multiple-line clears.

### Music
Create an original atmospheric soundtrack with delicate electronic elements, spacious textures and cinematic orchestration.

The music should influence snow movement, ice illumination and particle behavior.

---

# 2. JAPAN WORLD — ANCIENT WOOD AND SAKURA

Create a beautiful, atmospheric Japanese-inspired world.

### Environment
- Traditional wooden architectural structures.
- Japanese-inspired bridges.
- Wooden temples.
- Cherry blossom trees.
- Mountain silhouettes.
- A peaceful Japanese garden.
- Flowing water.
- Lanterns.
- Floating petals.
- Distant wooden buildings.
- Atmospheric mist.

### Animated objects
- Cherry blossom petals drifting through the environment.
- Trees moving gently in the wind.
- Floating lanterns.
- Animated water.
- Original particle formations resembling birds.
- Small distant figures or creatures moving through the environment where appropriate.

### Tetris blocks
Create wooden tetromino blocks.

Materials:
- Beautiful natural wood grain.
- Dark polished wood.
- Warm wooden edges.
- Subtle carved patterns.
- Fine surface detail.
- Soft reflections.

Use distinct wood tones for the seven tetrominoes.

The blocks must look like individually crafted 3D wooden objects.

### Line-clear effects
- Blocks dissolve into floating wooden dust and glowing particles.
- Sakura petals scatter across the environment.
- Warm light moves through the scene.
- Elegant energy waves.
- Visually satisfying combination effects.

### Music
Create original Japanese-inspired ambient music using an appropriate mix of traditional-inspired instruments and modern cinematic electronic elements.

Avoid using copyrighted existing compositions.

Synchronize blossom movement, lantern illumination and environmental animations with the soundtrack.

---

# 3. DESERT WORLD — THE MOVING SANDS

This should be one of the most visually spectacular environments.

### Environment
- Huge realistic sand dunes.
- Beautiful desert mountains.
- Distant sandstone formations.
- Ancient-looking architectural structures.
- Atmospheric sunlight.
- A warm glowing horizon.
- Moving sandstorms.
- Floating golden particles.
- Heat-haze-inspired effects.
- A vast sense of spatial depth.

### Animated 3D camels — IMPORTANT

I specifically want beautiful 3D camels walking through the desert environment.

Do not simply place static camel models into the scene.

Create original animated camel formations that move naturally across the distant desert.

The visual treatment should combine:

- Three-dimensional recognizable camel silhouettes.
- Thousands of small glowing sand and gold particles.
- Particle-based surface detail.
- Organic particle movement.
- Animated legs and body motion.
- Natural walking cycles.
- Moving particle trails.
- Dust rising from the ground beneath their feet.
- Gradual appearance and disappearance in the desert atmosphere.

Experiment with combining Blender-authored camel geometry, skeletal animation and Three.js GPU particles.

One approach is to distribute particles across the animated camel surface, making the creature look as though it is constructed from a living cloud of glowing sand.

The particles should follow the camel's underlying animation rather than moving randomly.

Create variations:
- A solitary camel crossing a dune.
- Small groups of camels walking together.
- Distant caravans moving slowly.
- Camels occasionally disappearing behind dunes or atmospheric dust.

Use intelligent animation timing and different walking speeds.

These should be beautiful environmental spectacles, not gameplay obstacles.

### Tetris blocks

The seven tetrominoes should look like beautifully crafted sandstone or desert crystal blocks.

Features:
- Warm sandstone surfaces.
- Fine grain and erosion.
- Subtle golden illumination.
- Carved edge details.
- Natural stone imperfections.
- Appropriate specular response.

Maintain clearly recognizable seven-piece color identities.

### Line-clear effects
- Blocks break into thousands of golden sand particles.
- Sand particles form swirling spirals.
- Golden energy waves travel across the board.
- Dust disperses into the environment.
- More powerful effects for combos and four-line clears.

### Music
Create an original cinematic desert soundtrack using atmospheric percussion, warm synths and appropriate acoustic-inspired textures.

Music should control sandstorms, camel movement intensity, particle behavior and the illumination of the desert.

---

# 4. DARK SPACE WORLD — DEEP COSMOS

Create an immense cosmic environment.

### Environment
- Deep space.
- Beautiful nebulae.
- Distant galaxies.
- Large planets.
- Floating asteroids.
- Cosmic dust fields.
- Glowing stars.
- Energy structures.
- Slowly moving celestial objects.
- Rich volumetric-looking atmospheric effects.

The background should create a powerful sense of scale.

### Animated objects
- Slowly rotating planets.
- Moving asteroids.
- Particle-based cosmic formations.
- Energy streams.
- Nebulae evolving over time.
- Original abstract space creatures made from particles.
- Occasional meteor trails.

### Tetris blocks
Create cosmic-themed tetrominoes.

Features:
- Deep translucent materials.
- Glowing internal energy.
- Small star-like particles.
- Nebula-inspired surface patterns.
- Subtle emissive edges.
- Beautiful reflections.
- Different material treatments for all seven pieces.

### Line-clear effects
- Blocks dissolve into cosmic particles.
- Energy waves propagate into space.
- Small stars burst outward.
- Intense multi-line clear effects resemble controlled cosmic explosions.

### Music
Create original atmospheric electronic and cinematic space music.

Music should influence the nebulae, cosmic particles, lighting and moving celestial structures.

---

# 5. MOUNTAIN WORLD — ALPINE HORIZON

Create an expansive mountainous landscape.

### Environment
- Large mountain ranges.
- Detailed peaks.
- Forest-covered slopes.
- Valleys.
- Rivers.
- Waterfalls.
- Distant clouds.
- Atmospheric fog.
- Snow on distant mountain tops.
- Sunrise and sunset lighting variations.

Give the environment several layers of depth.

### Animated objects
- Flying birds.
- Moving clouds.
- Waterfalls.
- Wind moving through trees.
- Original particle-based mountain wildlife.
- Floating atmospheric dust and pollen.

### Tetris blocks
Create natural mountain-inspired stone and crystal blocks.

Features:
- Beautiful stone surfaces.
- Subtle mineral patterns.
- Crystalline edges.
- Detailed materials.
- Natural color variations.
- Controlled illumination.

### Line-clear effects
- Blocks break into mineral particles.
- Small rock fragments disperse.
- Energy pulses travel through the mountains.
- Environmental particles respond to the impact.

### Music
Original atmospheric orchestral and ambient mountain music.

Use music to influence cloud movement, wind, lighting and environmental animation.

---

# 6. OCEAN WORLD — THE ABYSS

Create a beautiful underwater 3D environment.

### Environment
- Deep blue underwater scenery.
- Coral formations.
- Underwater mountains.
- Beautiful marine landscapes.
- Sunlight filtering through water.
- Caustic-inspired lighting patterns.
- Floating bubbles.
- Underwater plants.
- Distant underwater structures.
- Subtle atmospheric fog.

### Animated creatures

Populate the environment with original animated aquatic creatures.

Examples:
- Schools of small fish.
- Large distant fish.
- Jellyfish.
- Rays.
- Sea turtles.
- Other original marine-inspired creatures.

Create natural swimming motion.

Use animated 3D geometry combined with particle systems.

Fish should move in coordinated formations where appropriate.

### Tetris blocks

Create beautifully designed transparent and translucent ocean-inspired blocks.

Features:
- Aquatic blue and turquoise materials.
- Glass-like surfaces.
- Internal glowing details.
- Water-inspired reflections.
- Bubble-like particles inside the materials.
- Subtle surface distortion.
- Elegant illuminated edges.

Every tetromino must remain recognizable and distinguishable.

### Line-clear effects
- Blocks dissolve into water-like particles.
- Bubbles rise.
- Blue energy waves spread across the environment.
- Light rays intensify.
- Water-like particle streams react to combos.

### Music
Create original atmospheric underwater electronic music.

Synchronize bubbles, marine life, lighting and environmental movement.

---

# 7. FOREST WORLD — ENCHANTED WILDERNESS

Create a lush, atmospheric 3D forest.

### Environment
- Giant trees.
- Deep forest landscapes.
- Beautiful green vegetation.
- Moss-covered rocks.
- Streams and waterfalls.
- Sunlight rays through tree canopies.
- Floating pollen.
- Fireflies.
- Atmospheric fog.
- Distant hills.

### Animated objects
- Glowing fireflies.
- Birds.
- Butterflies.
- Moving leaves.
- Original particle-based forest creatures.
- Swaying vegetation.

### Tetris blocks
Create beautiful natural crystal and emerald-inspired blocks.

Features:
- Green crystalline materials.
- Organic patterns.
- Subtle glowing surfaces.
- Moss-inspired detail where appropriate.
- Translucency and reflective highlights.

### Line-clear effects
- Blocks dissolve into luminous green particles.
- Fireflies scatter.
- Leaves drift across the scene.
- Natural energy waves spread into the forest.

### Music
Original organic ambient music with atmospheric electronic textures.

---

# 8. VOLCANIC WORLD — EMBER CORE

Create a powerful volcanic environment.

### Environment
- Massive volcanic structures.
- Flowing lava.
- Dark volcanic rocks.
- Glowing cracks.
- Floating embers.
- Volcanic smoke.
- Molten formations.
- Dramatic red-orange lighting.

### Animated objects
- Lava flows.
- Sparks.
- Molten fragments.
- Rising smoke.
- Original fiery particle creatures.
- Subtle movement in distant volcanic structures.

### Tetris blocks
Create volcanic stone blocks with glowing molten interiors.

Features:
- Dark obsidian-style surfaces.
- Glowing red-orange cracks.
- Molten emissive interiors.
- Subtle heat-inspired effects.

### Line-clear effects
- Blocks fragment into glowing embers.
- Energy bursts travel across the playfield.
- Molten particles disperse.
- Larger clears generate powerful but controlled volcanic effects.

### Music
Original intense cinematic electronic music.

---

# 9. AURORA WORLD — NORTHERN LIGHTS

Create a beautiful, dreamlike northern environment.

### Environment
- Snowy landscapes.
- Distant mountains.
- Dark atmospheric sky.
- Large animated aurora formations.
- Stars.
- Frozen structures.
- Floating glowing particles.

### Animated objects
- Aurora waves.
- Light streams.
- Snow particles.
- Distant wildlife.
- Original luminous particle formations.

### Tetris blocks
Create colorful translucent crystal blocks with subtle internal light.

### Line-clear effects
- Crystalline light bursts.
- Aurora-like energy waves.
- Particles scatter and reform.
- Atmospheric light intensifies.

### Music
Original beautiful atmospheric electronic music with cinematic ambience.

---

# 10. JAPANESE NIGHT WORLD — NEON TOKYO

Create an original futuristic Japanese-inspired city at night.

### Environment
- Dense futuristic architecture.
- Neon signs with original fictional designs.
- Rain-slick reflective surfaces.
- Elevated structures.
- Glowing streets.
- Moving vehicles in the distance.
- Light trails.
- Atmospheric rain.
- Deep urban perspective.

### Animated objects
- Flying vehicles.
- Animated distant buildings.
- Rain.
- Moving light formations.
- Original particle-based urban effects.

### Tetris blocks
Create polished neon-glass blocks with controlled emissive details.

### Line-clear effects
- Blocks dissolve into luminous digital particles.
- Neon energy pulses travel through the environment.
- Bright city lights respond to major clears.

### Music
Original futuristic electronic soundtrack.

---

# 11. OTHER FUTURE WORLDS

Do not restrict the game to these ten environments.

The architecture must support additional original stages such as:

- Ancient Egypt.
- Tropical rainforest.
- Crystal caves.
- Floating islands.
- Celestial gardens.
- Futuristic underwater cities.
- Dreamlike surreal worlds.
- Mechanical cities.
- Sunset landscapes.
- Deep jungle.
- Space stations.
- Abstract geometric dimensions.

New worlds must be addable through the established content architecture.

---

# 12. THE LIVING CREATURE SYSTEM

Create a reusable environment-creature framework.

This is particularly important for the camels in the Desert stage.

Creatures should not be simple static models.

Create a flexible system supporting:

- Blender-authored models.
- Skeletal animation.
- Procedural movement.
- Particle-based surface representations.
- GPU particle motion.
- Natural movement cycles.
- Environment-specific behavior.
- LOD.
- Distance-based animation quality.
- Visibility and resource management.

Support particles attached to animated geometry.

For particle creatures, investigate sampling particle positions from animated mesh surfaces or using a stable particle simulation that follows the underlying animation.

Create particle representations that preserve the recognizable silhouette and anatomy of each creature.

Use proper 3D models as a structural foundation where necessary, then enhance them with particles to achieve the desired magical appearance.

Do not try to simulate millions of individually updated particles on the CPU.

Use GPU-friendly techniques.

Creatures are part of the world and must never interfere with the Tetris playfield or gameplay controls.

---

# 13. STAGE-SPECIFIC TETROMINO MATERIAL SYSTEM

Every environment must be able to change the appearance of the seven traditional Tetris pieces.

The gameplay geometry and rules must never change.

Only the visual materials, surface detail and optional decorative effects change.

Create a reusable BlockTheme system.

Each theme controls:

- Base material.
- Surface properties.
- Color palette.
- Roughness.
- Metalness.
- Transparency.
- Emissive intensity.
- Edge appearance.
- Surface texture.
- Internal visual effects.
- Optional particles.
- Line-clear shader.
- Landing effects.
- Spawn animation.

Examples:

ICE: Translucent frozen crystal blocks.

JAPAN WOOD: Beautiful natural wooden blocks with detailed grain.

DESERT: Sandstone and golden mineral blocks.

DARK SPACE: Cosmic crystal blocks with internal stars.

MOUNTAINS: Natural minerals and polished stone.

OCEAN: Translucent aquatic blocks with subtle internal bubbles.

FOREST: Emerald and organic crystal blocks.

VOLCANIC: Dark obsidian blocks with glowing lava cracks.

NEON CITY: Polished luminous glass blocks.

The same seven tetrominoes must remain immediately identifiable in every visual theme.

Use a consistent color identity or secondary visual markings so two adjacent pieces are never difficult to distinguish.

Include a classic block appearance option for players who prefer traditional colors.

---

# 14. STRICT VISUAL QUALITY REQUIREMENTS

Do not treat the environments as simple background assets.

Each stage must have a real 3D scene with depth, perspective, lighting and animation.

Use a proper combination of:

- Blender-authored 3D geometry.
- Procedural Three.js objects.
- Custom shaders.
- GPU particles.
- Animated models.
- Volumetric-inspired effects.
- Advanced lighting.
- Post-processing.
- Carefully designed materials.

Use photographic and real-world visual references for artistic inspiration where appropriate.

Aim for professional environmental art direction.

Do not use low-quality generic stock assets.

Do not use obvious placeholders in completed stages.

Do not simply recolor the same 3D scene ten times.

Every stage must have its own strong artistic identity.

Use Blender for detailed and complex original assets, and Three.js for real-time procedural and interactive elements.

All assets should be optimized for the web.

Keep editable Blender source files.

---

# 15. STAGE TRANSITIONS AND IMMERSION

When entering another stage, the player should feel like moving into an entirely new world.

Create cinematic but responsive transitions.

Examples:

- Ice crystals grow around the playfield as the Ice world loads.
- Sand and golden particles sweep into the Desert environment.
- Stars expand into view when entering Dark Space.
- Cherry blossom petals drift into the Japan environment.
- Water-like light and bubbles reveal the Ocean world.
- Aurora formations illuminate the Northern Lights stage.

Transitions must support:

- Preloading.
- Loading progress.
- Asset preparation.
- Music transitions.
- Environment transitions.
- Smooth visual state changes.

Do not freeze gameplay or create unnecessary loading delays.

---

# 16. EACH STAGE MUST HAVE ITS OWN COMPLETE EXPERIENCE

Every completed stage must include:

1. Original 3D environment.
2. Distinct artistic identity.
3. Unique environmental objects.
4. Animated environmental elements.
5. At least one meaningful original animated creature or environmental spectacle where appropriate.
6. Unique block materials.
7. Dedicated particle effects.
8. Original or properly licensed music.
9. A music-reactivity profile.
10. Dedicated line-clear effects.
11. Landing and spawning effects.
12. Original lighting.
13. A stage preview image.
14. A functional stage manifest.
15. Properly optimized assets.

Do not claim a stage is complete simply because its name appears in the stage-selection menu.

---

# 17. FINAL ARTISTIC ACCEPTANCE TEST

For each stage, inspect the actual running browser game.

Evaluate:

- Does the environment have real 3D depth?
- Does it have its own identity?
- Are the details visually attractive?
- Does the environment feel alive?
- Are the creatures recognizable and animated correctly?
- Do the particles look intentional and sophisticated?
- Do the Tetris blocks match the environment?
- Are the blocks still easy to distinguish?
- Do the line-clear effects feel satisfying?
- Does music meaningfully affect the environment?
- Does the stage perform smoothly?
- Does the playfield remain readable?
- Does the result feel professionally designed rather than procedurally generated without artistic direction?

Capture screenshots and short gameplay recordings for each environment.

Compare the results against the artistic brief and improve the weak stages.

**FINAL CREATIVE DIRECTION:**

I want each Tetro Effect stage to feel like a small living universe.

When I enter the Desert, I should see the desert, moving camels, sand particles and sandstone blocks.

When I enter the Ice world, I should feel surrounded by ice, snow, crystals and frozen environments.

When I enter the Ocean, I should feel underwater, surrounded by marine life and aquatic lighting.

When I enter Dark Space, I should feel surrounded by a vast cosmic world.

The Tetris gameplay remains exactly what I enjoy: the seven traditional tetrominoes, the familiar falling-block mechanics and satisfying line clears.

Everything surrounding that gameplay should be extraordinarily beautiful.

This is not a collection of background themes.

This is a complete, expandable 3D audiovisual world built around authentic Tetris gameplay.

# 26. FULL VIRTUAL REALITY IMPLEMENTATION — WEBXR

## PROJECT OBJECTIVE

I own a VR headset and want Tetro Effect to support a complete immersive virtual reality experience directly through a web browser.

VR is a major feature of this project, not a small experimental extra.

I want to enter the Tetro Effect world, see the Tetris playfield in real 3D space, look around the environment, experience the surrounding animated worlds, listen to music and play the actual Tetris game using my VR controllers.

The VR experience must feel like a professionally developed VR game.

It must support the same seven-piece traditional Tetris gameplay as desktop mode.

Do not introduce another puzzle genre, rhythm-slicing game or alternative block mechanics.

The same game must operate in:
- Normal desktop mode.
- Fullscreen desktop mode.
- Immersive VR mode.

All three must share the same gameplay engine, progression, stages, settings, audio engine and scoring system.

## A. RESEARCH MOON RIDER — MANDATORY

Study this repository before implementing VR:

https://github.com/supermedium/moonrider

Repository:

https://github.com/supermedium/moonrider/tree/master

Moon Rider is an important reference for implementing immersive browser-based VR.

Investigate its architecture, paying attention to:

- WebXR initialization.
- VR session handling.
- Headset tracking.
- Stereo rendering.
- Camera management.
- Controller recognition.
- Controller input.
- VR interaction.
- Spatial user interfaces.
- 3D environmental scenes.
- Music-driven visual experiences.
- VR-compatible asset presentation.
- Performance considerations.
- Transitions between application states.

Examine relevant source files and components rather than relying exclusively on the README.

Create:

VR_REFERENCE_RESEARCH.md

Document the relevant techniques, findings, advantages and limitations.

IMPORTANT:

Moon Rider uses A-Frame. Our application uses React, TypeScript and Three.js.

Do not replace our application architecture with A-Frame simply because Moon Rider uses it.

Translate the useful concepts into our existing Three.js architecture.

Use independently implemented components unless there is a specific, justified reason to reuse compatible MIT-licensed code. If code is reused, preserve its copyright and license notices.

## B. WEBXR ARCHITECTURE

Use the WebXR Device API and Three.js WebXR integration.

Implement a dedicated VR subsystem.

Responsibilities should include:

- Headset capability detection.
- WebXR session initialization.
- VR session lifecycle.
- Stereo rendering.
- Head tracking.
- Reference-space management.
- Controller recognition.
- VR input mapping.
- Controller visual representation.
- VR user interface.
- VR performance management.
- Session exit and restoration.

Create a reusable XRManager or equivalent system.

The rest of the application must not depend directly on WebXR implementation details.

Use current stable Three.js APIs and official examples.

Investigate:
- WebXR Device API.
- Three.js WebXRManager.
- Three.js VRButton.
- XRSession.
- XRReferenceSpace.
- XRInputSource.
- XRFrame.
- WebXR Gamepads Module.

Use runtime feature detection rather than assuming every headset or browser supports the same capabilities.

## C. RENDERER COMPATIBILITY — VERY IMPORTANT

The existing project uses a WebGPU-preferred rendering architecture.

However, WebGPU and WebXR support must be treated as separate compatibility questions.

Do not assume that because a VR button accepts a WebGPURenderer, every headset/browser combination supports WebGPU immersive rendering.

Build a renderer abstraction that can select the most appropriate rendering backend.

Preferred strategy:

1. Desktop: WebGPU where supported, with WebGL 2 fallback.
2. VR: use a verified WebXR-compatible rendering backend.
3. Support WebGL 2 VR rendering as the reliable compatibility path.
4. Enable WebGPU-based VR rendering only where the exact browser, headset and Three.js implementation have been tested successfully.

This is particularly important for standalone headsets such as Meta Quest.

Maintain the same gameplay engine, scene data, stage definitions, materials and visual identity across rendering backends.

Create compatible fallback implementations for custom shaders and visual effects when necessary.

Do not compromise VR compatibility to force WebGPU.

## D. VR SESSION AND DEVICE DETECTION

When the user opens Tetro Effect:

- Detect whether WebXR is available.
- Check whether immersive-vr is supported.
- Detect available XR input sources.
- Provide an Enter VR button when supported.
- Clearly explain when VR is unavailable.
- Provide normal desktop gameplay regardless of VR availability.

Use appropriate WebXR capability checks.

Do not rely on browser user-agent strings alone.

The user must explicitly activate the VR session through a user gesture.

Handle:
- Session start.
- Session end.
- Session interruption.
- Browser focus changes.
- Headset disconnection.
- Controller disconnection.
- Rendering errors.
- Unsupported VR capabilities.

When exiting VR, restore normal desktop gameplay without restarting the game.

Do not lose the current game state or score.

## E. VR ENVIRONMENT AND PLAYFIELD DESIGN

This is one of the most important artistic requirements.

I do not want a flat 2D Tetris board floating awkwardly in front of my face.

Create an actual spatial 3D Tetris playfield.

The playfield should have:

- Proper 3D depth.
- Carefully designed proportions.
- Realistic-looking 3D tetrominoes.
- Beautiful materials.
- Subtle lighting.
- Spatial shadows.
- Atmospheric environmental lighting.
- Beautiful particle effects.
- Depth between the board and the surrounding world.

Make it feel like an immersive physical Tetris installation inside the stage environment.

The board should be positioned at a comfortable viewing distance and height.

Use real-world scale consistently, with Three.js world units treated as meters.

Provide a comfortable seated configuration as the primary default, with an optional standing configuration.

Allow the user to adjust:
- Board distance.
- Board height.
- Board scale.
- Board position.
- Board tilt.
- HUD distance.
- HUD scale.

Include a reset-to-comfortable-position option.

The board must remain stable and easy to play.

Head movement should control the viewing direction, not rotate the Tetris board or cause the gameplay to become disorienting.

## F. IMMERSIVE STAGE ENVIRONMENTS

All existing stages must support VR.

This includes:

- Ice.
- Japan Wood.
- Desert.
- Dark Space.
- Mountains.
- Ocean.
- Forest.
- Volcanic.
- Aurora.
- Neon City.
- All future stages.

The VR version should not be a separate simplified collection of backgrounds.

The player should experience the actual 3D environment surrounding the Tetris board.

Examples:

ICE:
- Large frozen structures.
- Crystalline geometry.
- Snow particles.
- Glowing ice formations.
- Three-dimensional icy block materials.

JAPAN:
- Beautiful traditional-inspired architecture.
- Cherry blossom trees.
- Floating petals.
- Wooden structures.
- Animated lanterns.

DESERT:
- Vast sand dunes.
- Sandstorms.
- Distant 3D camels.
- Particle-based camel formations.
- Golden atmospheric lighting.

DARK SPACE:
- Planets.
- Nebulae.
- Stars.
- Floating asteroids.
- Cosmic particles.

OCEAN:
- Underwater environments.
- Marine life.
- Schools of fish.
- Jellyfish.
- Floating bubbles.
- Underwater lighting.

Each stage should surround the player in a spatial environment.

Use stereoscopic depth intelligently.

Do not place important particles or extremely bright elements directly against the eyes or excessively close to the viewer.

## G. VR GAMEPLAY AND CONTROLLER SUPPORT

Implement proper VR controller support.

Recognize available XR controllers using WebXR input sources.

Support appropriate controllers from:
- Meta Quest.
- Valve Index.
- HTC Vive.
- Other compatible WebXR devices.

Do not assume every headset uses identical button layouts.

Use controller profiles and available Gamepad information to identify controls.

Create a unified VR gameplay input mapping.

Suggested default controls:

LEFT CONTROLLER:
- Left directional input: Move piece left.
- Right directional input: Move piece right.
- Main button: Rotate counterclockwise.
- Secondary button: Hold piece.

RIGHT CONTROLLER:
- Main button: Rotate clockwise.
- Secondary button: Hard drop.
- Trigger or designated input: Soft drop.
- Menu button: Pause, where available.

Provide editable mappings.

Every control must be configurable.

Support:
- Analog sticks.
- D-pads.
- Controller buttons.
- Trigger inputs.
- Input buffering.
- Controller reconnecting.
- Custom sensitivity.
- Input repeat.
- Vibration where available.

Prevent unwanted simultaneous inputs.

Display the detected controller status in settings.

## H. INTERACTIVE VR MENUS

Create dedicated VR-friendly menus.

The user must be able to navigate menus without removing the headset.

Implement:
- Main menu.
- Stage selection.
- Game mode selection.
- Settings.
- Audio settings.
- Graphics settings.
- Controller configuration.
- Pause menu.
- Results screen.

Use 3D spatial UI panels.

Make them readable and easy to interact with.

Support controller raycasting and selection.

Use appropriate controller interaction feedback.

Optional hand tracking may be supported where available, but it must not be required for playing the game.

Keep the VR interface elegant and consistent with the Tetro Effect visual identity.

Do not simply display a desktop web page inside the headset.

## I. VR HUD

Create an immersive HUD with:

- Tetris playfield.
- Next-piece preview.
- Hold-piece preview.
- Score.
- Level.
- Lines cleared.
- Combo information.
- Timer.
- Pause access.

Position auxiliary information around the playfield without obstructing gameplay.

Keep typography readable at the intended viewing distance.

Allow the player to adjust HUD distance and scale.

Provide the option to hide secondary HUD elements.

Make sure all important game information can be understood comfortably without continuously moving the head.

## J. MUSIC AND SPATIAL AUDIO IN VR

Integrate the existing Audio Engine and Music Director.

Do not create another independent music engine for VR.

The same audio analysis data must drive the desktop and VR environments.

Support:
- Music playback.
- Sound effects.
- Ambient environmental audio.
- Music reactivity.
- Frequency analysis.
- Beat synchronization.
- Spatial audio.
- Appropriate stereo positioning.
- Volume adjustment.

Use spatial audio where it meaningfully improves immersion.

Examples:

Desert:
- Wind surrounding the environment.
- Distant environmental sounds.
- Spatial camel movement audio where appropriate.

Ocean:
- Underwater ambient sounds.
- Spatial creature sounds.
- Bubbles and environmental effects.

Forest:
- Birds.
- Wind.
- Water.
- Environmental ambience.

Music should remain the main musical experience.

Do not make the sound unnecessarily overwhelming or spatially confusing.

## K. PERFORMANCE AND FRAME RATE

VR performance is more demanding than normal desktop rendering.

Rendering must remain smooth and stable to minimize discomfort.

Use the refresh rate supported by the active headset/runtime.

Profile:
- CPU frame time.
- GPU frame time where measurable.
- Frame timing stability.
- Render resolution.
- Draw calls.
- Particle count.
- Shader complexity.
- Texture memory.
- Stereo rendering overhead.

Create VR-specific graphics profiles:

- VR Low.
- VR Medium.
- VR High.
- VR Ultra.
- VR Custom.

Allow adjustment of:
- Render resolution scale.
- Particle density.
- Shadow quality.
- Environment detail.
- Reflection quality.
- Post-processing.
- Antialiasing.
- Bloom.
- Environmental animation intensity.

Do not assume desktop graphics presets will work efficiently in VR.

Preserve the visual identity of every stage while offering appropriately optimized effects.

Use instancing, GPU particles and efficient scene management.

Avoid unnecessary overdraw and excessively transparent overlapping particles.

Do not allocate unnecessary memory every frame.

Do not allow visual effects to block input or Tetris gameplay.

## L. VR COMFORT AND MOTION SICKNESS PREVENTION

Comfort is mandatory.

The game should be designed primarily around a stationary seated experience.

Implement:

- Stable player position.
- Stable playfield.
- Stationary camera position in the environment.
- Optional seated and standing layouts.
- Adjustable viewing distance.
- Adjustable board height.
- Reduced-motion mode.
- Reduced particles.
- Reduced camera effects.
- Disable camera shake in VR by default.
- Disable motion blur in VR by default.
- Avoid forced locomotion.
- Avoid artificial camera acceleration.
- Avoid abrupt perspective changes.
- Avoid unnecessary flashing.
- Avoid intense full-field visual effects.

Do not move the player's viewpoint in response to gameplay or music.

The stage may animate and evolve, but the user's viewpoint must remain comfortable and stable.

Use smooth fades for stage transitions.

Allow the player to exit VR immediately.

Do not require the user to physically walk around to play Tetris.

## M. VR SETTINGS

Add a dedicated VR settings category.

Include:

- Enter VR.
- Exit VR.
- Seated mode.
- Standing mode.
- Board height.
- Board distance.
- Board scale.
- Board tilt.
- HUD scale.
- HUD distance.
- Controller remapping.
- Controller sensitivity.
- Controller vibration.
- Graphics quality.
- Render scale.
- Particle density.
- Reduced motion.
- Environment intensity.
- Audio settings.
- Reset VR configuration.

All configuration must persist.

## N. WEBXR SECURITY AND PRIVATE ACCESS

WebXR requires appropriate secure-context support and browser permissions.

Support HTTPS for private online access.

Development should support localhost or another properly configured secure local setup.

Do not disable browser security restrictions.

Do not create a publicly accessible deployment.

Do not assume a secret URL makes a private website secure.

Keep the repository private and protect any online deployment with real access control.

## O. VR DEVELOPMENT AND TESTING

Use the following resources:

Three.js WebXR documentation:
https://threejs.org/manual/pages/how-to-create-vr-content.html

Three.js VRButton:
https://threejs.org/docs/pages/VRButton.html

Three.js WebXRManager:
https://threejs.org/docs/pages/WebXRManager.html

MDN WebXR documentation:
https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API

Moon Rider:
https://github.com/supermedium/moonrider

Meta Quest Browser documentation:
https://developers.meta.com/vr/documentation/web/browser-specs/

Also investigate the Meta Quest Immersive Web Emulator:
https://github.com/meta-quest/immersive-web-emulator

Use the emulator for early WebXR interaction testing where appropriate.

However, emulation is not proof of real-world headset performance or compatibility.

Test on an actual headset before declaring VR complete.

## P. VR ACCEPTANCE TESTS

Verify the following:

1. The application detects immersive VR support.
2. The user can enter VR.
3. Both eyes render correctly.
4. Head tracking works.
5. The 3D environment displays correctly.
6. The Tetris board is positioned comfortably.
7. All seven tetrominoes render correctly.
8. All Tetris rules work correctly.
9. Controller inputs work.
10. All game controls can be remapped.
11. Menus are navigable.
12. The HUD is readable.
13. Music plays correctly.
14. Music-reactive effects work.
15. Stage transitions work.
16. The game pauses correctly.
17. VR exit works.
18. Desktop gameplay resumes correctly.
19. Settings are saved.
20. Rendering remains stable during extended gameplay.

Test all available supported rendering backends separately.

Document which headset, browser, renderer and refresh settings were actually tested.

Do not claim support for a headset that has not been tested.

## Q. REQUIRED DELIVERABLES

Provide:

- VR_REFERENCE_RESEARCH.md
- VR_ARCHITECTURE.md
- VR_SETTINGS.md
- VR_TESTING.md
- Complete WebXR integration.
- VR controller support.
- VR-compatible 3D stage environments.
- VR-friendly HUD.
- Spatial menus.
- VR graphics profiles.
- Desktop-to-VR session transitions.
- Documented setup instructions.

## FINAL REQUIREMENT

I want to put on my VR headset, open Tetro Effect in the browser, enter a beautiful 3D world and play authentic Tetris.

I want the Tetris playfield to feel like an actual three-dimensional object in the environment.

I want to see beautiful landscapes surrounding me, animated creatures, sophisticated particles, detailed blocks, changing lights and music-reactive effects.

I want proper VR controller support.

I want to play the same Tetris game I enjoy, but in an immersive world.

Do not build a VR technology demonstration.

Build a complete VR version of Tetro Effect that shares the quality, features and gameplay of the desktop version.

VR is a first-class game mode, not an afterthought.

# 27. PROFESSIONAL ORIGINAL SOUNDTRACK AND STAGE-SPECIFIC SOUND DESIGN

## CREATIVE OBJECTIVE

Audio is one of the defining elements of Tetro Effect.

I want every stage to have its own original musical identity and carefully designed sound effects.

The music must match the environment, atmosphere, visual design, materials and mood of each individual stage.

I do not want one generic electronic soundtrack playing across every level.

I also do not want generic sound effects reused everywhere.

Every stage must feel like a complete audiovisual experience.

The audio experience should be comparable to a professionally produced commercial game soundtrack.

Create original music and original sound effects, or use properly licensed audio assets.

Never extract, copy or reproduce copyrighted music or sound effects from Tetris Effect or other commercial games.

Do not create tracks that imitate specific copyrighted compositions.

---

# A. INDIVIDUAL ORIGINAL SOUNDTRACK FOR EVERY STAGE

Each stage must have its own music composition.

The following are creative production briefs.

## 1. ICE — FROZEN KINGDOM

Musical identity:

- Beautiful atmospheric electronic music.
- Delicate crystalline synthesizers.
- Deep atmospheric pads.
- Subtle orchestral textures.
- Ethereal melodic elements.
- Spacious ambient sound.
- Gentle percussion.
- Beautiful evolving harmonies.
- Occasional powerful cinematic moments.

The music should feel cold, magical, beautiful and immersive.

Sound design:

- Delicate ice chimes.
- Crystalline resonances.
- Subtle frozen wind.
- Tiny glass-like particles.
- Deep icy impacts.
- Frozen energy sounds.

The soundtrack should complement the visual appearance of translucent ice blocks and frozen environments.

Hard drop:
A solid icy impact with a short crystalline fracture, low-frequency body and tiny ice fragments scattering.

Line clear:
Beautiful crystalline shattering and a wave of resonant ice tones.

Multiple-line clear:
A much larger crystalline explosion with layered chimes and falling fragments.

## 2. JAPAN WOOD — ANCIENT GARDEN

Musical identity:

- Original Japanese-inspired ambient compositions.
- Beautiful plucked string textures.
- Original koto-inspired melodies.
- Shakuhachi-inspired atmospheric tones.
- Soft traditional-inspired percussion.
- Warm wooden resonances.
- Modern cinematic ambient layers.
- Delicate electronic textures.

Balance traditional-inspired musical elements with modern production.

Sound design:

- Woodblock percussion.
- Soft wooden resonance.
- Delicate bamboo-like tones.
- Falling cherry blossom effects.
- Gentle wind.
- Lantern ambience.
- Flowing water.
- Organic environmental sounds.

Hard drop:
A rich wooden impact with a warm hollow resonance, a subtle wooden vibration and a small scattering of wooden dust.

Line clear:
Wooden chimes mixed with drifting petals and a soft musical flourish.

Multiple-line clear:
A beautiful combination of wooden percussion, resonant strings and a larger blossom-petal effect.

## 3. DESERT — MOVING SANDS

Musical identity:

- Original cinematic desert music.
- Deep warm atmospheric synthesizers.
- Organic percussion.
- Rich low-frequency rhythm.
- Plucked string textures.
- Atmospheric drones.
- Gradually evolving melodies.
- Cinematic orchestral elements.
- Subtle desert-inspired rhythmic instrumentation.

The music should evoke a vast, beautiful desert with an incredible sense of scale.

It should feel warm, mysterious, expansive and alive.

Sound design:

- Moving sand.
- Blowing desert wind.
- Fine granular particles.
- Distant environmental ambience.
- Deep sandstone resonance.
- Subtle desert percussion.
- Camel footsteps in the distance.
- Sandstorm movement.

Hard drop:
A heavy sandstone impact followed by a short, satisfying granular sand burst.

It should sound like a heavy stone block landing in sand.

Use a combination of:
1. Deep impact.
2. Dry stone contact.
3. Granular sand scattering.
4. Short atmospheric tail.

Line clear:
A burst of golden sand particles with a warm resonant desert tone.

Multiple-line clear:
A large swirling sand explosion, deep cinematic impact and musical flourish.

Combo:
Increasing rhythmic percussion and warm energy as the combo grows.

The sound must complement the animated particle camels, dunes and gold-colored effects.

## 4. DARK SPACE — DEEP COSMOS

Musical identity:

- Deep cinematic electronic music.
- Beautiful atmospheric synthesizers.
- Evolving harmonic textures.
- Cosmic drones.
- Powerful low-frequency elements.
- Subtle rhythmic sequences.
- Ethereal melodic elements.
- Large cinematic transitions.
- Carefully controlled percussion.

The music should feel immense, mysterious and otherworldly.

Sound design:

- Deep spatial resonances.
- Subtle energy hums.
- Cosmic particle sounds.
- Electronic impacts.
- Subtle metallic textures.
- Atmospheric transitions.

Hard drop:
A heavy cosmic impact with a deep resonant body, followed by a short electronic energy pulse.

Line clear:
A spatial burst of star-like particles and crystalline electronic tones.

Multiple-line clear:
A powerful cosmic energy explosion with carefully layered bass and high-frequency details.

## 5. MOUNTAINS — ALPINE HORIZON

Musical identity:

- Cinematic orchestral ambient music.
- Beautiful strings.
- Gentle piano.
- Atmospheric pads.
- Natural percussion.
- Warm melodic progressions.
- Spacious environmental textures.
- Emotional musical development.

The music should evoke enormous landscapes, freedom and natural beauty.

Sound design:

- Mountain wind.
- Subtle distant birds.
- Natural stone impacts.
- Water.
- Air movement.
- Gentle environmental ambience.

Hard drop:
A solid mineral impact with a natural stone resonance and a small scattering of rock fragments.

Line clear:
Crystal and mineral chimes with a subtle mountain wind effect.

## 6. OCEAN — THE ABYSS

Musical identity:

- Deep underwater ambient music.
- Beautiful fluid synthesizers.
- Warm atmospheric pads.
- Subtle organic rhythms.
- Evolving underwater tones.
- Delicate high-frequency textures.
- Spacious cinematic ambience.

The music should feel immersive, peaceful, mysterious and fluid.

Sound design:

- Bubbles.
- Deep underwater resonances.
- Water movement.
- Soft aquatic impacts.
- Marine ambience.
- Fluid transitions.
- Subtle low-frequency environmental effects.

Hard drop:
A deep, rounded watery impact followed by bubbles and a short fluid resonance.

Line clear:
A beautiful aquatic energy wave with bubbles and resonant water tones.

Multiple-line clear:
A bigger underwater impact accompanied by a rising stream of bubbles and a musical swell.

## 7. FOREST — ENCHANTED WILDERNESS

Musical identity:

- Organic cinematic ambient music.
- Delicate piano.
- Warm strings.
- Natural textures.
- Soft percussion.
- Beautiful atmospheric melodies.
- Organic electronic layers.

Sound design:

- Leaves.
- Wind.
- Birds.
- Fireflies.
- Wood resonance.
- Natural environmental ambience.

Hard drop:
A solid natural wooden or mineral impact, depending on the selected block material, with leaves and small particles scattering.

Line clear:
Glowing particles, leaves and beautiful organic chimes.

## 8. VOLCANIC — EMBER CORE

Musical identity:

- Powerful cinematic electronic music.
- Deep percussion.
- Dark synthesizers.
- Heavy rhythmic elements.
- Dramatic orchestral textures.
- Slowly building intensity.
- Aggressive but controlled musical sections.

Sound design:

- Deep volcanic rumbling.
- Crackling embers.
- Molten material.
- Stone impacts.
- Sparks.
- Heat and atmospheric movement.

Hard drop:
A heavy dark volcanic impact with a low rumble, crackling molten detail and a short burst of embers.

Line clear:
Cracking obsidian and scattering glowing particles.

Multiple-line clear:
A powerful volcanic burst with deeper percussion and molten energy.

## 9. AURORA — NORTHERN LIGHTS

Musical identity:

- Ethereal cinematic ambient music.
- Beautiful evolving synth pads.
- Delicate melodic sequences.
- Soft piano.
- Spacious strings.
- Subtle percussion.
- Emotionally expressive atmospheric layers.

Sound design:

- Delicate crystalline tones.
- Cold wind.
- Soft sparkling effects.
- Airy environmental sound.
- Glowing energy effects.

Hard drop:
A crystalline impact with a warm low-frequency foundation and a delicate luminous resonance.

Line clear:
A beautiful shimmering sound with a long, controlled atmospheric decay.

## 10. NEON CITY — FUTURE NIGHTS

Musical identity:

- Original electronic music.
- Rhythmic synthesizers.
- Deep electronic bass.
- Beautiful melodic sequences.
- Neon-inspired sound design.
- Modern atmospheric textures.
- Evolving percussion.
- Energetic musical sections.

Sound design:

- Electronic impacts.
- Subtle digital textures.
- Futuristic energy.
- Rain.
- Urban ambience.
- Mechanical movement.
- Electrical pulses.

Hard drop:
A tight electronic impact with a powerful low-frequency punch and a short digital resonance.

Line clear:
A sequence of beautiful electronic tones and a burst of luminous digital particles.

---

# B. DYNAMIC AND ADAPTIVE MUSIC SYSTEM

Do not simply play a single static audio loop throughout a complete game.

Build an adaptive music system.

Each stage should support multiple musical layers and sections.

Possible musical layers:

1. Ambient foundation.
2. Main melodic layer.
3. Percussion.
4. Bass.
5. Secondary instrumentation.
6. Atmospheric textures.
7. High-intensity layer.
8. Special event layer.

Implement these layers using either:

- Properly composed and rendered audio stems.
- Independently synchronized audio tracks.
- Carefully designed procedural synthesis.
- A combination of these methods.

Use the Web Audio API to manage playback, timing, mixing and transitions.

### Music should evolve with gameplay

During quiet gameplay:
- Play atmospheric music.
- Keep the musical arrangement relatively spacious.
- Allow environmental sound to be heard.

During active gameplay:
- Introduce more rhythmic content.
- Increase selected musical layers.
- Add subtle energy.

During combos:
- Introduce musical emphasis.
- Increase selected rhythmic or harmonic layers.
- Make successful gameplay feel more exciting.

During major scoring events:
- Add coordinated musical flourishes.
- Trigger appropriately timed effects.
- Create a satisfying musical climax.

During level transitions:
- Use proper musical transitions.
- Fade and crossfade layers appropriately.
- Avoid abrupt cuts.

During pauses:
- Apply a smooth, intentional audio transition.

Do not make every individual piece movement trigger an unnecessary musical event.

The music must still sound like a coherent composition.

---

# C. PROFESSIONAL TETRIS SOUND EFFECT LIBRARY

Create a complete library of gameplay sound effects.

Every significant gameplay event requires an appropriate sound.

Required event sounds:

- Piece spawning.
- Horizontal movement.
- Rotation clockwise.
- Rotation counterclockwise.
- Soft drop.
- Hard drop.
- Piece locking.
- Single-line clear.
- Double-line clear.
- Triple-line clear.
- Four-line clear.
- Hold piece.
- Combo increase.
- Back-to-back event.
- Spin recognition.
- Level up.
- Stage completion.
- Game over.
- Pause.
- Resume.
- Menu navigation.
- Menu selection.
- Menu confirmation.
- Unlocking a new stage.

Every sound must feel intentional and professionally produced.

Avoid generic interface beeps.

Avoid excessive sound repetition.

Use subtle pitch, volume and variation where appropriate to reduce repetitive listening fatigue.

---

# D. MATERIAL-AWARE IMPACT SOUND SYSTEM

This is an especially important requirement.

Hard-drop and landing sounds must respond to the active block material theme.

Create a MaterialAudioProfile system.

Every stage should define its own block impact profile.

### ICE
- Solid crystalline impact.
- Short frozen resonance.
- Subtle ice fragments.
- Glass-like high-frequency detail.

### JAPAN WOOD
- Deep wooden knock.
- Warm hollow resonance.
- Subtle wooden vibration.
- Fine wooden particle sound.

### DESERT
- Heavy sandstone contact.
- Deep dry stone impact.
- Granular sand scattering.
- Short sandy tail.

### DARK SPACE
- Deep cosmic impact.
- Electronic resonance.
- Energy pulse.
- Subtle spatial tail.

### MOUNTAINS
- Mineral impact.
- Stone resonance.
- Small rock fragments.

### OCEAN
- Deep watery impact.
- Soft fluid movement.
- Bubbles.
- Aquatic resonance.

### FOREST
- Warm organic impact.
- Wood or crystal resonance.
- Leaves and natural particles.

### VOLCANIC
- Heavy obsidian impact.
- Low-frequency body.
- Molten crackling.
- Ember particles.

### AURORA
- Crystalline impact.
- Soft luminous resonance.
- Atmospheric high-frequency detail.

### NEON CITY
- Clean electronic impact.
- Tight punch.
- Short synthetic resonance.

The sound must be synchronized with the actual rendered animation.

The audio engine should know which material theme is active without depending on the rendering engine directly.

---

# E. DIFFERENTIATED HARD DROP AND LOCK SOUNDS

Hard dropping a piece is a particularly satisfying action.

Give it dedicated sound design.

A hard drop should have a noticeably stronger and more immediate sound than ordinary movement or piece locking.

Support layered sounds:

1. Initial impact transient.
2. Material-specific impact.
3. Short resonance.
4. Particle scattering sound.
5. Optional stage-specific environmental response.

The sound should vary appropriately depending on:

- Block material.
- Impact strength.
- Distance dropped.
- Number of pieces impacted, if applicable.
- Game event intensity.

Avoid making a hard drop excessively loud.

Provide independent controls for gameplay effects and environmental ambience.

Soft drop should use a different, lighter sound.

Ordinary piece locking should be more subtle than hard drop.

Landing and line-clear sounds must not become confused with one another.

---

# F. LAYERED LINE-CLEAR AUDIO

Line clears must be extremely satisfying.

Create separate audio compositions for:

Single line:
- Crisp material break.
- Short musical accent.
- Light particle scattering.

Double line:
- Stronger impact.
- Additional harmonic layer.
- Wider particle sound.

Triple line:
- More powerful layered sound.
- Musical flourish.
- More substantial energy.

Four-line clear:
- Signature celebration sound.
- Strong but controlled impact.
- Beautiful musical accent.
- Unique stage-specific audio response.

Combos should have escalating musical emphasis.

However, sound layering must be mixed carefully so it does not become noisy or annoying during extended sessions.

---

# G. ADVANCED AUDIO MIXING

Create a professional audio mixer.

Use separate channels or buses for:

- Master.
- Music.
- Gameplay sound effects.
- Environmental ambience.
- Gameplay impacts.
- Stage-specific effects.
- Menu sounds.

Implement:

- Independent volume.
- Master volume.
- Mute.
- Smooth volume changes.
- Fade in.
- Fade out.
- Crossfades.
- Optional limiter.
- Appropriate headroom.
- Prevention of clipping.

Gameplay sounds must remain audible over music.

Music must remain the main experience without overwhelming the gameplay.

Avoid excessively compressed or fatiguing audio.

---

# H. MUSIC AND SOUND ASSETS

Establish an organized content-production pipeline.

Example:

assets/audio/
  music/
    ice/
    japan-wood/
    desert/
    dark-space/
    mountains/
    ocean/
    forest/
    volcanic/
    aurora/
    neon-city/

  sfx/
    common/
    ice/
    japan-wood/
    desert/
    dark-space/
    mountains/
    ocean/
    forest/
    volcanic/
    aurora/
    neon-city/

  ambience/
    ice/
    desert/
    ocean/
    forest/

  metadata/
    tracks/
    sound-profiles/

Maintain editable source projects for original compositions whenever available.

Prefer proper audio stems for adaptive arrangements.

For example:

desert/
  desert-ambient
  desert-bass
  desert-percussion
  desert-melody
  desert-intensity
  desert-transitions

All stems must share an appropriate timing reference and be synchronized accurately.

Use suitable web audio formats such as OGG/Opus and other appropriate browser-compatible formats.

Keep high-quality original audio masters separately.

Use a consistent naming convention.

Document asset sources and licenses.

---

# I. MUSIC PRODUCTION WORKFLOW

First, determine which audio-production tools are actually available.

If an appropriate DAW or original audio-generation tool is available, use it for high-quality compositions.

Use generated or procedurally synthesized music only when it meets the artistic quality target.

Do not assume a generic programmatic melody is sufficient for a professional game soundtrack.

Do not claim that a track has been composed or mastered unless an actual audio file exists and has been reviewed.

For each stage, produce:

- A complete original main soundtrack.
- Appropriate looping arrangements.
- Adaptive musical stems.
- Appropriate transitions.
- Dedicated gameplay sound effects.
- Environmental ambience.
- Audio metadata.

Where possible, create multiple variations so music does not become repetitive.

If the available tools cannot produce professional original music, create the integration and asset pipeline first and clearly identify the missing audio assets. Do not silently substitute placeholder tones for completed compositions.

---

# J. AUDIO REACTIVITY INTEGRATION

Integrate with the existing music-analysis engine.

Do not create a separate FFT system for each stage.

Music analysis must continue to provide:

- Bass energy.
- Midrange energy.
- Treble energy.
- Spectral flux.
- Overall energy.
- Onsets.
- Beat detection.
- BPM.
- Musical section information.

Use this information to synchronize:

- Environmental lighting.
- Particles.
- Animated creatures.
- Special musical events.
- Stage transitions.
- Line-clear effects.

Audio effects must not compete with the soundtrack or obscure important gameplay sounds.

---

# K. SPATIAL AUDIO FOR VR

All stages must support an appropriate VR audio experience.

Where available, use spatial positioning for:

- Environmental creatures.
- Moving camels.
- Birds.
- Marine life.
- Environmental objects.
- Atmospheric events.

Maintain the music as the central soundtrack.

Avoid placing important gameplay effects behind or far away from the player in ways that make them difficult to hear.

Support headset volume controls and the application's audio settings.

Desktop mode must continue to work properly with normal stereo headphones and speakers.

---

# L. AUDIO SETTINGS

Implement:

- Master volume.
- Music volume.
- Gameplay sound-effects volume.
- Hard-drop volume.
- Environmental ambience volume.
- Stage-specific effects volume.
- Music intensity.
- Adaptive music on/off.
- Audio-reactivity on/off.
- Spatial audio on/off where appropriate.
- Sound-effect variation.
- Audio calibration where useful.

All settings must be persistent.

Provide an audio test screen where I can preview the currently selected stage's music and sound effects.

---

# M. AUDIO ACCEPTANCE TESTING

For every completed stage, test the following:

1. The correct original soundtrack plays.
2. Music loops seamlessly.
3. Musical transitions work.
4. Adaptive layers synchronize.
5. Music analysis works.
6. The environment reacts to music.
7. Piece movement sounds work.
8. Soft drop sounds work.
9. Hard drop sounds match the block material.
10. Landing and locking sound correct.
11. Every line-clear category has appropriate sound design.
12. Combos have suitable musical emphasis.
13. Effects do not clip or overwhelm the soundtrack.
14. Pause and resume work.
15. Settings are saved.
16. VR audio works where supported.
17. Extended gameplay does not become sonically repetitive or fatiguing.

Test actual audio in the browser, not just the audio files independently.

Review the complete experience with headphones and speakers.

---

# FINAL AUDIO DIRECTION

I want every Tetro Effect stage to have its own soundtrack that I genuinely enjoy listening to.

I want to recognize the world through its music and sound, even with my eyes closed.

I want hard drops, rotations, landings, line clears and combos to feel satisfying.

I want the sound effects to belong to the actual material and environment.

I want the Desert to sound like a desert, the Ice world to sound crystalline and frozen, the Ocean to sound fluid and underwater, and Dark Space to feel enormous and otherworldly.

Do not create generic game sounds.

Create a complete original musical and sound-design identity for every stage.

The music, blocks, particles, environment and gameplay must feel like parts of one professionally produced audiovisual experience.

## FINAL INSTRUCTION

I do not want a quick Tetris clone.

I want a complete, beautiful, responsive, immersive 3D rhythm-puzzle game that is enjoyable enough to become a regular part of my daily gaming.

Give the greatest attention to gameplay feel, beautiful 3D block design, immersive environments, sophisticated particles, music synchronization, line-clear feedback, controller support, configuration and performance.

Think like a professional game studio.

Build it properly.

Begin with repository inspection and the reference-game investigation. Then implement the project milestone by milestone, testing the actual application throughout development.