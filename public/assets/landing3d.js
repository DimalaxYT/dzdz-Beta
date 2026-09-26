/* DropQR — immersive 3D experience engine.
   Three.js (vendored, same-origin) · CSP-safe · 60 FPS desktop · graceful mobile.
   Structure:
     1. environment & quality tiers
     2. renderer / scene / camera / lights
     3. canvas-texture helpers (file labels, chapter words, glow sprites, QR)
     4. world: particles, trails, distant geometry, file fleet, portal, chapter vignettes
     5. feature mini-scenes (scissor rendering on #gl2)
     6. scroll & pointer rig (true depth parallax)
     7. upload sequence (file ? object ? particle-QR morph)
     8. UI: nav, auth slot, toast, result overlay
*/

import * as THREE from '/assets/vendor/three.module.min.js';

(() => {
  'use strict';

  /* ------------------------------------------------ 1. environment */
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const smallScreen = window.matchMedia('(max-width: 820px)').matches;
  const Q = {
    coarse: coarse || smallScreen,
    dpr: Math.min(window.devicePixelRatio || 1, (coarse || smallScreen) ? 1.5 : 1.75),
    particles: reduced ? 420 : (coarse || smallScreen) ? 700 : 1500,
    files: reduced ? 7 : (coarse || smallScreen) ? 9 : 14,
    qrPoints: (coarse || smallScreen) ? 900 : 1600,
    antialias: !(coarse || smallScreen)
  };
  const MOTION = reduced ? 0 : 1;

  const canvas = document.getElementById('gl');
  const canvas2 = document.getElementById('gl2');
  const body = document.body;

  let renderer = null;
  try {
    const test = document.createElement('canvas');
    if (!(window.WebGLRenderingContext && (test.getContext('webgl2') || test.getContext('webgl')))) throw new Error('no webgl');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: Q.antialias, alpha: false, powerPreference: 'high-performance', stencil: false });
  } catch (_err) {
    renderer = null;
  }
  if (!renderer) {
    body.classList.add('no-webgl');
    initFlatUI(); // UI (upload, overlays, auth) reste fonctionnelle sans 3D
    return;
  }

  /* ------------------------------------------------ 2. renderer / scene / camera / lights */
  renderer.setPixelRatio(Q.dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x08090b, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x08090b, 0.05);

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 60);
  camera.position.set(0, 0.15, 8.2);

  scene.add(new THREE.HemisphereLight(0x353a46, 0x0a0b0d, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(4, 5, 6);
  scene.add(key);
  const accentV = new THREE.PointLight(0x8b7cff, 14, 18, 2); // decay 2
  accentV.position.set(-4.5, 1.6, -2.5);
  scene.add(accentV);
  const accentB = new THREE.PointLight(0x5b8cff, 10, 18, 2);
  accentB.position.set(4.5, -1.4, 1.5);
  scene.add(accentB);

  /* ------------------------------------------------ 3. helpers */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
  const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return { c, x: c.getContext('2d') };
  }

  function canvasTexture(c) {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function roundedRectShape(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    return s;
  }

  /* Texte géant des chapitres, intégré à la scène (vraie profondeur). */
  function makeWordPlane(word, scale = 1) {
    const { c, x } = makeCanvas(2048, 640);
    x.clearRect(0, 0, 2048, 640);
    // Auto-ajustement: sans ça, un mot long (ex. 'dropqr.app/x7K92') déborde du canvas.
    let wordFont = 470;
    x.font = `760 ${wordFont}px Inter, system-ui, -apple-system, sans-serif`;
    const maxWordWidth = 2048 - 140;
    const measuredWidth = x.measureText(word).width;
    if (measuredWidth > maxWordWidth) {
      wordFont = Math.max(120, Math.floor(wordFont * (maxWordWidth / measuredWidth)));
      x.font = `760 ${wordFont}px Inter, system-ui, -apple-system, sans-serif`;
    }
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.letterSpacing = '-12px';
    x.fillStyle = 'rgba(236,233,226,0.96)';
    x.shadowColor = 'rgba(139,124,255,0.25)';
    x.shadowBlur = 48;
    x.fillText(word, 1024, 330);
    const tex = canvasTexture(c);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8.4 * scale, 2.625 * scale), mat);
    mesh.renderOrder = 2;
    return mesh;
  }

  /* Étiquette d'un objet fichier (canvas 512x640). */
  const FILE_KINDS = {
    photo: { tag: 'JPG', name: 'IMG_4821.JPG', meta: '24.2 MB · 6000×4000', hue: '#5b8cff' },
    video: { tag: 'MP4', name: 'SUMMER_2026.MP4', meta: '1.8 GB · 4K · 03:12', hue: '#8b7cff' },
    doc: { tag: 'PDF', name: 'PROJECT.PDF', meta: '2.4 MB · 14 pages', hue: '#9aa3b2' },
    zip: { tag: 'ZIP', name: 'FILES.ZIP', meta: '312 MB · 48 items', hue: '#c9b48c' },
    fig: { tag: 'FIG', name: 'LANDING_V3.FIG', meta: '18 MB · design', hue: '#7ce0c3' },
    audio: { tag: 'WAV', name: 'MASTER_FINAL.WAV', meta: '88 MB · 96 kHz', hue: '#e0a37c' }
  };
  function fileLabelTexture(kind, w = 512, h = 640, name, meta) {
    const k = FILE_KINDS[kind] || FILE_KINDS.doc;
    const { c, x } = makeCanvas(w, h);
    // fond graphite + liseré
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#16181d'); g.addColorStop(1, '#0d0e12');
    x.fillStyle = g; roundedRectPath(x, 0, 0, w, h, 40); x.fill();
    x.strokeStyle = 'rgba(236,233,226,0.14)'; x.lineWidth = 2;
    roundedRectPath(x, 1, 1, w - 2, h - 2, 40); x.stroke();
    x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    // badge type en haut à gauche
    x.strokeStyle = k.hue; x.globalAlpha = 0.5; x.lineWidth = 2;
    roundedRectPath(x, 46, 52, 108, 56, 12); x.stroke(); x.globalAlpha = 1;
    x.fillStyle = k.hue; x.font = '800 27px Inter, system-ui, sans-serif';
    x.fillText(k.tag, 62, 88);
    // grand panneau « aperçu » central
    x.fillStyle = 'rgba(255,255,255,0.035)';
    roundedRectPath(x, 48, 140, w - 96, 290, 22); x.fill();
    x.strokeStyle = 'rgba(236,233,226,0.07)'; x.lineWidth = 1.5;
    roundedRectPath(x, 48, 140, w - 96, 290, 22); x.stroke();
    // repère lumineux discret, teinté par type
    const rg = x.createRadialGradient(w / 2, 285, 10, w / 2, 285, 150);
    rg.addColorStop(0, k.hue + '2e'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = rg; x.fillRect(48, 140, w - 96, 290);
    x.fillStyle = 'rgba(236,233,226,0.16)';
    x.font = '300 120px Inter, system-ui, sans-serif';
    x.textAlign = 'center';
    x.fillText(k.tag.slice(0, 1), w / 2, 328);
    x.textAlign = 'left';
    // nom + méta en bas
    const label = (name || k.name);
    x.fillStyle = '#ece9e2';
    x.font = '650 30px Inter, system-ui, sans-serif';
    x.fillText(label.length > 19 ? label.slice(0, 18) + '…' : label, 48, h - 104);
    x.fillStyle = 'rgba(168,164,155,0.85)';
    x.font = '500 23px Inter, system-ui, sans-serif';
    x.fillText(meta || k.meta, 48, h - 62);
    return canvasTexture(c);
  }

  /* Sprite lumineux (dégradé radial) pour halos discrets. */
  let glowTex = null;
  function getGlowTexture() {
    if (glowTex) return glowTex;
    const { c, x } = makeCanvas(256, 256);
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(139,124,255,0.85)');
    g.addColorStop(0.35, 'rgba(91,140,255,0.28)');
    g.addColorStop(1, 'rgba(91,140,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    glowTex = canvasTexture(c);
    return glowTex;
  }

  /* QR — attend la lib classique chargée avant le module (abandon passé ~6 s). */
  function whenQR(cb, tries = 0) {
    if (window.qrcode) return cb(window.qrcode);
    if (tries > 100) {
      console.warn('DropQR: bibliothèque QR introuvable — animations QR désactivées.');
      return;
    }
    setTimeout(() => whenQR(cb, tries + 1), 60);
  }
  function qrMatrixFor(text) {
    let mat = null;
    whenQR((qr) => {
      try {
        const q = qr(0, 'M');
        q.addData(text);
        q.make();
        const n = q.getModuleCount();
        mat = { n, dark: (r, cIdx) => q.isDark(r, cIdx) };
      } catch (_e) { mat = null; }
    });
    return mat;
  }

  /* ------------------------------------------------ 4. world */

  /* ---- 4.1 champ de particules (instancié via Points, shader dédié) */
  const pGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(Q.particles * 3);
    const seed = new Float32Array(Q.particles * 4); // phase, speed, tint, size
    for (let i = 0; i < Q.particles; i += 1) {
      pos[i * 3] = (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 17;
      pos[i * 3 + 2] = -2 - Math.random() * 22;
      seed[i * 4] = Math.random() * Math.PI * 2;
      seed[i * 4 + 1] = 0.05 + Math.random() * 0.2;
      seed[i * 4 + 2] = Math.random() < 0.12 ? Math.random() : 0; // 12% teintés
      seed[i * 4 + 3] = 0.6 + Math.random() * 1.5;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  }
  const pUniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector3(99, 99, 0) },
    uPixel: { value: Q.dpr },
    uDensity: { value: 0 }
  };
  const pMat = new THREE.ShaderMaterial({
    uniforms: pUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec4 aSeed;
      uniform float uTime; uniform vec3 uMouse; uniform float uPixel; uniform float uDensity;
      varying float vTint; varying float vFade;
      void main() {
        vec3 p = position;
        p.y += sin(uTime * aSeed.y + aSeed.x) * 0.55;
        p.x += cos(uTime * aSeed.y * 0.7 + aSeed.x * 1.3) * 0.45;
        vec3 toM = p - uMouse;
        float d = length(toM.xy);
        float push = smoothstep(2.4, 0.0, d);
        p.xy += normalize(toM.xy + 0.0001) * push * 0.85;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        gl_PointSize = aSeed.w * uPixel * (30.0 / max(dist, 4.0));
        vTint = aSeed.z;
        vFade = (1.0 - smoothstep(9.0, 26.0, dist)) * (0.35 + 0.65 * aSeed.w * 0.5)
              + uDensity * smoothstep(6.0, 0.5, length(p - uMouse)) * 0.4;
      }`,
    fragmentShader: `
      varying float vTint; varying float vFade;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.06, length(uv));
        vec3 base = vec3(0.78, 0.79, 0.83);
        vec3 tint = mix(vec3(0.545,0.486,1.0), vec3(0.357,0.549,1.0), fract(vTint * 7.0));
        vec3 col = mix(base, tint, step(0.01, vTint));
        gl_FragColor = vec4(col, a * 0.5 * clamp(vFade, 0.0, 1.0));
      }`
  });
  const particles = new THREE.Points(pGeo, pMat);
  scene.add(particles);

  /* ---- 4.2 lointain: anneaux immenses + filaments de lumière */
  const distant = new THREE.Group();
  for (let i = 0; i < 3; i += 1) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(9 + i * 3.4, 0.006, 8, 128),
      new THREE.MeshBasicMaterial({ color: 0x39404e, transparent: true, opacity: 0.16 - i * 0.04, depthWrite: false })
    );
    ring.position.set((i - 1) * 5, (i % 2) ? 2.5 : -2, -16 - i * 4);
    ring.rotation.set(Math.PI / 2.4, 0, i * 0.7);
    distant.add(ring);
  }
  const trailMats = [];
  [[[-9, 3, -14], [-2, 0.5, -11], [6, 2, -15], [12, -1, -19]],
   [[-11, -2.5, -18], [-4, -1, -13], [3, -3, -12], [10, 1.5, -16]]].forEach((pts) => {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    const geo = new THREE.TubeGeometry(curve, 140, 0.014, 6, false);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uHue: { value: Math.random() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        uniform float uTime; uniform float uHue; varying vec2 vUv;
        void main(){
          float band = smoothstep(0.0, 0.22, fract(vUv.x * 2.0 - uTime * 0.05)) * (1.0 - smoothstep(0.35, 0.62, fract(vUv.x * 2.0 - uTime * 0.05)));
          vec3 col = mix(vec3(0.545,0.486,1.0), vec3(0.357,0.549,1.0), uHue);
          gl_FragColor = vec4(col, (0.05 + band * 0.35) * 0.5);
        }`
    });
    trailMats.push(mat);
    distant.add(new THREE.Mesh(geo, mat));
  });
  scene.add(distant);

  /* ---- 4.3 le portail (Drop Zone 3D) */
  const portal = new THREE.Group();
  const PORTAL_POS = new THREE.Vector3(0, -0.35, -1.4);
  portal.position.copy(PORTAL_POS);
  const portalUniforms = { uTime: { value: 0 }, uIntensity: { value: 0 }, uDrag: { value: 0 } };
  const portalSurf = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRectShape(5.2, 3.3, 0.42), 24),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: portalUniforms,
      vertexShader: `
        varying vec3 vN; varying vec3 vV; varying vec2 vUv;
        void main(){ vUv = uv; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform float uTime; uniform float uIntensity; uniform float uDrag;
        varying vec3 vN; varying vec3 vV; varying vec2 vUv;
        void main(){
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
          vec3 deep = vec3(0.045, 0.05, 0.062);
          // grain animé très léger
          float n = fract(sin(dot(vUv * (900.0 + mod(uTime, 10.0)), vec2(12.9898, 78.233))) * 43758.5453) * 0.012;
          vec3 rimA = vec3(0.545, 0.486, 1.0);
          vec3 rimB = vec3(0.357, 0.549, 1.0);
          vec3 rim = mix(rimA, rimB, vUv.y + sin(uTime * 0.2) * 0.15);
          float glow = fres * (0.36 + uIntensity * 0.85 + uDrag * 0.9);
          vec3 col = deep + n + rim * glow * 0.6;
          gl_FragColor = vec4(col, 0.5 + glow * 0.28);
        }`
    })
  );
  portal.add(portalSurf);
  // bord fin
  {
    const shape = roundedRectShape(5.2, 3.3, 0.42);
    const pts = shape.getPoints(128).map((p) => new THREE.Vector3(p.x, p.y, 0.004));
    const colors = [];
    const cA = new THREE.Color(0x8b7cff), cB = new THREE.Color(0x5b8cff);
    pts.forEach((p, i) => { const c = cA.clone().lerp(cB, 0.5 + 0.5 * Math.sin(i / pts.length * Math.PI * 2)); colors.push(c.r, c.g, c.b); });
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    portal.userData.edgeMat = mat;
    portal.add(new THREE.LineLoop(geo, mat));
  }
  // halos d'angle très doux
  [[-2.6, 1.65], [2.6, -1.65]].forEach(([hx, hy]) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(2.6);
    s.position.set(hx, hy, -0.05);
    portal.add(s);
  });
  scene.add(portal);

  /* ---- 4.4 flottille de fichiers 3D */
  const fileProtoGeo = new THREE.BoxGeometry(1.05, 1.34, 0.055);
  const fileEdgeMat = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.45, metalness: 0.55 });
  const fleets = [];
  const kinds = Object.keys(FILE_KINDS);
  for (let i = 0; i < Q.files; i += 1) {
    const kind = kinds[i % kinds.length];
    const depth = -1 - Math.random() * 6.5;
    const g = new THREE.Group();
    const bodyMesh = new THREE.Mesh(fileProtoGeo, fileEdgeMat);
    g.add(bodyMesh);
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.98, 1.27),
      new THREE.MeshStandardMaterial({ map: fileLabelTexture(kind), roughness: 0.65, metalness: 0.08, transparent: true, opacity: 0.96 })
    );
    face.position.z = 0.03;
    g.add(face);
    const layerT = clamp((-depth - 1) / 6.5, 0, 1); // 0 proche → 1 lointain
    const base = new THREE.Vector3(
      (Math.random() - 0.5) * (layerT > 0.6 ? 11 : 8),
      (Math.random() - 0.5) * (layerT > 0.6 ? 6.5 : 4.6),
      depth
    );
    g.position.copy(base);
    g.rotation.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.22);
    const sc = lerp(0.72, 1.05, 1 - layerT);
    g.scale.setScalar(sc);
    scene.add(g);
    fleets.push({
      g, base, layerT,
      phase: Math.random() * Math.PI * 2,
      rotSpd: (Math.random() - 0.5) * 0.24,
      driftA: 0.25 + Math.random() * 0.5,
      fallOffset: Math.random(),
      fallSpeed: 0.55 + Math.random() * 0.7,
      vel: new THREE.Vector3(),
      orbitAng: (i / Q.files) * Math.PI * 2,
      parallax: lerp(0.5, 0.06, layerT)
    });
  }

  /* ---- 4.5 mots des chapitres (typographie dans le monde) */
  const words = {
    drop: makeWordPlane('DROP.'),
    share: makeWordPlane('SHARE.'),
    scan: makeWordPlane('SCAN.')
  };
  words.drop.position.set(-0.9, 0.7, -4.6); words.drop.material.opacity = 0;
  words.share.position.set(1.1, -0.4, -5.4);
  words.scan.position.set(0, 0.35, -9.9); words.scan.scale.setScalar(1.5); // derrière le panneau QR
  Object.values(words).forEach((w) => scene.add(w));

  /* ---- 4.6 vignette SHARE : deux appareils + fil de données */
  const shareScene = new THREE.Group();
  function deviceSlab() {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.0, 0.09),
      new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.4, metalness: 0.6 }));
    const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.34, 1.84),
      new THREE.MeshBasicMaterial({ color: 0x0c0e13, transparent: true, opacity: 0.92 }));
    screenMesh.position.z = 0.048;
    const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending }));
    glint.scale.setScalar(2.4);
    g.add(shell, screenMesh, glint);
    return g;
  }
  const devA = deviceSlab(); devA.position.set(-3.6, 0.1, -4.2); devA.rotation.y = 0.34;
  const devB = deviceSlab(); devB.position.set(3.7, -0.5, -5.6); devB.rotation.y = -0.3; devB.scale.setScalar(0.86);
  shareScene.add(devA, devB);
  const shareCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.7, 0.35, -4.2),
    new THREE.Vector3(-1.1, 1.15, -4.9),
    new THREE.Vector3(1.2, -1.15, -5.1),
    new THREE.Vector3(2.9, -0.25, -5.5)
  ]);
  const shareTrailMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uProg: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform float uTime; uniform float uProg; varying vec2 vUv;
      void main(){
        float head = smoothstep(uProg - 0.24, uProg, vUv.x) * (1.0 - smoothstep(uProg - 0.001, uProg + 0.001, vUv.x));
        float flow = smoothstep(0.0, 0.3, fract(vUv.x * 6.0 - uTime * 0.32)) * (1.0 - smoothstep(0.42, 0.7, fract(vUv.x * 6.0 - uTime * 0.32)));
        float tail = smoothstep(0.0, 0.5, uProg) * (1.0 - vUv.x);
        vec3 col = mix(vec3(0.545,0.486,1.0), vec3(0.357,0.549,1.0), vUv.x);
        float a = 0.05 * tail + flow * 0.16 * tail + head * 0.85;
        gl_FragColor = vec4(col, a);
      }`
  });
  shareScene.add(new THREE.Mesh(new THREE.TubeGeometry(shareCurve, 160, 0.017, 6, false), shareTrailMat));
  const packet = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xcfd3ff, transparent: true, opacity: 0.95 }));
  const packetGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
  packetGlow.scale.setScalar(0.85);
  packet.add(packetGlow);
  shareScene.add(packet);
  scene.add(shareScene);
  shareScene.visible = false;

  /* ---- 4.7 vignette SCAN : QR géant + ligne de balayage */
  const scanScene = new THREE.Group();
  const scanPanelMat = new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.5, metalness: 0.35, transparent: true, opacity: 0 });
  const scanPanel = new THREE.Mesh(new THREE.BoxGeometry(3.7, 3.7, 0.08), scanPanelMat);
  const scanQrMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, toneMapped: false });
  const scanQr = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 3.1), scanQrMat);
  scanQr.position.z = 0.05;
  const scanLineMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uY: { value: -1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      uniform float uY; varying vec2 vUv;
      void main(){
        float line = 1.0 - smoothstep(0.0, 0.12, abs(vUv.y - uY));
        gl_FragColor = vec4(vec3(0.62, 0.58, 1.0), line * 0.75 * step(-0.5, uY) + 0.0);
      }`
  });
  const scanLine = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 3.3), scanLineMat);
  scanLine.position.z = 0.07;
  const scanFrameMat = new THREE.MeshBasicMaterial({ color: 0x8b7cff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  [[-1.85,1.85],[1.85,1.85],[-1.85,-1.85],[1.85,-1.85]].forEach(([cx, cy]) => {
    const corner = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.028), scanFrameMat);
    corner.position.set(cx + (cx > 0 ? -0.17 : 0.17), cy, 0.09);
    const cornerV = corner.clone(); cornerV.rotation.z = Math.PI / 2;
    cornerV.position.set(cx, cy + (cy > 0 ? -0.17 : 0.17), 0.09);
    scanScene.add(corner, cornerV);
  });
  scanScene.add(scanPanel, scanQr, scanLine);
  scanScene.position.set(0, 0.2, -9);
  scene.add(scanScene);
  const scanUrl = makeWordPlane('dropqr.app/x7K92', 0.5);
  scanUrl.position.set(0, -2.6, -8.2);
  scene.add(scanUrl);

  /* QR de démo pour le chapitre SCAN (généré plus tard quand la lib est prête) */
  function paintQRToCanvas(text, cv, fg = '#12141a', bg = '#f2f0ea', tex = null) {
    const m = qrMatrixFor(text);
    let tries = 0;
    const tryPaint = () => {
      const mm = m || qrMatrixFor(text);
      if (!mm) {
        tries += 1;
        if (tries > 100) return; // abandon (~8 s) : pas de minuteur infini
        return setTimeout(tryPaint, 80);
      }
      const pad = 2, n = mm.n, size = cv.width, cell = size / (n + pad * 2);
      const x = cv.getContext('2d');
      x.fillStyle = bg; x.fillRect(0, 0, size, size);
      x.fillStyle = fg;
      for (let r = 0; r < n; r += 1) for (let c2 = 0; c2 < n; c2 += 1) {
        if (mm.dark(r, c2)) x.fillRect((c2 + pad) * cell, (r + pad) * cell, cell + 0.5, cell + 0.5);
      }
      // Si la texture était déjà téléversée sur le GPU (canvas encore vide), la rafraîchir.
      if (tex) tex.needsUpdate = true;
    };
    tryPaint();
  }
  {
    const demoQR = document.createElement('canvas');
    demoQR.width = 420; demoQR.height = 420;
    const demoTex = new THREE.CanvasTexture(demoQR);
    demoTex.colorSpace = THREE.SRGBColorSpace;
    scanQrMat.map = demoTex;
    scanQrMat.needsUpdate = true;
    paintQRToCanvas('https://dropqr.app/x7K92', demoQR, '#ece9e2', '#0d0f13', demoTex);
  }

  /* ---- 4.8 nuage de particules pour la métamorphose fichier → QR */
  const MORPH_N = Q.qrPoints;
  const morphGeo = new THREE.BufferGeometry();
  {
    const from = new Float32Array(MORPH_N * 3);
    const to = new Float32Array(MORPH_N * 3);
    const rnd = new Float32Array(MORPH_N * 2);
    for (let i = 0; i < MORPH_N; i += 1) { rnd[i * 2] = Math.random(); rnd[i * 2 + 1] = Math.random(); }
    morphGeo.setAttribute('position', new THREE.BufferAttribute(from, 3)); // placeholder
    morphGeo.setAttribute('aFrom', new THREE.BufferAttribute(from, 3));
    morphGeo.setAttribute('aTo', new THREE.BufferAttribute(to, 3));
    morphGeo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 2));
  }
  const morphUniforms = { uMix: { value: 0 }, uTime: { value: 0 }, uPixel: { value: Q.dpr }, uAlpha: { value: 0 }, uSize: { value: 1 } };
  const morphMat = new THREE.ShaderMaterial({
    uniforms: morphUniforms,
    transparent: true, depthWrite: false,
    vertexShader: `
      attribute vec3 aFrom; attribute vec3 aTo; attribute vec2 aRnd;
      uniform float uMix; uniform float uTime; uniform float uPixel; uniform float uSize;
      varying float vKeep;
      void main(){
        float t = clamp((uMix - aRnd.x * 0.42) / 0.58, 0.0, 1.0);
        float e = t * t * (3.0 - 2.0 * t);
        vec3 p = mix(aFrom, aTo, e);
        float wob = (1.0 - e) * 0.55;
        p.x += sin(uTime * 2.0 + aRnd.y * 40.0) * wob * 0.35;
        p.y += cos(uTime * 1.7 + aRnd.x * 40.0) * wob * 0.35;
        p.z += sin(uTime * 1.3 + (aRnd.x + aRnd.y) * 30.0) * wob * 0.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * uPixel * (46.0 / max(-mv.z, 3.0)) * (0.7 + aRnd.y * 0.6);
        vKeep = aRnd.y;
      }`,
    fragmentShader: `
      uniform float uAlpha; varying float vKeep;
      void main(){
        vec2 uv = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.12, length(uv));
        vec3 col = mix(vec3(0.93, 0.92, 0.9), vec3(0.62, 0.58, 1.0), step(0.9, vKeep) * 0.8);
        gl_FragColor = vec4(col, a * uAlpha);
      }`
  });
  const morph = new THREE.Points(morphGeo, morphMat);
  morph.visible = false;
  scene.add(morph);

  function seedMorphFrom(fileCenter, width, height) {
    const from = morphGeo.getAttribute('aFrom');
    for (let i = 0; i < MORPH_N; i += 1) {
      from.setXYZ(i,
        fileCenter.x + (Math.random() - 0.5) * width,
        fileCenter.y + (Math.random() - 0.5) * height,
        fileCenter.z + (Math.random() - 0.5) * 0.08);
    }
    from.needsUpdate = true;
  }
  function seedMorphTo(url, center, targetSize) {
    const to = morphGeo.getAttribute('aTo');
    const fill = (m) => {
      const n = m.n, cell = targetSize / (n + 4);
      const cells = [];
      for (let r = 0; r < n; r += 1) for (let c2 = 0; c2 < n; c2 += 1) if (m.dark(r, c2)) cells.push([c2, r]);
      for (let i = 0; i < MORPH_N; i += 1) {
        if (cells.length) {
          const [cx2, ry] = cells[i % cells.length];
          to.setXYZ(i,
            center.x + (cx2 - n / 2 + 2) * cell + (Math.random() - 0.5) * cell * 0.3,
            center.y + (n / 2 - ry - 2) * cell + (Math.random() - 0.5) * cell * 0.3,
            center.z + (Math.random() - 0.5) * 0.14);
        } else {
          to.setXYZ(i, center.x, center.y, center.z);
        }
      }
      to.needsUpdate = true;
    };
    const m = qrMatrixFor(url);
    if (m) fill(m);
    else whenQR(() => { const mm = qrMatrixFor(url); if (mm) fill(mm); });
  }

  /* ---- 4.9 objet fichier héros (séquence d'envoi) */
  const heroFile = new THREE.Group();
  const heroBodyMat = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.42, metalness: 0.55, transparent: true });
  const heroBody = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.95, 0.07), heroBodyMat);
  const heroFaceMat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.08, transparent: true });
  const heroFace = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 1.87), heroFaceMat);
  heroFace.position.z = 0.045;
  const heroRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.55, 0.012, 10, 160),
    new THREE.MeshBasicMaterial({ color: 0x6f7dff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  heroFile.add(heroBody, heroFace, heroRing);
  heroFile.visible = false;
  scene.add(heroFile);

  /* ------------------------------------------------ 5. mini-scènes des features (#gl2, scissor) */
  let renderer2 = null;
  const minis = [];
  const featuresSection = document.getElementById('product');
  const views = [...document.querySelectorAll('.mini-view')];
  try {
    renderer2 = new THREE.WebGLRenderer({ canvas: canvas2, antialias: Q.antialias, alpha: true, powerPreference: 'high-performance', stencil: false });
    renderer2.setPixelRatio(Q.dpr);
    renderer2.setSize(window.innerWidth, window.innerHeight, false);
    renderer2.setClearColor(0x000000, 0);
    renderer2.toneMapping = THREE.ACESFilmicToneMapping;
  } catch (_e) { renderer2 = null; }

  function miniBase() {
    const s = new THREE.Scene();
    s.add(new THREE.HemisphereLight(0x3a3f4c, 0x0a0b0d, 1.1));
    const d = new THREE.DirectionalLight(0xffffff, 1.1); d.position.set(3, 4, 5); s.add(d);
    const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
    return { scene: s, cam };
  }
  function miniFileSlab(sc = 1, hue = 0x8b7cff) {
    const g = new THREE.Group();
    const body2 = new THREE.Mesh(new THREE.BoxGeometry(1.05 * sc, 1.34 * sc, 0.07), fileEdgeMat);
    const seam = new THREE.Mesh(new THREE.PlaneGeometry(0.98 * sc, 0.16 * sc),
      new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    seam.position.set(0, 0.52 * sc, 0.045);
    g.add(body2, seam);
    return g;
  }

  if (renderer2 && views.length) {
    /* UNLIMITED — ruban infini de fichiers */
    {
      const { scene: s, cam } = miniBase();
      cam.position.set(0, 0.15, 3.4);
      const N = 26, lane = 5.4;
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 0.8, 0.05), fileEdgeMat, N);
      const seams = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.56, 0.09),
        new THREE.MeshBasicMaterial({ color: 0x8b7cff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }), N);
      s.add(inst, seams);
      const dummy = new THREE.Object3D();
      const seeds = Array.from({ length: N }, (_, i) => ({ u: i / N, y: (Math.random() - 0.5) * 1.7, z: -Math.random() * 1.6, r: (Math.random() - 0.5) * 0.5, sp: 0.55 + Math.random() * 0.25 }));
      minis.push({ scene: s, cam, update(t) {
          seeds.forEach((sd, i) => {
            const u = (sd.u + t * 0.055 * sd.sp) % 1;
            const x = (u - 0.5) * lane;
            const fade = sstep(0, 0.08, u) * (1 - sstep(0.92, 1, u));
            dummy.position.set(x, sd.y + Math.sin(t * 0.6 + i) * 0.07, sd.z);
            dummy.rotation.set(0, sd.r, 0);
            dummy.scale.setScalar(Math.max(0.001, fade));
            dummy.updateMatrix();
            inst.setMatrixAt(i, dummy.matrix);
            dummy.position.y += 0.31; dummy.position.z += 0.032;
            dummy.updateMatrix();
            seams.setMatrixAt(i, dummy.matrix);
          });
          inst.instanceMatrix.needsUpdate = true;
          seams.instanceMatrix.needsUpdate = true;
        }
      });
    }
    /* FAST — fichier le long d'une trajectoire lumineuse */
    {
      const { scene: s, cam } = miniBase();
      cam.position.set(0, 0.35, 3.6);
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-2.4, -0.6, 0), new THREE.Vector3(-0.8, 0.7, -0.6),
        new THREE.Vector3(0.9, -0.55, -0.4), new THREE.Vector3(2.5, 0.5, 0)
      ]);
      const tmat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `
          uniform float uTime; varying vec2 vUv;
          void main(){
            float flow = smoothstep(0.0,0.25,fract(vUv.x*5.0 - uTime*0.9)) * (1.0 - smoothstep(0.36,0.66,fract(vUv.x*5.0 - uTime*0.9)));
            gl_FragColor = vec4(mix(vec3(0.545,0.486,1.0), vec3(0.357,0.549,1.0), vUv.x), 0.06 + flow * 0.4);
          }`
      });
      s.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.014, 6, false), tmat));
      const flyer = miniFileSlab(0.5, 0x5b8cff);
      s.add(flyer);
      const pt = new THREE.Vector3(); const tan = new THREE.Vector3();
      minis.push({ scene: s, cam, update(t) {
          tmat.uniforms.uTime.value = t;
          const u = (t * 0.42) % 1;
          curve.getPointAt(u, pt);
          curve.getTangentAt(u, tan);
          flyer.position.copy(pt);
          flyer.position.y += Math.sin(t * 2.2) * 0.05;
          flyer.lookAt(pt.clone().add(tan));
          flyer.rotation.z = Math.sin(t * 1.3) * 0.18;
        }
      });
    }
    /* PRIVATE — fichier dans une structure protectrice */
    {
      const { scene: s, cam } = miniBase();
      cam.position.set(0, 0.15, 3.5);
      const cage = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.28, 1)),
        new THREE.LineBasicMaterial({ color: 0x8b7cff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending })
      );
      const cage2 = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.46, 0)),
        new THREE.LineBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending })
      );
      const inner = miniFileSlab(0.95, 0x9aa3b2);
      s.add(cage, cage2, inner);
      minis.push({ scene: s, cam, update(t) {
          cage.rotation.y = t * 0.24; cage.rotation.x = Math.sin(t * 0.3) * 0.25;
          cage2.rotation.y = -t * 0.16; cage2.rotation.z = t * 0.08;
          inner.rotation.y = Math.sin(t * 0.5) * 0.4;
          inner.position.y = Math.sin(t * 0.8) * 0.09;
        }
      });
    }
    /* INSTANT QR — particules qui s'assemblent en QR */
    {
      const { scene: s, cam } = miniBase();
      cam.position.set(0, 0, 3.9);
      const CAP = 800;
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.052, 0.052, 0.052),
        new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.4, metalness: 0.2 }), CAP);
      s.add(inst);
      let targets = null;
      const scatterArr = new Float32Array(CAP * 3);
      for (let i = 0; i < CAP; i += 1) {
        scatterArr[i * 3] = (Math.random() - 0.5) * 4.6;
        scatterArr[i * 3 + 1] = (Math.random() - 0.5) * 3.2;
        scatterArr[i * 3 + 2] = (Math.random() - 0.5) * 2.4;
      }
      whenQR(() => {
        const m = qrMatrixFor('https://dropqr.app/hello');
        if (!m) return;
        const n = m.n, cell = 2.1 / (n + 2), cells = [];
        for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (m.dark(r, c)) cells.push([c, r]);
        targets = { cells, n, cell };
      });
      const dummy = new THREE.Object3D();
      minis.push({ scene: s, cam, update(t) {
          const mixv = reduced ? 1 : sstep(0.15, 0.85, 0.5 - 0.5 * Math.cos(t * 0.5));
          for (let i = 0; i < CAP; i += 1) {
            let x = scatterArr[i * 3], y = scatterArr[i * 3 + 1], z = scatterArr[i * 3 + 2];
            let sc = 0.001;
            if (targets && i < targets.cells.length) {
              const [cx2, ry] = targets.cells[i];
              const tx = (cx2 - targets.n / 2 + 1) * targets.cell;
              const ty = (targets.n / 2 - ry - 1) * targets.cell;
              const stag = (i % 97) / 97 * 0.25;
              const e = sstep(stag, 1 - stag + 0.001, mixv);
              x = lerp(x + Math.sin(t + i) * 0.06, tx, e);
              y = lerp(y + Math.cos(t * 0.8 + i) * 0.06, ty, e);
              z = lerp(z, 0, e);
              sc = lerp(0.35, 1, e);
            }
            dummy.position.set(x, y, z);
            dummy.scale.setScalar(sc);
            dummy.rotation.set(t * 0.3 + i, t * 0.2, 0);
            dummy.updateMatrix();
            inst.setMatrixAt(i, dummy.matrix);
          }
          inst.instanceMatrix.needsUpdate = true;
        }
      });
    }
  }

  /* ------------------------------------------------ 6. rig: scroll + pointeur */
  const pointer = { x: 0, y: 0, sx: 0, sy: 0, active: false };
  window.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    pointer.active = true;
  }, { passive: true });

  const nv = document.getElementById('nv');
  const dz = document.getElementById('dropzone');
  const storyEl = document.getElementById('story');

  let storyP = 0, storySmooth = 0;
  let featuresOn = false, afterW = 0, afterWS = 0;
  const camState = {
    pos: new THREE.Vector3(0, 0.15, 8.2),
    look: new THREE.Vector3(0, 0, 0),
    tPos: new THREE.Vector3(),
    tLook: new THREE.Vector3()
  };

  const V = { // vecteurs temporaires
    a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3()
  };

  function stationWeights(p) {
    return {
      hero: 1 - sstep(0.005, 0.05, p),
      drop: sstep(0.005, 0.07, p) * (1 - sstep(0.3, 0.38, p)),
      share: sstep(0.3, 0.4, p) * (1 - sstep(0.62, 0.7, p)),
      scan: sstep(0.62, 0.72, p)
    };
  }

  /* ------------------------------------------------ 7. état UI / upload */
  const state = {
    dragging: false, dragDepth: 0,
    uploading: false, progress: 0,
    uploadW: 0, targetUploadW: 0,
    morphing: false,
    resultShown: false,
    resetToken: 0
  };
  const dzTitle = dz ? dz.querySelector('.dz-title') : null;
  const dzSub = dz ? dz.querySelector('.dz-sub') : null;
  const upOverlay = document.getElementById('upload-overlay');
  const upName = document.getElementById('up-name');
  const upStatus = document.getElementById('up-status');
  const upBar = document.getElementById('up-bar');
  const upPct = document.getElementById('up-pct');
  const resOverlay = document.getElementById('result-overlay');
  const resLink = document.getElementById('result-link');
  const resNote = document.getElementById('result-note');
  const resQrHost = document.getElementById('result-qr');
  const veil = document.getElementById('drag-veil');
  const toastEl = document.getElementById('toast');

  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2400);
  }

  const RING_LEN = 2 * Math.PI * 58;
  if (upBar) { upBar.style.strokeDasharray = `${RING_LEN}`; upBar.style.strokeDashoffset = `${RING_LEN}`; }
  function setProgress(p) {
    state.progress = p;
    if (upBar) upBar.style.strokeDashoffset = `${RING_LEN * (1 - p)}`;
    if (upPct) upPct.textContent = `${Math.round(p * 100)}%`;
  }

  function humanSize(b) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  function heroFileLabel(file) {
    const ext = (file.name.match(/\.([a-z0-9]{2,5})$/i) || [null, 'FILE'])[1].toUpperCase();
    const kind = Object.keys(FILE_KINDS).find((k) => FILE_KINDS[k].tag === ext) || 'doc';
    const kindPrev = FILE_KINDS[kind];
    FILE_KINDS[kind] = { ...kindPrev, tag: ext.length <= 4 ? ext : kindPrev.tag, name: file.name, meta: humanSize(file.size) };
    const tex = fileLabelTexture(kind, 512, 640, file.name.length > 20 ? file.name.slice(0, 19) + '…' : file.name, humanSize(file.size));
    FILE_KINDS[kind] = kindPrev;
    return tex;
  }

  function startUpload(file) {
    if (state.uploading || !file) return;
    state.uploading = true;
    state.targetUploadW = 1;
    state.resetToken += 1;
    const token = state.resetToken;
    setProgress(0);
    if (upName) upName.textContent = file.name;
    if (upStatus) upStatus.textContent = 'Uploading';
    if (upOverlay) upOverlay.classList.add('on');
    if (resOverlay) resOverlay.classList.remove('on');
    state.resultShown = false;
    if (dz) { dz.classList.remove('dragging', 'near'); }

    // L'objet héros reçoit l'étiquette du vrai fichier
    if (heroFaceMat.map) heroFaceMat.map.dispose();
    heroFaceMat.map = heroFileLabel(file);
    heroFaceMat.needsUpdate = true;
    heroFile.visible = true;
    heroFile.position.set(0, -0.12, 1.05);
    heroFile.rotation.set(0, 0, 0);
    heroFile.scale.setScalar(0.001);
    heroRing.material.opacity = 0;

    const form = new FormData();
    form.append('file', file, file.name || 'fichier');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transfers');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(clamp(e.loaded / e.total, 0, 0.985));
    };
    xhr.onload = () => {
      if (token !== state.resetToken) return;
      if (xhr.status === 201 && xhr.response && xhr.response.shareUrl) {
        setProgress(1);
        if (upStatus) upStatus.textContent = 'Uploaded';
        setTimeout(() => { if (token === state.resetToken) completeUpload(xhr.response); }, reduced ? 120 : 420);
      } else {
        const msg = (xhr.response && xhr.response.error) || 'Upload failed. Please try again.';
        failUpload(msg);
      }
    };
    xhr.onerror = () => failUpload('Network error. Check your connection and retry.');
    xhr.ontimeout = () => failUpload('Upload timed out. Try again with a stable connection.');
    xhr.timeout = 20 * 60 * 1000;
    xhr.send(form);
  }

  function failUpload(msg) {
    state.uploading = false;
    state.targetUploadW = 0;
    if (upStatus) { upStatus.textContent = msg; }
    if (upPct) upPct.textContent = '';
    if (upBar) upBar.style.strokeDashoffset = `${RING_LEN}`;
    toast(msg);
    setTimeout(() => {
      if (upOverlay) upOverlay.classList.remove('on');
      heroFile.visible = false;
    }, 2200);
  }

  function completeUpload(payload) {
    if (upOverlay) upOverlay.classList.remove('on');
    state.morphing = true;
    // la métamorphose : le fichier devient un QR de particules
    morph.visible = true;
    morphUniforms.uAlpha.value = 1;
    morphUniforms.uMix.value = 0;
    const center = heroFile.position.clone();
    seedMorphFrom(center, 1.5, 1.95);
    seedMorphTo(payload.shareUrl, center, 2.15);
    state.morphStart = performance.now();
    state.morphDur = reduced ? 600 : 1900;
    state.morphPayload = payload;
  }

  function showResult(payload) {
    state.resultShown = true;
    const host = resOverlay;
    if (!host) return;
    const pretty = payload.shareUrl.replace(/^https?:\/\//, '');
    if (resLink) resLink.textContent = pretty;
    if (resNote) {
      const mins = Math.max(1, Math.round((payload.secondsRemaining || 900) / 60));
      resNote.textContent = mins >= 60
        ? `Link expires in ~${Math.round(mins / 60)} h · code ${payload.code}`
        : `Link expires in ~${mins} min · code ${payload.code}`;
    }
    if (resQrHost) {
      resQrHost.innerHTML = '';
      const cv = document.createElement('canvas');
      cv.width = 440; cv.height = 440;
      paintQRToCanvas(payload.shareUrl, cv, '#0b0d10', '#ffffff');
      resQrHost.appendChild(cv);
    }
    const copyBtn = document.getElementById('btn-copy');
    const dlBtn = document.getElementById('btn-download');
    if (copyBtn) copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(payload.shareUrl);
        toast('Link copied to clipboard');
      } catch (_e) {
        const ta = document.createElement('textarea');
        ta.value = payload.shareUrl; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); ta.remove();
        toast('Link copied to clipboard');
      }
    };
    if (dlBtn) dlBtn.onclick = () => {
      const cv = document.createElement('canvas');
      cv.width = 1080; cv.height = 1080;
      paintQRToCanvas(payload.shareUrl, cv, '#0b0d10', '#ffffff');
      const a = document.createElement('a');
      a.href = cv.toDataURL('image/png');
      a.download = `dropqr-${payload.code || 'qr'}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      toast('QR code downloaded');
    };
    host.classList.add('on');
  }

  function resetExperience() {
    state.resetToken += 1;
    state.uploading = false;
    state.morphing = false;
    state.targetUploadW = 0;
    state.resultShown = false;
    if (resOverlay) resOverlay.classList.remove('on');
    if (upOverlay) upOverlay.classList.remove('on');
    morphUniforms.uMix.value = 0;
    morphUniforms.uAlpha.value = 0;
    morph.visible = false;
    heroFile.visible = false;
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }
  const againBtn = document.getElementById('btn-again');
  if (againBtn) againBtn.addEventListener('click', resetExperience);

  /* ---- drag & drop fenêtre entière ---- */
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

  // Plusieurs fichiers/dossiers -> une archive .zip ; un seul fichier -> tel quel.
  // Tous les formats sont acceptés (.zip, .rblx, .obj, images, vidéos…).
  async function prepareUploadFile(entries) {
    const list = (entries || []).filter(Boolean);
    if (!list.length) return null;
    if (list.length === 1 || !window.DropQRZip) return list[0].data || list[0];
    const total = list.reduce((sum, entry) => sum + Number((entry.data || entry).size || 0), 0);
    toast(`Regroupement de ${list.length} fichiers en .zip…`);
    if (upStatus) upStatus.textContent = `Packing ${list.length} files into one .zip…`;
    return window.DropQRZip.makeZipFile(list, `DropQR-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.zip`, {
      onProgress: (processed) => {
        if (upStatus) upStatus.textContent = `Packing .zip · ${humanSize(processed)} / ${humanSize(total)}`;
      }
    });
  }
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || state.uploading) return;
    e.preventDefault();
    state.dragDepth += 1;
    state.dragging = true;
    if (veil) veil.classList.add('on');
    if (dz) { dz.classList.add('dragging'); if (dzTitle) dzTitle.textContent = 'Drop your files'; if (dzSub) dzSub.textContent = 'Release to start the transfer'; }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      state.dragging = false;
      if (veil) veil.classList.remove('on');
      if (dz) { dz.classList.remove('dragging'); if (dzTitle) dzTitle.textContent = 'Drop anything here'; if (dzSub) dzSub.textContent = 'or choose files'; }
    }
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    state.dragDepth = 0; state.dragging = false;
    if (veil) veil.classList.remove('on');
    if (dz) { dz.classList.remove('dragging'); if (dzTitle) dzTitle.textContent = 'Drop anything here'; if (dzSub) dzSub.textContent = 'or choose files'; }
    if (state.uploading) return;
    let entries = [];
    try {
      entries = (window.DropQRZip && window.DropQRZip.collectEntries)
        ? await window.DropQRZip.collectEntries(e.dataTransfer)
        : Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((file) => ({ name: file.name, data: file }));
    } catch (_error) {
      entries = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((file) => ({ name: file.name, data: file }));
    }
    if (!entries.length) return;
    window.scrollTo({ top: 0, behavior: 'auto' });
    const file = await prepareUploadFile(entries);
    if (file) startUpload(file);
  });
  if (dz) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    dz.appendChild(input);
    dz.addEventListener('click', () => { if (!state.uploading) input.click(); });
    dz.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !state.uploading) { e.preventDefault(); input.click(); } });
    input.addEventListener('change', async () => {
      const files = Array.from((input.files && input.files.length) ? input.files : []);
      input.value = '';
      if (!files.length || state.uploading) return;
      const entries = (window.DropQRZip && window.DropQRZip.entriesFromFiles)
        ? window.DropQRZip.entriesFromFiles(files)
        : files.map((file) => ({ name: file.name, data: file }));
      const file = await prepareUploadFile(entries);
      if (file) startUpload(file);
    });
    // approche du curseur : la scène « respire » vers la zone
    dz.addEventListener('pointerenter', () => { dz.classList.add('near'); if (dzTitle && !state.dragging) dzTitle.textContent = 'Drop your files'; pointer.nearDz = true; });
    dz.addEventListener('pointerleave', () => { dz.classList.remove('near'); if (dzTitle && !state.dragging) dzTitle.textContent = 'Drop anything here'; pointer.nearDz = false; });
  }

  /* CTA nav → retour au portail avec impulsion */
  const cta = document.getElementById('cta-start');
  let portalPulse = 0;
  if (cta) cta.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    portalPulse = 1;
    if (dz) dz.focus({ preventScroll: true });
  });

  /* ------------------------------------------------ 8. Discord auth (slot) */
  (async function initAuth() {
    const slots = [...document.querySelectorAll('[data-discord-auth]')];
    if (!slots.length) return;
    let data = null;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.ok) data = await res.json();
    } catch (_e) { data = null; }
    slots.forEach((slot) => {
      slot.innerHTML = '';
      if (data && data.configured && data.user) {
        const u = data.user;
        const chip = document.createElement('span');
        chip.className = 'discord-chip';
        const img = document.createElement('img');
        img.src = u.avatar; img.alt = ''; img.width = 26; img.height = 26;
        const name = document.createElement('span');
        name.className = 'discord-chip-name';
        name.textContent = u.globalName || u.username;
        const btn = document.createElement('button');
        btn.className = 'discord-logout';
        btn.type = 'button'; btn.title = 'Sign out'; btn.setAttribute('aria-label', 'Sign out');
        btn.textContent = '×';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_e) {}
          window.location.reload();
        });
        chip.append(img, name, btn);
        slot.appendChild(chip);
      } else if (data && data.configured) {
        const a = document.createElement('a');
        a.className = 'discord-auth-btn';
        a.href = `/api/auth/discord/login?next=${encodeURIComponent('/')}`;
        a.textContent = 'Sign in with Discord';
        slot.appendChild(a);
      }
    });
  })();

  /* nav scrolled */
  function onScrollNav() { nv && nv.classList.toggle('scrolled', window.scrollY > 28); }
  window.addEventListener('scroll', onScrollNav, { passive: true });
  onScrollNav();

  /* ------------------------------------------------ boucle principale */
  const clock = new THREE.Clock();
  let time = 0;
  const mouseWorld = new THREE.Vector3(99, 99, 0);

  function computeScroll() {
    const rect = storyEl ? storyEl.getBoundingClientRect() : { top: 0, height: 1 };
    const span = Math.max(rect.height - window.innerHeight, 1);
    storyP = clamp(-rect.top / span, 0, 1);
    if (featuresSection) {
      const fr = featuresSection.getBoundingClientRect();
      featuresOn = fr.top < window.innerHeight * 0.95 && fr.bottom > window.innerHeight * 0.12;
      // 0 → la story s'achève, 1 → la section produit occupe l'écran (arrière-plan calme)
      const enterX = (window.innerHeight - fr.top) / window.innerHeight;
      afterW = sstep(0.35, 0.8, enterX);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    time += dt;
    computeScroll();
    storySmooth = reduced ? storyP : damp(storySmooth, storyP, storyP > storySmooth ? 3.4 : 4.6, dt);

    pointer.sx = reduced ? 0 : damp(pointer.sx, pointer.x, 5, dt);
    pointer.sy = reduced ? 0 : damp(pointer.sy, pointer.y, 5, dt);
    portalPulse = Math.max(0, portalPulse - dt * 1.6);

    state.uploadW = damp(state.uploadW, state.targetUploadW, 3.2, dt);

    const w = stationWeights(storySmooth);
    const dragW = state.dragging ? 1 : 0;
    state.dragW = damp(state.dragW || 0, dragW, 4, dt);
    afterWS = damp(afterWS, afterW, 4, dt);
    const storyFade = afterWS > 0.96 ? 0 : 1 - afterWS; // snap: évite tout fantôme résiduel

    /* caméra : stations + interpolation */
    const uploadFocus = state.uploadW;
    camState.tPos.set(0, 0.15, 8.2);
    camState.tLook.set(0, -0.1, -1.2);
    /* DROP: plongée */
    if (w.drop > 0) {
      const t = sstep(0, 0.24, storySmooth);
      V.a.set(0, lerp(0.15, 0.75, t), lerp(8.2, 4.6, t));
      V.b.set(0, lerp(-0.1, 0.25, t), -2.2);
      camState.tPos.lerpVectors(camState.tPos, V.a, w.drop);
      camState.tLook.lerpVectors(camState.tLook, V.b, w.drop);
    }
    /* SHARE: traversée le long du pont de données */
    if (w.share > 0) {
      const t = sstep(0.32, 0.6, storySmooth);
      V.a.set(lerp(-1.6, 1.7, t), lerp(0.9, 0.2, t), lerp(4.4, 3.2, t));
      V.b.set(lerp(-0.6, 0.7, t), 0, -4.9);
      camState.tPos.lerpVectors(camState.tPos, V.a, w.share);
      camState.tLook.lerpVectors(camState.tLook, V.b, w.share);
    }
    /* SCAN: approche du QR */
    if (w.scan > 0) {
      const t = sstep(0.64, 0.95, storySmooth);
      V.a.set(0, lerp(0.2, 0.15, t), lerp(-2.4, -5.4, t));
      V.b.set(0, 0.2, -9);
      camState.tPos.lerpVectors(camState.tPos, V.a, w.scan);
      camState.tLook.lerpVectors(camState.tLook, V.b, w.scan);
    }
    /* Upload: gros plan sur l'objet */
    if (uploadFocus > 0.001) {
      V.a.set(0, -0.05, 3.4); V.b.set(0, -0.12, 1.0);
      camState.tPos.lerpVectors(camState.tPos, V.a, uploadFocus);
      camState.tLook.lerpVectors(camState.tLook, V.b, uploadFocus);
    }
    /* Après la story: fond calme et large derrière les features */
    if (afterWS > 0.001) {
      V.a.set(0, 0.75, 7.6); V.b.set(0, -0.4, -5.5);
      camState.tPos.lerpVectors(camState.tPos, V.a, afterWS);
      camState.tLook.lerpVectors(camState.tLook, V.b, afterWS);
    }

    /* parallaxe souris (amplitude décroît avec la distance plan prévue) */
    const mx = pointer.sx, my = pointer.sy;
    const dampK = reduced ? 0 : 1;
    V.c.copy(camState.tPos);
    V.c.x += mx * 0.42 * dampK * (1 - uploadFocus * 0.7);
    V.c.y += my * 0.3 * dampK * (1 - uploadFocus * 0.7);
    camState.pos.lerp(V.c, 1 - Math.exp(-3.6 * dt));
    camera.position.copy(camState.pos);
    V.c.copy(camState.tLook);
    V.c.x += mx * 0.55 * dampK * (1 - uploadFocus * 0.5);
    V.c.y += my * 0.34 * dampK * (1 - uploadFocus * 0.5);
    camState.look.lerp(V.c, 1 - Math.exp(-4.2 * dt));
    camera.lookAt(camState.look);
    camera.updateMatrixWorld();

    /* pointeur en coordonnées monde (plan z = -1.4, plan du portail) */
    {
      const ndc = new THREE.Vector3(mx, my, 0.5).unproject(camera);
      const dir = ndc.sub(camera.position).normalize();
      const tPl = (-1.4 - camera.position.z) / dir.z;
      mouseWorld.copy(camera.position).add(dir.multiplyScalar(tPl));
      pUniforms.uMouse.value.copy(state.dragW > 0.05 ? portal.position : mouseWorld);
    }

    /* portail : respiration + tilt vers le curseur + impulsions */
    portal.visible = state.uploadW < 0.4 && afterWS < 0.5;
    portal.position.y = PORTAL_POS.y - sstep(0.3, 0.55, storySmooth) * 3.4;
    const portalTargetIntensity = clamp(0.3 + portalPulse + (pointer.nearDz ? 0.5 : 0) + state.dragW * 0.9, 0, 1.6);
    portalUniforms.uIntensity.value = damp(portalUniforms.uIntensity.value, portalTargetIntensity, 4, dt);
    portalUniforms.uDrag.value = state.dragW;
    portalUniforms.uTime.value = time;
    portal.rotation.y = damp(portal.rotation.y, mx * 0.14 * dampK, 4, dt);
    portal.rotation.x = damp(portal.rotation.x, -my * 0.1 * dampK, 4, dt);
    portal.scale.setScalar(1 + portalPulse * 0.06 + state.dragW * 0.045);
    if (portal.userData.edgeMat) portal.userData.edgeMat.opacity = 0.32 + portalUniforms.uIntensity.value * 0.4;

    /* flottille : dérive, répulsion curseur, chute (DROP), orbite (drag) */
    const fallSpan = sstep(0.015, 0.3, storySmooth);
    fleets.forEach((f, i) => {
      const g = f.g;
      /* position de base flottante */
      const fl = MOTION;
      V.a.set(
        f.base.x + Math.sin(time * 0.16 * f.driftA + f.phase) * 0.7 * fl,
        f.base.y + Math.cos(time * 0.13 * f.driftA + f.phase * 1.7) * 0.5 * fl,
        f.base.z
      );
      /* chute cinématique du chapitre DROP */
      if (w.drop > 0.001) {
        const u = (fallSpan * f.fallSpeed + f.fallOffset) % 1;
        const fy = lerp(6.5, -1.9, u);
        const fz = lerp(f.base.z - 3, -0.6 - f.layerT * 1.2, u);
        const fx = f.base.x * lerp(1, 0.28, u * u);
        V.b.set(fx, fy, fz);
        V.a.lerpVectors(V.a, V.b, w.drop);
        const blurish = Math.abs(u - 0.5) * 2; // fades en début/fin de chute
        g.visible = blurish < 0.98;
      } else g.visible = true;
      /* orbite de drag / attraction portail */
      if (state.dragW > 0.02 || (pointer.nearDz ? 0.12 : 0) > 0) {
        const orb = Math.max(state.dragW, pointer.nearDz ? 0.12 : 0);
        const ang = f.orbitAng + time * (0.22 + 0.1 * MOTION) * (state.dragW > 0.02 ? 1 : 0.25);
        V.b.set(
          portal.position.x + Math.cos(ang) * 2.55,
          portal.position.y + Math.sin(ang) * 1.55,
          portal.position.z + Math.sin(ang * 2 + f.phase) * 0.5
        );
        V.a.lerpVectors(V.a, V.b, orb);
      }
      /* dégager la scène centrale pour les vignettes SHARE / SCAN */
      const clearCenter = w.share + w.scan + afterWS * 0.9;
      if (clearCenter > 0.001) {
        V.a.x *= 1 + Math.min(clearCenter, 1) * 1.15;
        V.a.y -= w.share * 1.1 + afterWS * 1.4;
        V.a.z -= w.scan * 2.4 + afterWS * 3.0;
      }
      /* répulsion douce du curseur (monde proche uniquement) */
      if (pointer.active && !reduced && f.layerT < 0.55 && state.dragW < 0.2) {
        const dx = V.a.x - mouseWorld.x, dy = V.a.y - mouseWorld.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 2.9) {
          const d = Math.sqrt(d2) || 0.001;
          const push = (1.7 - Math.min(d, 1.7)) * 0.5;
          V.a.x += (dx / d) * push;
          V.a.y += (dy / d) * push;
        }
      }
      /* parallaxe pointeur selon la profondeur */
      V.a.x += -mx * f.parallax * 1.1;
      V.a.y += -my * f.parallax * 0.7;

      g.position.x = damp(g.position.x, V.a.x, 2.6, dt);
      g.position.y = damp(g.position.y, V.a.y, 2.6, dt);
      g.position.z = damp(g.position.z, V.a.z, 2.2, dt);
      g.rotation.y += f.rotSpd * dt * MOTION * 0.35;
      g.rotation.z = damp(g.rotation.z, Math.sin(time * 0.2 + f.phase) * 0.12 * MOTION, 2, dt);
    });

    /* mots-chapitres */
    words.drop.material.opacity = w.drop * sstep(0.03, 0.12, storySmooth) * (1 - sstep(0.24, 0.32, storySmooth)) * 0.94;
    words.drop.position.x = -0.9 + mx * 0.1;
    words.share.material.opacity = sstep(0.32, 0.4, storySmooth) * (1 - sstep(0.56, 0.64, storySmooth)) * 0.94;
    words.share.position.x = 1.1 + mx * 0.1;
    words.scan.material.opacity = sstep(0.6, 0.7, storySmooth) * (1 - sstep(0.94, 1, storySmooth)) * 0.9 * storyFade;

    /* vignette SHARE */
    const shareActive = w.share > 0.01;
    shareScene.visible = shareActive;
    if (shareActive) {
      shareTrailMat.uniforms.uTime.value = time;
      const sp = clamp((storySmooth - 0.36) / 0.26, 0, 1);
      shareTrailMat.uniforms.uProg.value = sp;
      shareCurve.getPointAt(clamp(sp, 0.001, 0.999), packet.position);
      packet.visible = sp > 0.02 && sp < 0.98;
      devA.position.y = 0.1 + Math.sin(time * 0.5) * 0.06 * MOTION;
      devB.position.y = -0.5 + Math.cos(time * 0.45) * 0.06 * MOTION;
      packetGlow.material.opacity = 0.45 + Math.sin(time * 6) * 0.15 * MOTION;
    }

    /* vignette SCAN */
    const scanActive = storySmooth > 0.58 && storyFade > 0.01;
    scanScene.visible = scanActive;
    scanUrl.material.opacity = sstep(0.86, 0.95, storySmooth) * (1 - sstep(0.985, 1, storySmooth)) * 0.92 * storyFade;
    if (scanActive) {
      const t = sstep(0.62, 0.74, storySmooth);
      scanPanelMat.opacity = t * 0.96 * storyFade;
      scanQrMat.opacity = sstep(0.68, 0.76, storySmooth) * storyFade;
      scanFrameMat.opacity = sstep(0.7, 0.78, storySmooth) * 0.8 * storyFade;
      const scanT = sstep(0.74, 0.9, storySmooth);
      scanLineMat.uniforms.uY.value = scanT > 0 && scanT < 1 ? lerp(0.02, 0.98, scanT) : -1;
      scanScene.rotation.y = damp(scanScene.rotation.y, mx * 0.22 * dampK + Math.sin(time * 0.15) * 0.08 * MOTION, 3, dt);
      scanScene.position.z = lerp(-9, -8.2, sstep(0.8, 1, storySmooth));
    }

    /* particules & lointain */
    pUniforms.uTime.value = time * (0.4 + 0.6 * MOTION);
    pUniforms.uDensity.value = damp(pUniforms.uDensity.value, (pointer.nearDz ? 0.5 : 0) + state.dragW, 3, dt);
    trailMats.forEach((m) => { m.uniforms.uTime.value = time * (0.4 + 0.6 * MOTION); });
    distant.rotation.y = mx * 0.03 * dampK + time * 0.004 * MOTION;
    distant.position.x = -mx * 0.25 * dampK;

    /* lumières d'accent suivent doucement le curseur */
    accentV.position.x = -4.5 + mx * 1.4;
    accentV.position.y = 1.6 + my * 1.1;
    accentB.position.x = 4.5 + mx * 1.1;
    accentB.position.y = -1.4 + my * 0.9;

    /* séquence d'upload : objet héros */
    if (heroFile.visible) {
      const pop = reduced ? 1 : sstep(0, 0.16, state.uploadW);
      heroFile.scale.setScalar(Math.max(0.001, pop));
      heroFile.rotation.y += dt * (0.5 + state.progress * 0.6) * (MOTION || 0.3);
      heroFile.position.y = -0.12 + Math.sin(time * 1.1) * 0.05 * MOTION;
      heroRing.material.opacity = state.uploadW * (0.4 + state.progress * 0.4);
      heroRing.rotation.z = -state.progress * Math.PI * 2 + time * 0.3 * MOTION;
      heroRing.scale.setScalar(1 + Math.sin(time * 2) * 0.02 * MOTION);
      if (state.morphing) {
        const k = clamp((performance.now() - state.morphStart) / state.morphDur, 0, 1);
        morphUniforms.uMix.value = k;
        heroFile.scale.setScalar(Math.max(0.001, 1 - sstep(0.05, 0.4, k)));
        heroFaceMat.opacity = 1 - sstep(0.05, 0.35, k);
        heroBodyMat.opacity = 1 - sstep(0.05, 0.35, k);
        heroRing.material.opacity = (1 - k) * 0.6;
        if (k >= 1 && !state.resultShown) {
          showResult(state.morphPayload);
          heroFile.visible = false;
          heroFaceMat.opacity = 1; heroBodyMat.opacity = 1;
        }
      }
    }
    if (morph.visible) {
      morphUniforms.uTime.value = time;
      morph.rotation.y = Math.sin(time * 0.12) * 0.12 * MOTION + mx * 0.06 * dampK;
      // le QR plans dérive doucement vers l'avant une fois formé
      morph.position.z = damp(morph.position.z, state.morphing ? 0.35 : 0, 2, dt);
    }

    /* features : rendu scissor quand la section est visible */
    if (canvas2) canvas2.classList.toggle('visible', featuresOn);
    if (renderer2 && featuresOn) {
      renderer2.setScissorTest(false);
      renderer2.clear();
      renderer2.setScissorTest(true);
      views.forEach((el, idx) => {
        const mini = minis[idx];
        if (!mini) return;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return;
        const wpx = Math.max(1, Math.floor(r.width)), hpx = Math.max(1, Math.floor(r.height));
        const left = Math.floor(r.left), bottom = Math.floor(window.innerHeight - r.bottom);
        mini.cam.aspect = wpx / hpx;
        mini.cam.updateProjectionMatrix();
        mini.update(time);
        renderer2.setViewport(left, bottom, wpx, hpx);
        renderer2.setScissor(left, bottom, wpx, hpx);
        renderer2.render(mini.scene, mini.cam);
      });
    }

    renderer.render(scene, camera);
  }

  function onResize() {
    const wpx2 = window.innerWidth, hpx2 = window.innerHeight;
    camera.aspect = wpx2 / hpx2;
    camera.updateProjectionMatrix();
    renderer.setSize(wpx2, hpx2, false);
    if (renderer2) renderer2.setSize(wpx2, hpx2, false);
  }
  window.addEventListener('resize', onResize, { passive: true });

  if (location.hash === '#debug') {
    window.__dq = () => ({
      storyP, storySmooth, afterW, afterWS,
      words: Object.fromEntries(Object.entries(words).map(([k, m]) => [k, +m.material.opacity.toFixed(3)])),
      scanVisible: scanScene.visible,
      scanMats: { panel: +scanPanelMat.opacity.toFixed(3), qr: +scanQrMat.opacity.toFixed(3), frame: +scanFrameMat.opacity.toFixed(3) },
      scanUrl: +scanUrl.material.opacity.toFixed(3),
      shareVisible: shareScene.visible,
      morphVisible: morph.visible,
      morphAlpha: +morphUniforms.uAlpha.value.toFixed(3),
      shareTrail: shareTrailMat.uniforms ? +shareTrailMat.uniforms.uProg.value.toFixed(3) : null,
      portalVisible: portal.visible,
      cam: camState.pos.toArray().map((v) => +v.toFixed(2))
    });
  }

  frame();

  /* ------------------------------------------------ fallback UI sans WebGL */
  function initFlatUI() {
    // Le DOM (dropzone, overlays, auth) fonctionne sans 3D : branchements minimaux.
    const dzEl = document.getElementById('dropzone');
    const upOv = document.getElementById('upload-overlay');
    const upNm = document.getElementById('up-name');
    const upSt = document.getElementById('up-status');
    const upBr = document.getElementById('up-bar');
    const upPc = document.getElementById('up-pct');
    const resOv = document.getElementById('result-overlay');
    const rl = document.getElementById('result-link');
    const rn = document.getElementById('result-note');
    const rq = document.getElementById('result-qr');
    const LEN = 2 * Math.PI * 58;
    if (upBr) { upBr.style.strokeDasharray = `${LEN}`; }
    const setP = (p) => { if (upBr) upBr.style.strokeDashoffset = `${LEN * (1 - p)}`; if (upPc) upPc.textContent = `${Math.round(p * 100)}%`; };
    let busy = false;
    function paint2(text, cv, fg, bg) {
      const go = () => {
        if (!window.qrcode) return setTimeout(go, 70);
        try {
          const q = window.qrcode(0, 'M'); q.addData(text); q.make();
          const n = q.getModuleCount(), pad = 2, cell = cv.width / (n + pad * 2), x = cv.getContext('2d');
          x.fillStyle = bg; x.fillRect(0, 0, cv.width, cv.width);
          x.fillStyle = fg;
          for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) x.fillRect((c + pad) * cell, (r + pad) * cell, cell + .5, cell + .5);
        } catch (_e) {}
      };
      go();
    }
    // Plusieurs fichiers/dossiers -> archive .zip ; un seul fichier -> tel quel.
    async function prepareFlatFile(items) {
      const list = (items || []).filter(Boolean);
      if (!list.length) return null;
      if (list.length === 1 || !window.DropQRZip) return list[0].data || list[0];
      const total = list.reduce((sum, entry) => sum + Number((entry.data || entry).size || 0), 0);
      if (upSt) upSt.textContent = `Packing ${list.length} files into one .zip…`;
      return window.DropQRZip.makeZipFile(list, `DropQR-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.zip`, {
        onProgress: (processed) => {
          if (upSt) upSt.textContent = `Packing .zip · ${Math.round((processed / Math.max(total, 1)) * 100)}%`;
        }
      });
    }
    function doUpload(file) {
      if (busy || !file) return;
      busy = true;
      if (upNm) upNm.textContent = file.name;
      if (upSt) upSt.textContent = 'Uploading';
      if (upOv) upOv.classList.add('on');
      setP(0);
      const form = new FormData();
      form.append('file', file, file.name || 'fichier');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/transfers'); xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) setP(Math.min(e.loaded / e.total, .985)); };
      xhr.onload = () => {
        busy = false;
        if (xhr.status === 201 && xhr.response && xhr.response.shareUrl) {
          setP(1);
          if (upOv) upOv.classList.remove('on');
          const p = xhr.response;
          if (rl) rl.textContent = p.shareUrl.replace(/^https?:\/\//, '');
          if (rn) rn.textContent = `code ${p.code}`;
          if (rq) { rq.innerHTML = ''; const cv = document.createElement('canvas'); cv.width = 440; cv.height = 440; paint2(p.shareUrl, cv, '#0b0d10', '#ffffff'); rq.appendChild(cv); }
          const copyBtn = document.getElementById('btn-copy');
          const dlBtn = document.getElementById('btn-download');
          if (copyBtn) copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(p.shareUrl); } catch (_e) {} };
          if (dlBtn) dlBtn.onclick = () => { const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1080; paint2(p.shareUrl, cv, '#0b0d10', '#ffffff'); const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `dropqr-${p.code}.png`; a.click(); };
          if (resOv) resOv.classList.add('on');
        } else {
          if (upSt) upSt.textContent = (xhr.response && xhr.response.error) || 'Upload failed.';
          setTimeout(() => upOv && upOv.classList.remove('on'), 2000);
        }
      };
      xhr.onerror = () => { busy = false; if (upSt) upSt.textContent = 'Network error.'; setTimeout(() => upOv && upOv.classList.remove('on'), 2000); };
      xhr.send(form);
    }
    const again = document.getElementById('btn-again');
    if (again) again.addEventListener('click', () => { resOv && resOv.classList.remove('on'); });
    if (dzEl) {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.hidden = true;
      dzEl.appendChild(input);
      dzEl.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const files = Array.from((input.files && input.files.length) ? input.files : []);
        input.value = '';
        if (!files.length || busy) return;
        const entries = (window.DropQRZip && window.DropQRZip.entriesFromFiles)
          ? window.DropQRZip.entriesFromFiles(files)
          : files.map((file) => ({ name: file.name, data: file }));
        doUpload(await prepareFlatFile(entries));
      });
    }
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (busy) return;
      let entries = [];
      try {
        entries = (window.DropQRZip && window.DropQRZip.collectEntries)
          ? await window.DropQRZip.collectEntries(e.dataTransfer)
          : Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((file) => ({ name: file.name, data: file }));
      } catch (_error) {
        entries = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((file) => ({ name: file.name, data: file }));
      }
      const file = await prepareFlatFile(entries);
      if (file) doUpload(file);
    });
    // auth slot (identique, version légère)
    (async () => {
      const slots = [...document.querySelectorAll('[data-discord-auth]')];
      if (!slots.length) return;
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const data = res.ok ? await res.json() : null;
        slots.forEach((slot) => {
          if (data && data.configured && data.user) {
            slot.innerHTML = `<span class="discord-chip"><img src="${data.user.avatar}" width="26" height="26" alt=""><span class="discord-chip-name"></span><button class="discord-logout" type="button" aria-label="Sign out">×</button></span>`;
            slot.querySelector('.discord-chip-name').textContent = data.user.globalName || data.user.username;
            slot.querySelector('.discord-logout').addEventListener('click', async () => { try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_e) {} window.location.reload(); });
          } else if (data && data.configured) {
            slot.innerHTML = `<a class="discord-auth-btn" href="/api/auth/discord/login?next=/">Sign in with Discord</a>`;
          }
        });
      } catch (_e) {}
    })();
  }
})();
