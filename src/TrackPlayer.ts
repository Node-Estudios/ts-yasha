import EventEmitter from 'node:events'

import VoiceConnection from './VoiceConnection.js'
import AudioPlayer from 'sange'

import sodium from 'sodium'
import { UnsupportedError, GenericError, InternalError } from 'js-common'
import { UnplayableError } from './Error.js'
// @ts-expect-error
import { VoiceConnectionStatus } from '@discordjs/voice'
import { YoutubeTrack } from './api/Youtube.js'
import { SpotifyTrack } from './api/Spotify.js'
import { SoundcloudTrack } from './api/Soundcloud.js'
import { AppleMusicTrack } from './api/AppleMusic.js'
import { FileTrack } from './api/File.js'

const RANDOM_BYTES = Buffer.alloc(24)
const CONNECTION_NONCE = Buffer.alloc(24)
const AUDIO_NONCE = Buffer.alloc(24)
const AUDIO_BUFFER = Buffer.alloc(8192)
const AUDIO_OUTPUT = Buffer.alloc(8192)

const SILENCE = Buffer.from([0xf8, 0xff, 0xfe])

/* these bytes never change */
AUDIO_BUFFER[0] = 0x80
AUDIO_BUFFER[1] = 0x78

const MAX_PLAY_ID = 2 ** 32 - 1
const ERROR_INTERVAL = 5 * 60 * 1000 /* 5 minutes */

const EncryptionMode = {
    NONE: 0,
    LITE: 1,
    SUFFIX: 2,
    DEFAULT: 3,
}

class Subscription {
    connection: VoiceConnection
    player: TrackPlayer
    constructor (connection: VoiceConnection, player: TrackPlayer) {
        this.connection = connection
        this.player = player
    }

    unsubscribe () {
        // @ts-expect-error
        this.connection.onSubscriptionRemoved(this)
        this.player.unsubscribe(this)
    }
}

export type trackTypes = YoutubeTrack | SpotifyTrack | SoundcloudTrack | AppleMusicTrack | FileTrack
class TrackPlayer extends EventEmitter {
    normalize_volume = false
    external_encrypt = false
    external_packet_send = false
    last_error = 0
    track?: trackTypes
    stream?: any
    subscriptions: Subscription[] = []
    play_id = 0
    silence_frames_interval?: NodeJS.Timer
    silence_frames_left = 0
    silence_frames_needed = false
    player?: AudioPlayer

    override on (event: 'packet', callback: (packet: { frame_size: number, buffer: Buffer }) => void): this
    override on (event: 'finish', callback: () => void): this
    override on (event: 'error', callback: (error: Error) => void): this
    // @ts-expect-error
    override on (event: 'ready', callback: () => void): this

    constructor (options?: {
        normalize_volume?: boolean
        external_encrypt?: boolean
        external_packet_send?: boolean
    }) {
        super()

        if (options) {
            this.normalize_volume = !!options.normalize_volume
            this.external_encrypt = !!options.external_encrypt
            this.external_packet_send = !!options.external_packet_send
        }

        this.last_error = 0

        this.stream = null
        this.subscriptions = []

        this.play_id = 0

        this.silence_frames_left = 0
        this.silence_frames_needed = false

        this.onstatechange = this.onstatechange.bind(this)
    }

    onstatechange (_old: any, cur: { status: VoiceConnectionStatus }) {
        if (cur.status === VoiceConnection.Status.Ready) { this.init_secretbox() } else if (this.external_encrypt && this.external_packet_send && this.player) { this.player.ffplayer.pipe() }
    }

    subscribe (connection: VoiceConnection) {
        if (this.external_encrypt) {
            if (this.subscriptions.length) { throw new UnsupportedError('Cannot subscribe to multiple connections when external encryption is enabled') }
            // @ts-expect-error
            connection.on('stateChange', this.onstatechange)
        }

        const subscription = new Subscription(connection, this)

        this.subscriptions.push(subscription)

        this.init_secretbox()

        return subscription
    }

    unsubscribe (subscription: Subscription) {
        const index = this.subscriptions.indexOf(subscription)

        if (index === -1) { return }
        // @ts-expect-error
        if (this.external_encrypt) { this.subscriptions[index].connection.removeListener('stateChange', this.onstatechange) }
        this.subscriptions.splice(index, 1)

        if (!this.subscriptions.length) { this.destroy() }
    }

