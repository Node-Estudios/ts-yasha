// src/TrackPlayer.ts (Corregido)

import EventEmitter from 'node:events'
// --- CAMBIO: Se importa 'setTimeout' y 'clearTimeout' para claridad ---
import { setTimeout, clearTimeout } from 'node:timers'
import VoiceConnection from './VoiceConnection.js'
import AudioPlayer from '@eliyya/sange'
import sodium from '@eliyya/sodium'
import { UnplayableError, GenericError, InternalError, UnsupportedError } from './Error.js'
import type { VoiceConnectionState } from '@discordjs/voice'
import { YoutubeTrack } from './api/Youtube.js'
import { SpotifyTrack } from './api/Spotify.js'
import { SoundcloudTrack } from './api/Soundcloud.js'
import { AppleMusicTrack } from './api/AppleMusic.js'
import { FileTrack, FileStream } from './api/File.js'
import { TrackStream } from './Track.js'

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
        // @ts-expect-error - If onSubscriptionRemoved is a custom method not in base types
        this.connection.onSubscriptionRemoved(this)
        this.player.unsubscribe(this)
    }
}

export type trackTypes = YoutubeTrack | SpotifyTrack | SoundcloudTrack | AppleMusicTrack | FileTrack
type StreamType = (TrackStream | FileStream) & { url?: string | null, isFile?: boolean, volume?: number }

class TrackPlayer extends EventEmitter {
    normalize_volume = false
    external_encrypt = false
    external_packet_send = false
    last_error = 0
    track?: trackTypes
    stream?: StreamType | null = undefined
    subscriptions: Subscription[] = []
    play_id = 0
    silence_frames_interval?: NodeJS.Timeout
    silence_frames_left = 0
    silence_frames_needed = false
    player?: AudioPlayer

