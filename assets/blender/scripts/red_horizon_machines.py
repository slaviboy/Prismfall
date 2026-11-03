"""Red Horizon kit, part two: the recon drone and the colossus (imported by red_horizon_kit.py)."""
from mathutils import Vector

from red_horizon_kit import Kit, R, S, T, aim, bm_box, bm_cyl, bm_ibeam, bm_loft, bm_prism, bm_shell, bm_sphere, bm_strut, bm_tube


def drone():
    """A 2.1 m reconnaissance drone: a faceted fuselage with a dorsal spine, four booms carrying ducted
    fans that tilt for thrust vectoring, a gimballed sensor turret under the nose (a segmented sensor
    strip above two stacked lenses) and a searchlight beside it. Faces +Y here."""
    k = Kit("drone", 0)
    body = k.bone("body", -1, (0, 0, 0))
    corners = ((1, 1), (-1, 1), (1, -1), (-1, -1))
    arms = [k.bone(f"arm{i}", body, (sx * 0.26, sy * 0.36, 0.02)) for i, (sx, sy) in enumerate(corners)]
    rotors = [k.bone(f"rotor{i}", arms[i], (sx * 0.82, sy * 0.5, 0.02)) for i, (sx, sy) in enumerate(corners)]
    yaw = k.bone("turretYaw", body, (0, 0.5, -0.17))
    pitch = k.bone("turretPitch", yaw, (0, 0.52, -0.27))
    p = k.part("fuselage", "rhArmour", body)
    bm_loft(p.bm, [(-0.78, 0.05, 0.04, 0.02), (-0.6, 0.13, 0.08, 0.02), (-0.2, 0.24, 0.13, 0.0), (0.25, 0.26, 0.15, 0.0), (0.55, 0.2, 0.13, -0.02), (0.74, 0.1, 0.07, -0.03), (0.8, 0.04, 0.03, -0.03)], 8)
    p.done(bevel=0.01)
    p = k.part("spine", "rhFrame", body)
    bm_box(p.bm, 0.08, 1.0, 0.06, T(0, 0.0, 0.17))
    for i in range(5):
        bm_box(p.bm, 0.22, 0.03, 0.05, T(0, -0.36 + i * 0.18, 0.15))
    bm_box(p.bm, 0.36, 0.18, 0.06, T(0, -0.62, 0.05))
    bm_cyl(p.bm, 0.006, 0.004, 0.3, 6, T(0.04, -0.4, 0.34) @ R(-12, 0, 0))
    p.done(bevel=0.006)
    p = k.part("navlamp", "rhLamp", body)
    bm_box(p.bm, 0.03, 0.03, 0.02, T(0, -0.68, 0.1))
    p.done()
    for i, (sx, sy) in enumerate(corners):
        p = k.part(f"boom{i}", "rhFrame", arms[i])
        bm_strut(p.bm, (sx * 0.2, sy * 0.3, 0.02), (sx * 0.82, sy * 0.5, 0.02), 0.07, 0.05)
        bm_cyl(p.bm, 0.05, 0.05, 0.1, 10, T(sx * 0.24, sy * 0.35, 0.02) @ R(0, 90, 0))
        p.done(bevel=0.006)
        p = k.part(f"duct{i}", "rhArmour", arms[i])
        bm_shell(p.bm, 0.25, 0.285, 0, 360, -0.07, 0.07, 20, T(sx * 0.82, sy * 0.5, 0.02))
        for a in (0, 90):
            bm_box(p.bm, 0.5, 0.02, 0.02, T(sx * 0.82, sy * 0.5, -0.04) @ R(0, 0, a))
        p.done(bevel=0.006)
        p = k.part(f"rotor{i}", "rhRotor", rotors[i])
        bm_cyl(p.bm, 0.04, 0.04, 0.05, 10, T(sx * 0.82, sy * 0.5, 0.03))
        for b in range(3):
            bm_box(p.bm, 0.22, 0.045, 0.008, T(sx * 0.82, sy * 0.5, 0.03) @ R(0, 0, b * 120) @ T(0.12, 0, 0) @ R(14, 0, 0))
        p.done()
    p = k.part("turret_ring", "rhJoint", yaw)
    bm_cyl(p.bm, 0.1, 0.11, 0.08, 16, T(0, 0.5, -0.17))
    bm_box(p.bm, 0.24, 0.06, 0.12, T(0, 0.52, -0.25))
    p.done(bevel=0.005)
    p = k.part("turret_ball", "rhArmour", pitch)
    bm_sphere(p.bm, 0.095, T(0, 0.52, -0.27), 16, 10)
    p.done()
    p = k.part("turret_glass", "rhGlass", pitch)
    bm_box(p.bm, 0.13, 0.04, 0.09, T(0, 0.605, -0.27))
    p.done(bevel=0.004)
    p = k.part("turret_lens", "rhLens", pitch)
    for i in range(4):
        bm_box(p.bm, 0.022, 0.012, 0.012, T(-0.036 + i * 0.024, 0.627, -0.245))
    for zz in (-0.272, -0.302):
        bm_cyl(p.bm, 0.016, 0.014, 0.01, 10, T(0.0, 0.628, zz) @ R(-90, 0, 0))
    p.done()
    p = k.part("searchlight", "rhJoint", pitch)
    bm_cyl(p.bm, 0.05, 0.045, 0.14, 12, T(0.15, 0.53, -0.27) @ R(-90, 0, 0))
    p.done(bevel=0.004)
    p = k.part("searchlight_lens", "rhSearch", pitch)
    bm_cyl(p.bm, 0.04, 0.04, 0.01, 12, T(0.15, 0.605, -0.27) @ R(-90, 0, 0))
    p.done()
    return k


