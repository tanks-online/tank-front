import * as THREE from 'three';
import type { GameState, ObstacleState, PlayerState, TankKind } from './types';

const COVER: ObstacleState[] = [
  { x: -20, z: -12, w: 12, d: 8, h: 4 },
  { x: 16, z: 10, w: 10, d: 12, h: 4 },
  { x: 0, z: -20, w: 10, d: 6, h: 3 },
  { x: -12, z: 18, w: 8, d: 8, h: 3 },
  { x: 27, z: -19, w: 6, d: 14, h: 4 },
  { x: -29, z: 12, w: 6, d: 14, h: 4 },
  { x: 1, z: 3, w: 8, d: 5, h: 3 },
];
const PALETTE = [0x73b4ad, 0xd77e71, 0x91a970, 0x9b91bd, 0x6c9fbe, 0xc9976b, 0xc6b8d4];
const TAU = Math.PI * 2;
const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const clamp = THREE.MathUtils.clamp;

interface TankVisual {
  root: THREE.Group;
  turret: THREE.Group;
  label: THREE.Sprite;
  labelTexture: THREE.CanvasTexture;
  labelCanvas: HTMLCanvasElement;
  labelKey: string;
  ring: THREE.Mesh;
  kind: TankKind;
  player: PlayerState;
  ownedMaterials: THREE.Material[];
  armorMaterials: THREE.MeshStandardMaterial[];
  damageFlash: number;
}
interface ShellVisual { root: THREE.Group; x: number; z: number }
interface Particle {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  smoke: boolean;
}

