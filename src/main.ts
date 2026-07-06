import './style.css';
import * as THREE from 'three';
import { initEmbed, getColyseusAuth, waitForPlayer } from '@genex-ai/embed-sdk';
import { initGameSentry, sentryCanvasSnapshot } from '@genex-ai/embed-sdk/sentry';
import { matchmake, type Matchmaking, type Session } from '@genex-ai/multiplayer';
import { GENEX } from './genex.config';

initGameSentry({ slug: GENEX.slug });
initEmbed({
  slug: GENEX.slug,
  apiUrl: GENEX.apiUrl,
  dashboardOrigins: GENEX.dashboardOrigins,
});

type NetValue = number | number[];
type DuelState = Record<string, NetValue> & {
  x: number;
  z: number;
  q: number[];
  hp: number;
  alive: number;
  swing: number;
  round: number;
};

type StrikeEvent = {
  from: string;
  target: string | null;
  damage: number;
  x: number;
  z: number;
  q: number[];
  round: number;
};

type FighterVisual = {
  root: THREE.Group;
  body: THREE.Mesh;
  visor: THREE.Mesh;
  blade: THREE.Mesh;
  slash: THREE.Mesh;
  shadow: THREE.Mesh;
};

type HitSpark = {
  mesh: THREE.Mesh;
  born: number;
  life: number;
};

const MAX_HP = 100;
const MOVE_SPEED = 6.4;
const ARENA_RADIUS = 8.2;
const FIGHTER_RADIUS = 0.45;
const STRIKE_RANGE = 2.05;
const STRIKE_ARC_DOT = 0.42;
const STRIKE_DAMAGE = 25;
const STRIKE_COOLDOWN_MS = 620;
const STRIKE_ANIM_MS = 180;
const NETWORK_TICK_MS = 66;

function mustFind<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

const app = mustFind<HTMLDivElement>('#app');

app.innerHTML = `
  <canvas id="game"></canvas>
  <div class="hud" aria-live="polite">
    <div class="topline">
      <div>
        <div class="eyebrow">Duel Arena</div>
        <div id="status" class="status">Opening arena</div>
      </div>
      <div id="queue" class="queue"></div>
    </div>
    <div class="bars">
      <div class="fighter-panel">
        <div id="leftName" class="fighter-name">You</div>
        <div class="bar"><span id="leftHp"></span></div>
      </div>
      <div class="versus">VS</div>
      <div class="fighter-panel right">
        <div id="rightName" class="fighter-name">Opponent</div>
        <div class="bar"><span id="rightHp"></span></div>
      </div>
    </div>
  </div>
`;

const canvas = mustFind<HTMLCanvasElement>('#game');
const statusEl = mustFind<HTMLDivElement>('#status');
const queueEl = mustFind<HTMLDivElement>('#queue');
const leftNameEl = mustFind<HTMLDivElement>('#leftName');
const rightNameEl = mustFind<HTMLDivElement>('#rightName');
const leftHpEl = mustFind<HTMLSpanElement>('#leftHp');
const rightHpEl = mustFind<HTMLSpanElement>('#rightHp');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080a14);
scene.fog = new THREE.Fog(0x080a14, 15, 32);

