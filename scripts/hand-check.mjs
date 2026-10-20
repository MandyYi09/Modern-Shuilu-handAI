import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const context = vm.createContext({ window: {}, performance, Math, Number, Array, setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL('../hands.js', import.meta.url), 'utf8'), context);
const { measureHand, HandControls } = context.window.HandInteraction;

export function handFixture(fist, x = 320, label = 'Left', scale = 1, rotation = 0) {
  const keypoints = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  keypoints[0] = { x: 0, y: 80 };
  for (let i = 1; i <= 4; i++) keypoints[i] = { x: -70 - i * 7, y: 70 - i * 20 };
  [5, 9, 13, 17].forEach((base, i) => {
    const px = (i - 1.5) * 28;
    keypoints[base] = { x: px, y: 0 };
    keypoints[base + 1] = { x: px, y: -30 };
    keypoints[base + 2] = { x: px, y: fist ? -10 : -55 };
    keypoints[base + 3] = { x: px, y: fist ? 28 : -90 };
  });
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return { handedness: label, confidence: .99, keypoints: keypoints.map(p => ({ x: x + (p.x * c - p.y * s) * scale, y: 240 + (p.x * s + p.y * c) * scale })) };
}

for (const scale of [.5, 1, 2]) for (const rotation of [0, .7, 1.8, 3.14]) {
  assert.equal(measureHand(handFixture(true, 320, 'Left', scale, rotation), 640, 480).curled, 4);
  assert.equal(measureHand(handFixture(false, 320, 'Right', scale, rotation), 640, 480).curled, 0);
  for (const fist of [true, false]) {
    const hand = handFixture(fist, 320, 'Left', scale, rotation);
    hand.keypoints3D = hand.keypoints.map(p => ({ x: p.x * .001, y: p.y * .001, z: 0 }));
    assert.equal(measureHand(hand, 640, 480).curled, fist ? 4 : 0);
  }
}
assert.equal(measureHand({ keypoints: [] }, 640, 480), null);
assert.equal(measureHand({ ...handFixture(false), confidence: .2 }, 640, 480), null);
const controls = new HandControls();
controls.receive([handFixture(true, 160, 'Left'), handFixture(false, 480, 'Right')], 640, 480, 1000);
controls.step(.2, 1100);
assert(controls.slots[0].gather > .8 && controls.slots[1].gather === 0);
assert(controls.slots[0].x > .7 && controls.slots[1].x < .3, 'Camera coordinates must be mirrored');
controls.receive([handFixture(true, 480, 'Right'), handFixture(false, 160, 'Left')], 640, 480, 1150);
controls.step(.2, 1200);
assert(!controls.slots[0].fist && controls.slots[1].fist, 'Detection order must not swap hand identities');
for (let i = 0; i < 20; i++) controls.step(.05, 1600 + i * 50);
assert(controls.slots.every(slot => slot.power < .001 && slot.gather < .001 && !slot.fist), 'Lost hands must release and fade');
console.log('Hand landmarks: open/fist, scale/rotation, mirroring, independent hands, reordered detections, and lost-hand recovery passed.');
