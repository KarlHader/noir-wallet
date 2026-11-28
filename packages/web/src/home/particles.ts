/**
 * Particle effect for the statue at the very bottom of the page (our own implementation; the
 * mechanics and parameters follow ReactBits' Particle Image).
 * - The original image stays visible underneath (Image Opacity 1); the canvas is covered with
 *   hundreds of thousands of particles, each carrying the image brightness at its spawn point.
 * - Particles drift along a slowly changing noise flow field, fade in and out over their
 *   lifespan, and respawn at a random position when it ends, so the image surface always has
 *   a layer of flowing grains.
 * - When the mouse passes over, its velocity is passed to nearby particles in proportion: they
 *   get dragged along and dark particles cover bright areas, so the statue looks smeared.
 *   Dragged particles respawn on the original image when their lifespan ends, so the picture
 *   slowly recovers. A tap on a touch screen bursts particles outward from the finger.
 * Particle state is updated on the GPU every frame (WebGL2 transform feedback) and the CPU only
 * passes the mouse; the loop stops while the footer is out of the viewport.
 */

type Options = {
  /** The statue container; the canvas is the same size as it. */
  box: HTMLElement
  /** The page's statue image; its URL and object-position keep the particles aligned with it. */
  img: HTMLImageElement
  canvas: HTMLCanvasElement
  /**
   * Area that receives pointer events. It is the whole footer, so the mouse still stirs particles
   * over the copyright text and the wordmark that overlap the statue.
   */
  hitArea: HTMLElement
  onReady: () => void
  onFail: () => void
}

/** Names and values follow the Customize panel of ReactBits' Particle Image (defaults). */
export const PARTICLE_PARAMS = {
  /**
   * 500,000 on ReactBits' demo canvas (about 631 × 560); scaled by area here to the same density,
   * then capped (see countFor).
   */
  particleCount: 500_000,
  /** Particle diameter (CSS px). */
  particleSize: 2,
  /** Opacity of a particle at its brightest. */
  particleOpacity: 0.85,
  /** How fast the flow field changes over time. */
  speed: 1,
  /** Spatial frequency of the flow field: smaller means longer, smoother streams. */
  noiseScale: 0.0005,
  /** Acceleration along the flow field per frame (px / frame²). */
  noiseStrength: 0.05,
  /** Fraction of velocity kept each frame. */
  damping: 0.95,
  /** Number of frames a particle lives before it respawns. */
  lifespan: 200,
  /** Opacity of the original image underneath (controlled by CSS, see .statue img). */
  imageOpacity: 1,
  /** How much of the mouse velocity is passed on to nearby particles. */
  cursorStrength: 0.1,
  /** Mouse influence radius (CSS px). */
  cursorRadius: 100
} as const

const REFERENCE_AREA = 631 * 560
const MIN_PARTICLES = 60_000
const MAX_PARTICLES = 500_000
/** How far the flow field advances along the time axis per second (multiplied by speed). */
const FLOW_RATE = 1
/**
 * ReactBits' noiseStrength is in different units from the pixel-based displacement used here:
 * taken directly as px/frame², 0.05 would carry a particle ~180px along the flow field over its
 * life, and at rest the statue would be smudged by dark particles. With this factor a particle
 * drifts about 20px per life, which matches how its demo looks at rest: a clear image with fine
 * dust blown off the edges. Mouse dragging is not affected.
 */
const DRIFT = 0.12
/** Cap on mouse movement per frame, so a hard flick cannot throw particles out of the picture. */
const MAX_MOVE = 60
/** Burst strength of a tap on a touch screen (px / frame). */
const BURST = 6
/**
 * How far particles spread sideways while the mouse drags (relative to the drag direction), so
 * the trail looks like scattered dust rather than streaks.
 */
const SPREAD = 0.9

/** Six numbers per particle: position x, y, velocity x, y, age (frames), brightness. */
const STRIDE = 6

