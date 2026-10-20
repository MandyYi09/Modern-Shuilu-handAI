# Cloud Spirits · 雲

A full-window p5.js point cloud that morphs between six guardian paintings. The only visible control is a fullscreen button. ml5.js HandPose tracks both hands through a hidden, mirrored webcam feed.

## Run

```sh
cd /Users/mandy/Documents/水陆画/Modern-Shuilu-handAI
python3 -m http.server 8008 --bind 127.0.0.1
```

Open [http://127.0.0.1:8008](http://127.0.0.1:8008) and allow camera access. Serve over localhost or HTTPS; opening the HTML directly is unsupported. All libraries and model weights are bundled, so no internet connection is required at runtime. Camera frames are processed locally and never uploaded. The sketch continues its automatic morphing if camera access is unavailable; a small status message explains camera or loading failures and disappears once tracking starts.

## Gestures

- Each palm controls its own small area of nearby points.
- Open hands gently push points aside.
- Close either hand into a fist to gather points at that palm. Both fists work simultaneously.
- Open the hand or move it out of view to release the points and let the painting reform.
- Coordinates are mirrored, so moving your hand left moves its influence left.

The interaction radius is 6.5% of the displayed painting height, capped at 52 CSS pixels, compared with the previous 155-pixel mouse radius. Open-hand push strength is also reduced. Gesture detection uses finger joint angles and palm-relative distances, with hysteresis and smoothing to reduce flicker. Lost detections expire after 250 ms and fade out. There is no mouse/touch particle interaction.

The collection automatically cycles through all six paintings with a 7.2-second hold and a 3.4-second morph. Optional keyboard shortcuts: **1–6** or **arrows** select paintings, **Space** pauses/resumes, **S** saves a PNG, and **F** toggles fullscreen. Reduced-motion preferences start the animation paused; press Space to opt into motion. Mobile starts with 30,000 points; desktop uses 46,000.

## Files

- `sketch.js`: p5 lifecycle, image sampling, WebGL particle rendering and morphing.
- `hands.js`: camera lifecycle, ml5 initialization, two-hand matching, gesture classification and smoothing.
- `references.js`: image manifest and approximate silhouette masks.
- `index.html` / `style.css`: full-window canvas and fullscreen control.
- `assets/`: unchanged copies of `5691.JPG`, `5689.JPG`, `5696 2.JPG`, `5683.JPG`, `5693.JPG`, and `5705.JPG` from `../../zx/3d-trad-chinese-art/3d/reference-images/`.
- `assets/models/`: the official MediaPipe HandPose lite detector and landmark models, served locally through ml5's TensorFlow.js runtime.
- `vendor/`: p5.js 1.11.11, ml5.js 1.2.1, and upstream licenses. Model weights originate from [MediaPipe HandPose 3D](https://www.kaggle.com/models/mediapipe/handpose-3d).

Painting labels are poetic interpretations, not historical identifications. Rights to the original paintings remain with their owners. This is an image-based artistic relief, not a reconstructed sculpture.

## Verification

```sh
node scripts/hand-check.mjs
node --experimental-websocket scripts/browser-check.mjs
```

The first command checks landmark classification across scale/rotation, mirroring, two independent hands, reordered detections and lost-hand recovery. The browser check requires the static server on port 8008 and an isolated Chrome instance with remote debugging on port 9224, `--use-fake-device-for-media-stream`, and `--use-fake-ui-for-media-stream`. It verifies real ml5 model loading/inference against a synthetic camera, then uses synthetic landmarks to check gesture-to-renderer behavior. It also checks the fullscreen button, morphs, camera denial and mobile layout. These checks do not access a physical camera; live gesture accuracy should be evaluated with the user's camera and lighting.

References: [p5.js](https://p5js.org/reference/), [ml5 HandPose](https://docs.ml5js.org/#/reference/handpose), [TensorFlow.js HandPose](https://github.com/tensorflow/tfjs-models/tree/master/hand-pose-detection).