    unsubscribe_all () {
        while (this.subscriptions.length) { this.subscriptions[0].unsubscribe() }
    }

    onpacket (packet: Uint8Array, length: number, frameSize: any) {
        if (!this.isPaused()) { this.stop_silence_frames() }
        packet = new Uint8Array(packet.buffer, 0, length)

        if (!this.external_packet_send) { this.send(packet, frameSize) }
        this.emit('packet', packet, frameSize)
    }

    onfinish () {
        this.emit('finish')
        this.start_silence_frames()
    }

    onerror (error: any, code: any, retryable: any) {
        if (this.error(error, retryable)) { return }
        if (this.track) this.track.streams = undefined
        this.create_player(this.getTime())
        void this.start()
    }

    secretbox_ready () {
        return this.subscriptions.length && this.subscriptions[0].connection.ready()
    }

    get_connection () {
        return this.subscriptions[0].connection
    }

    get_connection_data () {
        return this.get_connection().state.networking.state.connectionData
    }

    get_connection_udp () {
        return this.get_connection().state.networking.state.udp
    }

    init_secretbox () {
        if (!this.external_encrypt || !this.player) { return }
        if (this.secretbox_ready()) {
            const connectionData = this.get_connection_data()
            const udp = this.get_connection_udp()
            let mode

            switch (connectionData.encryptionMode) {
                case 'xsalsa20_poly1305_lite':
                    mode = EncryptionMode.LITE

                    break
                case 'xsalsa20_poly1305_suffix':
                    mode = EncryptionMode.SUFFIX

                    break
                default:
                    mode = EncryptionMode.DEFAULT

                    break
            }

            const data = this.get_connection_data()

            try {
                this.player.ffplayer.setSecretBox(connectionData.secretKey, mode, connectionData.ssrc)
                this.player.ffplayer.updateSecretBox(data.sequence, data.timestamp, data.nonce)

                if (this.external_packet_send) { this.player.ffplayer.pipe(udp.remote.ip, udp.remote.port) }
            } catch (e) {
                this.cleanup()
                this.emit('error', new GenericError(e))

                return
            }
// @ts-expect-error
            if (this.external_packet_send) { this.get_connection().setSpeaking(true) }
            return
        }

        try {
            this.player.ffplayer.setSecretBox(new Uint8Array(32), 0, 0)
        } catch (e) {
            this.cleanup()
            this.emit('error', new GenericError(e))
        }

        if (this.external_packet_send) { this.player.ffplayer.pipe() }
    }

    create_player (startTime?: number) {
        this.destroy_player()

        // @ts-expect-error
        if (this.track?.player) {
            // @ts-expect-error
            // eslint-disable-next-line new-cap
            this.player = new this.track.player(this.external_encrypt ? new Uint8Array(4096) : AUDIO_OUTPUT, false)
            this.player.setTrack(this.track)
        } else {
            try {
                this.player = new AudioPlayer(this.external_encrypt ? new Uint8Array(4096) : AUDIO_OUTPUT, false)
            } catch (e) {
                this.emit('error', new GenericError(e))

                return
            }
        }

        this.player.setOutput(2, 48000, 256000)

        if (startTime) { this.player.seek(startTime) }
        this.player.ffplayer.onready = this.emit.bind(this, 'ready')
        this.player.ffplayer.onpacket = this.onpacket.bind(this)
        this.player.ffplayer.onfinish = this.onfinish.bind(this)
        this.player.ffplayer.onerror = this.onerror.bind(this)
        this.player.ffplayer.ondebug = this.emit.bind(this, 'debug')

        this.init_secretbox()
    }

    async load_streams () {
        let streams; const playId = this.play_id

        if (!this.track?.streams?.expired()) { streams = this.track?.streams } else {
            try {
                streams = await this.track.getStreams()
            } catch (error) {
                if (this.play_id === playId) { this.emit('error', error) }
                return false
            }

            if (this.play_id !== playId) { return false }
            this.track.streams = streams
        }

        this.stream = this.get_best_stream(streams)

        if (!this.stream) {
            this.emit('error', new UnplayableError('No streams found'))

            return false
        }

        if (!this.stream.url) {
            try {
                this.stream.url = await this.stream.getUrl()
            } catch (error) {
                if (this.play_id === playId) { this.emit('error', error) }
                return false
            }

            if (this.play_id !== playId) { return false }
        }

        return true
    }