def colossus():
    """A 46 m six-legged walking refinery: a long armoured hull with a segmented carapace, an
    industrial superstructure (exhaust stacks, a crane boom, furnace ports glowing through louvres),
    a sensor gondola slung under the bow with a horizontal segmented sensor bar and one large
    rotating lens, and six arched legs: hip turret, box-section femur with a hydraulic ram,
    telescoping tibia and a clawed foot pad. Faces +Y here; metres."""
    k = Kit("colossus", 0)
    hull = k.bone("hull", -1, (0, 0, 28))
    gondola = k.bone("gondola", hull, (0, 15.5, 25.5))
    sensor = k.bone("sensor", gondola, (0, 18.6, 22.6))
    legs = []
    for i, (s, y) in enumerate(((1, 11), (-1, 11), (1, 0), (-1, 0), (1, -11), (-1, -11))):
        coxa = k.bone(f"coxa{i}", hull, (s * 6.6, y, 27.5))
        femur = k.bone(f"femur{i}", coxa, (s * 8.4, y, 28.2))
        tibia = k.bone(f"tibia{i}", femur, (s * 16.5, y, 39.0))
        foot = k.bone(f"foot{i}", tibia, (s * 21.0, y, 2.2))
        legs.append((s, y, coxa, femur, tibia, foot))
    # ---- Hull.
    p = k.part("hull", "rhSteel", hull)
    bm_loft(p.bm, [(-18, 3.5, 2.5, 28.5), (-16, 5.6, 3.6, 28.2), (-8, 6.6, 4.2, 28), (6, 6.6, 4.4, 28), (13, 5.8, 3.8, 27.6), (17, 4.0, 2.8, 27.2), (18.4, 2.2, 1.6, 27)], 10)
    bm_box(p.bm, 3.0, 30, 2.0, T(0, 0, 23.4))
    p.done(bevel=0.12)
    p = k.part("carapace", "rhArmour", hull)
    for i in range(7):
        y = -15 + i * 4.6
        bm_shell(p.bm, 5.8, 6.4, -62, 62, -2.6, 2.6, 12, T(0, y, 28.6) @ R(-90, 0, 0) @ S(1.08, 0.72, 1))
    for sd in (1, -1):
        for i in range(5):
            bm_prism(p.bm, [(-3.0, 0.0), (3.0, 0.0), (2.6, -3.2), (-2.6, -3.4)], 0.35, T(sd * 7.05, -13 + i * 6.2, 28.6) @ R(90, 0, 90))
    p.done(bevel=0.08)
    p = k.part("superstructure", "rhSteel", hull)
    for x, y, r, h in ((2.4, -9.5, 1.15, 9.0), (-2.4, -9.5, 1.15, 10.5), (0.0, -4.0, 0.8, 7.0)):
        bm_cyl(p.bm, r, r * 0.9, h, 16, T(x, y, 32.0 + h / 2))
        bm_cyl(p.bm, r * 1.18, r * 1.18, 0.4, 16, T(x, y, 32.0 + h - 0.6))
        bm_cyl(p.bm, r * 1.12, r * 1.12, 0.3, 16, T(x, y, 32.0 + h * 0.45))
    bm_box(p.bm, 7.0, 9.0, 3.2, T(0, -9.5, 32.4))
    bm_box(p.bm, 5.0, 6.0, 4.5, T(0, 3.0, 33.4))
    bm_box(p.bm, 3.0, 3.0, 2.4, T(0, 3.0, 36.6))
    bm_ibeam(p.bm, (0, 3.0, 37.6), (0, 14.0, 41.5), 0.9, 0.6, 0.14)
    bm_tube(p.bm, [(1.8, 8.0, 32.4), (2.4, 0.0, 32.6), (2.6, -6.0, 33.2), (2.4, -9.5, 34.5)], 0.45, 10)
    bm_tube(p.bm, [(-1.8, 8.0, 32.2), (-2.6, 0.0, 32.4), (-2.6, -6.0, 32.9), (-2.4, -9.5, 34.0)], 0.38, 10)
    for i in range(8):
        bm_box(p.bm, 6.2, 0.18, 2.2, T(0, -16.6 + i * 0.5, 29.6))
    p.done(bevel=0.05)
    p = k.part("furnace", "rhHot", hull)
    for sd in (1, -1):
        for i in range(4):
            bm_box(p.bm, 0.18, 1.6, 0.5, T(sd * 6.9, -6 + i * 2.2, 28.6))
    p.done()
    p = k.part("louvres", "rhFrame", hull)
    for sd in (1, -1):
        for i in range(4):
            for j in range(3):
                bm_box(p.bm, 0.3, 1.8, 0.08, T(sd * 7.0, -6 + i * 2.2, 28.42 + j * 0.18) @ R(0, sd * 30, 0))
    p.done()
    p = k.part("warning_lamps", "rhWarning", hull)
    for x, y, zz in ((2.4, -9.5, 41.3), (-2.4, -9.5, 42.8), (0, 14.0, 41.9), (0, 3.0, 38.0)):
        bm_sphere(p.bm, 0.32, T(x, y, zz), 8, 6)
    p.done()
    # ---- Sensor gondola.
    p = k.part("gondola", "rhArmour", gondola)
    bm_loft(p.bm, [(13.0, 2.6, 1.8, 24.6), (16.0, 3.2, 2.2, 24.2), (18.2, 2.8, 2.0, 24.0), (19.0, 2.0, 1.4, 24.0)], 8)
    bm_box(p.bm, 1.2, 1.2, 2.2, T(0, 15.5, 26.2))
    p.done(bevel=0.08)
    p = k.part("gondola_glass", "rhGlass", gondola)
    bm_box(p.bm, 5.0, 0.5, 0.7, T(0, 18.9, 24.7))
    p.done(bevel=0.05)
    p = k.part("gondola_bar", "rhLens", gondola)
    for i in range(9):
        bm_box(p.bm, 0.42, 0.18, 0.34, T(-2.0 + i * 0.5, 19.15, 24.7))
    p.done()
    p = k.part("sensor_drum", "rhJoint", sensor)
    bm_cyl(p.bm, 1.05, 1.05, 2.6, 20, T(0, 18.6, 22.6) @ R(0, 90, 0))
    bm_cyl(p.bm, 0.75, 0.7, 0.7, 18, T(0, 19.6, 22.6) @ R(-90, 0, 0))
    p.done(bevel=0.05)
    p = k.part("sensor_lens", "rhLens", sensor)
    bm_cyl(p.bm, 0.56, 0.5, 0.12, 18, T(0, 19.98, 22.6) @ R(-90, 0, 0))
    p.done()
    # ---- Legs.
    for i, (s, y, coxa, femur, tibia, foot) in enumerate(legs):
        p = k.part(f"coxa{i}", "rhSteel", coxa)
        bm_cyl(p.bm, 1.7, 1.7, 3.4, 18, T(s * 6.8, y, 27.5))
        bm_box(p.bm, 2.4, 2.6, 2.4, T(s * 8.0, y, 28.1))
        p.done(bevel=0.08)
        fa, fb = Vector((s * 8.4, y, 28.2)), Vector((s * 16.5, y, 39.0))
        p = k.part(f"femur{i}", "rhSteel", femur)
        bm_strut(p.bm, fa, fb, 1.8, 2.3)
        bm_cyl(p.bm, 1.5, 1.5, 2.6, 18, T(*fb) @ R(90, 0, 0))
        bm_cyl(p.bm, 1.3, 1.3, 2.8, 18, T(*fa) @ R(90, 0, 0))
        p.done(bevel=0.1)
        p = k.part(f"femur_armour{i}", "rhArmour", femur)
        m, length = aim(fa, fb)
        bm_box(p.bm, 2.4, 0.4, length * 0.8, m @ T(0, 1.3, length * 0.5))
        bm_box(p.bm, 2.4, 0.4, length * 0.8, m @ T(0, -1.3, length * 0.5))
        for j in range(4):
            bm_box(p.bm, 2.6, 2.9, 0.35, m @ T(0, 0, length * (0.2 + j * 0.18)))
        p.done(bevel=0.06)
        ta, tb = fb, Vector((s * 21.0, y, 2.2))
        p = k.part(f"tibia{i}", "rhSteel", tibia)
        m, length = aim(ta, tb)
        bm_cyl(p.bm, 1.05, 0.9, length * 0.55, 14, m @ T(0, 0, length * 0.275))
        bm_cyl(p.bm, 1.2, 1.2, 1.2, 14, m @ T(0, 0, length * 0.56))
        bm_cyl(p.bm, 0.7, 0.62, length * 0.46, 14, m @ T(0, 0, length * 0.77))
        for j in range(3):
            bm_cyl(p.bm, 1.12, 1.12, 0.28, 14, m @ T(0, 0, length * (0.1 + j * 0.14)))
        p.done(bevel=0.05)
        p = k.part(f"tibia_armour{i}", "rhArmour", tibia)
        bm_shell(p.bm, 1.12, 1.4, -70, 70, length * 0.05, length * 0.5, 10, m @ R(0, 0, 90 * s))
        p.done(bevel=0.05)
        p = k.part(f"foot{i}", "rhFrame", foot)
        bm_cyl(p.bm, 0.9, 0.9, 1.6, 14, T(s * 21.0, y, 2.2) @ R(90, 0, 0))
        bm_cyl(p.bm, 2.1, 2.4, 1.0, 16, T(s * 21.0, y, 0.5))
        for a in (0, 120, 240):
            bm_prism(p.bm, [(0, 0), (1.5, 0.3), (1.6, -0.2), (0, -0.6)], 0.8, T(s * 21.0, y, 0.7) @ R(0, 0, a + 30) @ T(1.8, 0, 0) @ R(90, 0, 0))
        p.done(bevel=0.06)
        k.piston(f"ram{i}", femur, (s * 9.6, y, 26.6), tibia, (s * 17.2, y, 33.0), 0.65, 0.38)
    return k