const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 80);
camera.position.set(0, 12.5, 12.5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aimPoint = new THREE.Vector3();
const upAxis = new THREE.Vector3(0, 1, 0);
const tempQuat = new THREE.Quaternion();

const keys = new Set<string>();
const fighterVisuals = new Map<string, FighterVisual>();
const hitSparks: HitSpark[] = [];
const unbindSessionEvents: Array<() => void> = [];

let matchmaking: Matchmaking<DuelState> | null = null;
let boundSession: Session<DuelState> | null = null;
let matchError = '';
let playerName = 'You';
let pointerHasAim = false;
let localAttackUntil = 0;
let localCooldownUntil = 0;
let eliminatedRound = -1;
let lastRoundKey = '';
let lastFrameTime = performance.now();

const me = {
  x: -4.6,
  z: 0,
  yaw: Math.PI / 2,
  hp: MAX_HP,
  alive: 1,
};

buildArena();
installInput();
resize();
window.addEventListener('resize', resize);

void startMatchmaking();
setInterval(publishLocalState, NETWORK_TICK_MS);
renderer.setAnimationLoop(frame);

async function startMatchmaking() {
  try {
    const { user } = await waitForPlayer();
    playerName = user.name;
    matchmaking = await matchmake<DuelState>({
      url: GENEX.colyseusUrl,
      room: GENEX.slug,
      name: user.name,
      auth: () => getColyseusAuth(),
    });

    matchmaking.on('matched', () => {
      resetForRound();
    });
    matchmaking.on('matchStart', () => {
      resetForRound();
    });
    matchmaking.on('matchEnded', () => {
      localAttackUntil = 0;
    });
    matchmaking.on('error', () => {
      matchError = 'Matchmaking paused';
    });
  } catch {
    matchError = 'Sign-in needed';
  }
}

function buildArena() {
  const hemi = new THREE.HemisphereLight(0xbfd5ff, 0x222018, 1.9);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffe4b0, 2.7);
  key.position.set(-6, 12, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 2;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -12;
  key.shadow.camera.right = 12;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  scene.add(key);

  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_RADIUS + 0.6, ARENA_RADIUS + 0.6, 0.18, 96),
    new THREE.MeshStandardMaterial({ color: 0x242735, roughness: 0.82, metalness: 0.08 }),
  );
  floor.position.y = -0.11;
  floor.receiveShadow = true;
  scene.add(floor);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(ARENA_RADIUS, 0.075, 12, 128),
    new THREE.MeshStandardMaterial({
      color: 0xffc857,
      emissive: 0x8f5700,
      emissiveIntensity: 0.25,
      roughness: 0.36,
      metalness: 0.4,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  scene.add(ring);

  const midLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.04, ARENA_RADIUS * 1.55),
    new THREE.MeshStandardMaterial({ color: 0x4f596f, roughness: 0.75 }),
  );
  midLine.position.y = 0.02;
  scene.add(midLine);

  const padGeo = new THREE.CylinderGeometry(1.25, 1.25, 0.04, 48);
  const leftPad = new THREE.Mesh(
    padGeo,
    new THREE.MeshStandardMaterial({
      color: 0x224f88,
      emissive: 0x0d315a,
      emissiveIntensity: 0.35,
      roughness: 0.65,
    }),
  );
  leftPad.position.set(-4.6, 0.01, 0);
  scene.add(leftPad);

  const rightPad = new THREE.Mesh(
    padGeo.clone(),
    new THREE.MeshStandardMaterial({
      color: 0x8c2f39,
      emissive: 0x5d121a,
      emissiveIntensity: 0.35,
      roughness: 0.65,
    }),
  );
  rightPad.position.set(4.6, 0.01, 0);
  scene.add(rightPad);

  const grid = new THREE.GridHelper((ARENA_RADIUS + 0.6) * 2, 18, 0x384057, 0x303546);
  grid.position.y = 0.025;
  scene.add(grid);
}

function installInput() {
  window.addEventListener('keydown', (event) => {
    keys.add(event.code);
    if ((event.code === 'Space' || event.code === 'Enter') && !event.repeat) {
      event.preventDefault();
      strike();
    }
  });

  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
  });

  canvas.addEventListener('pointermove', (event) => {
    aimFromPointer(event.clientX, event.clientY);
  });

  canvas.addEventListener('pointerdown', (event) => {
    aimFromPointer(event.clientX, event.clientY);
    strike();
  });

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  bindCurrentSession();
  ensureRoundState();
  updateLocalFighter(dt);
  drawFighters();
  updateHitSparks();
  updateHud();

  renderer.render(scene, camera);
  sentryCanvasSnapshot(renderer.domElement);
}

function bindCurrentSession() {
  const session = matchmaking?.session ?? null;
  if (session === boundSession) return;

  while (unbindSessionEvents.length > 0) {
    const unbind = unbindSessionEvents.pop();
    unbind?.();
  }

  fighterVisuals.forEach((visual) => scene.remove(visual.root));
  fighterVisuals.clear();
  boundSession = session;
  lastRoundKey = '';

  if (!session) return;

  unbindSessionEvents.push(
    session.on('leave', (id) => {
      const visual = fighterVisuals.get(id);
      if (visual) {
        scene.remove(visual.root);
        fighterVisuals.delete(id);
      }
    }),
  );

  unbindSessionEvents.push(
    session.on('strike', (payload) => {
      handleStrikeEvent(session, payload);
    }),
  );
}