const UPDATE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aVel;
layout(location = 2) in float aAge;
layout(location = 3) in float aShade;
uniform sampler2D uImage;
uniform vec2 uSize;
uniform float uTime;
uniform float uSeed;
uniform float uNoiseScale;
uniform float uNoiseStrength;
uniform float uDamping;
uniform float uLife;
uniform vec4 uSeg;
uniform float uPush;
uniform float uRadius;
uniform vec3 uBurst;
uniform float uSpread;
out vec2 vPos;
out vec2 vVel;
out float vAge;
out float vShade;

float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), u.x), mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), u.x), mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}

void main() {
  vec2 pos = aPos;
  vec2 vel = aVel;
  float age = aAge + 1.0;
  float shade = aShade;
  float id = float(gl_VertexID);
  if (age >= uLife) {
    vec2 r = vec2(hash(vec3(id * 0.0173, uSeed, 1.7)), hash(vec3(id * 0.0291, uSeed, 9.3)));
    pos = r * uSize;
    vel = vec2(0.0);
    age = 0.0;
    shade = texture(uImage, r).r;
  }
  float angle = noise(vec3(pos * uNoiseScale, uTime)) * 12.5664;
  vel += vec2(cos(angle), sin(angle)) * uNoiseStrength;
  if (uPush > 0.0) {
    vec2 ab = uSeg.zw - uSeg.xy;
    float t = clamp(dot(pos - uSeg.xy, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
    float d = distance(pos, uSeg.xy + ab * t);
    if (d < uRadius) {
      float k = 1.0 - d / uRadius;
      // Each particle reacts differently: 0.5 to 1.5 times the force along the drag direction,
      // plus a sideways nudge, so the drag leaves scattered dust
      float along = 0.5 + hash(vec3(id * 0.0137, 3.1, 7.7));
      float across = hash(vec3(id * 0.0219, 5.3, 1.9)) - 0.5;
      vel += (ab * along + vec2(-ab.y, ab.x) * across * uSpread) * uPush * k * k;
    }
  }
  if (uBurst.z > 0.0) {
    vec2 away = pos - uBurst.xy;
    float d = length(away);
    float reach = uRadius * 1.2;
    if (d < reach && d > 0.001) {
      // Randomize both strength and direction so the burst is a puff of dust, not a neat ring
      vec2 dir = away / d;
      dir = normalize(dir + vec2(-dir.y, dir.x) * (hash(vec3(id * 0.0171, 1.1, 6.1)) - 0.5) * 1.4);
      vel += dir * uBurst.z * (1.0 - d / reach) * (0.2 + hash(vec3(id * 0.0113, 8.3, 2.9)));
    }
  }
  vel *= uDamping;
  pos += vel;
  vPos = pos;
  vVel = vel;
  vAge = age;
  vShade = shade;
}`

const UPDATE_FS = `#version 300 es
precision mediump float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}`

const RENDER_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 2) in float aAge;
layout(location = 3) in float aShade;
uniform vec2 uSize;
uniform float uLife;
uniform float uOpacity;
uniform float uPointSize;
out float vAlpha;
out float vShade;
void main() {
  float t = aAge / uLife;
  vAlpha = uOpacity * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.85, 1.0, t));
  vShade = aShade;
  vec2 clip = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = uPointSize;
}`

const RENDER_FS = `#version 300 es
precision mediump float;
in float vAlpha;
in float vShade;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  outColor = vec4(vec3(vShade) * vAlpha, vAlpha);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, varyings?: string[]) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vs)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fs)
  const program = gl.createProgram()
  if (!vertex || !fragment || !program) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  if (varyings) gl.transformFeedbackVaryings(program, varyings, gl.INTERLEAVED_ATTRIBS)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
  gl.deleteProgram(program)
  return null
}

/**
 * Converts one component of object-position to a pixel offset (free = container size minus the
 * size of the image once it covers the container).
 */
function offset(value: string | undefined, free: number) {
  if (value?.endsWith('%')) return (free * parseFloat(value)) / 100
  if (value?.endsWith('px')) return parseFloat(value)
  return free / 2
}

/**
 * Draws the image into a width × height canvas the way object-fit: cover does, so it lines up
 * with the <img> on the page.
 */
function coverCanvas(
  source: HTMLImageElement,
  img: HTMLImageElement,
  width: number,
  height: number
) {
  const scratch = document.createElement('canvas')
  scratch.width = width
  scratch.height = height
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const scale = Math.max(width / source.naturalWidth, height / source.naturalHeight)
  const drawW = source.naturalWidth * scale
  const drawH = source.naturalHeight * scale
  const [posX, posY] = getComputedStyle(img).objectPosition.split(' ')
  ctx.drawImage(source, offset(posX, width - drawW), offset(posY, height - drawH), drawW, drawH)
  return { canvas: scratch, pixels: ctx.getImageData(0, 0, width, height).data }
}

/** Scales by area to the same density as the ReactBits demo, then clamps to a sensible range. */
function countFor(width: number, height: number) {
  const scaled = (PARTICLE_PARAMS.particleCount * width * height) / REFERENCE_AREA
  return Math.round(Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, scaled)))
}

type Sim = {
  width: number
  height: number
  count: number
  buffers: [WebGLBuffer, WebGLBuffer]
  updateVaos: [WebGLVertexArrayObject, WebGLVertexArrayObject]
  renderVaos: [WebGLVertexArrayObject, WebGLVertexArrayObject]
  texture: WebGLTexture
  /** Which buffer currently holds the latest state. */
  current: 0 | 1
}

export function createParticleImage({
  box,
  img,
  canvas,
  hitArea,
  onReady,
  onFail
}: Options): () => void {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true
  })
  const update = gl && link(gl, UPDATE_VS, UPDATE_FS, ['vPos', 'vVel', 'vAge', 'vShade'])
  const render = gl && link(gl, RENDER_VS, RENDER_FS)
  const feedback = gl?.createTransformFeedback()
  if (!gl || !update || !render || !feedback) {
    onFail()
    return () => {}
  }

  const u = (program: WebGLProgram, name: string) => gl.getUniformLocation(program, name)
  const up = {
    image: u(update, 'uImage'),
    size: u(update, 'uSize'),
    time: u(update, 'uTime'),
    seed: u(update, 'uSeed'),
    noiseScale: u(update, 'uNoiseScale'),
    noiseStrength: u(update, 'uNoiseStrength'),
    damping: u(update, 'uDamping'),
    life: u(update, 'uLife'),
    seg: u(update, 'uSeg'),
    push: u(update, 'uPush'),
    radius: u(update, 'uRadius'),
    burst: u(update, 'uBurst'),
    spread: u(update, 'uSpread')
  }
  const rp = {
    size: u(render, 'uSize'),
    life: u(render, 'uLife'),
    opacity: u(render, 'uOpacity'),
    pointSize: u(render, 'uPointSize')
  }

  gl.useProgram(update)
  gl.uniform1f(up.noiseScale, PARTICLE_PARAMS.noiseScale)
  gl.uniform1f(up.noiseStrength, PARTICLE_PARAMS.noiseStrength * DRIFT)
  gl.uniform1f(up.damping, PARTICLE_PARAMS.damping)
  gl.uniform1f(up.life, PARTICLE_PARAMS.lifespan)
  gl.uniform1f(up.radius, PARTICLE_PARAMS.cursorRadius)
  gl.uniform1f(up.spread, SPREAD)
  gl.uniform1i(up.image, 0)
  gl.useProgram(render)
  gl.uniform1f(rp.life, PARTICLE_PARAMS.lifespan)
  gl.uniform1f(rp.opacity, PARTICLE_PARAMS.particleOpacity)
  gl.clearColor(0, 0, 0, 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  let sim: Sim | null = null
  let source: HTMLImageElement | null = null
  let raf = 0
  let frameNo = 0
  let dead = false
  let resizeTimer = 0
  const start = performance.now()
  const pointer = {
    x: 0,
    y: 0,
    lastX: 0,
    lastY: 0,
    clientX: 0,
    clientY: 0,
    inside: false,
    moved: false
  }
  let burst: { x: number; y: number } | null = null

  const freeSim = (old: Sim) => {
    old.buffers.forEach(buffer => gl.deleteBuffer(buffer))
    old.updateVaos.forEach(vao => gl.deleteVertexArray(vao))
    old.renderVaos.forEach(vao => gl.deleteVertexArray(vao))
    gl.deleteTexture(old.texture)
  }

  /**
   * Builds particles for the current size: spread evenly over the canvas, with staggered ages and
   * brightness sampled from the original image. Does nothing if the size has not changed.
   */
  const layout = () => {
    if (!source) return false
    const rect = box.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (!width || !height) return false
    if (sim && sim.width === width && sim.height === height) return true
    const cover = coverCanvas(source, img, width, height)
    if (!cover) return false

    const count = countFor(width, height)
    const data = new Float32Array(count * STRIDE)
    for (let i = 0; i < count; i += 1) {
      const x = Math.random() * width
      const y = Math.random() * height
      const o = i * STRIDE
      data[o] = x
      data[o + 1] = y
      data[o + 4] = Math.random() * PARTICLE_PARAMS.lifespan
      data[o + 5] = cover.pixels[(Math.floor(y) * width + Math.floor(x)) * 4] / 255
    }

    const texture = gl.createTexture()
    const a = gl.createBuffer()
    const b = gl.createBuffer()
    const vaos = [
      gl.createVertexArray(),
      gl.createVertexArray(),
      gl.createVertexArray(),
      gl.createVertexArray()
    ]
    if (!texture || !a || !b || vaos.some(vao => !vao)) return false

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cover.canvas)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const bytes = STRIDE * 4
    const describe = (vao: WebGLVertexArrayObject, buffer: WebGLBuffer, forUpdate: boolean) => {
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, bytes, 0)
      if (forUpdate) {
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, bytes, 8)
      }
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, bytes, 16)
      gl.enableVertexAttribArray(3)
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, bytes, 20)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, a)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY)
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_COPY)
    const [ua, ub, ra, rb] = vaos as WebGLVertexArrayObject[]
    describe(ua, a, true)
    describe(ub, b, true)
    describe(ra, a, false)
    describe(rb, b, false)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    gl.useProgram(update)
    gl.uniform2f(up.size, width, height)
    gl.useProgram(render)
    gl.uniform2f(rp.size, width, height)
    gl.uniform1f(rp.pointSize, PARTICLE_PARAMS.particleSize * dpr)

    if (sim) freeSim(sim)
    sim = {
      width,
      height,
      count,
      buffers: [a, b],
      updateVaos: [ua, ub],
      renderVaos: [ra, rb],
      texture,
      current: 0
    }
    return true
  }

  /**
   * Advances one frame: reads the current buffer and writes the new state into the other one
   * (transform feedback).
   */
  const step = (now: number) => {
    if (!sim) return
    const from = sim.current
    const to = from === 0 ? 1 : 0

    let push = 0
    const seg = [pointer.lastX, pointer.lastY, pointer.x, pointer.y]
    if (pointer.inside && pointer.moved) {
      let dx = pointer.x - pointer.lastX
      let dy = pointer.y - pointer.lastY
      const length = Math.hypot(dx, dy)
      if (length > MAX_MOVE) {
        dx *= MAX_MOVE / length
        dy *= MAX_MOVE / length
        seg[0] = pointer.x - dx
        seg[1] = pointer.y - dy
      }
      push = length > 0.3 ? PARTICLE_PARAMS.cursorStrength : 0
      pointer.lastX = pointer.x
      pointer.lastY = pointer.y
      pointer.moved = false
    }

    gl.useProgram(update)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sim.texture)
    gl.uniform1f(up.time, ((now - start) / 1000) * PARTICLE_PARAMS.speed * FLOW_RATE)
    gl.uniform1f(up.seed, (frameNo * 0.6180339887) % 1000)
    gl.uniform4f(up.seg, seg[0], seg[1], seg[2], seg[3])
    gl.uniform1f(up.push, push)
    gl.uniform3f(up.burst, burst?.x ?? 0, burst?.y ?? 0, burst ? BURST : 0)
    burst = null
    gl.bindVertexArray(sim.updateVaos[from])
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, sim.buffers[to])
    gl.enable(gl.RASTERIZER_DISCARD)
    gl.beginTransformFeedback(gl.POINTS)
    gl.drawArrays(gl.POINTS, 0, sim.count)
    gl.endTransformFeedback()
    gl.disable(gl.RASTERIZER_DISCARD)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
    gl.bindVertexArray(null)
    sim.current = to
    frameNo += 1
  }

  const draw = () => {
    if (!sim) return
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(render)
    gl.bindVertexArray(sim.renderVaos[sim.current])
    gl.drawArrays(gl.POINTS, 0, sim.count)
    gl.bindVertexArray(null)
  }

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    step(now)
    draw()
  }

  const run = (on: boolean) => {
    if (on && !raf && sim) raf = requestAnimationFrame(frame)
    if (!on && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  const local = (event: PointerEvent) => {
    const rect = box.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top] as const
  }
  const onMove = (event: PointerEvent) => {
    const [x, y] = local(event)
    // Scrolling makes the browser fire extra pointermove events: the pointer has not moved on
    // screen, only the content has. Those only reset the starting point and do not count as
    // stirring the particles.
    const still =
      pointer.inside && event.clientX === pointer.clientX && event.clientY === pointer.clientY
    pointer.clientX = event.clientX
    pointer.clientY = event.clientY
    pointer.x = x
    pointer.y = y
    if (!pointer.inside || still) {
      pointer.inside = true
      pointer.lastX = x
      pointer.lastY = y
      pointer.moved = false
      return
    }
    pointer.moved = true
  }
  const onLeave = () => {
    pointer.inside = false
    pointer.moved = false
  }
  const onDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return
    const [x, y] = local(event)
    burst = { x, y }
  }

  const viewport = new IntersectionObserver(([entry]) => run(entry.isIntersecting))
  const resize = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      if (!dead && !layout()) fail()
    }, 150)
  })

  const cleanup = () => {
    dead = true
    run(false)
    window.clearTimeout(resizeTimer)
    viewport.disconnect()
    resize.disconnect()
    hitArea.removeEventListener('pointermove', onMove)
    hitArea.removeEventListener('pointerleave', onLeave)
    hitArea.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('webglcontextlost', onLost)
    if (!gl.isContextLost()) {
      if (sim) freeSim(sim)
      gl.deleteTransformFeedback(feedback)
      gl.deleteProgram(update)
      gl.deleteProgram(render)
    }
    sim = null
  }
  const fail = () => {
    if (dead) return
    cleanup()
    onFail()
  }
  const onLost = (event: Event) => {
    event.preventDefault()
    fail()
  }

  canvas.addEventListener('webglcontextlost', onLost)
  const image = new Image()
  image.decoding = 'async'
  image.src = img.currentSrc || img.src
  image.decode().then(
    () => {
      if (dead) return
      source = image
      if (!layout()) {
        fail()
        return
      }
      draw()
      hitArea.addEventListener('pointermove', onMove, { passive: true })
      hitArea.addEventListener('pointerleave', onLeave)
      hitArea.addEventListener('pointerdown', onDown, { passive: true })
      viewport.observe(box)
      resize.observe(box)
      onReady()
    },
    () => fail()
  )

  return () => {
    if (!dead) cleanup()
  }
}