    send (buffer: Buffer | Uint8Array, frameSize: number, isSilence?: boolean) {
        const subscriptions = this.subscriptions; let connection

        for (let i = 0; i < subscriptions.length; i++) {
            connection = subscriptions[i].connection

            if (!connection.ready()) { continue }
            connection.setSpeaking(true)

            const state = connection.state.networking.state
            const connectionData = state.connectionData
            let mode = connectionData.encryption_mode
            if (this.external_encrypt && !isSilence) {
                state.udp.send(buffer)

                continue
            }

            if (!mode) {
                switch (connectionData.encryptionMode) {
                    case 'xsalsa20_poly1305_lite':
                        connectionData.encryption_mode = EncryptionMode.LITE

                        break
                    case 'xsalsa20_poly1305_suffix':
                        connectionData.encryption_mode = EncryptionMode.SUFFIX

                        break
                    default:
                        connectionData.encryption_mode = EncryptionMode.DEFAULT

                        break
                }

                mode = connectionData.encryption_mode
            }

            connectionData.sequence++
            connectionData.timestamp += frameSize

            if (connectionData.sequence > 65535) { connectionData.sequence = 0 }
            if (connectionData.timestamp > 4294967295) { connectionData.timestamp = 0 }
            AUDIO_BUFFER.writeUIntBE(connectionData.sequence, 2, 2)
            AUDIO_BUFFER.writeUIntBE(connectionData.timestamp, 4, 4)
            AUDIO_BUFFER.writeUIntBE(connectionData.ssrc, 8, 4)

            let len = 12 /* header length */

            switch (mode) {
                case EncryptionMode.LITE:
                    connectionData.nonce++

                    if (connectionData.nonce > 4294967295) { connectionData.nonce = 0 }
                    CONNECTION_NONCE.writeUInt32BE(connectionData.nonce, 0)

                    len += sodium.crypto_secretbox_easy(AUDIO_BUFFER.subarray(12), buffer, CONNECTION_NONCE, connectionData.secretKey)

                    AUDIO_BUFFER.set(CONNECTION_NONCE.subarray(0, 4), len)

                    len += 4

                    break
                case EncryptionMode.SUFFIX:
                    sodium.randombytes_buf(RANDOM_BYTES)

                    len += sodium.crypto_secretbox_easy(AUDIO_BUFFER.subarray(12), buffer, RANDOM_BYTES, connectionData.secretKey)

                    AUDIO_BUFFER.set(RANDOM_BYTES, len)

                    len += 24

                    break
                case EncryptionMode.DEFAULT:
                    AUDIO_BUFFER.copy(AUDIO_NONCE, 0, 0, 12)

                    len += sodium.crypto_secretbox_easy(AUDIO_BUFFER.subarray(12), buffer, AUDIO_NONCE, connectionData.secretKey)

                    break
            }

            state.udp.send(AUDIO_BUFFER.subarray(0, len))
        }
    }

    start_silence_frames () {
        if (!this.silence_frames_needed || this.silence_frames_interval) { return }
        this.silence_frames_needed = false

        if (this.player && this.external_encrypt && this.secretbox_ready()) {
            /* restore modified secretbox state from the player */
            const box = this.player.ffplayer.getSecretBox()
            const data = this.get_connection_data()
            data.nonce = box.nonce
            data.timestamp = box.timestamp
            data.sequence = box.sequence
        }

        this.silence_frames_interval = setInterval(() => {
            this.silence_frames_left--

            this.send(SILENCE, 960, true)

            if (this.player && this.external_encrypt && this.secretbox_ready()) {
                /* save modified secretbox state to the player */
                const data = this.get_connection_data()

                this.player.ffplayer.updateSecretBox(data.sequence, data.timestamp, data.nonce)
            }

            if (!this.silence_frames_left) {
                clearInterval(this.silence_frames_interval)

                this.silence_frames_interval = undefined
            }
        }, 20)
    }

    stop_silence_frames () {
        if (this.silence_frames_needed) { return }
        if (this.silence_frames_interval) {
            clearInterval(this.silence_frames_interval)

            this.silence_frames_interval = undefined
        }

        this.silence_frames_needed = true
        this.silence_frames_left = 5
    }

