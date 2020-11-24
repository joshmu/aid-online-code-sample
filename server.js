const express = require('express')
const app = express()
const http = require('http').createServer(app)
const path = require('path')
const io = require('socket.io')(http)
const AidRoom = require('../src/utils/aidRoom')

const morgan = require('morgan')
const cors = require('cors')

const port = process.env.PORT || 3000

//////////////////////////
// MIDDLEWARES
//////////////////////////

app.use(express.json())
app.use(cors())
app.use(morgan('tiny'))

//////////////////////////
// ROUTES
//////////////////////////

// PUBLIC
app.use(express.static(path.join(__dirname, '../client/dist')))

// ROUTE - HOME
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'))
})

// ROUTE - HEARTBEAT TO PEVENT HEROKU FROM IDLING AFTER 30MIN
// @see https://stackoverflow.com/questions/59573799/why-did-my-herokuapp-idle-and-shut-down-while-in-use
app.post('/heartbeat', (req, res) => {
  console.log('server: - HEARTBEAT - ')
  res.status(200)
  res.json({
    msg: 'heartbeat',
    data: { client: req.body.data, server: Date.now() },
  })
})

// ROUTE - GET SPEECH MP3 AUDIO FILE
app.get('/mp3/:filename', (req, res) => {
  console.log('server: speech mp3 requested!')
  const filename = req.params.filename
  res.sendFile(path.join(__dirname, `../src/lib/mp3/${filename}`))
})

// ROUTE - DYNAMIC ROUTE ROOMS
app.get('/:room', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/room.html'))
  // res.sendFile(path.join(__dirname, '../client/src/indexV2.html'))
})

//////////////////////////
// SOCKET IO
//////////////////////////

const AID_ROOMS = []

// CONNECT
io.on('connection', socket => {
  console.log('server: new connection', socket.id)
  console.log('server: total sockets:', totalSockets(io))

  // JOIN ROOM
  socket.on('join-room', data => {
    console.log('server: join-room', data)
    const { roomId, searchParams } = data
    const room = { id: roomId, searchParams }

    // join room
    socket.join(roomId)

    // if there isn't a aid room yet for this roomId
    if (AID_ROOMS.every(aidRoom => aidRoom.id !== roomId)) {
      // create new aid instance
      const aidRoomInstance = new AidRoom({ io, room })
      // create object to store holding instance and id
      const aidRoom = {
        instance: aidRoomInstance,
        id: roomId,
      }
      // add to list of current aid rooms
      AID_ROOMS.push(aidRoom)
    }

    // add socket to aid room
    const aidRoom = AID_ROOMS.find(aidRoom => aidRoom.id === roomId)
    aidRoom.instance.addSocket(socket, searchParams)
  })

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log('server: user disconnected', socket.id)
    console.log('server: total sockets:', totalSockets(io))

    // check all the rooms and remove the socket
    AID_ROOMS.forEach(aidRoom => aidRoom.instance.removeSocket(socket))
  })
})

http.listen(port, () => {
  console.log(`server: listening on *:${port}`)
})

//////////////////////////
// HELPERS
//////////////////////////

function totalSockets(io) {
  const srvSockets = io.sockets.sockets
  return Object.keys(srvSockets).length
}
