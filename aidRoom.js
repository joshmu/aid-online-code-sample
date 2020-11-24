const braceryAid = require('./braceryAID.js')
const { txtToMp3 } = require('../modules/textToMp3')
var mp3Duration = require('mp3-duration')

// CONSTANTS
const RATE_OFFSET = -0.1
const PITCH_OFFSET = -5

//////////////////////////
// AID ROOM CLASS
//////////////////////////

/**
 * Data Flow:
 * create AidRoom instance > add Socket > add listeners > START > init & setup braceryAid > expansions > END
 *
 * - can send & receive events from any socket
 * - can add & remove sockets at anytime
 */

class AidRoom {
  aid = null
  sockets = []
  admins = []
  speechDuration = null
  isStarted = false
  isRunning = false
  isEnd = false
  isPaused = false
  isRestart = false

  constructor({ io, room }) {
    this.io = io
    this.room = room
  }

  addSocket(socket, searchParams) {
    console.log('aid: adding socket', socket.id)

    this.sockets.push(socket)

    this.modifySocketWithParams(socket, searchParams)
    this.addListeners(socket)

    // initial socket connection gets ADMIN role
    if (this.sockets.length === 1) {
      this.assignAdmin(socket)

      // if the instance has started we can resume
      if (this.isStarted) {
        console.log('aid: resuming aid room')
        this.isRunning = true
        this.nextExpansion()
      }
    }
  }

  addListeners(socket) {
    console.log('aid: add listeners')
    socket.on('start', data => this.start(data))
    socket.on('pause', isPaused => (isPaused ? this.pause() : this.unpause()))
    socket.on('end', () => (this.isEnd = true))
    socket.on('restart', () => this.preRestart())
    socket.on('update-aid', data => this.updateAid(data))

    // @example - we can pass custom individual messages based on AID data
    // socket.emit('message', {
    //   message: `Welcome to the ${this.room.id} room. You are user ${this.sockets.length}. Press start or wait for others to join.`,
    // })
  }

  removeSocket(socket) {
    console.log('aid: removing socket', socket.id)
    this.sockets = this.sockets.filter(sock => sock.id !== socket.id)

    this.checkAndRemoveAdmin(socket)

    if (this.sockets.length === 0) {
      console.log('aid: suspending aid room')
      this.isRunning = false
    }
  }

  start(data = {}) {
    if (this.isRunning) return
    console.log('aid: start')
    this.isStarted = true

    this.room.startTime = new Date().getTime()

    if (data.formData) this.updateFormData(data.formData)

    this.broadcast().emit('start', this.room)

    this.setupAid()
    this.run()
  }

  preRestart() {
    if (!this.isRunning || this.isPaused) return this.restart()
    console.log('aid: pre restart')
    // otherwise wait for nextExpansion to trigger restart
    this.isRestart = true
  }

  restart() {
    if (this.isRestart === false) return

    console.log('aid: restart')
    this.broadcast().emit('finished')
    this.isStarted = false
    this.isRestart = false
    this.isRunning = false
    this.isPaused = false
    this.start()
  }

  async expand(cmd) {
    return braceryAid.trim(await braceryAid.expand(this.aid, cmd))
  }

  updateFormData(formData) {
    console.log('aid: update formData', formData)
    // establish or update
    this.room.formData = this.room.formData
      ? { ...this.room.formData, ...formData }
      : formData
  }

  pause() {
    if (this.isPaused) return
    console.log('aid: pause')
    this.isPaused = true
    this.broadcast().emit('pause', this.isPaused)
  }

  unpause() {
    if (!this.isPaused) return
    console.log('aid: unpause')
    this.isPaused = false
    this.broadcast().emit('pause', this.isPaused)
    this.run()
  }

  run() {
    if (this.isEnd) return
    console.log('aid: run')

    this.isRunning = true

    this.nextExpansion()
  }

  checkForHowlerMusic() {
    // check if we have new music to provide
    if (!this.aid.aid.howler) return

    this.broadcast().emit('audio', this.aid.aid.howler)
    delete this.aid.aid.howler
  }

  async nextExpansion() {
    if (!this.isRunning || this.isPaused) return
    if (this.isRestart) return this.restart()
    console.log('aid: next expansion')

    const expansionData = await this.getExpansion()
    const {
      msg,
      delay,
      rate,
      pitch,
      duration,
      speechAudioFilename,
    } = expansionData

    this.checkForHowlerMusic()

    // tell sockets the expansion data
    this.broadcast().emit('message', expansionData)

    // expansion delay (rather than using bracery extension)
    console.log({ speechDuration: this.speechDuration, delay })
    await sleep(this.speechDuration + delay)

    // are we at the end
    this.isEnd ? this.end() : this.nextExpansion()
  }

