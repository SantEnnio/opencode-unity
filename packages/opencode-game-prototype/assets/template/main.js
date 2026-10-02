import * as THREE from "three"
import { createGame, keys, overlap, hud } from "kit"

const game = createGame()
game.camera.position.set(0, 6, 10)
game.camera.lookAt(0, 0, 0)

const ground = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 20), new THREE.MeshStandardMaterial({ color: 0x3a7d44 }))
ground.name = "Ground"
ground.position.set(0, -0.5, 0)
game.scene.add(ground)

const player = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff8800 }))
player.name = "Player"
player.position.set(0, 0.5, 0)
game.scene.add(player)

const coin = new THREE.Mesh(new THREE.SphereGeometry(0.4), new THREE.MeshStandardMaterial({ color: 0xffdd00 }))
coin.name = "Coin"
coin.position.set(4, 0.5, 0)
game.scene.add(coin)

const speed = 5
const jumpSpeed = 7
const gravity = 20
let velocityY = 0
let score = 0
hud("Score 0")

game.run((dt) => {
  if (keys.down("KeyA")) player.position.x -= speed * dt
  if (keys.down("KeyD")) player.position.x += speed * dt
  if (keys.down("KeyW")) player.position.z -= speed * dt
  if (keys.down("KeyS")) player.position.z += speed * dt

  const onGround = player.position.y <= 0.5
  if (keys.pressed("Space") && onGround) velocityY = jumpSpeed
  velocityY -= gravity * dt
  player.position.y += velocityY * dt
  if (player.position.y < 0.5) {
    player.position.y = 0.5
    velocityY = 0
  }

  if (overlap(player, coin)) {
    game.scene.remove(coin)
    score += 1
    hud("Score " + score)
  }
})
