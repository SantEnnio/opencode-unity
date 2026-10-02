// Added by opencode-game-prototype's local server to every page it serves; it is not part of the
// prototype. It records what the page does (errors, what three.js draws, where objects go) and
// sends it back. With ?__run=<id> it also plays a test: presses the keys it is given, then reports.
(() => {
  if (window.__protoProbe) return
  window.__protoProbe = true

  const runId = new URLSearchParams(location.search).get("__run")
  const base = location.pathname.replace(/[^/]*$/, "")
  const page = base.split("/")[1] || ""
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0) / 1000
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // ---- what went wrong: console errors and warnings, exceptions, files that did not load

  const events = new Map()
  let dirty = false

  const fileOf = (url) => {
    try {
      const pathname = new URL(url, location.href).pathname
      return pathname.startsWith(base) ? pathname.slice(base.length) : pathname
    } catch {
      return String(url)
    }
  }

  // The first stack frame in the prototype's own files: an error thrown inside three.js is still
  // caused by a line of the prototype.
  function whereOf(stack) {
    for (const match of String(stack || "").matchAll(/(https?:\/\/[^\s)]+?):(\d+):\d+/g)) {
      if (match[1].includes("/vendor/") || match[1].includes("/__proto/")) continue
      return `${fileOf(match[1])}:${match[2]}`
    }
    return ""
  }

  function record(kind, text, where) {
    const message = String(text).replace(/\s+/g, " ").trim().slice(0, 300)
    const key = `${kind}|${message}|${where || ""}`
    const seen = events.get(key)
    if (seen) seen.count++
    else if (events.size < 40) events.set(key, { kind, text: message, where: where || "", count: 1, first: now() })
    dirty = true
  }

  const printed = (value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === "object" && value !== null) {
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    return String(value)
  }

  for (const level of ["error", "warn"]) {
    const original = console[level]
    console[level] = function (...args) {
      const error = args.find((a) => a instanceof Error)
      record(level, args.map(printed).join(" "), whereOf(error ? error.stack : new Error().stack))
      return original.apply(this, args)
    }
  }

  addEventListener(
    "error",
    (event) => {
      if (event instanceof ErrorEvent) {
        const where = whereOf(event.error && event.error.stack) || (event.filename ? `${fileOf(event.filename)}:${event.lineno}` : "")
        record("exception", String(event.message).replace(/^Uncaught /, ""), where)
        return
      }
      const target = event.target
      const url = target && (target.src || target.href)
      if (url) record("load", `could not load ${fileOf(url)}`, "")
    },
    true,
  )
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason
    record("exception", reason instanceof Error ? `${reason.name}: ${reason.message} (in a promise)` : `${printed(reason)} (in a promise)`, whereOf(reason && reason.stack))
  })

  // ---- what three.js draws: it announces every scene and renderer to a devtools hook

  const scenes = new Set()
  let renderer = null
  let revision = null
  let last = null
  let frames = 0
  let firstFrame = null
  let grab = null

  function watch(target) {
    if (target.__protoWatched) return
    target.__protoWatched = true
    renderer = target
    const render = target.render
    target.render = function (scene, camera) {
      const result = render.apply(this, arguments)
      frames++
      if (firstFrame === null) firstFrame = now()
      if (scene && scene.isScene) {
        scenes.add(scene)
        last = { scene, camera }
      }
      if (sampling) sample()
      else if (warming) warm()
      if (grab) {
        const take = grab
        grab = null
        take(pixels(this))
      }
      return result
    }
  }

  const hub = window.__THREE_DEVTOOLS__ instanceof EventTarget ? window.__THREE_DEVTOOLS__ : (window.__THREE_DEVTOOLS__ = new EventTarget())
  hub.addEventListener("observe", (event) => {
    const detail = event.detail
    if (!detail) return
    if (detail.isScene) scenes.add(detail)
    else if (typeof detail.render === "function" && typeof detail.getContext === "function") watch(detail)
  })
  hub.addEventListener("register", (event) => {
    revision = (event.detail && event.detail.revision) || null
  })

  let rafFrames = 0
  const countFrame = () => {
    rafFrames++
    requestAnimationFrame(countFrame)
  }
  requestAnimationFrame(countFrame)

  // A grid of pixels read right after a render: one flat color means nothing visible was drawn.
  function pixels(target) {
    try {
      const gl = target.getContext()
      const width = gl.drawingBufferWidth
      const height = gl.drawingBufferHeight
      const pixel = new Uint8Array(4)
      const colors = new Set()
      for (let x = 1; x <= 8; x++) {
        for (let y = 1; y <= 6; y++) {
          gl.readPixels(Math.floor((width * x) / 9), Math.floor((height * y) / 7), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          colors.add(`${pixel[0]},${pixel[1]},${pixel[2]}`)
        }
      }
      return { flat: colors.size === 1, color: [...colors][0] }
    } catch {
      return null
    }
  }

  // ---- where the objects go

  const tracks = new Map()
  const MAX_TRACKS = 150
  // Objects first seen after the first sample appeared during the play.
  let firstSample = true
  // During a test play every drawn frame is sampled: the top of a jump falls between timer ticks.
  let sampling = false

  const labelOf = (object) => object.name || (object.geometry ? `${object.type}(${object.geometry.type})` : object.type)

  // Tracked: what sits directly in the scene, and anything deeper that was given a name. Unnamed
  // children are parts of their parent. Lights and helpers are never what the game is about.
  function tracked(object, scene) {
    if (object === scene || object.isLight || /Helper$/.test(object.type)) return false
    return object.parent === scene || Boolean(object.name)
  }

  function position(object) {
    const point = new object.position.constructor()
    object.getWorldPosition(point)
    return point
  }

  // A jump is a sudden gain of upward speed between two frames. Counting them is what tells a
  // double jump from a single one: the height alone does not. Landing is a sudden change too, but
  // it ends at rest, not moving up.
  const motion = new WeakMap()
  // How fast the object moves up now and how much that changed since the frame before, or null
  // while there are not yet two frames to compare.
  function vertical(object, y) {
    const stamp = performance.now()
    const before = motion.get(object)
    if (before && stamp - before.stamp < 2) return null
    const speed = before ? ((y - before.y) * 1000) / (stamp - before.stamp) : null
    motion.set(object, { stamp, y, speed })
    return before && before.speed !== null ? { speed, gain: speed - before.speed } : null
  }

  // Before the keys start, speeds are followed without recording anything: a jump on the very
  // first key press needs a "before" to be compared with.
  let warming = false
  function warm() {
    if (!last) return
    last.scene.traverse((object) => {
      if (tracked(object, last.scene)) vertical(object, position(object).y)
    })
  }

  // When the text on screen last changed: "GAME OVER at 2.4 s" next to "an enemy appeared at 2.9 s"
  // is how a game that should have stopped is caught still running.
  let hudSeen = null
  let hudChanged = null

  function sample() {
    const text = hudText()
    if (hudSeen !== null && text !== hudSeen) hudChanged = now()
    hudSeen = text
    if (!last) return
    const time = now()
    const seen = new Set()
    const visit = (object) => {
      seen.add(object)
      let track = tracks.get(object)
      if (!track) {
        if (tracks.size >= MAX_TRACKS) return
        track = { label: labelOf(object), start: null, end: null, far: 0, rose: 0, pushedUp: [], added: firstSample ? null : time, removed: null, onScreen: null }
        tracks.set(object, track)
      }
      const point = position(object)
      const at = [point.x, point.y, point.z]
      if (!track.start) track.start = at
      track.end = at
      track.removed = null
      const change = vertical(object, at[1])
      if (sampling && change && change.speed > 1 && change.gain > 2 && track.pushedUp.length < 8) track.pushedUp.push(time)
      track.far = Math.max(track.far, Math.hypot(at[0] - track.start[0], at[1] - track.start[1], at[2] - track.start[2]))
      track.rose = Math.max(track.rose, at[1] - track.start[1])
      if (last.camera && last.camera.isCamera) {
        const ndc = point.project(last.camera)
        track.onScreen = Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z >= -1 && ndc.z <= 1
      }
    }
    last.scene.traverse((object) => {
      if (tracked(object, last.scene)) visit(object)
    })
    if (last.camera && last.camera.isCamera && !seen.has(last.camera)) {
      const camera = last.camera
      seen.add(camera)
      let track = tracks.get(camera)
      if (!track) tracks.set(camera, (track = { label: camera.name || "Camera", start: null, end: null, far: 0, rose: 0, added: null, removed: null, onScreen: null, camera: true }))
      const point = position(camera)
      const at = [point.x, point.y, point.z]
      if (!track.start) track.start = at
      track.end = at
      track.far = Math.max(track.far, Math.hypot(at[0] - track.start[0], at[1] - track.start[1], at[2] - track.start[2]))
    }
    for (const [object, track] of tracks) {
      if (!seen.has(object) && track.removed === null) track.removed = time
    }
    firstSample = false
  }

  const hudText = () => {
    const element = document.getElementById("hud")
    return element ? element.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : ""
  }

  // ---- a test play

  function press(type, key) {
    const event = new KeyboardEvent(type, { code: key.code, key: key.key, bubbles: true, cancelable: true })
    // Old code reads keyCode, which the constructor does not set.
    Object.defineProperty(event, "keyCode", { get: () => key.keyCode })
    Object.defineProperty(event, "which", { get: () => key.keyCode })
    ;(document.activeElement || document.body || document).dispatchEvent(event)
  }

  async function testPlay() {
    const answer = await fetch(`/__proto/run/${runId}`)
    // A stale address (the tab was reloaded after its test): back to the game.
    if (!answer.ok) return void location.replace(location.pathname)
    const spec = await answer.json()
    // Wait for the first drawn frame; a page that never draws is reported as such. A page that
    // already failed is not going to draw: no point in waiting it out.
    const broken = () => [...events.values()].some((event) => event.kind === "exception" || event.kind === "load")
    for (let waited = 0; frames === 0 && waited < 3000 && !(broken() && waited >= 500); waited += 50) await sleep(50)
    warming = true
    await sleep(300)
    warming = false

    const started = now()
    const sincePlay = (time) => Math.max(0, Math.round((time - started) * 1000) / 1000)
    const framesBefore = frames
    const rafBefore = rafFrames
    const hudBefore = hudText()
    sample()
    sampling = true
    for (const step of spec.steps) {
      if (step.keys.length === 0) {
        await sleep(step.wait * 1000)
        continue
      }
      for (const key of step.keys) press("keydown", key)
      await sleep(step.hold * 1000)
      for (const key of step.keys) press("keyup", key)
      await sleep(100)
    }
    await sleep(spec.tail * 1000)
    sampling = false
    sample()

    const shot = renderer && frames > framesBefore
      ? await new Promise((resolve) => {
          grab = resolve
          setTimeout(() => {
            if (grab === resolve) {
              grab = null
              resolve(null)
            }
          }, 400)
        })
      : null

    await fetch(`/__proto/report/${runId}`, {
      method: "POST",
      body: JSON.stringify({
        id: runId,
        page,
        seconds: sincePlay(now()),
        frames: frames - framesBefore,
        rafFrames: rafFrames - rafBefore,
        visible: document.visibilityState === "visible",
        three: revision,
        drawn: Boolean(renderer),
        calls: renderer && renderer.info ? renderer.info.render.calls : null,
        pixels: shot,
        hud: [hudBefore, hudText()],
        hudChanged: hudChanged === null ? null : sincePlay(hudChanged),
        // Times count from the start of the play, like `seconds`.
        events: [...events.values()].map((event) => ({ ...event, first: sincePlay(event.first) })),
        objects: [...tracks.values()].map((track) => ({
          ...track,
          pushedUp: (track.pushedUp || []).map(sincePlay),
          added: track.added === null ? null : sincePlay(track.added),
          removed: track.removed === null ? null : sincePlay(track.removed),
        })),
      }),
    })
    // In the user's own tab the game comes back as it was, without the test in its address.
    if (!/HeadlessChrome/.test(navigator.userAgent)) location.replace(location.pathname)
  }

  if (runId) {
    testPlay().catch((error) => record("exception", `the test play failed: ${error && error.message}`, ""))
    return
  }

  // ---- the user's own tab: reload when a file changes, and tell the plugin what goes wrong

  // The first report goes out even when nothing went wrong: it replaces what the page said before
  // it was reloaded.
  dirty = true
  const live = new EventSource(`/__proto/live?page=${encodeURIComponent(page)}`)
  live.addEventListener("reload", () => location.reload())
  live.addEventListener("run", (event) => location.replace(`${location.pathname}?__run=${encodeURIComponent(event.data)}`))
  setInterval(() => {
    if (!dirty) return
    dirty = false
    fetch(`/__proto/events?page=${encodeURIComponent(page)}`, {
      method: "POST",
      body: JSON.stringify({ seconds: now(), frames, visible: document.visibilityState === "visible", events: [...events.values()] }),
    }).catch(() => {})
  }, 1000)
})()