function ensureRoundState() {
  const session = matchmaking?.session;
  const view = matchmaking?.matchmaking;
  if (!session || !view || view.status === 'ended') return;

  const key = `${session.id}:${view.roundId}:${view.players.join('|')}:${view.status}`;
  if (key === lastRoundKey) return;

  lastRoundKey = key;
  resetForRound();
}

function resetForRound() {
  const session = matchmaking?.session;
  const view = matchmaking?.matchmaking;
  if (!session || !view) return;

  const spawn = spawnFor(session.id, view);
  me.x = spawn.x;
  me.z = spawn.z;
  me.yaw = spawn.yaw;
  me.hp = MAX_HP;
  me.alive = view.role === 'player' ? 1 : 0;
  localAttackUntil = 0;
  localCooldownUntil = 0;
  eliminatedRound = -1;
}

function spawnFor(id: string, view: Matchmaking<DuelState>['matchmaking']) {
  const champion = view.championId ?? view.players[0] ?? id;
  const challenger = view.challengerId ?? view.players.find((playerId) => playerId !== champion);

  if (id === champion) {
    return { x: -4.6, z: 0, yaw: Math.PI / 2 };
  }
  if (id === challenger) {
    return { x: 4.6, z: 0, yaw: -Math.PI / 2 };
  }
  return { x: 0, z: 5.8, yaw: Math.PI };
}

function updateLocalFighter(dt: number) {
  if (!canMove()) return;

  const xAxis = keyDown('KeyD', 'ArrowRight') - keyDown('KeyA', 'ArrowLeft');
  const zAxis = keyDown('KeyS', 'ArrowDown') - keyDown('KeyW', 'ArrowUp');
  const length = Math.hypot(xAxis, zAxis);

  if (length > 0) {
    const nx = xAxis / length;
    const nz = zAxis / length;
    me.x += nx * MOVE_SPEED * dt;
    me.z += nz * MOVE_SPEED * dt;

    if (!pointerHasAim) {
      me.yaw = Math.atan2(nx, nz);
    }
  }

  clampToArena();
}

function keyDown(primary: string, secondary: string) {
  return keys.has(primary) || keys.has(secondary) ? 1 : 0;
}

function canMove() {
  const view = matchmaking?.matchmaking;
  return Boolean(
    matchmaking?.session &&
      view?.role === 'player' &&
      view.status !== 'ended' &&
      view.status !== 'searching' &&
      me.alive > 0,
  );
}

function canStrike() {
  const view = matchmaking?.matchmaking;
  return Boolean(
    matchmaking?.session &&
      view?.role === 'player' &&
      view.status === 'playing' &&
      me.alive > 0 &&
      performance.now() >= localCooldownUntil,
  );
}

function clampToArena() {
  const distance = Math.hypot(me.x, me.z);
  const maxDistance = ARENA_RADIUS - FIGHTER_RADIUS;
  if (distance <= maxDistance) return;

  const scale = maxDistance / Math.max(distance, 0.001);
  me.x *= scale;
  me.z *= scale;
}

