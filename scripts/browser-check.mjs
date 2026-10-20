// Run with the static server on :8008 and a dedicated Chrome CDP on :9224.
// Node 20: node --experimental-websocket scripts/browser-check.mjs
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { handFixture } from './hand-check.mjs';

const pages = await (await fetch('http://127.0.0.1:9224/json/list')).json();
const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
let sequence = 0;
const pending = new Map(), errors = [], downloads = [];
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(message.params.exceptionDetails));
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
  if (message.method === 'Browser.downloadWillBegin') downloads.push({ ...message.params, state: 'inProgress' });
  if (message.method === 'Browser.downloadProgress') {
    const download = downloads.find(item => item.guid === message.params.guid);
    if (download) download.state = message.params.state;
  }
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await wait(100); }
  throw Error(`Timed out: ${expression}`);
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function screenshot(file) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL(`../${file}`, import.meta.url), Buffer.from(result.data, 'base64'));
}
async function navigate(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: 'http://127.0.0.1:8008/' });
  await until('!!window.cloudSpirits?.state.ready'); await wait(1000);
}
try {
  await send('Log.clear'); await send('Runtime.discardConsoleEntries');
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Browser.resetPermissions');
  // Observe the real controller without exposing a production gesture simulator.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(window, 'HandInteraction', { configurable: true, set(value) {
      const Original = value.HandControls;
      value.HandControls = class extends Original { constructor(...args) { super(...args); window.__testHands = this; } };
      Object.defineProperty(window, 'HandInteraction', { value, configurable: true });
    }});
  ` });
  await navigate(1440, 1000);
  await until('cloudSpirits.state.tracking === "tracking" && cloudSpirits.state.inferenceFrames >= 2', 30000);
  assert.equal(await evaluate('document.querySelectorAll("button").length'), 1);
  assert.equal(await evaluate('document.querySelector("#status").textContent'), '');
  assert.equal(await evaluate('cloudSpirits.state.count'), 46000);
  assert.equal(await evaluate('document.querySelector("canvas").getContext("webgl").getError()'), 0);
  assert(await evaluate('cloudSpirits.state.handRadius <= 52'));
  await screenshot('preview.png');
  // Real inference above used the synthetic camera. Inject landmark fixtures
  // below to check the gesture-to-shader path for both hands independently.
  await evaluate('window.__predictions=[]; __testHands.model.detect=async()=>window.__predictions');
  const inject = hands => evaluate(`window.__predictions=${JSON.stringify(hands)}`);
  await inject([handFixture(true, 270, 'Left'), handFixture(false, 370, 'Right')]);
  await until('cloudSpirits.state.hands[0].gather > .8 && cloudSpirits.state.hands[1].power > .8');
  assert(await evaluate('cloudSpirits.state.hands[1].gather < .1'));
  await inject([handFixture(true, 370, 'Right'), handFixture(true, 270, 'Left')]);
  await until('cloudSpirits.state.hands.every(hand=>hand.gather > .8)');
  await screenshot('preview-hands.png');
  await inject([handFixture(false, 370, 'Right'), handFixture(false, 270, 'Left')]);
  await until('cloudSpirits.state.hands.every(hand=>hand.gather < .1)');
  await inject([]);
  await until('cloudSpirits.state.hands.every(hand=>hand.power < .05)');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720, y: 480 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 720, y: 480, button: 'left', clickCount: 1 });
  await wait(300);
  assert(await evaluate('cloudSpirits.state.hands.every(hand=>hand.power < .01)'));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 720, y: 480, button: 'left', clickCount: 1 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '2', code: 'Digit2' });
  await until('cloudSpirits.state.current === 1 && cloudSpirits.state.progress > .35');
  await screenshot('preview-transition.png');
  await until('!cloudSpirits.state.morphing');
  // Check the actual fullscreen button with a trusted input event.
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1397, y: 43, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1397, y: 43, button: 'left', clickCount: 1 });
  await until('!!document.fullscreenElement');
  await evaluate('document.exitFullscreen()');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(600);
  assert(await evaluate('document.documentElement.scrollWidth === 390 && document.documentElement.scrollHeight === 844'));
  assert.equal(await evaluate('cloudSpirits.state.width'), 390);
  await screenshot('preview-mobile.png');
  // A reload tests the lower mobile point budget and camera lifecycle.
  await navigate(390, 844, true);
  assert.equal(await evaluate('cloudSpirits.state.count'), 30000);
  await until('cloudSpirits.state.tracking === "tracking"', 30000);
  // Denied camera access must leave a working canvas with an explanation.
  // Fake-UI Chrome always grants media; simulate its standard denied exception.
  const deniedScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Camera denied by test', 'NotAllowedError'); };` });
  await navigate(1440, 1000);
  await until('cloudSpirits.state.tracking === "unavailable"');
  assert(await evaluate('document.querySelector("#status").textContent.includes("Allow the camera")'));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: deniedScript.identifier });
  await navigate(1440, 1000);
  await until('cloudSpirits.state.tracking === "tracking"', 30000);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ status: 'passed', camera: 'synthetic test stream; no real camera accessed', realModelInference: true, twoHandGestures: 'synthetic landmarks', verified: ['local model loading and inference', 'canvas and one fullscreen button', 'two independent hands', 'fist gather', 'open-hand release', 'lost-hand fade', 'mouse disabled', 'morphing', 'fullscreen', 'mobile viewport', 'camera permission denial'], runtimeErrors: errors }, null, 2));
} finally { ws.close(); }
