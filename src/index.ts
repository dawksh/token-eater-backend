// Required: npm install ws node-fetch @types/ws @types/node --save
import http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import url from 'url'
import fetch from 'node-fetch'
import { handleUserEat, handleFoodEat } from './lib'

// Use WeakMap to associate WebSocket with gameId
const wsGameIds = new WeakMap<WebSocket, string>()

// Configurable webhook URL
const WEBHOOK_URL = (process as any).env.WEBHOOK_URL || 'http://localhost:4000/webhook'
const PORT = (process as any).env.PORT || 3001

// In-memory game state: { [gameId]: { players, food } }
const games: Record<string, {
    players: Record<string, { name: string, x: number, y: number, ws: WebSocket, score: number }>
    food: Record<string, { id: string, x: number, y: number, score: number }>
}> = {}

// Utility: generate random ID
const genId = () => Math.random().toString(36).slice(2, 10)
// Utility: random position
const randPos = () => ({ x: Math.random() * 1000, y: Math.random() * 1000 })
// Utility: random score for food
const randScore = () => Math.floor(Math.random() * 10) + 1
// Utility: distance between two points
const dist = (a: { x: number, y: number }, b: { x: number, y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
// Utility: get player radius (should match frontend logic)
const playerRadius = (score: number) => 10 + score
// Utility: get food radius (optional, dynamic)
const foodRadius = (score: number) => 10 + score

// Create HTTP server (for webhook POSTs and healthcheck)
const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
    }
})
const wss = new WebSocketServer({ noServer: true })

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
    const { pathname } = url.parse(req.url || '')
    const match = pathname?.match(/^\/ws\/(\w+)$/)
    if (!match) return socket.destroy()
    wss.handleUpgrade(req, socket, head, ws => {
        wsGameIds.set(ws, match[1])
        wss.emit('connection', ws, req)
    })
})

// Broadcast state to all players in a game
const broadcastState = (gameId: string) => {
    const g = games[gameId]
    if (!g) return
    const players = Object.entries(g.players).map(([id, p]) => ({ id, name: p.name, x: p.x, y: p.y, score: p.score }))
    const food = Object.values(g.food)
    const msg = JSON.stringify({ type: 'state', players, food })
    Object.values(g.players).forEach(p => p.ws.readyState === 1 && p.ws.send(msg))
}

// Handle WebSocket connections
wss.on('connection', (ws: WebSocket, req) => {
    const gameId = wsGameIds.get(ws)!
    games[gameId] = games[gameId] || { players: {}, food: {} }
    const g = games[gameId]
    let playerId = genId()

    ws.on('message', data => {
        let msg
        try { msg = JSON.parse(data.toString()) } catch { return }
        if (msg.type === 'join') {
            g.players[playerId] = { name: msg.name, x: 500, y: 500, ws, score: 0 }
            if (Object.keys(g.food).length === 0)
                Array.from({ length: 20 }, () => {
                    const id = genId(); g.food[id] = { id, ...randPos(), score: randScore() }
                })
            console.log(`[JOIN] ${msg.name} joined game ${gameId} as ${playerId}`)
            broadcastState(gameId)
        }
        if (msg.type === 'move') {
            const player = g.players[playerId]
            if (player) {
                Object.assign(player, { x: msg.x, y: msg.y })
                // Check for food collision
                Object.values(g.food).forEach(food => {
                    if (dist(player, food) < playerRadius(player.score) + foodRadius(food.score)) {
                        player.score += food.score
                        handleFoodEat(food.id, playerId)
                        console.log(`[EAT] ${player.name} (${playerId}) ate food ${food.id} (score ${food.score}) at (${food.x},${food.y}) in ${gameId}`)
                        fetch(WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ player: player.name, food, gameId })
                        }).then(() =>
                            console.log(`[WEBHOOK] Sent for ${player.name} eating food ${food.id} in ${gameId}`)
                        ).catch(() =>
                            console.log(`[WEBHOOK] Failed for ${player.name} eating food ${food.id} in ${gameId}`)
                        )
                        delete g.food[food.id]
                    }
                })
                // Check for player collision (eating)
                Object.entries(g.players).forEach(([otherId, other]) => {
                    if (otherId !== playerId) {
                        const r1 = playerRadius(player.score)
                        const r2 = playerRadius(other.score)
                        if (dist(player, other) < r1 + r2) {
                            if (player.score > other.score) {
                                player.score += other.score
                                handleUserEat(otherId, playerId, gameId)
                                console.log(`[PLAYER EAT] ${player.name} (${playerId}) ate ${other.name} (${otherId}) and gained ${other.score} points in ${gameId}`)
                                delete g.players[otherId]
                            } else if (player.score < other.score) {
                                other.score += player.score
                                handleUserEat(playerId, otherId, gameId)
                                console.log(`[PLAYER EAT] ${other.name} (${otherId}) ate ${player.name} (${playerId}) and gained ${player.score} points in ${gameId}`)
                                delete g.players[playerId]
                                broadcastState(gameId)
                                return
                            }
                        }
                    }
                })
                console.log(`[MOVE] ${player.name} (${playerId}) moved to (${msg.x},${msg.y}) in ${gameId}`)
                broadcastState(gameId)
            }
        }
    })

    ws.on('close', () => {
        console.log(`[LEAVE] ${g.players[playerId]?.name || playerId} left game ${gameId}`)
        delete g.players[playerId]
        broadcastState(gameId)
        if (Object.keys(g.players).length === 0) delete games[gameId]
    })
})

server.listen(PORT, () =>
    console.log(`ws server on ws://localhost:${PORT}/ws/:gameId`)
)
