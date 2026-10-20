/* Cloud Spirits. A self-contained p5.js sketch; no build step.
 * p5 handles image loading, canvas lifecycle, timing and PNG export.
 * ml5 HandPose supplies two independent, localized hand interactions.
 * A WebGL point shader moves the entire cloud in a single draw call.
 */
'use strict';

const VERTEX = `
precision highp float;
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec4 aColorFrom;
attribute vec4 aColorTo;
attribute vec4 aSeed;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec4 uHand0;
uniform vec4 uHand1;
uniform float uHandRadius;
uniform float uHeight;
uniform float uProgress;
uniform float uTime;
uniform float uDrift;
uniform float uVeil;
uniform float uSize;
uniform float uPixelRatio;

varying vec4 vColor;

vec2 handForce(vec2 screen, vec4 hand) {
  vec2 delta = screen - hand.xy;
  float distance = length(delta);
  float influence = (1. - smoothstep(uHandRadius * .25, uHandRadius, distance)) * hand.z;
  vec2 repel = delta / max(distance, 1.) * influence * uHandRadius * .20;
  vec2 gather = (-delta * .94 + vec2(-delta.y, delta.x) * .12) * influence;
  return mix(repel, gather, hand.w);
}

void main() {
  float t = clamp(uProgress * 1.24 - aSeed.w * .24, 0., 1.);
  float eased = t * t * (3. - 2. * t);
  float arc = sin(t * 3.14159265);
  vec3 p = mix(aFrom, aTo, eased);
  // The same point keeps its identity as its location and pigment change.
  vec3 swirl = vec3(sin(aSeed.x * 31. + t * 4.),
                    cos(aSeed.y * 27. + t * 3.),
                    sin(aSeed.z * 23. + t * 5.));
  p += swirl * arc * (.09 + aSeed.z * .18);
  p += vec3(sin(aSeed.x * 40. + uTime * .6),
            cos(aSeed.y * 40. + uTime * .5),
            sin(aSeed.z * 40. + uTime * .4)) * uDrift * .006;
  float perspective = 1. / (1. - p.z * .55);
  vec2 screen = uCenter + vec2(p.x, -p.y) * uHeight * perspective;
  // Both forces use the same original screen position, so hands act independently.
  screen += handForce(screen, uHand0) + handForce(screen, uHand1);
  vColor = mix(aColorFrom, aColorTo, eased);
  // The mask is stored in alpha: 1 = guardian, 0 = surrounding clouds.
  float figure = vColor.a;
  vColor.a = mix(uVeil * .6, .92, figure);
  vColor.rgb = pow(vColor.rgb, vec3(.83)) * 1.12;
  gl_Position = vec4(screen / uResolution * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
  gl_PointSize = max(1., uSize * uPixelRatio * (.7 + aSeed.z * .65) * perspective);
}`;

const FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - .5) * 2.;
  if (d > 1.) discard;
  float alpha = (1. - smoothstep(.5, 1., d)) * vColor.a;
  gl_FragColor = vec4(vColor.rgb, alpha);
}`;

new p5(p => {
  const refs = window.REFERENCES;
  const $ = selector => document.querySelector(selector);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const COUNT = matchMedia('(max-width: 700px)').matches ? 30000 : 46000;
  const MORPH_SECONDS = 3.4, HOLD_SECONDS = 7.2;
  const images = [], shapes = [], bindings = {};
  let gl, program, canvas, ready = false, failed = false;
  let current = 0, from = 0, morphing = false, progress = 1, hold = 0;
  let paused = reducedMotion.matches, autoplay = !reducedMotion.matches;
  let time = 0;
  // Keep the point size, stillness and hidden cloud veil from the user's view.
  const size = 3, drift = 0, veil = 0;
  let pixelRatio = 1;
  let pendingSelection = null, exportRequested = false;
  const hands = new HandInteraction.HandControls(message => { $('#status').textContent = message; });

  function randomGenerator(seed) {
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  }

  p.preload = () => {
    refs.forEach((ref, i) => {
      images[i] = p.loadImage(ref.file, () => {}, () => fail(`Could not load ${ref.file}. Serve this folder over HTTP and reload.`));
    });
  };

  function fail(message) {
    failed = true;
    $('#status').textContent = message;
    document.querySelectorAll('button,input').forEach(el => { el.disabled = true; });
    console.error(message);
  }

  // Morton ordering pairs nearby samples across paintings. Unlike pairing
  // random points, it lets the figure flow coherently through its next pose.
  function morton(x, y) {
    const spread = n => {
      n = (n | (n << 8)) & 0x00ff00ff;
      n = (n | (n << 4)) & 0x0f0f0f0f;
      n = (n | (n << 2)) & 0x33333333;
      return (n | (n << 1)) & 0x55555555;
    };
    return (spread(x) | (spread(y) << 1)) >>> 0;
  }

  function sampleImage(image, ref, index) {
    const w = 340, h = Math.round(w * image.height / image.width);
    const surface = document.createElement('canvas');
    surface.width = w; surface.height = h;
    const ctx = surface.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image.canvas, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);
    ctx.save(); ctx.scale(w / image.width, h / image.height);
    ctx.fillStyle = '#fff'; ctx.fill(new Path2D(ref.outline)); ctx.restore();
    const mask = ctx.getImageData(0, 0, w, h).data;
    const random = randomGenerator(12871 + index * 543), samples = [];
    // 82% of samples belong to the guardian, 18% to its cloud setting.
    for (let i = 0; i < COUNT; i++) {
      const wantFigure = i < Math.floor(COUNT * .82);
      let x = 0, y = 0, offset = 0;
      for (let tries = 0; tries < 300; tries++) {
        x = Math.floor((.035 + random() * .93) * w);
        y = Math.floor((.04 + random() * .925) * h);
        offset = (y * w + x) * 4;
        const inside = mask[offset + 3] > 127;
        if (inside === wantFigure) break;
      }
      const r = pixels[offset] / 255, g = pixels[offset + 1] / 255, b = pixels[offset + 2] / 255;
      const lum = .2126 * r + .7152 * g + .0722 * b;
      samples.push({
        x: ((x + random()) / w - .5) * w / h,
        y: .54 - (y + random()) / h,
        z: (lum - .45) * (wantFigure ? .105 : .04) + (wantFigure ? .02 : -.055),
        r, g, b, figure: wantFigure ? 1 : 0,
        order: morton(Math.floor(x / w * 1023), Math.floor(y / h * 1023))
      });
    }
    samples.sort((a, b) => a.order - b.order);
    const position = new Float32Array(COUNT * 3), color = new Float32Array(COUNT * 4);
    samples.forEach((s, i) => {
      position.set([s.x, s.y, s.z], i * 3);
      color.set([s.r, s.g, s.b, s.figure], i * 4);
    });
    return { position, color };
  }

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function createRenderer() {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    for (const [name, components] of [['aFrom',3], ['aTo',3], ['aColorFrom',4], ['aColorTo',4], ['aSeed',4]]) {
      bindings[name] = { buffer: gl.createBuffer(), location: gl.getAttribLocation(program, name), components };
    }
    const random = randomGenerator(83129), seeds = new Float32Array(COUNT * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random();
    upload('aSeed', seeds);
    bindShapes(0, 0);
  }

  function upload(name, values) {
    gl.bindBuffer(gl.ARRAY_BUFFER, bindings[name].buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
  }

  function bindShapes(a, b) {
    upload('aFrom', shapes[a].position); upload('aTo', shapes[b].position);
    upload('aColorFrom', shapes[a].color); upload('aColorTo', shapes[b].color);
  }

  const uniforms = {};
  function uniform(name, ...values) {
    if (!(name in uniforms)) uniforms[name] = gl.getUniformLocation(program, name);
    if (values.length === 4) gl.uniform4f(uniforms[name], ...values);
    else if (values.length === 2) gl.uniform2f(uniforms[name], ...values);
    else gl.uniform1f(uniforms[name], values[0]);
  }

  function layout() {
    return { x: p.width * .5, y: p.height * .46, height: Math.min(p.height * .96, p.width * 1.55) };
  }

  p.setup = () => {
    if (failed) { p.noLoop(); return; }
    try {
      p.setAttributes({ version: 1, alpha: true, antialias: false, preserveDrawingBuffer: true });
      const host = $('#sketch');
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2); p.pixelDensity(pixelRatio);
      canvas = p.createCanvas(host.clientWidth, host.clientHeight, p.WEBGL);
      canvas.parent(host); canvas.elt.setAttribute('aria-label', 'Guardian paintings morphing as a point cloud. Move either hand to interact; close a fist to gather nearby points.');
      gl = p.drawingContext;
      images.forEach((image, i) => { shapes.push(sampleImage(image, refs[i], i)); });
      createRenderer(); connectControls();
      ready = true;
      $('#status').textContent = '';
      hands.start();
      window.addEventListener('pagehide', () => hands.stop());
      window.addEventListener('pageshow', event => { if (event.persisted) hands.start(); });
      new ResizeObserver(() => {
        if (host.clientWidth !== p.width || host.clientHeight !== p.height) p.resizeCanvas(host.clientWidth, host.clientHeight);
      }).observe(host);
      // A small read-only inspection surface for browser verification.
      window.cloudSpirits = { get state() { return {
        ready, count: COUNT, current, from, morphing, progress, paused, autoplay, time,
        tracking: hands.status, inferenceFrames: hands.frames, hands: hands.slots.map(({ x, y, power, gather, fist }) => ({ x, y, power, gather, fist })),
        handRadius: Math.min(layout().height * .065, 52), width: p.width, height: p.height
      }; } };

    } catch (error) { fail(`The point cloud could not start: ${error.message}. Please use a browser with WebGL enabled.`); p.noLoop(); }
  };

  p.draw = () => {
    if (!ready || failed) return;
    const dt = Math.min(p.deltaTime / 1000 || 1 / 60, .05);
    if (!paused && !document.hidden) {
      time += dt;
      if (morphing) {
        progress = Math.min(1, progress + dt / MORPH_SECONDS);
        if (progress === 1) {
          morphing = false; from = current; hold = 0;
          if (pendingSelection !== null) { const next = pendingSelection; pendingSelection = null; select(next); }
        }
      } else if (autoplay) {
        hold += dt;
        if (hold >= HOLD_SECONDS) select((current + 1) % refs.length);
      }
      hands.step(dt);

    }
    const frame = layout();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    for (const { buffer, location, components } of Object.values(bindings)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
    }
    uniform('uResolution', p.width, p.height); uniform('uCenter', frame.x, frame.y);
    uniform('uHeight', frame.height); uniform('uProgress', progress); uniform('uTime', time);
    uniform('uDrift', reducedMotion.matches ? 0 : drift); uniform('uVeil', veil); uniform('uSize', size);
    uniform('uPixelRatio', pixelRatio);
    uniform('uHandRadius', Math.min(frame.height * .065, 52));
    hands.slots.forEach((hand, i) => uniform(`uHand${i}`, hand.x * p.width, hand.y * p.height, hand.power, hand.gather));
    gl.drawArrays(gl.POINTS, 0, COUNT);
    if (exportRequested) {
      // Composite the transparent WebGL canvas over its gallery background.
      const output = document.createElement('canvas'); output.width = canvas.elt.width; output.height = canvas.elt.height;
      const context = output.getContext('2d'); context.fillStyle = '#080e10'; context.fillRect(0, 0, output.width, output.height);
      context.drawImage(canvas.elt, 0, 0);
      output.toBlob(blob => {
        if (!blob) { $('#status').textContent = 'Could not save this frame. Please try again.'; return; }
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = `cloud-spirits-${String(current + 1).padStart(2, '0')}.png`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
      exportRequested = false;
    }
  };

  function select(index) {
    if (!ready) return;
    index = (index + refs.length) % refs.length;
    if (morphing) {
      pendingSelection = index === current ? null : index;

      return;
    }
    if (index === current) return;
    from = current; current = index; progress = 0; hold = 0; morphing = true;
    bindShapes(from, current);
    if (paused) { progress = 1; morphing = false; from = current; }
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('#experience').requestFullscreen) await $('#experience').requestFullscreen();
    } catch { $('#status').textContent = 'Fullscreen is unavailable in this browser.'; }
  }

  function connectControls() {
    $('#fullscreen').addEventListener('click', fullscreen);
    document.addEventListener('fullscreenchange', () => $('#fullscreen').setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen'));
    document.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      if (/^[1-6]$/.test(event.key)) select(Number(event.key) - 1);
      else if (event.key === 'ArrowRight') { event.preventDefault(); select((pendingSelection ?? current) + 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); select((pendingSelection ?? current) - 1); }
      else if (event.code === 'Space' && event.target.tagName !== 'BUTTON') { event.preventDefault(); paused = !paused; }
      else if (event.key.toLowerCase() === 's') exportRequested = true;
      else if (event.key.toLowerCase() === 'f') fullscreen();
    });
    reducedMotion.addEventListener('change', event => {
      if (event.matches) { paused = true; autoplay = false; progress = 1; morphing = false; pendingSelection = null; }
    });
  }
});
