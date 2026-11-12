// three.js 3D 지도: 시도 경계를 입체로 세우고, 높이=기온 / 색=PM2.5 등급 / 라벨=기온+PM10+PM2.5
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const K = 10, COS = 0.81, LON0 = 127.8, LAT0 = 36; // 경위도 → 월드 좌표 (등장방형, 위도 36° 보정)
const toX = (lon) => (lon - LON0) * COS * K;
const toN = (lat) => (lat - LAT0) * K; // 북쪽이 +
const toLon = (x) => x / (COS * K) + LON0;
const toLat = (n) => n / K + LAT0;

let renderer, scene, camera, controls, group, raycaster, tip, container;
let polys = [];            // [{code, polys:[ring...]}] (SIDO 순서와 동일)
let items = [];            // 현재 표시 데이터
let meshes = [];           // [{mesh, idx}]
let selectedIdx = -1, hoverIdx = -1;
let onPick = () => {};
const ready = {};
ready.promise = new Promise((r) => (ready.resolve = r));

export async function init3D(el, opts) {
  container = el;
  onPick = opts.onPick;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // WebGL 미지원이면 여기서 예외
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  camera.position.set(0, 42, 38);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.1;
  controls.minDistance = 12;
  controls.maxDistance = 90;

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-20, 40, 25);
  scene.add(sun);

  // 바다 바닥
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshBasicMaterial({ color: 0x16335f, transparent: true, opacity: 0.55 })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -0.02;
  scene.add(sea);

  group = new THREE.Group();
  scene.add(group);

  raycaster = new THREE.Raycaster();
  tip = document.createElement("div");
  tip.className = "tip3d";
  tip.hidden = true;
  el.appendChild(tip);

  const resize = () => {
    const w = el.clientWidth, h = el.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(el);
  resize();

  // 클릭 vs 드래그 구분
  let down = null;
  const cv = renderer.domElement;
  cv.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
  cv.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const hit = pick(e);
    if (hit) onPick({ idx: hit.idx, lat: toLat(-hit.point.z), lon: toLon(hit.point.x) });
  });
  cv.addEventListener("pointermove", (e) => {
    const hit = pick(e);
    const idx = hit ? hit.idx : -1;
    cv.style.cursor = hit ? "pointer" : "grab";
    if (idx !== hoverIdx) { hoverIdx = idx; paint(); }
    if (hit) {
      const it = items[idx], r = el.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${e.clientX - r.left + 12}px`;
      tip.style.top = `${e.clientY - r.top + 12}px`;
      tip.textContent = `${it.name} · ${it.temp == null ? "-" : Math.round(it.temp) + "°C"} · PM10 ${fmt(it.pm10)} · PM2.5 ${fmt(it.pm25)}`;
    } else tip.hidden = true;
  });
  cv.addEventListener("pointerleave", () => { tip.hidden = true; hoverIdx = -1; paint(); });

  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();

  polys = await (await fetch("data/korea.json")).json();
  ready.resolve();
}

const fmt = (v) => (v == null ? "-" : Math.round(v));

function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
    camera
  );
  const hit = raycaster.intersectObjects(meshes.map((m) => m.mesh), false)[0];
  if (!hit) return null;
  return { idx: meshes.find((m) => m.mesh === hit.object).idx, point: hit.point };
}

function label(it, h) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 150;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(255,255,255,.95)";
  g.beginPath(); g.roundRect(4, 4, 248, 142, 22); g.fill();
  g.fillStyle = "#1b2a49";
  g.textAlign = "center";
  g.font = "bold 28px 'Malgun Gothic', sans-serif";
  g.fillText(it.name.replace(/\(.*\)/, ""), 128, 38);
  g.font = "bold 46px 'Malgun Gothic', sans-serif";
  g.fillText(it.temp == null ? "-" : `${Math.round(it.temp)}°`, 128, 88);
  [[it.pm10, it.pm10Color, 64], [it.pm25, it.pm25Color, 192]].forEach(([v, col, x]) => {
    g.fillStyle = col;
    g.beginPath(); g.roundRect(x - 44, 100, 88, 36, 10); g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 26px sans-serif";
    g.fillText(fmt(v), x, 128);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sp.scale.set(3.6, 2.1, 1);
  sp.position.set(toX(it.lon), h + 1.6, -toN(it.lat));
  sp.renderOrder = 10;
  return sp;
}

function paint() {
  for (const { mesh, idx } of meshes) {
    const base = new THREE.Color(items[idx].pm25Color);
    mesh.material.color.copy(base);
    mesh.material.emissive.set(idx === selectedIdx ? 0x555555 : idx === hoverIdx ? 0x333333 : 0x000000);
  }
}

export async function update(newItems) {
  await ready.promise;
  items = newItems;
  group.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
  group.clear();
  meshes = [];
  items.forEach((it, idx) => {
    const depth = 0.5 + Math.max(0, (it.temp ?? 10) + 10) * 0.045; // 기온이 높을수록 높게
    const mat = new THREE.MeshStandardMaterial({ color: it.pm25Color, roughness: 0.6 });
    for (const ring of polys[idx].polys) {
      const shape = new THREE.Shape(ring.map(([lon, lat]) => new THREE.Vector2(toX(lon), toN(lat))));
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // 세워서: 북쪽 = -z, 높이 = +y
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);
      meshes.push({ mesh, idx });
      const top = ring.map(([lon, lat]) => new THREE.Vector3(toX(lon), depth + 0.01, -toN(lat)));
      group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(top), new THREE.LineBasicMaterial({ color: 0xffffff })));
    }
    group.add(label(it, depth));
  });
  paint();
}

export function select(idx) {
  selectedIdx = idx;
  if (items.length) paint();
}
