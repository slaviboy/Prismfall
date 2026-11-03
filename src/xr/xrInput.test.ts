import { describe, expect, it } from 'vitest';
import type { RawInputEvent } from '../input/types';
import { XRControllerInput, type XRInputSourceLike } from './xrInput';

function controller(hand: 'left' | 'right', opts: { buttons?: number[]; axes?: number[] } = {}): XRInputSourceLike {
  const values = opts.buttons ?? [0, 0, 0, 0, 0, 0];
  return {
    handedness: hand,
    gamepad: { buttons: values.map((v) => ({ pressed: v > 0.9, value: v })), axes: opts.axes ?? [0, 0, 0, 0] },
  };
}

describe('XR controller input', () => {
  it('maps trigger, face buttons and stick directions with hysteresis', () => {
    const events: RawInputEvent[] = [];
    const input = new XRControllerInput((e) => events.push(e));
    input.poll([controller('right', { buttons: [0.8, 0, 0, 0, 1, 0], axes: [0, 0, 0.7, 0] })], 1);
    expect(events.map((e) => `${e.control}:${e.down}`)).toEqual(['xr:right:trigger:true', 'xr:right:a:true', 'xr:right:stick-right:true']);
    events.length = 0;
    // Partial release stays held (hysteresis), full release lets go.
    input.poll([controller('right', { buttons: [0.45, 0, 0, 0, 1, 0], axes: [0, 0, 0.45, 0] })], 2);
    expect(events).toHaveLength(0);
    input.poll([controller('right', { buttons: [0.1, 0, 0, 0, 0, 0], axes: [0, 0, 0.1, 0] })], 3);
    expect(events.map((e) => `${e.control}:${e.down}`)).toEqual(['xr:right:trigger:false', 'xr:right:a:false', 'xr:right:stick-right:false']);
  });

  it('names left face buttons x and y and tags the hand as the pad slot', () => {
    const events: RawInputEvent[] = [];
    const input = new XRControllerInput((e) => events.push(e));
    input.poll([controller('left', { buttons: [0, 0, 0, 0, 1, 1], axes: [0, 0, 0, -0.9] })], 1);
    expect(events.map((e) => e.control)).toEqual(['xr:left:x', 'xr:left:y', 'xr:left:stick-up']);
    expect(events.every((e) => e.pad === 0 && e.device === 'xr')).toBe(true);
  });

  it('uses the touchpad (only while pressed) on controllers without a thumbstick', () => {
    const events: RawInputEvent[] = [];
    const input = new XRControllerInput((e) => events.push(e));
    input.poll([controller('right', { buttons: [0, 0, 0, 0], axes: [-0.9, 0] })], 1);
    expect(events).toHaveLength(0);
    input.poll([controller('right', { buttons: [0, 0, 1, 0], axes: [-0.9, 0] })], 2);
    expect(events.map((e) => e.control)).toEqual(['xr:right:stick-left']);
  });

  it('releases a controller that disappears', () => {
    const events: RawInputEvent[] = [];
    const input = new XRControllerInput((e) => events.push(e));
    input.poll([controller('left', { buttons: [1, 1, 0, 0, 0, 0] })], 1);
    events.length = 0;
    input.poll([], 2);
    expect(events.map((e) => `${e.control}:${e.down}`).sort()).toEqual(['xr:left:squeeze:false', 'xr:left:trigger:false']);
  });
});