  end() {
    console.log('aid: --- FINISHED ---')
    this.broadcast().emit('finished')
    this.reset()
  }

  reset() {
    console.log('aid: reset state')
    this.aid = null
    this.isRunning = false
    this.isEnd = false
    this.isStarted = false
  }

  broadcast() {
    return this.io.to(this.room.id)
  }

  async getExpansion() {
    // get expansion of bracery variables
    const msg = await this.expand('&eval{#ss#}')
    const delay = +(await this.expand('#delay#'))
    let rate = +(await this.expand('#rate#'))
    const pitch = +(await this.expand('#pitch#'))
    this.isEnd = !!(await this.expand('#end#'))

    // FROM GOOGLE valid speaking_rate is between 0.25 and 4.0.
    rate = rate < 0.25 ? 0.25 : rate > 4 ? 4 : rate

    const audioConfig = {
      pitch: pitch + PITCH_OFFSET,
      speakingRate: rate + RATE_OFFSET,
    }

    // convert msg in to mp3 and pass the filename
    const { filename: speechAudioFilename, filepath } = await txtToMp3({
      text: msg,
      roomId: this.room.id,
      audioConfig,
    })
    console.log({ speechAudioFilename })

    const { duration: durationSeconds } = await getMp3Duration(filepath)
    this.speechDuration = durationSeconds * 1000

    const duration = (
      (new Date().getTime() - this.room.startTime) /
      1000
    ).toFixed(1)

    return {
      msg,
      delay,
      rate,
      pitch,
      duration,
      roomInfo: this.room,
      aid: this.aid.aid,
      speechAudioFilename,
    }
  }

  setupAid() {
    console.log('aid: setup aid')
    // configuration setup for bracery instance
    // INIT
    this.aid = braceryAid.init()

    // AID MEMORY STORE
    this.aid.aid = {
      formData: this.room.formData,
      roomInfo: this.room,
    }

    // formData Defaults
    // todo: check if this is still required
    const formDataDefaults = {
      cast: ['josh', 'teb'],
      userObjects: ['table'],
      userAreas: ['studio'],
      sessionLength: ['5'],
    }
    // use formDataDefaults for any missing values
    this.room.formData = { ...formDataDefaults, ...this.room.formData }

    // RULES
    this.aid.addRules({
      ss: ['&~setRules{init}#ss#'],
      delay: ['10'],
      // when 'end' has text we stop the bracery loop()
      end: [''],
      // room
      room_id: [this.room.id],
      room_start_time: [this.room.startTime.toString()],
      // formData defaults are instantiated in Admin.js on the client side
      cast_members: this.room.formData.cast,
      user_objects: this.room.formData.userObjects,
      user_areas: this.room.formData.userAreas,
      session_length: this.room.formData.sessionLength,
    })
  }

  modifySocketWithParams(socket, searchParams) {
    if (!searchParams) return

    const urlParams = new URLSearchParams(searchParams)
    console.log('aid:', urlParams)

    if (urlParams.get('admin')) {
      console.log('aid: manual admin created')
      this.assignAdmin(socket)
    }

    if (urlParams.get('update')) {
      console.log('aid: manual update of aid room')
      this.updateRoom({ searchParams })
      this.preRestart()
    }
  }

  updateRoom(data) {
    this.room = { ...this.room, ...data }
  }

  assignAdmin(socket) {
    // validate if socket is already admin
    if (this.admins.find(sock => sock.id === socket.id)) return

    socket.emit('role', 'ADMIN')

    this.admins.push(socket)

    console.log(`aid: ${this.admins.length} admins`)
  }

  checkAndRemoveAdmin(socket) {
    // validate if socket is not an admin
    if (!this.admins.find(sock => sock.id === socket.id)) return

    console.log('aid: removing admin', socket.id)
    this.admins = this.admins.filter(sock => sock.id !== socket.id)
  }

  updateAid(data) {
    if (data.name !== 'formData') return
    console.log('aid: update aid formData')
    const formData = data.data
    this.updateFormData(formData)

    // if we are currently running then we need to manually update bracery aid instance
    if (this.isRunning) {
      // console.log('cast instance rule', this.aid.rules['cast_members'])
      this.aid.deleteRule('cast_members')
      this.aid.deleteRule('session_length')
      this.aid.addRules({
        cast_members: this.room.formData.cast,
        session_length: this.room.formData.sessionLength,
      })
      // console.log('cast instance rule', this.aid.rules['cast_members'])
    }
  }
}

module.exports = AidRoom

//////////////////////////
// HELPERS
//////////////////////////

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const getMp3Duration = filepath => {
  return new Promise((resolve, reject) => {
    mp3Duration(filepath, function (err, duration) {
      if (err) reject(err.message)
      resolve({ duration })
    })
  })
}
