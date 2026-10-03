import * as THREE from "three"
import { createGame, keys, overlap, onTop, landOn, follow, hud } from "kit"

const game = createGame()

const ground = game.box("Ground", 20, 1, 20, 0x3a7d44)
ground.position.set(0, -0.5, 0)

const player = game.box("Player", 1, 1, 1, "orange")
player.position.set(0, 0.5, 0)

const coin = game.sphere("Coin", 0.4, "gold")
coin.position.set(4, 0.5, 0)

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

  if (keys.pressed("Space") && onTop(player, ground)) velocityY = jumpSpeed
  velocityY -= gravity * dt
  player.position.y += velocityY * dt
  if (velocityY <= 0 && landOn(player, ground)) velocityY = 0

  if (overlap(player, coin)) {
    game.scene.remove(coin)
    score += 1
    hud("Score " + score)
  }

  follow(game.camera, player, 0, 6, 10)
})