function aimFromPointer(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
  pointer.y = -(((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
  raycaster.setFromCamera(pointer, camera);

  if (!raycaster.ray.intersectPlane(groundPlane, aimPoint)) return;

  const dx = aimPoint.x - me.x;
  const dz = aimPoint.z - me.z;
  if (Math.hypot(dx, dz) > 0.08) {
    me.yaw = Math.atan2(dx, dz);
    pointerHasAim = true;
  }
}

function strike() {
  if (!canStrike()) return;

  const session = matchmaking?.session;
  const view = matchmaking?.matchmaking;
  if (!session || !view) return;

  const now = performance.now();
  localCooldownUntil = now + STRIKE_COOLDOWN_MS;
  localAttackUntil = now + STRIKE_ANIM_MS;

  const hit = findStrikeTarget(session, view);
  spawnSlash(me.x, me.z, myQuaternion(), hit ? 0xfff1a6 : 0xffb24d);

  if (hit) {
    spawnHitSpark(hit.x, hit.z, 0xfff1a6);
  }

  const event: StrikeEvent = {
    from: session.id,
    target: hit?.id ?? null,
    damage: STRIKE_DAMAGE,
    x: me.x,
    z: me.z,
    q: myQuaternion(),
    round: view.roundId,
  };
  session.send('strike', event);
}

function findStrikeTarget(session: Session<DuelState>, view: Matchmaking<DuelState>['matchmaking']) {
  const forwardX = Math.sin(me.yaw);
  const forwardZ = Math.cos(me.yaw);
  let best: { id: string; x: number; z: number; distance: number } | null = null;

  for (const id of view.opponents) {
    const player = session.players.get(id);
    if (!player || !isLiveDuelState(player.stateRaw)) continue;
    if (player.stateRaw.alive <= 0 || player.stateRaw.round !== view.roundId) continue;

    const dx = player.stateRaw.x - me.x;
    const dz = player.stateRaw.z - me.z;
    const distance = Math.hypot(dx, dz);
    if (distance > STRIKE_RANGE || distance <= 0.01) continue;

    const dot = (dx / distance) * forwardX + (dz / distance) * forwardZ;
    if (dot < STRIKE_ARC_DOT) continue;
    if (!best || distance < best.distance) {
      best = { id, x: player.stateRaw.x, z: player.stateRaw.z, distance };
    }
  }

  return best;
}

function handleStrikeEvent(session: Session<DuelState>, payload: unknown) {
  if (!isStrikeEvent(payload)) return;
  if (payload.from === session.id) return;

  spawnSlash(payload.x, payload.z, payload.q, payload.target === session.id ? 0xfff1a6 : 0xff8d4c);

  const view = matchmaking?.matchmaking;
  if (!view || payload.round !== view.roundId || payload.target !== session.id || me.alive <= 0) return;

  me.hp = Math.max(0, me.hp - payload.damage);
  spawnHitSpark(me.x, me.z, 0xff4f63);

  if (me.hp <= 0) {
    me.alive = 0;
    if (eliminatedRound !== view.roundId) {
      eliminatedRound = view.roundId;
      matchmaking?.eliminated();
    }
  }
}

function isStrikeEvent(value: unknown): value is StrikeEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<StrikeEvent>;
  return (
    typeof event.from === 'string' &&
    (typeof event.target === 'string' || event.target === null) &&
    typeof event.damage === 'number' &&
    typeof event.x === 'number' &&
    typeof event.z === 'number' &&
    Array.isArray(event.q) &&
    event.q.length === 4 &&
    typeof event.round === 'number'
  );
}

function drawFighters() {
  const session = matchmaking?.session;
  const view = matchmaking?.matchmaking;
  const visible = new Set<string>();

  if (!session || !view) {
    return;
  }

  if (view.role === 'player') {
    drawFighter(session.id, localState(), true);
    visible.add(session.id);
  }

  for (const [id, player] of session.players) {
    if (id === session.id) continue;
    if (!isLiveDuelState(player.state)) continue;
    if (player.state.round !== view.roundId && view.status !== 'waiting') continue;

    drawFighter(id, player.state, false);
    visible.add(id);
  }

  for (const [id, visual] of fighterVisuals) {
    if (!visible.has(id)) {
      scene.remove(visual.root);
      fighterVisuals.delete(id);
    }
  }
}

function drawFighter(id: string, state: DuelState, isSelf: boolean) {
  const visual = visualFor(id, isSelf);
  const hpRatio = THREE.MathUtils.clamp(state.hp / MAX_HP, 0, 1);
  const alive = state.alive > 0;
  const color = colorForFighter(id, isSelf);

  visual.root.position.set(state.x, 0, state.z);
  if (state.q.length === 4) {
    visual.root.quaternion.fromArray(state.q);
  }

  const bodyMaterial = visual.body.material;
  if (bodyMaterial instanceof THREE.MeshStandardMaterial) {
    bodyMaterial.color.copy(color);
    bodyMaterial.emissive.copy(color).multiplyScalar(alive ? 0.16 : 0.03);
    bodyMaterial.opacity = alive ? 1 : 0.45;
  }

  const visorMaterial = visual.visor.material;
  if (visorMaterial instanceof THREE.MeshStandardMaterial) {
    visorMaterial.emissiveIntensity = isSelf ? 1.8 : 1.1;
  }

  visual.root.scale.setScalar(alive ? 1 : 0.72);
  visual.body.position.y = alive ? 0.88 : 0.48;
  visual.blade.visible = alive;
  visual.shadow.scale.set(1.05 + hpRatio * 0.4, 1.05 + hpRatio * 0.4, 1);
  visual.slash.visible = alive && (isSelf ? performance.now() < localAttackUntil : state.swing > 0.08);
}

function visualFor(id: string, isSelf: boolean) {
  const current = fighterVisuals.get(id);
  if (current) return current;

  const root = new THREE.Group();
  const color = colorForFighter(id, isSelf);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  root.add(shadow);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.38, 0.88, 8, 18),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.16),
      roughness: 0.48,
      metalness: 0.05,
      transparent: true,
    }),
  );
  body.position.y = 0.88;
  body.castShadow = true;
  root.add(body);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.48, 0.16, 0.13),
    new THREE.MeshStandardMaterial({
      color: 0xe8f7ff,
      emissive: 0x9ee8ff,
      emissiveIntensity: isSelf ? 1.8 : 1.1,
      roughness: 0.22,
    }),
  );
  visor.position.set(0, 1.2, 0.36);
  root.add(visor);

  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.92),
    new THREE.MeshStandardMaterial({
      color: 0xf8d27a,
      emissive: 0xffb52e,
      emissiveIntensity: 0.9,
      roughness: 0.28,
    }),
  );
  blade.position.set(0.34, 0.8, 0.56);
  root.add(blade);

  const slash = new THREE.Mesh(
    new THREE.BoxGeometry(1.45, 0.08, 0.16),
    new THREE.MeshBasicMaterial({
      color: 0xffe6a3,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  );
  slash.position.set(0, 0.75, 1.1);
  slash.visible = false;
  root.add(slash);

  scene.add(root);

  const visual = { root, body, visor, blade, slash, shadow };
  fighterVisuals.set(id, visual);
  return visual;
}

function colorForFighter(id: string, isSelf: boolean) {
  const view = matchmaking?.matchmaking;
  if (isSelf) return new THREE.Color(0x2f93ff);
  if (view?.championId === id) return new THREE.Color(0x2f93ff);
  if (view?.challengerId === id) return new THREE.Color(0xff4f63);
  return new THREE.Color(0xd8d6c8);
}

function spawnSlash(x: number, z: number, q: number[], color: number) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.75, 0.075, 0.18),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  mesh.position.set(x, 0.78, z);
  if (q.length === 4) mesh.quaternion.fromArray(q);
  mesh.translateZ(1.05);
  mesh.rotateY(Math.PI / 10);
  scene.add(mesh);
  hitSparks.push({ mesh, born: performance.now(), life: STRIKE_ANIM_MS });
}

