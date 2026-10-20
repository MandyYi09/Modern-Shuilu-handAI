/* ml5 HandPose → two smoothed, mirrored palm controls. */
(() => {
  'use strict';
  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

  function measureHand(hand, width, height) {
    const points = hand.keypoints;
    if (!Array.isArray(points) || points.length < 21 || !points.every(k => Number.isFinite(k.x) && Number.isFinite(k.y))) return null;
    if (Number.isFinite(hand.confidence) && hand.confidence < .55) return null;
    const palm = [0, 5, 9, 13, 17].reduce((sum, i) => ({ x: sum.x + points[i].x / 5, y: sum.y + points[i].y / 5 }), { x: 0, y: 0 });
    // Relative distances and joint angles work for either hand and camera distance.
    const joints = hand.keypoints3D?.length === 21 ? hand.keypoints3D : points;
    const palmLength = Math.max(distance(joints[0], joints[9]), 1e-5);
    let curled = 0;
    for (const base of [5, 9, 13, 17]) {
      const mcp = joints[base], pip = joints[base + 1], tip = joints[base + 3];
      const a = { x: mcp.x - pip.x, y: mcp.y - pip.y, z: (mcp.z || 0) - (pip.z || 0) };
      const b = { x: tip.x - pip.x, y: tip.y - pip.y, z: (tip.z || 0) - (pip.z || 0) };
      const cosine = (a.x * b.x + a.y * b.y + a.z * b.z) / Math.max(Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z), 1e-8);
      const foldedAngle = cosine > -.25;
      const foldedDistance = distance(tip, joints[0]) < distance(pip, joints[0]) * 1.12 && distance(tip, mcp) < palmLength * .85;
      if (foldedAngle || foldedDistance) curled++;
    }
    return { x: clamp(1 - palm.x / width, 0, 1), y: clamp(palm.y / height, 0, 1), curled, label: hand.handedness || '' };
  }

  class HandControls {
    constructor(report = () => {}) {
      this.report = report;
      this.slots = Array.from({ length: 2 }, () => ({ x: .5, y: .5, targetX: .5, targetY: .5, power: 0, gather: 0, fist: false, lastSeen: -Infinity, label: '' }));
      this.status = 'idle'; this.video = null; this.stream = null; this.model = null;
      this.running = false; this.timer = null; this.generation = 0; this.frames = 0;
    }

    receive(results, width = 640, height = 480, now = performance.now()) {
      const hands = results.slice(0, 2).map(hand => measureHand(hand, width, height)).filter(Boolean);
      const cost = (hand, slot) => (now - slot.lastSeen < 700 ? Math.hypot(hand.x - slot.targetX, hand.y - slot.targetY) : .6) + (slot.label && hand.label !== slot.label ? .16 : 0);
      let assignments = [];
      if (hands.length === 2) {
        const direct = cost(hands[0], this.slots[0]) + cost(hands[1], this.slots[1]);
        const swapped = cost(hands[0], this.slots[1]) + cost(hands[1], this.slots[0]);
        assignments = direct <= swapped ? [[hands[0], 0], [hands[1], 1]] : [[hands[0], 1], [hands[1], 0]];
      } else if (hands.length === 1) assignments = [[hands[0], cost(hands[0], this.slots[0]) <= cost(hands[0], this.slots[1]) ? 0 : 1]];
      for (const [hand, index] of assignments) {
        const slot = this.slots[index], wasLost = now - slot.lastSeen > 350;
        slot.targetX = hand.x; slot.targetY = hand.y; slot.label = hand.label;
        // Three curled fingers enter a fist; two keep it until a clear opening.
        slot.fist = hand.curled >= (slot.fist && !wasLost ? 2 : 3);
        if (wasLost) { slot.x = hand.x; slot.y = hand.y; }
        slot.lastSeen = now;
      }
    }

    step(dt, now = performance.now()) {
      const follow = 1 - Math.exp(-dt * 15), gestureFollow = 1 - Math.exp(-dt * 10);
      for (const slot of this.slots) {
        const active = now - slot.lastSeen < 250;
        slot.x += (slot.targetX - slot.x) * follow; slot.y += (slot.targetY - slot.y) * follow;
        slot.power += ((active ? 1 : 0) - slot.power) * gestureFollow;
        slot.gather += ((active && slot.fist ? 1 : 0) - slot.gather) * gestureFollow;
        if (!active) slot.fist = false;
      }
    }

    async start() {
      if (this.running || this.status === 'starting') return;
      const generation = ++this.generation;
      this.status = 'starting'; this.report('Allow camera access to interact with both hands.');
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Error('Camera access requires localhost or HTTPS.');
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } });
        if (generation !== this.generation) { this.stop(); return; }
        this.video = document.createElement('video');
        this.video.width = 640; this.video.height = 480; this.video.muted = true; this.video.autoplay = true; this.video.playsInline = true;
        this.video.setAttribute('aria-hidden', 'true'); this.video.srcObject = this.stream;
        document.body.append(this.video); await this.video.play();
        this.report('Preparing hand tracking…');
        if (!window.ml5?.handPose) throw Error('Hand tracking could not load. Reload to try again.');
        this.model = ml5.handPose({ runtime: 'tfjs', maxHands: 2, modelType: 'lite', flipped: false,
          detectorModelUrl: 'assets/models/detector/model.json', landmarkModelUrl: 'assets/models/landmark/model.json' });
        await this.model.ready;
        if (generation !== this.generation) { this.model.model?.dispose(); return; }
        this.running = true; this.status = 'tracking'; this.report(''); this.loop();
      } catch (error) {
        this.stop(); this.status = 'unavailable';
        const denied = error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError';
        this.report(denied ? 'Allow the camera in your browser, then reload to use hand gestures.' : error.name === 'NotFoundError' ? 'No camera found. Connect a camera, then reload.' : error.message || 'Hand tracking is unavailable. Reload to try again.');
      }
    }

    async loop() {
      if (!this.running) return;
      try {
        if (!document.hidden && this.video.readyState >= 2) {
          const hands = await this.model.detect(this.video);
          if (!this.running) return;
          this.frames++;
          this.receive(hands, this.video.videoWidth, this.video.videoHeight);
        }
        this.timer = setTimeout(() => this.loop(), 40);
      } catch {
        this.stop(); this.status = 'unavailable'; this.report('Hand tracking stopped. Reload to try again.');
      }
    }

    stop() {
      this.generation++; this.running = false; clearTimeout(this.timer);
      this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
      if (this.video) { this.video.srcObject = null; this.video.remove(); this.video = null; }
      for (const slot of this.slots) { slot.lastSeen = -Infinity; slot.fist = false; }
    }
  }
  window.HandInteraction = { measureHand, HandControls };
})();
