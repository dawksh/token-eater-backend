// Required: npm install ws node-fetch @types/ws @types/node --save
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import fetch from 'node-fetch'
import { handleUserEat, handleFoodEat } from './lib'

// Configurable webhook URL
const WEBHOOK_URL = (process as any).env.WEBHOOK_URL || 'http://localhost:4000/webhook'
const PORT = (process as any).env.PORT || 3001

// In-memory game state: { [gameId]: { players, food } }
const games: Record<string, {
    players: Record<string, { name: string, x: number, y: number, score: number, walletAddress: string, socketId: string }>
    food: Record<string, { id: string, x: number, y: number, score: number }>
}> = {}

// Utility: generate random ID
const genId = () => Math.random().toString(36).slice(2, 10)
// Utility: random position (laptop screen size)
const randPos = () => ({ x: Math.random() * 1920, y: Math.random() * 1080 })
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

const io = new SocketIOServer(server, { cors: { origin: '*' } })

// Broadcast state to all players in a game
const broadcastState = (gameId: string) => {
    const g = games[gameId]
    if (!g) return
    const players = Object.entries(g.players).map(([id, p]) => ({ id, name: p.name, x: p.x, y: p.y, score: p.score, walletAddress: p.walletAddress }))
    const food = Object.values(g.food)
    io.to(gameId).emit('state', { players, food })
}

// Handle socket.io connections
io.on('connection', socket => {
    let gameId: string | null = null
    let playerId: string | null = null

    socket.on('join', (msg: { gameId: string, name: string, walletAddress: string }) => {
        if (!msg.walletAddress) return
        gameId = msg.gameId
        playerId = genId()
        games[gameId] = games[gameId] || { players: {}, food: {} }
        const g = games[gameId]
        g.players[playerId] = { name: msg.name, x: 500, y: 500, score: 0, walletAddress: msg.walletAddress, socketId: socket.id }
        if (Object.keys(g.food).length === 0)
            Array.from({ length: 20 }, () => {
                const id = genId(); g.food[id] = { id, ...randPos(), score: randScore() }
            })
        socket.join(gameId)
        broadcastState(gameId)
        console.log(`[JOIN] ${msg.name} joined game ${gameId} as ${playerId} (${msg.walletAddress})`)
    })

    socket.on('move', (msg: { x: number, y: number }) => {
        if (!gameId || !playerId) return
        const g = games[gameId!]
        const player = g?.players[playerId!]
        if (!player) return
        Object.assign(player, { x: msg.x, y: msg.y })
        // Food collision
        Object.values(g.food).forEach(food => {
            if (dist(player, food) < playerRadius(player.score) + foodRadius(food.score)) {
                player.score += food.score
                handleFoodEat(food.score.toString(), player.walletAddress)
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
        // Player collision
        Object.entries(g.players).forEach(([otherId, other]) => {
            if (otherId !== playerId) {
                const r1 = playerRadius(player.score)
                const r2 = playerRadius(other.score)
                if (dist(player, other) < r1 + r2) {
                    if (player.score > other.score) {
                        player.score += other.score
                        handleUserEat(other.walletAddress, player.walletAddress, gameId!)
                        delete g.players[otherId]
                        console.log(`[PLAYER EAT] ${player.name} (${playerId}) ate ${other.name} (${otherId}) and gained ${other.score} points in ${gameId}`)
                    } else if (player.score < other.score) {
                        other.score += player.score
                        handleUserEat(player.walletAddress, other.walletAddress, gameId!)
                        delete g.players[playerId!]
                        broadcastState(gameId!)
                        console.log(`[PLAYER EAT] ${other.name} (${otherId}) ate ${player.name} (${playerId}) and gained ${player.score} points in ${gameId}`)
                        return
                    }
                }
            }
        })
        broadcastState(gameId!)
        console.log(`[MOVE] ${player.name} (${playerId}) moved to (${msg.x},${msg.y}) in ${gameId}`)
    })

    socket.on('disconnect', () => {
        if (!gameId || !playerId) return
        const g = games[gameId!]
        if (g && g.players[playerId!]) {
            console.log(`[LEAVE] ${g.players[playerId!].name || playerId} left game ${gameId}`)
            delete g.players[playerId!]
            broadcastState(gameId!)
            if (Object.keys(g.players).length === 0) delete games[gameId!]
        }
    })
})

server.listen(PORT, () =>
    console.log(`socket.io server on ws://localhost:${PORT}/ws/:gameId`)
)