function spawnHitSpark(x: number, z: number, color: number) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 12, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  mesh.position.set(x, 0.92, z);
  scene.add(mesh);
  hitSparks.push({ mesh, born: performance.now(), life: 260 });
}

function updateHitSparks() {
  const now = performance.now();
  for (let index = hitSparks.length - 1; index >= 0; index -= 1) {
    const spark = hitSparks[index];
    const t = (now - spark.born) / spark.life;
    if (t >= 1) {
      scene.remove(spark.mesh);
      hitSparks.splice(index, 1);
      continue;
    }

    spark.mesh.scale.setScalar(1 + t * 1.8);
    const material = spark.mesh.material;
    if (material instanceof THREE.MeshBasicMaterial) {
      material.opacity = 0.9 * (1 - t);
    }
  }
}

function publishLocalState() {
  const session = matchmaking?.session;
  const view = matchmaking?.matchmaking;
  if (!session || !view || view.role !== 'player') return;
  session.me.set(localState());
}

function localState(): DuelState {
  const view = matchmaking?.matchmaking;
  return {
    x: me.x,
    z: me.z,
    q: myQuaternion(),
    hp: me.hp,
    alive: me.alive,
    swing: performance.now() < localAttackUntil ? 1 : 0,
    round: view?.roundId ?? 0,
  };
}