/** Procedural low-poly scene: every model and texture ships with the client. */
export class TankRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(43, 1, 0.1, 220);
  private readonly sun: THREE.DirectionalLight;
  private readonly tankLayer = new THREE.Group();
  private readonly coverLayer = new THREE.Group();
  private readonly tanks = new Map<string, TankVisual>();
  private readonly shells = new Map<string, ShellVisual>();
  private readonly particles: Particle[] = [];
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly raycaster = new THREE.Raycaster();
  // Aim on the shell's flight plane so the cursor and barrel agree at every zoom.
  private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.92);
  private readonly aimReticle = new THREE.Group();
  private readonly mouse = new THREE.Vector2();
  private readonly aimPoint = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly previewTarget = new THREE.Vector3();
  private readonly desiredCamera = new THREE.Vector3();
  private readonly resizeObserver: ResizeObserver;
  private readonly onAim: (angle: number) => void;
  private readonly onFire: (pressed: boolean) => void;
  private playerId = '';
  private state?: GameState;
  private coverKey = '';
  private raf = 0;
  private lastFrame = 0;
  private elapsed = 0;
  private pointerPresent = false;
  private localAim?: number;
  private zoom = 1;
  private targetZoom = 1;
  private snapCamera = false;
  private quality: 'low' | 'high' = 'high';
  private preview = false;
  private disposed = false;

  constructor(private readonly container: HTMLElement, onAim: (angle: number) => void, onFire: (pressed: boolean) => void) {
    this.onAim = onAim;
    this.onFire = onFire;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.setAttribute('aria-label', 'Трёхмерная арена танкового боя');
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:crosshair';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x17282c);
    this.scene.fog = new THREE.Fog(0x17282c, 100, 180);
    this.scene.add(new THREE.HemisphereLight(0xfff3d3, 0x6c8581, 2.6));
    this.sun = new THREE.DirectionalLight(0xffe8ba, 3.2);
    this.sun.position.set(-35, 55, 24);
    this.sun.castShadow = true;
    Object.assign(this.sun.shadow.camera, { left: -57, right: 57, top: 47, bottom: -47, near: 1, far: 130 });
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target, this.tankLayer, this.coverLayer);
    this.buildArena();
    this.buildCover(COVER);
    this.buildReticle();
    this.camera.position.set(0, 59, 46);
    this.camera.lookAt(0, 0, 0);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.domElement.addEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointerleave', this.pointerLeave);
    this.renderer.domElement.addEventListener('contextmenu', this.contextMenu);
    this.renderer.domElement.addEventListener('wheel', this.wheel, { passive: false });
    window.addEventListener('pointerup', this.pointerUp);
    window.addEventListener('blur', this.pointerUp);
    this.raf = requestAnimationFrame(this.frame);
  }

  update(state: GameState, playerId: string): void {
    const changedIdentity = this.playerId !== playerId;
    if (changedIdentity) {
      this.localAim = undefined;
      this.snapCamera = Boolean(playerId);
    }
    this.playerId = playerId;
    this.state = state;
    this.preview = !playerId && !state.room && state.players.length > 0;
    if (this.preview) {
      this.previewTarget.set(0, 0.8, 0);
      for (const player of state.players) {
        this.previewTarget.x += player.x / state.players.length;
        this.previewTarget.z += player.z / state.players.length;
      }
    }
    const key = JSON.stringify(state.obstacles);
    if (key !== this.coverKey) this.buildCover(state.obstacles);
    const active = new Set<string>();
    for (const player of state.players) {
      active.add(player.id);
      let visual = this.tanks.get(player.id);
      if (visual && (visual.kind !== player.tank || changedIdentity)) {
        this.removeTank(player.id);
        visual = undefined;
      }
      if (!visual) {
        visual = this.createTank(player, player.id === playerId);
        this.tanks.set(player.id, visual);
        visual.root.position.set(player.x, 0, player.z);
        visual.root.rotation.y = player.angle;
        visual.turret.rotation.y = player.turret - player.angle;
      } else {
        if (visual.player.alive && !player.alive) this.explode(player.x, player.z);
        if (player.hp < visual.player.hp) {
          visual.damageFlash = 0.22;
          this.sparks(player.x, player.z, 5);
        }
        if (!visual.player.alive && player.alive) {
          visual.root.position.set(player.x, 0, player.z);
          visual.root.rotation.y = player.angle;
          if (player.id === playerId) this.snapCamera = true;
        }
        visual.player = player;
      }
      visual.root.visible = player.alive;
      visual.root.scale.setScalar(this.preview ? 1.7 : 1);
      visual.label.visible = !this.preview;
      visual.ring.visible = !this.preview;
      this.updateLabel(visual);
    }
    for (const id of this.tanks.keys()) if (!active.has(id)) this.removeTank(id);

    const shellIds = new Set<string>();
    for (const shell of state.shells) {
      shellIds.add(shell.id);
      let visual = this.shells.get(shell.id);
      if (!visual) {
        const root = new THREE.Group();
        const core = this.mesh(this.geometry('shell-core', () => new THREE.IcosahedronGeometry(0.17, 0)), this.material(0xffedab, false, 0xffa932));
        const streak = this.mesh(this.box(0.11, 0.11, 0.82), this.material(0xffa643, false, 0xff8f27));
        streak.position.z = -0.35;
        root.add(core, streak);
        root.position.set(shell.x, 0.92, shell.z);
        this.scene.add(root);
        visual = { root, x: shell.x, z: shell.z };
        this.shells.set(shell.id, visual);
      }
      const dx = shell.x - visual.x;
      const dz = shell.z - visual.z;
      if (dx * dx + dz * dz > 0.001) visual.root.rotation.y = Math.atan2(dx, dz);
      visual.x = shell.x;
      visual.z = shell.z;
    }
    for (const [id, shell] of this.shells) {
      if (!shellIds.has(id)) {
        this.sparks(shell.x, shell.z, 3);
        shell.root.traverse(object => {
          if (object instanceof THREE.Mesh) this.releaseMaterial(object.material as THREE.Material);
        });
        this.scene.remove(shell.root);
        this.shells.delete(id);
      }
    }
  }

  setQuality(quality: 'low' | 'high'): void {
    this.quality = quality;
    this.renderer.setPixelRatio(quality === 'low' ? Math.min(window.devicePixelRatio || 1, 1) : Math.min(window.devicePixelRatio || 1, 1.7));
    this.renderer.shadowMap.enabled = quality === 'high';
    this.sun.castShadow = quality === 'high';
    this.resize();
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.removeEventListener('pointerleave', this.pointerLeave);
    this.renderer.domElement.removeEventListener('contextmenu', this.contextMenu);
    this.renderer.domElement.removeEventListener('wheel', this.wheel);
    window.removeEventListener('pointerup', this.pointerUp);
    window.removeEventListener('blur', this.pointerUp);
    this.onFire(false);
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.sun.shadow.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerPresent = true;
    this.updateAim();
  };
  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.state) return;
    this.pointerMove(event);
    this.onFire(true);
    event.preventDefault();
  };
  private readonly pointerUp = (): void => { this.onFire(false); };
  private readonly pointerLeave = (): void => { this.pointerPresent = false; this.aimReticle.visible = false; this.onFire(false); };
  private readonly contextMenu = (event: Event): void => { event.preventDefault(); };
  private readonly wheel = (event: WheelEvent): void => {
    if (!this.playerId || !this.state) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.container.clientHeight : 1;
    const delta = clamp(event.deltaY * units, -140, 140);
    this.targetZoom = clamp(this.targetZoom * Math.exp(delta * 0.0014), 0.72, 1.4);
  };

  private updateAim(): void {
    const tank = this.tanks.get(this.playerId);
    this.aimReticle.visible = Boolean(this.pointerPresent && tank?.player.alive && this.state?.phase !== 'ended');
    if (!this.aimReticle.visible || !tank) return;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (this.raycaster.ray.intersectPlane(this.aimPlane, this.aimPoint)) {
      const dx = this.aimPoint.x - tank.root.position.x;
      const dz = this.aimPoint.z - tank.root.position.z;
      // Avoid a 180 degree flip when the cursor passes through the tank itself.
      if (dx * dx + dz * dz > 0.16) {
        this.localAim = Math.atan2(dx, dz);
        this.onAim(this.localAim);
        tank.turret.rotation.y = this.localAim - tank.root.rotation.y;
      }
      this.aimReticle.position.copy(this.aimPoint);
    } else {
      this.aimReticle.visible = false;
    }
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 60);
    this.lastFrame = now;
    this.elapsed += dt;
    const blend = 1 - Math.exp(-16 * dt);
    for (const tank of this.tanks.values()) {
      const player = tank.player;
      const local = player.id === this.playerId;
      const distance = Math.hypot(tank.root.position.x - player.x, tank.root.position.z - player.z);
      // Show the latest authoritative local position with less additional render delay.
      const amount = distance > 12 ? 1 : local ? 1 - Math.exp(-28 * dt) : blend;
      tank.root.position.x = THREE.MathUtils.lerp(tank.root.position.x, player.x, amount);
      tank.root.position.z = THREE.MathUtils.lerp(tank.root.position.z, player.z, amount);
      tank.root.rotation.y = lerpAngle(tank.root.rotation.y, player.angle, amount);
      tank.turret.rotation.y = local && this.localAim !== undefined
        ? this.localAim - tank.root.rotation.y
        : lerpAngle(tank.turret.rotation.y, player.turret - tank.root.rotation.y, 1 - Math.exp(-24 * dt));
      tank.damageFlash = Math.max(0, tank.damageFlash - dt);
      for (const material of tank.armorMaterials) {
        material.emissive.setHex(tank.damageFlash > 0 ? 0xff381b : 0x000000);
        material.emissiveIntensity = tank.damageFlash > 0 ? tank.damageFlash * 3 : 0;
      }
      tank.ring.rotation.z = this.elapsed * 0.12;
    }
    for (const shell of this.shells.values()) {
      shell.root.position.x = THREE.MathUtils.lerp(shell.root.position.x, shell.x, blend);
      shell.root.position.z = THREE.MathUtils.lerp(shell.root.position.z, shell.z, blend);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.age += dt;
      if (particle.age >= particle.life) {
        this.scene.remove(particle.mesh);
        this.releaseMaterial(particle.mesh.material as THREE.Material);
        this.particles.splice(i, 1);
        continue;
      }
      particle.mesh.position.x += particle.vx * dt;
      particle.mesh.position.y += particle.vy * dt;
      particle.mesh.position.z += particle.vz * dt;
      if (!particle.smoke) {
        particle.vy -= 14 * dt;
        particle.mesh.rotation.x += dt * 5;
        particle.mesh.rotation.z += dt * 3;
        if (particle.mesh.position.y < 0.12) { particle.mesh.position.y = 0.12; particle.vy = Math.abs(particle.vy) * 0.2; }
      } else {
        particle.mesh.scale.setScalar(0.4 + particle.age * 1.5);
      }
      (particle.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - particle.age / particle.life) * (particle.smoke ? 0.5 : 1);
    }
    const own = this.tanks.get(this.playerId);
    if (own) {
      this.cameraTarget.set(clamp(own.root.position.x, -33, 33), 0, clamp(own.root.position.z, -25, 25));
      if (this.snapCamera) this.focus.copy(this.cameraTarget);
      else this.focus.lerp(this.cameraTarget, 1 - Math.exp(-10 * dt));
      this.zoom = this.snapCamera ? this.targetZoom : THREE.MathUtils.lerp(this.zoom, this.targetZoom, 1 - Math.exp(-12 * dt));
      const portraitFactor = this.camera.aspect < 1 ? 1.32 : 1;
      const distance = portraitFactor * this.zoom;
      // One smoothing stage keeps the view level and avoids the old elastic lag.
      this.camera.position.set(this.focus.x, 34 * distance, this.focus.z + 27 * distance);
      this.snapCamera = false;
    } else if (this.preview) {
      this.focus.lerp(this.previewTarget, 1 - Math.exp(-3 * dt));
      const portraitFactor = this.camera.aspect < 1 ? 1.25 : 1;
      this.desiredCamera.set(this.focus.x + 12 * portraitFactor, 16 * portraitFactor, this.focus.z + 22 * portraitFactor);
      this.camera.position.lerp(this.desiredCamera, 1 - Math.exp(-3 * dt));
    } else {
      this.cameraTarget.set(0, 0, 0);
      this.focus.lerp(this.cameraTarget, 1 - Math.exp(-2 * dt));
      this.desiredCamera.set(Math.sin(this.elapsed * 0.07) * 7, 59, 46);
      this.camera.position.lerp(this.desiredCamera, 1 - Math.exp(-2 * dt));
    }
    this.camera.lookAt(this.focus);
    this.updateAim();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.frame);
  };

  private geometry(name: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.geometries.get(name);
    if (!geometry) { geometry = create(); this.geometries.set(name, geometry); }
    return geometry;
  }
  private box(w: number, h: number, d: number): THREE.BufferGeometry {
    return this.geometry(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
  }
  private material(color: number, standard = true, emissive = 0): THREE.MeshStandardMaterial | THREE.MeshBasicMaterial {
    const material = standard
      ? new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.08, flatShading: true, emissive, emissiveIntensity: emissive ? 1 : 0 })
      : new THREE.MeshBasicMaterial({ color });
    this.materials.add(material);
    return material;
  }
  private releaseMaterial(material: THREE.Material): void { material.dispose(); this.materials.delete(material); }
  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildReticle(): void {
    const outline = new THREE.MeshBasicMaterial({ color: 0x162b2d, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const highlight = new THREE.MeshBasicMaterial({ color: 0xffe4a1, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    this.materials.add(outline);
    this.materials.add(highlight);
    const shadowRing = new THREE.Mesh(this.geometry('aim-outline', () => new THREE.RingGeometry(0.37, 0.59, 32)), outline);
    const ring = new THREE.Mesh(this.geometry('aim-ring', () => new THREE.RingGeometry(0.44, 0.5, 32)), highlight);
    shadowRing.rotation.x = ring.rotation.x = -Math.PI / 2;
    shadowRing.renderOrder = 100;
    ring.renderOrder = 101;
    this.aimReticle.add(shadowRing, ring);
    for (const side of [-1, 1]) {
      const horizontal = new THREE.Mesh(this.box(0.32, 0.025, 0.07), highlight);
      const vertical = new THREE.Mesh(this.box(0.07, 0.025, 0.32), highlight);
      horizontal.position.x = side * 0.73;
      vertical.position.z = side * 0.73;
      horizontal.renderOrder = vertical.renderOrder = 101;
      this.aimReticle.add(horizontal, vertical);
    }
    this.aimReticle.visible = false;
    this.scene.add(this.aimReticle);
  }

  private buildArena(): void {
    const outer = this.mesh(this.box(160, 1, 144), this.material(0x243b3e));
    outer.position.y = -1.5;
    this.scene.add(outer);
    const platform = this.mesh(this.box(81.8, 1.1, 65.8), this.material(0x667575));
    platform.position.y = -0.65;
    this.scene.add(platform);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#bcae89';
    ctx.fillRect(0, 0, 256, 256);
    let seed = 29;
    for (let i = 0; i < 1600; i++) {
      seed = (seed * 16807) % 2147483647;
      const x = seed % 256;
      seed = (seed * 16807) % 2147483647;
      const y = seed % 256;
      ctx.fillStyle = i % 2 ? 'rgba(255,244,206,.07)' : 'rgba(73,67,47,.055)';
      ctx.fillRect(x, y, 1 + i % 4, 1 + i % 3);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 10);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(texture);
    const sandMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, color: 0xe1d3ac });
    this.materials.add(sandMaterial);
    const ground = this.mesh(this.geometry('ground', () => new THREE.PlaneGeometry(80, 64)), sandMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.castShadow = false;
    this.scene.add(ground);

    const lineMaterial = this.material(0xe6dab9);
    const roadMaterial = this.material(0xb1a682);
    for (const x of [-10, 12]) {
      const road = this.mesh(this.box(5, 0.018, 60), roadMaterial);
      road.position.set(x, 0.003, 0);
      road.castShadow = false;
      this.scene.add(road);
      for (let z = -29; z < 30; z += 5) {
        const stripe = this.mesh(this.box(0.1, 0.025, 1.5), lineMaterial);
        stripe.position.set(x - 2.1, 0.024, z);
        stripe.castShadow = false;
        this.scene.add(stripe);
      }
    }
    const edge = this.material(0x7b8273);
    const caution = this.material(0xd4ae58);
    for (let x = -39; x <= 39; x += 3) {
      for (const z of [-32, 32]) {
        const wall = this.mesh(this.box(2.85, 0.7, 0.55), edge);
        wall.position.set(x, 0.35, z);
        this.scene.add(wall);
        if (x % 3 === 0) {
          const top = this.mesh(this.box(0.65, 0.06, 0.58), caution);
          top.position.set(x, 0.73, z);
          this.scene.add(top);
        }
      }
    }
    for (let z = -29; z <= 29; z += 3) {
      for (const x of [-40, 40]) {
        const wall = this.mesh(this.box(0.55, 0.7, 2.85), edge);
        wall.position.set(x, 0.35, z);
        this.scene.add(wall);
      }
    }
    // Rocks and radio structures stay outside the physical play area.
    const rockMaterial = this.material(0x718a83);
    const rockGeometry = this.geometry('rock', () => new THREE.DodecahedronGeometry(1, 0));
    for (let i = 0; i < 42; i++) {
      const rock = this.mesh(rockGeometry, rockMaterial);
      const side = i % 4;
      const along = ((i * 17) % 83) - 41;
      const across = 38 + (i % 5) * 2.8;
      rock.position.set(side < 2 ? along : (side === 2 ? -across - 8 : across + 8), -0.35, side < 2 ? (side === 0 ? -across : across) : along * 0.7);
      rock.scale.set(0.6 + i % 4, 0.5 + (i % 3) * 0.5, 0.7 + i % 3);
      rock.rotation.set(i * 0.7, i * 1.4, i * 0.2);
      this.scene.add(rock);
    }
    const poleMat = this.material(0x4a6767);
    for (const x of [-44, 44]) for (const z of [-36, 36]) {
      const pole = this.mesh(this.box(0.22, 8, 0.22), poleMat);
      pole.position.set(x, 3.4, z);
      const lamp = this.mesh(this.box(1.4, 0.42, 0.65), this.material(0xffd983, false));
      lamp.position.set(x, 7.1, z);
      this.scene.add(pole, lamp);
    }
  }

  private buildCover(obstacles: ObstacleState[]): void {
    this.coverLayer.traverse(object => {
      if (object instanceof THREE.Mesh) this.releaseMaterial(object.material as THREE.Material);
    });
    this.coverLayer.clear();
    this.coverKey = JSON.stringify(obstacles);
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const bodyMat = this.material(i % 2 ? 0x6c8780 : 0x7d8980);
      const trimMat = this.material(0xa5aa92);
      const darkMat = this.material(0x435d58);
      const building = new THREE.Group();
      building.position.set(o.x, 0, o.z);
      const body = this.mesh(this.box(o.w, o.h, o.d), bodyMat);
      body.position.y = o.h / 2;
      building.add(body);
      const roof = this.mesh(this.box(o.w + 0.12, 0.22, o.d + 0.12), trimMat);
      roof.position.y = o.h - 0.04;
      building.add(roof);
      const foot = this.mesh(this.box(o.w + 0.2, 0.35, o.d + 0.2), darkMat);
      foot.position.y = 0.175;
      building.add(foot);
      for (const side of [-1, 1]) {
        const door = this.mesh(this.box(Math.min(2.2, o.w * 0.5), Math.min(2.2, o.h - 0.5), 0.035), darkMat);
        door.position.set(0, Math.min(2.2, o.h - 0.5) / 2 + 0.22, side * (o.d / 2 + 0.025));
        building.add(door);
        const lintel = this.mesh(this.box(Math.min(2.5, o.w * 0.6), 0.15, 0.12), trimMat);
        lintel.position.set(0, door.position.y * 2, side * (o.d / 2 + 0.08));
        building.add(lintel);
      }
      const vent = this.mesh(this.box(Math.min(2.5, o.w * 0.45), 0.45, Math.min(2, o.d * 0.4)), darkMat);
      vent.position.set(-o.w * 0.14, o.h + 0.24, 0);
      building.add(vent);
      for (let strip = 0; strip < 5; strip++) {
        const rib = this.mesh(this.box(Math.min(2.3, o.w * 0.42), 0.08, 0.1), trimMat);
        rib.position.set(vent.position.x, o.h + 0.5, (strip - 2) * 0.27);
        building.add(rib);
      }
      this.coverLayer.add(building);
    }
  }

  private hullGeometry(width: number, length: number, height: number): THREE.BufferGeometry {
    return this.geometry(`hull:${width}:${length}:${height}`, () => {
      const shape = new THREE.Shape();
      const w = width / 2, d = length / 2;
      shape.moveTo(-w + 0.2, -d);
      shape.lineTo(w - 0.2, -d);
      shape.lineTo(w, -d + 0.3);
      shape.lineTo(w, d - 0.2);
      shape.lineTo(w - 0.15, d);
      shape.lineTo(-w + 0.15, d);
      shape.lineTo(-w, d - 0.2);
      shape.lineTo(-w, -d + 0.3);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.055, bevelThickness: 0.055, steps: 1 });
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    });
  }

  private createTank(player: PlayerState, local: boolean): TankVisual {
    const root = new THREE.Group();
    const turret = new THREE.Group();
    const hash = [...player.id].reduce((n, char) => n + char.charCodeAt(0), 0);
    const color = local ? 0xe5b750 : PALETTE[hash % PALETTE.length];
    const armor = this.material(color) as THREE.MeshStandardMaterial;
    const lighter = this.material(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.15).getHex()) as THREE.MeshStandardMaterial;
    const dark = this.material(0x263b3a);
    const metal = this.material(0x6f7d75);
    const black = this.material(0x172c2e);
    const accent = this.material(local ? 0xffe1a0 : 0xd7ede1, false);
    const ownedMaterials: THREE.Material[] = [armor, lighter, dark, metal, black, accent];
    const heavy = player.tank === 'heavy';
    const scout = player.tank === 'scout';
    const length = heavy ? 2.85 : scout ? 2.28 : 2.58;
    const width = heavy ? 1.92 : scout ? 1.55 : 1.75;
    const body = this.mesh(this.hullGeometry(width - 0.35, length - 0.25, heavy ? 0.6 : 0.45), armor);
    body.position.y = 0.43;
    root.add(body);
    const deck = this.mesh(this.box(width - 0.5, 0.15, length * 0.6), lighter);
    deck.position.set(0, heavy ? 1.04 : 0.89, -0.2);
    root.add(deck);

    for (const side of [-1, 1]) {
      const track = this.mesh(this.box(0.39, 0.62, length), dark);
      track.position.set(side * (width / 2 - 0.04), 0.35, 0);
      root.add(track);
      for (let i = 0; i < (heavy ? 6 : 5); i++) {
        const wheel = this.mesh(this.geometry('wheel', () => new THREE.CylinderGeometry(0.22, 0.22, 0.05, 8)), metal);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * (width / 2 + 0.17), 0.33, -length * 0.39 + i * length * 0.78 / (heavy ? 5 : 4));
        root.add(wheel);
      }
      for (let i = 0; i < 8; i++) {
        const link = this.mesh(this.box(0.42, 0.04, 0.12), metal);
        link.position.set(side * (width / 2 - 0.04), 0.68, -length * 0.44 + i * length * 0.88 / 7);
        root.add(link);
      }
      const fender = this.mesh(this.box(0.44, 0.1, length * 0.86), armor);
      fender.position.set(side * (width / 2 - 0.04), 0.76, -0.06);
      root.add(fender);
      const lamp = this.mesh(this.box(0.18, 0.13, 0.06), accent);
      lamp.position.set(side * (width * 0.29), 0.73, length / 2 - 0.08);
      root.add(lamp);
    }
    turret.position.y = heavy ? 1.13 : 0.98;
    const turretBody = this.mesh(this.hullGeometry(heavy ? 1.36 : scout ? 0.87 : 1.12, heavy ? 1.35 : 1.05, heavy ? 0.44 : 0.33), lighter);
    turretBody.position.z = -0.13;
    turret.add(turretBody);
    const hatch = this.mesh(this.geometry('hatch', () => new THREE.CylinderGeometry(0.24, 0.24, 0.08, 8)), dark);
    hatch.position.set(-0.1, heavy ? 0.52 : 0.41, -0.22);
    turret.add(hatch);
    const cannonLength = heavy ? 1.7 : scout ? 1.28 : 1.5;
    const cannon = this.mesh(this.geometry(`cannon:${player.tank}`, () => new THREE.CylinderGeometry(heavy ? 0.12 : 0.08, heavy ? 0.14 : 0.11, cannonLength, 8)), dark);
    cannon.rotation.x = Math.PI / 2;
    cannon.position.set(0, 0.18, cannonLength / 2 + 0.35);
    turret.add(cannon);
    const barrelEnd = this.mesh(this.box(heavy ? 0.35 : 0.23, heavy ? 0.26 : 0.18, heavy ? 0.36 : 0.18), metal);
    barrelEnd.position.set(0, 0.18, cannonLength + 0.3);
    turret.add(barrelEnd);
    const muzzle = this.mesh(this.box(heavy ? 0.22 : 0.14, heavy ? 0.14 : 0.09, 0.02), black);
    muzzle.position.set(0, 0.18, cannonLength + (heavy ? 0.49 : 0.4));
    turret.add(muzzle);
    const stripe = this.mesh(this.box(0.12, 0.014, 0.55), accent);
    stripe.position.set(0.22, heavy ? 0.5 : 0.39, -0.12);
    turret.add(stripe);
    if (scout) {
      const antenna = this.mesh(this.box(0.025, 1.0, 0.025), dark);
      antenna.position.set(-0.26, 0.8, -0.37);
      turret.add(antenna);
    } else if (heavy) {
      for (const side of [-1, 1]) {
        const armorPlate = this.mesh(this.box(0.14, 0.38, 1.5), lighter);
        armorPlate.position.set(side * 0.99, 0.83, -0.18);
        root.add(armorPlate);
        const exhaust = this.mesh(this.box(0.2, 0.4, 0.25), dark);
        exhaust.position.set(side * 0.48, 0.97, -1.12);
        root.add(exhaust);
      }
    } else {
      const kit = this.mesh(this.box(0.75, 0.25, 0.4), dark);
      kit.position.set(0, 0.98, -0.92);
      root.add(kit);
    }
    root.add(turret);

    const ringMaterial = new THREE.MeshBasicMaterial({ color: local ? 0xffde8b : color, transparent: true, opacity: local ? 0.7 : 0.35, side: THREE.DoubleSide, depthWrite: false });
    this.materials.add(ringMaterial);
    ownedMaterials.push(ringMaterial);
    const ring = new THREE.Mesh(this.geometry('tank-ring', () => new THREE.RingGeometry(1.65, 1.7, 36, 1, 0.15, TAU - 0.3)), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    root.add(ring);

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 384;
    labelCanvas.height = 80;
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(labelTexture);
    const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false, depthWrite: false });
    this.materials.add(labelMaterial);
    ownedMaterials.push(labelMaterial);
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(5.5, 1.145, 1);
    label.position.y = 3.0;
    label.renderOrder = 30;
    root.add(label);
    this.tankLayer.add(root);
    return { root, turret, label, labelTexture, labelCanvas, labelKey: '', ring, kind: player.tank, player, ownedMaterials, armorMaterials: [armor, lighter], damageFlash: 0 };
  }

  private updateLabel(tank: TankVisual): void {
    const p = tank.player;
    const local = p.id === this.playerId;
    const key = `${p.name}:${p.hp}:${p.connected}:${local}`;
    if (tank.labelKey === key) return;
    tank.labelKey = key;
    const ctx = tank.labelCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 384, 80);
    ctx.textAlign = 'center';
    ctx.font = '600 23px system-ui, sans-serif';
    ctx.shadowColor = '#0e2229';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = local ? '#ffe1a0' : '#fff9e7';
    ctx.fillText(`${p.name}${p.connected ? '' : ' · связь…'}`, 192, 30, 370);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#203a3b';
    ctx.fillRect(93, 44, 198, 12);
    const ratio = clamp(p.hp / p.maxHp, 0, 1);
    ctx.fillStyle = ratio > 0.55 ? (local ? '#e8be65' : '#87c1a4') : ratio > 0.25 ? '#eca85b' : '#e97966';
    ctx.fillRect(95, 46, 194 * ratio, 8);
    tank.labelTexture.needsUpdate = true;
  }

  private removeTank(id: string): void {
    const tank = this.tanks.get(id);
    if (!tank) return;
    this.tankLayer.remove(tank.root);
    for (const material of tank.ownedMaterials) this.releaseMaterial(material);
    tank.labelTexture.dispose();
    this.textures.delete(tank.labelTexture);
    this.tanks.delete(id);
  }

  private sparks(x: number, z: number, count: number): void {
    if (this.particles.length > (this.quality === 'low' ? 35 : 100)) return;
    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffd77b : 0xd78345, transparent: true });
      this.materials.add(material);
      const mesh = this.mesh(this.geometry('spark', () => new THREE.BoxGeometry(0.1, 0.1, 0.23)), material);
      mesh.position.set(x, 0.85, z);
      mesh.castShadow = false;
      this.scene.add(mesh);
      const a = Math.random() * TAU;
      const speed = 2 + Math.random() * 4;
      this.particles.push({ mesh, vx: Math.sin(a) * speed, vz: Math.cos(a) * speed, vy: 2 + Math.random() * 4, age: 0, life: 0.35 + Math.random() * 0.3, smoke: false });
    }
  }

  private explode(x: number, z: number): void {
    this.sparks(x, z, this.quality === 'low' ? 8 : 18);
    for (let i = 0; i < (this.quality === 'low' ? 3 : 7); i++) {
      const material = new THREE.MeshBasicMaterial({ color: i < 2 ? 0xf1b357 : 0x516260, transparent: true, depthWrite: false });
      this.materials.add(material);
      const mesh = this.mesh(this.geometry('smoke', () => new THREE.IcosahedronGeometry(0.65, 0)), material);
      mesh.position.set(x + (Math.random() - 0.5), 0.6 + Math.random(), z + (Math.random() - 0.5));
      mesh.castShadow = false;
      this.scene.add(mesh);
      this.particles.push({ mesh, vx: (Math.random() - 0.5) * 1.5, vy: 1.4, vz: (Math.random() - 0.5) * 1.5, age: 0, life: 0.65 + Math.random() * 0.6, smoke: true });
    }
  }
}
