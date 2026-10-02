// The kit: the parts of a small game that are the same every time. This file is fixed.
//
//   const game = createGame()          game.scene, game.camera, game.renderer; lights are already there
//   game.run((dt) => { ... })          called every frame, dt in seconds; draws the scene after it
//   keys.down("KeyW")                  true while the key is held
//   keys.pressed("Space")              true only in the frame the key went down
//   overlap(a, b)                      true when the boxes around two objects touch
//   hud("Score 3")                     text in the top left corner

import * as THREE from "three"

const NAMES = {
  " ": "Space", space: "Space", spacebar: "Space",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  shift: "ShiftLeft", ctrl: "ControlLeft", control: "ControlLeft", alt: "AltLeft",
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab",
}

// Accepts the code ("KeyW") and the forms people write instead ("w", "W", "space", "left").
function code(name) {
  const text = String(name)
  if (/^[a-z]$/i.test(text)) return "Key" + text.toUpperCase()
  if (/^[0-9]$/.test(text)) return "Digit" + text
  return NAMES[text.toLowerCase()] ?? text
}

const held = new Set()
const justPressed = new Set()
addEventListener("keydown", (event) => {
  if (!held.has(event.code)) justPressed.add(event.code)
  held.add(event.code)
})
addEventListener("keyup", (event) => held.delete(event.code))
addEventListener("blur", () => held.clear())

export const keys = {
  down: (name) => held.has(code(name)),
  pressed: (name) => justPressed.has(code(name)),
}

export function createGame({ background = 0x20262e } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  document.body.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(background)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(5, 10, 7)
  scene.add(sun)

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  camera.position.set(0, 6, 10)
  camera.lookAt(0, 0, 0)

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  }
  addEventListener("resize", resize)
  resize()

  let update = null
  let last = 0
  const frame = (now) => {
    // A long pause (a hidden tab, a breakpoint) must not become one huge step.
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    update(dt)
    renderer.render(scene, camera)
    justPressed.clear()
    requestAnimationFrame(frame)
  }

  function run(callback) {
    const running = update !== null
    update = callback
    if (running) return
    last = performance.now()
    requestAnimationFrame(frame)
  }

  return { scene, camera, renderer, run }
}

const boxA = new THREE.Box3()
const boxB = new THREE.Box3()

// False for an object that was removed from the scene or hidden: a collected coin is not hit twice.
export function overlap(a, b) {
  if (!a || !b || !a.parent || !b.parent || !a.visible || !b.visible) return false
  return boxA.setFromObject(a).intersectsBox(boxB.setFromObject(b))
}

export function hud(text) {
  let element = document.getElementById("hud")
  if (!element) {
    element = document.createElement("div")
    element.id = "hud"
    document.body.appendChild(element)
  }
  element.textContent = String(text)
}