function myQuaternion() {
  return tempQuat.setFromAxisAngle(upAxis, me.yaw).toArray();
}

function isLiveDuelState(state: DuelState | undefined): state is DuelState {
  return Boolean(
    state &&
      Number.isFinite(state.x) &&
      Number.isFinite(state.z) &&
      Number.isFinite(state.hp) &&
      Number.isFinite(state.alive) &&
      Number.isFinite(state.swing) &&
      Number.isFinite(state.round) &&
      Array.isArray(state.q) &&
      state.q.length === 4,
  );
}

function updateHud() {
  const session = matchmaking?.session;
  const view = matchmaking?.matchmaking;

  if (matchError) {
    statusEl.textContent = matchError;
    queueEl.textContent = '';
    setHealth(leftHpEl, 0);
    setHealth(rightHpEl, 0);
    return;
  }

  if (!view) {
    statusEl.textContent = 'Opening arena';
    queueEl.textContent = '';
    setHealth(leftHpEl, me.hp);
    setHealth(rightHpEl, 0);
    return;
  }

  statusEl.textContent = statusText(view);
  queueEl.textContent = queueText(view);

  if (!session) {
    leftNameEl.textContent = playerName;
    rightNameEl.textContent = 'Opponent';
    setHealth(leftHpEl, me.hp);
    setHealth(rightHpEl, 0);
    return;
  }

  if (view.role === 'spectator') {
    const champion = view.championId ? session.players.get(view.championId) : undefined;
    const challenger = view.challengerId ? session.players.get(view.challengerId) : undefined;
    leftNameEl.textContent = champion?.name ?? 'Champion';
    rightNameEl.textContent = challenger?.name ?? 'Challenger';
    setHealth(leftHpEl, isLiveDuelState(champion?.stateRaw) ? champion.stateRaw.hp : 0);
    setHealth(rightHpEl, isLiveDuelState(challenger?.stateRaw) ? challenger.stateRaw.hp : 0);
    return;
  }

  const opponentId = view.opponents[0] ?? view.players.find((id) => id !== session.id);
  const opponent = opponentId ? session.players.get(opponentId) : undefined;

  leftNameEl.textContent = playerName;
  rightNameEl.textContent = opponent?.name ?? 'Opponent';
  setHealth(leftHpEl, me.hp);
  setHealth(rightHpEl, isLiveDuelState(opponent?.stateRaw) ? opponent.stateRaw.hp : 0);
}

function statusText(view: Matchmaking<DuelState>['matchmaking']) {
  if (view.role === 'spectator') return 'Waiting for winner';
  if (view.status === 'searching') return 'Finding a duel';
  if (view.status === 'waiting') return 'Waiting for challenger';
  if (view.status === 'countdown') return 'Duel starts soon';
  if (view.status === 'playing') return me.alive > 0 ? 'Fight' : 'Knocked out';
  if (view.status === 'ended') {
    if (!view.winnerId) return 'Draw';
    const session = matchmaking?.session;
    return view.winnerId === session?.id ? 'You won' : 'Winner stays';
  }
  return view.message || 'Duel arena';
}

function queueText(view: Matchmaking<DuelState>['matchmaking']) {
  if (view.status === 'searching') {
    return `Queue ${view.queue.position}/${Math.max(view.queue.size, 1)}`;
  }
  if (view.role === 'spectator') return 'Watching';
  if (view.status === 'ended' && view.winnerId) return `Round ${view.roundId}`;
  return '';
}

function setHealth(element: HTMLSpanElement, hp: number) {
  const ratio = THREE.MathUtils.clamp(hp / MAX_HP, 0, 1);
  element.style.transform = `scaleX(${ratio})`;
}