    error (error: any, retryable?: boolean) {
        if (!retryable || Date.now() - this.last_error < ERROR_INTERVAL) {
            this.destroy_player()
            this.emit('error', new InternalError(error))

            return true
        }

        this.last_error = Date.now()

        return false
    }

    get_best_stream_one (streams: any[]) {
        const opus = []; const audio = []; const other = []

        for (const stream of streams) {
            if (stream.video) {
                other.push(stream)

                continue
            }

            if (stream.codecs === 'opus') { opus.push(stream) } else { audio.push(stream) }
        }

        if (opus.length) { streams = opus } else if (audio.length) { streams = audio } else { streams = other }
        if (!streams.length) { return null }
        return streams.reduce((best, cur) => {
            return cur.bitrate > best.bitrate ? cur : best
        })
    }

    get_best_stream (streams: any[]) {
        // @ts-expect-error
        let result; const volume = streams.volume

        streams = streams.filter((stream) => stream.audio)
        result = this.get_best_stream_one(streams.filter((stream) => stream.default_audio_track))

        if (!result) { result = this.get_best_stream_one(streams) }
        if (result) { result.volume = volume }
        return result
    }

    play (track: trackTypes) {
        this.play_id++
        this.last_error = 0

        this.stream = null
        this.track = track

        if (this.play_id > MAX_PLAY_ID) { this.play_id = 0 }
        this.create_player()
    }

    async start () {
        if (!await this.load_streams() || !this.player) /* destroy could have been called while waiting */
        // eslint-disable-next-line @typescript-eslint/brace-style
        { return }
        if (this.normalize_volume && this.stream?.volume) { this.player.setVolume(this.stream.volume) }
        try {
            this.player.setURL(this.stream?.url, this.stream?.isFile)

            await this.player.start()
        } catch (e) {
            this.emit('error', new GenericError(e))
        }
    }

    check_destroyed () {
        if (!this.player) { throw new GenericError('Player was destroyed or nothing was playing') }
    }

    hasPlayer (): boolean {
        return this.player !== null
    }

    isPaused (): boolean {
        this.check_destroyed()

        return this.player.isPaused()
    }

    setPaused (paused?: boolean): void {
        this.check_destroyed()

        if (paused) { this.start_silence_frames() }
        return this.player.setPaused(!!paused)
    }

    setVolume (volume: number): void {
        this.check_destroyed()

        return this.player.setVolume(volume)
    }

    setBitrate (bitrate: number): void {
        this.check_destroyed()

        return this.player.setBitrate(bitrate)
    }

    setRate (rate: number): void {
        this.check_destroyed()

        return this.player.setRate(rate)
    }

    setTempo (tempo: number): void {
        this.check_destroyed()

        return this.player.setTempo(tempo)
    }

    setTremolo (depth: number, rate: number): void {
        this.check_destroyed()

        return this.player.setTremolo(depth, rate)
    }

    setEqualizer (eqs: Array<{
        band: number
        gain: number
    }>): void {
        this.check_destroyed()

        return this.player.setEqualizer(eqs)
    }

    seek (time: number): void {
        this.check_destroyed()
        this.start_silence_frames()

        return this.player.seek(time)
    }

    getTime (): number {
        this.check_destroyed()

        return this.player.getTime()
    }

    getDuration (): number {
        this.check_destroyed()

        return this.player.getDuration()
    }

    getFramesDropped (): number {
        this.check_destroyed()

        return this.player.getFramesDropped()
    }

    getTotalFrames (): number {
        this.check_destroyed()

        return this.player.getTotalFrames()
    }

    isCodecCopy (): boolean {
        this.check_destroyed()

        return this.player.ffplayer.isCodecCopy()
    }

    stop (): void {
        this.start_silence_frames()

        if (this.player) { return this.player.stop() }
    }

    destroy_player () {
        if (this.player) {
            this.start_silence_frames()
            this.player.destroy()
            this.player = null
        }
    }

    cleanup () {
        this.destroy_player()
    }

    destroy () {
        this.unsubscribe_all()

        if (this.player) {
            this.player.destroy()
            this.player = null
        }

        if (this.silence_frames_interval) {
            clearInterval(this.silence_frames_interval)

            this.silence_frames_interval = undefined
        }
    }
}

export default TrackPlayer