    override on (event: 'packet', callback: (packet: Uint8Array, frameSize: number) => void): this
    override on (event: 'finish', callback: () => void): this
    override on (event: 'error', callback: (error: Error) => void): this
    override on (event: 'ready', callback: () => void): this
    override on (event: 'debug', callback: (...args: any[]) => void): this
    override on (event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener)
    }

    override emit (event: 'packet', packet: Uint8Array, frameSize: number): boolean
    override emit (event: 'finish'): boolean
    override emit (event: 'error', error: Error): boolean
    override emit (event: 'ready'): boolean
    override emit (event: 'debug', ...args: any[]): boolean
    override emit (event: string | symbol, ...args: any[]): boolean {
        return super.emit(event, ...args)
    }

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
        this.stream = undefined
        this.subscriptions = []
        this.play_id = 0
        this.silence_frames_left = 0
        this.silence_frames_needed = false
        this.onstatechange = this.onstatechange.bind(this)
    }

    onstatechange (oldState: VoiceConnectionState, newState: VoiceConnectionState) {
        if (newState.status === VoiceConnection.Status.Ready) {
            this.init_secretbox()
        } else if (this.external_encrypt && this.external_packet_send && this.player?.ffplayer) {
            this.player.ffplayer.pipe() // Stop piping if not ready
        }
    }

    subscribe (connection: VoiceConnection) {
        if (this.external_encrypt) {
            if (this.subscriptions.length) { throw new UnsupportedError('Cannot subscribe to multiple connections when external encryption is enabled') }
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
        if (this.external_encrypt && this.subscriptions[index]) {
            // --- CAMBIO AQUÍ ---
            // Se realiza una aserción de tipo a 'any' para evitar el error de TypeScript,
            // permitiendo que se llame al método 'off' que existe en tiempo de ejecución.
            (this.subscriptions[index].connection as any).off('stateChange', this.onstatechange)
        }
        this.subscriptions.splice(index, 1)

        if (!this.subscriptions.length) { this.destroy() }
    }

    unsubscribe_all () {
        const subsCopy = [...this.subscriptions]
        for (const sub of subsCopy) {
            sub.unsubscribe()
        }
    }

    onpacket (packet: Uint8Array, length: number, frameSize: number) {
        if (!this.isPaused()) { this.stop_silence_frames() }
        const finalPacket = packet.length === length ? packet : new Uint8Array(packet.buffer, packet.byteOffset, length)

        if (!this.external_packet_send) { this.send(finalPacket, frameSize) }
        this.emit('packet', finalPacket, frameSize)
    }

    onfinish () {
        this.emit('finish')
        this.start_silence_frames()
    }

    onerror (error: any, code: any, retryable: boolean) {
        if (this.error(error, retryable)) { return }
        if (this.track) { this.track.streams = undefined }
        const seekTime = this.player ? this.getTime() : 0
        this.create_player(seekTime)
        this.start().catch(startError => {
            this.emit('error', new GenericError(new Error(startError instanceof Error ? startError.message : String(startError ?? 'Failed to restart after error'))))
        })
    }

    secretbox_ready (): boolean {
        return this.subscriptions.length > 0 && this.subscriptions[0].connection.state.status === VoiceConnection.Status.Ready
    }

    get_connection (): VoiceConnection {
        if (!this.subscriptions.length) {
            throw new GenericError(new Error('TrackPlayer has no subscriptions, cannot get VoiceConnection'))
        }
        return this.subscriptions[0].connection
    }

    get_connection_data () {
        const state = this.get_connection().state
        if (state.status !== VoiceConnection.Status.Ready || !state.networking?.state?.connectionData) {
            throw new GenericError(new Error('Connection not ready or missing connection data'))
        }
        return state.networking.state.connectionData
    }

    get_connection_udp () {
        const state = this.get_connection().state
        if (state.status !== VoiceConnection.Status.Ready || !state.networking?.state?.udp) {
            throw new GenericError(new Error('Connection not ready or missing UDP information'))
        }
        return state.networking.state.udp
    }

    init_secretbox () {
        if (!this.external_encrypt || !this.player?.ffplayer) { return }
        if (this.secretbox_ready()) {
            try {
                const connectionData = this.get_connection_data()
                const udp = this.get_connection_udp()
                let mode

                if (typeof connectionData.encryptionMode !== 'string') {
                    throw new Error('Missing or invalid encryptionMode in connection data')
                }

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

                if (connectionData.secretKey === undefined || connectionData.ssrc === undefined || connectionData.sequence === undefined || connectionData.timestamp === undefined || connectionData.nonce === undefined) {
                    throw new Error('Missing required connection data properties for secret box')
                }

                this.player.ffplayer.setSecretBox(connectionData.secretKey, mode, connectionData.ssrc)
                this.player.ffplayer.updateSecretBox(connectionData.sequence, connectionData.timestamp, connectionData.nonce)

                if (this.external_packet_send) {
                    if (!udp?.remote?.ip || udp?.remote?.port === undefined) {
                        throw new Error('Missing UDP remote address or port')
                    }
                    this.player.ffplayer.pipe(udp.remote.ip, udp.remote.port)
                }
            } catch (e) {
                this.cleanup()
                this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Error setting secret box'))))
                return
            }
            return
        }

        try {
            this.player.ffplayer.setSecretBox(new Uint8Array(32), EncryptionMode.NONE, 0)
        } catch (e) {
            this.cleanup()
            this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Error setting empty secret box'))))
        }

        if (this.external_packet_send && this.player?.ffplayer) {
            this.player.ffplayer.pipe()
        }
    }

    create_player (startTime?: number) {
        this.destroy_player()
        // @ts-expect-error
        const CustomPlayer = this.track?.player

        if (CustomPlayer && typeof CustomPlayer === 'function') {
            try {
                // eslint-disable-next-line new-cap
                this.player = new CustomPlayer(this.external_encrypt ? new Uint8Array(4096) : AUDIO_OUTPUT, false)
                if (typeof this.player?.setTrack !== 'function') {
                    throw new Error("Custom player instance missing 'setTrack' method")
                }
                this.player.setTrack(this.track)
            } catch (e) {
                this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Failed to instantiate custom player'))))
                return
            }
        } else {
            try {
                if (typeof AudioPlayer !== 'function') {
                    throw new Error("'sange' AudioPlayer is not a constructor")
                }
                this.player = new AudioPlayer(this.external_encrypt ? new Uint8Array(4096) : AUDIO_OUTPUT, false)
            } catch (e) {
                this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Failed to instantiate sange AudioPlayer'))))
                return
            }
        }

        if (!this.player?.ffplayer) {
            this.emit('error', new GenericError(new Error('Failed to initialize ffplayer component')))
            this.player = undefined
            return
        }

        this.player.setOutput(2, 48000, 256000)

        if (startTime && typeof startTime === 'number' && startTime > 0) {
            this.player.seek(startTime)
        }

        this.player.ffplayer.onready = this.emit.bind(this, 'ready')
        this.player.ffplayer.onpacket = this.onpacket.bind(this)
        this.player.ffplayer.onfinish = this.onfinish.bind(this)
        this.player.ffplayer.onerror = this.onerror.bind(this)
        this.player.ffplayer.ondebug = this.emit.bind(this, 'debug')

        this.init_secretbox()
    }

    async load_streams (): Promise<boolean> {
        let streams; const playId = this.play_id

        if (!this.track?.getStreams) {
            this.emit('error', new GenericError(new Error('Current track is missing getStreams method')))
            return false
        }

        if (this.track.streams && typeof this.track.streams.expired === 'function' && !this.track.streams.expired()) {
            streams = this.track.streams
        } else {
            try {
                streams = await this.track.getStreams()
                if (this.play_id !== playId) { return false }
                if (!streams || typeof streams !== 'object') {
                    throw new Error('getStreams returned invalid data')
                }
                this.track.streams = streams
            } catch (error) {
                if (this.play_id === playId) {
                    const err = error instanceof Error ? error : new Error(String(error ?? 'Failed to get streams'))
                    this.emit('error', err)
                }
                return false
            }
        }

        if (!Array.isArray(streams)) {
            this.emit('error', new GenericError(new Error('Streams data is not an array')))
            return false
        }

        this.stream = this.get_best_stream(streams)

        if (!this.stream) {
            this.emit('error', new UnplayableError('No suitable stream found'))
            return false
        }

        if (this.stream && !this.stream.url) {
            if (!this.stream.getUrl || typeof this.stream.getUrl !== 'function') {
                this.emit('error', new GenericError(new Error('Stream object missing getUrl method')))
                return false
            }
            try {
                const result = await this.stream.getUrl()
                this.stream.url = result ?? undefined
                if (this.play_id !== playId) { return false }
                if (typeof this.stream.url !== 'string') {
                    throw new Error('getUrl resolved to an invalid type or null')
                }
            } catch (error) {
                if (this.play_id === playId) {
                    const err = error instanceof Error ? error : new Error(String(error ?? 'Failed to get stream URL'))
                    this.emit('error', err)
                }
                this.stream = null
                return false
            }
        }

        return true
    }

    send (buffer: Buffer | Uint8Array, frameSize: number, isSilence?: boolean) {
        const subscriptions = this.subscriptions

        for (const connection of subscriptions.map(sub => sub.connection)) {
            if (connection.state.status !== VoiceConnection.Status.Ready) { continue }

            try {
                connection.setSpeaking(true)
            } catch (speakError) {
                console.warn('Failed to set speaking state:', speakError)
            }

            const networking = connection.state.networking
            if (!networking?.state) continue

            const connectionData = networking.state.connectionData
            const udp = networking.state.udp

            if (!connectionData || !udp) continue

            let mode = connectionData.encryption_mode

            if (this.external_encrypt && !isSilence) {
                const packetToSend = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
                udp.send(packetToSend)
                continue
            }

            if (!mode) {
                if (typeof connectionData.encryptionMode !== 'string') continue

                switch (connectionData.encryptionMode) {
                    case 'xsalsa20_poly1305_lite': mode = EncryptionMode.LITE; break
                    case 'xsalsa20_poly1305_suffix': mode = EncryptionMode.SUFFIX; break
                    default: mode = EncryptionMode.DEFAULT; break
                }
                connectionData.encryption_mode = mode
            }

            if (connectionData.sequence === undefined || connectionData.timestamp === undefined || connectionData.ssrc === undefined || connectionData.secretKey === undefined) {
                console.warn('Missing connection data for packet encryption')
                continue
            }

            connectionData.sequence++
            connectionData.timestamp += frameSize

            if (connectionData.sequence > 65535) { connectionData.sequence = 0 }
            if (connectionData.timestamp > 4294967295) { connectionData.timestamp = 0 }

            AUDIO_BUFFER.writeUInt16BE(connectionData.sequence, 2)
            AUDIO_BUFFER.writeUInt32BE(connectionData.timestamp, 4)
            AUDIO_BUFFER.writeUInt32BE(connectionData.ssrc, 8)

            let len = 12
            const audioPayload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)

            try {
                switch (mode) {
                    case EncryptionMode.LITE:
                        connectionData.nonce = (connectionData.nonce ?? 0) + 1
                        if (connectionData.nonce > 4294967295) { connectionData.nonce = 0 }
                        CONNECTION_NONCE.writeUInt32BE(connectionData.nonce, 0)
                        len += sodium.crypto_secretbox_easy(AUDIO_BUFFER.subarray(12), audioPayload, CONNECTION_NONCE, connectionData.secretKey)
                        AUDIO_BUFFER.set(CONNECTION_NONCE.subarray(0, 4), len)
                        len += 4
                        break
                    case EncryptionMode.SUFFIX:
                        sodium.randombytes_buf(RANDOM_BYTES)
                        len += sodium.crypto_secretbox_easy(AUDIO_BUFFER.subarray(12), audioPayload, RANDOM_BYTES, connectionData.secretKey)
                        AUDIO_BUFFER.set(RANDOM_BYTES, len)
                        len += 24
                        break
                    case EncryptionMode.DEFAULT:
                        AUDIO_BUFFER.copy(AUDIO_NONCE, 0, 0, 12)
                        len += sodium.crypto_secretbox_easy(AUDIO_BUFFER.subarray(12), audioPayload, AUDIO_NONCE, connectionData.secretKey)
                        break
                }
                udp.send(AUDIO_BUFFER.subarray(0, len))
            } catch (cryptoError) {
                console.error('Encryption/Send error:', cryptoError)
            }
        }
    }

    start_silence_frames () {
        if (!this.silence_frames_needed || this.silence_frames_interval) { return }
        this.silence_frames_needed = false

        if (this.player && this.external_encrypt && this.secretbox_ready()) {
            try {
                if (!this.player.ffplayer) throw new Error('ffplayer not available')
                const box = this.player.ffplayer.getSecretBox()
                const data = this.get_connection_data()
                if (box.nonce === undefined || box.timestamp === undefined || box.sequence === undefined) {
                    throw new Error('Invalid secret box state from player')
                }
                data.nonce = box.nonce
                data.timestamp = box.timestamp
                data.sequence = box.sequence
            } catch (e) {
                console.error('Error restoring secret box state:', e)
                return
            }
        }

        this.silence_frames_interval = setInterval(() => {
            this.silence_frames_left--

            this.send(SILENCE, 960, true)

            if (this.player && this.external_encrypt && this.secretbox_ready()) {
                try {
                    if (!this.player.ffplayer) throw new Error('ffplayer not available')
                    const data = this.get_connection_data()
                    if (data.sequence === undefined || data.timestamp === undefined || data.nonce === undefined) {
                        throw new Error('Missing connection data for secret box update')
                    }
                    this.player.ffplayer.updateSecretBox(data.sequence, data.timestamp, data.nonce)
                } catch (e) {
                    console.error('Error updating secret box state:', e)
                    if (this.silence_frames_interval) {
                        clearInterval(this.silence_frames_interval)
                        this.silence_frames_interval = undefined
                    }
                    return
                }
            }

            if (!this.silence_frames_left) {
                if (this.silence_frames_interval) {
                    clearInterval(this.silence_frames_interval)
                    this.silence_frames_interval = undefined
                }
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

    error (error: any, retryable?: boolean): boolean {
        if (retryable === false || (Date.now() - this.last_error < ERROR_INTERVAL)) {
            this.destroy_player()
            const err = error instanceof Error ? error : new Error(String(error ?? 'Unknown playback error'))
            this.emit('error', new InternalError(err))
            return true
        }

        this.last_error = Date.now()
        return false
    }

    get_best_stream_one (streams: TrackStream[]): TrackStream | null {
        if (!Array.isArray(streams) || !streams.length) return null

        const opus: TrackStream[] = []
        const audio: TrackStream[] = []
        const other: TrackStream[] = []

        for (const stream of streams) {
            if (!stream || typeof stream !== 'object') continue
            if (stream.video) {
                other.push(stream)
                continue
            }
            if (stream.codecs === 'opus') { opus.push(stream) } else { audio.push(stream) }
        }

        const candidates: TrackStream[] = opus.length ? opus : (audio.length ? audio : other)
        if (!candidates.length) { return null }

        candidates.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        return candidates[0]
    }

    get_best_stream (streams: TrackStream[]): StreamType | null {
        if (!Array.isArray(streams)) return null
        // @ts-expect-error
        const volume = streams.volume

        const audioStreams = streams.filter((stream) => stream?.audio)
        // @ts-expect-error
        let result = this.get_best_stream_one(audioStreams.filter((stream) => stream?.default_audio_track))

        if (!result) { result = this.get_best_stream_one(audioStreams) }

        if (result && volume !== undefined) {
            result.volume = volume
        }
        return result as StreamType | null
    }

    play (track: trackTypes) {
        this.play_id++
        if (this.play_id > MAX_PLAY_ID) { this.play_id = 0 }

        this.last_error = 0
        this.stream = undefined
        this.track = track

        this.create_player()
        this.start().catch(startError => {
            this.emit('error', new GenericError(new Error(startError instanceof Error ? startError.message : String(startError ?? `Failed to start playback for track ${track.id}`))))
        })
    }

    async start () {
        if (!this.player || !this.track) { return }

        if (!await this.load_streams()) {
            console.log('load_streams failed, not starting player.')
            return
        }
        if (!this.player || !this.stream) {
            console.log('Player destroyed or stream missing after load_streams.')
            return
        }

        if (this.normalize_volume && this.stream && typeof this.stream.volume === 'number') {
            this.player.setVolume(this.stream.volume)
        }

        try {
            const url = this.stream.url
            const isFile = !!this.stream.isFile
            if (typeof url !== 'string' || !url) {
                throw new Error('Invalid stream URL provided to setURL')
            }
            this.player.setURL(url, isFile)
            await this.player.start()
        } catch (e) {
            this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Error starting player'))))
        }
    }

    check_destroyed () {
        if (!this.player) { throw new GenericError(new Error('Player was destroyed or nothing was playing')) }
    }

    hasPlayer (): boolean {
        return !!this.player
    }

    isPaused (): boolean {
        this.check_destroyed()
        return typeof this.player?.isPaused === 'function' ? this.player.isPaused() : false
    }

    setPaused (paused = true): void {
        this.check_destroyed()
        if (typeof this.player?.setPaused === 'function') {
            if (paused) { this.start_silence_frames() }
            this.player.setPaused(paused)
        }
    }

    setVolume (volume: number): void {
        this.check_destroyed()
        if (typeof this.player?.setVolume === 'function') {
            this.player.setVolume(volume)
        }
    }

    setBitrate (bitrate: number): void {
        this.check_destroyed()
        if (typeof this.player?.setBitrate === 'function') {
            this.player.setBitrate(bitrate)
        }
    }

    setRate (rate: number): void {
        this.check_destroyed()
        if (typeof this.player?.setRate === 'function') {
            this.player.setRate(rate)
        }
    }

    setTempo (tempo: number): void {
        this.check_destroyed()
        if (typeof this.player?.setTempo === 'function') {
            this.player.setTempo(tempo)
        }
    }

    setTremolo (depth: number, rate: number): void {
        this.check_destroyed()
        if (typeof this.player?.setTremolo === 'function') {
            this.player.setTremolo(depth, rate)
        }
    }

    setEqualizer (eqs: Array<{ band: number, gain: number }>): void {
        this.check_destroyed()
        if (typeof this.player?.setEqualizer === 'function') {
            this.player.setEqualizer(eqs)
        }
    }

    seek (time: number): void {
        this.check_destroyed()
        if (typeof this.player?.seek === 'function') {
            this.start_silence_frames()
            this.player.seek(time)
        }
    }

    getTime (): number {
        this.check_destroyed()
        return typeof this.player?.getTime === 'function' ? this.player.getTime() : 0
    }

    getDuration (): number {
        this.check_destroyed()
        return typeof this.player?.getDuration === 'function' ? this.player.getDuration() : 0
    }

    getFramesDropped (): number {
        this.check_destroyed()
        return typeof this.player?.getFramesDropped === 'function' ? this.player.getFramesDropped() : 0
    }

    getTotalFrames (): number {
        this.check_destroyed()
        return typeof this.player?.getTotalFrames === 'function' ? this.player.getTotalFrames() : 0
    }

    isCodecCopy (): boolean {
        this.check_destroyed()
        return typeof this.player?.ffplayer?.isCodecCopy === 'function' ? this.player.ffplayer.isCodecCopy() : false
    }

    stop (): void {
        if (this.player && typeof this.player.stop === 'function') {
            this.start_silence_frames()
            this.player.stop()
        }
    }

    destroy_player () {
        if (this.player) {
            if (typeof this.player.stop === 'function') {
                this.start_silence_frames()
                this.player.stop()
            }
            if (typeof this.player.destroy === 'function') {
                this.player.destroy()
            }
            this.player = undefined
        }
    }

    cleanup () {
        this.destroy_player()
    }

    destroy () {
        this.unsubscribe_all()
        this.destroy_player()

        if (this.silence_frames_interval) {
            clearInterval(this.silence_frames_interval)
            this.silence_frames_interval = undefined
        }
        this.removeAllListeners()
    }
}

export default TrackPlayer
