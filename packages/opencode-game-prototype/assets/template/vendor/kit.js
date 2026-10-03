// The kit: the parts of a small game that are the same every time. This file is fixed.
//
//   const game = createGame()                game.scene, game.camera, game.renderer; lights are already there
//   game.box("Player", 1, 1, 1, "orange")    a named box, already in the scene (sizes, then a colour name or 0xff8800)
//   game.sphere("Coin", 0.4, "gold")         a named sphere, already in the scene
//   game.run((dt) => { ... })                called every frame, dt in seconds; draws the scene after it
//   keys.down("KeyW")                        true while the key is held
//   keys.pressed("Space")                    true only in the frame the key went down
//   overlap(a, b)                            true when the boxes around two objects touch
//   onTop(a, b)                              true when a stands on b (its bottom at b's top, within b's edges)
//   landOn(a, b)                             when a is sinking into b from above, puts it on top and returns true
//   follow(game.camera, player, 0, 6, 10)    the camera keeps that offset from the object and looks at it
//   hud("Score 3")                           text in the top left corner

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

  // A named mesh, in the scene from the start: most of a prototype is boxes and spheres.
  const add = (name, geometry, color) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(color) }))
    mesh.name = name
    scene.add(mesh)
    return mesh
  }
  const box = (name, width = 1, height = 1, depth = 1, color = "white") => add(name, new THREE.BoxGeometry(width, height, depth), color)
  const sphere = (name, radius = 0.5, color = "white") => add(name, new THREE.SphereGeometry(radius), color)

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

  return { scene, camera, renderer, box, sphere, run }
}

const boxA = new THREE.Box3()
const boxB = new THREE.Box3()

// The boxes around two objects, from where they are now. Without this, Box3 reads the matrices
// of the last drawn frame: a player held up by landOn would sink a little every frame.
function boxes(a, b) {
  a.updateMatrixWorld(true)
  b.updateMatrixWorld(true)
  boxA.setFromObject(a)
  boxB.setFromObject(b)
}

// False for an object that was removed from the scene or hidden: a collected coin is not hit twice.
export function overlap(a, b) {
  if (!a || !b || !a.parent || !b.parent || !a.visible || !b.visible) return false
  boxes(a, b)
  return boxA.intersectsBox(boxB)
}

const withinEdges = () => boxA.max.x > boxB.min.x && boxA.min.x < boxB.max.x && boxA.max.z > boxB.min.z && boxA.min.z < boxB.max.z

// a stands on b: a's bottom is at b's top (a little above, or sunk into it by a fast fall), and a is
// within b's edges. Works for the ground, a platform, a moving platform.
export function onTop(a, b) {
  if (!a || !b || !a.parent || !b.parent || !a.visible || !b.visible) return false
  boxes(a, b)
  const gap = boxA.min.y - boxB.max.y
  return gap <= 0.15 && gap >= -0.6 && withinEdges()
}

// a fell onto b: its bottom is at or below b's top (down to one unit into it, a fast frame) while
// its centre is still above. Then a is put exactly on top and true is returned. Call it after
// moving a, each frame: `if (landOn(player, ground)) velocityY = 0`.
export function landOn(a, b) {
  if (!a || !b || !a.parent || !b.parent || !a.visible || !b.visible) return false
  boxes(a, b)
  const gap = boxA.min.y - boxB.max.y
  if (gap > 0.15 || gap < -1 || !withinEdges()) return false
  const centre = (boxA.min.y + boxA.max.y) / 2
  if (centre <= boxB.max.y) return false
  a.position.y += boxB.max.y - boxA.min.y
  return true
}

// The camera keeps the offset (dx, dy, dz) from the object and looks at it. Call it every frame.
export function follow(camera, target, dx = 0, dy = 6, dz = 10) {
  camera.position.set(target.position.x + dx, target.position.y + dy, target.position.z + dz)
  camera.lookAt(target.position)
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
