import EventEmitter from 'node:events'

import VoiceConnection from './VoiceConnection.js'
import AudioPlayer from 'sange'

// Assuming 'sodium' is correctly typed or use `require` if types are missing
import sodium from 'sodium'
import { UnplayableError, GenericError, InternalError, UnsupportedError } from './Error.js'
// Removed incorrect/unused import for @discordjs/voice types
import { YoutubeTrack } from './api/Youtube.js'
import { SpotifyTrack } from './api/Spotify.js'
import { SoundcloudTrack } from './api/Soundcloud.js'
import { AppleMusicTrack } from './api/AppleMusic.js'
import { FileTrack, FileStream } from './api/File.js' // Assuming FileStream is needed here based on usage
import { TrackStream } from './Track.js' // Import base TrackStream

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
// Define a type for the stream property, using the base class or specific types if known
// Note: Adjusted StreamType to better reflect potential properties based on usage
type StreamType = (TrackStream | FileStream) & { url?: string | null, isFile?: boolean, volume?: number }

class TrackPlayer extends EventEmitter {
    normalize_volume = false
    external_encrypt = false
    external_packet_send = false
    last_error = 0
    track?: trackTypes
    // FIX: Allow null for stream property type
    stream?: StreamType | null = undefined
    subscriptions: Subscription[] = []
    play_id = 0
    silence_frames_interval?: NodeJS.Timer
    silence_frames_left = 0
    silence_frames_needed = false
    player?: AudioPlayer // Keep AudioPlayer from 'sange'

    // Define event signatures more explicitly if possible
    override on (event: 'packet', callback: (packet: Uint8Array, frameSize: number) => void): this
    override on (event: 'finish', callback: () => void): this
    override on (event: 'error', callback: (error: Error) => void): this
    override on (event: 'ready', callback: () => void): this
    override on (event: 'debug', callback: (...args: any[]) => void): this // Add debug event if used
    override on (event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener)
    }

    // Define emit signatures more explicitly if possible
    override emit (event: 'packet', packet: Uint8Array, frameSize: number): boolean
    override emit (event: 'finish'): boolean
    override emit (event: 'error', error: Error): boolean
    override emit (event: 'ready'): boolean
    override emit (event: 'debug', ...args: any[]): boolean // Add debug event if used
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

        this.stream = undefined // Initialize as undefined
        this.subscriptions = []

        this.play_id = 0

        this.silence_frames_left = 0
        this.silence_frames_needed = false

        this.onstatechange = this.onstatechange.bind(this)
    }

    // Use status from the imported VoiceConnection class
    onstatechange (_old: any, cur: { status: number }) { // Assuming status is number from VoiceConnection.Status
        // Check if player exists before accessing its properties
        if (cur.status === VoiceConnection.Status.Ready) {
            this.init_secretbox()
        } else if (this.external_encrypt && this.external_packet_send && this.player?.ffplayer) {
            this.player.ffplayer.pipe() // Stop piping if not ready
        }
    }

    subscribe (connection: VoiceConnection) {
        if (this.external_encrypt) {
            if (this.subscriptions.length) { throw new UnsupportedError('Cannot subscribe to multiple connections when external encryption is enabled') }
            // Cast connection to any for .on
            (connection as any).on('stateChange', this.onstatechange)
        }

        const subscription = new Subscription(connection, this)

        this.subscriptions.push(subscription)

        // Attempt to init secretbox immediately if connection might already be ready
        this.init_secretbox()

        return subscription
    }

    unsubscribe (subscription: Subscription) {
        const index = this.subscriptions.indexOf(subscription)

        if (index === -1) { return }
        if (this.external_encrypt && this.subscriptions[index]) {
            // Cast connection to any for .removeListener
            (this.subscriptions[index].connection as any).removeListener('stateChange', this.onstatechange)
        }
        this.subscriptions.splice(index, 1)

        if (!this.subscriptions.length) { this.destroy() }
    }

    unsubscribe_all () {
        // Create a copy to avoid issues while iterating and modifying
        const subsCopy = [...this.subscriptions]
        for (const sub of subsCopy) {
            sub.unsubscribe()
        }
    }

    onpacket (packet: Uint8Array, length: number, frameSize: number) { // Assuming frameSize is number
        if (!this.isPaused()) { this.stop_silence_frames() }
        // Ensure packet is the correct slice/view after potential modifications
        const finalPacket = packet.length === length ? packet : new Uint8Array(packet.buffer, packet.byteOffset, length)

        if (!this.external_packet_send) { this.send(finalPacket, frameSize) }
        // Emit the potentially adjusted packet
        this.emit('packet', finalPacket, frameSize)
    }

    onfinish () {
        this.emit('finish')
        this.start_silence_frames()
    }

    onerror (error: any, code: any, retryable: boolean) { // Keep retryable boolean type
        if (this.error(error, retryable)) { return }
        if (this.track) { this.track.streams = undefined }
        // Check if player existed before trying to getTime
        const seekTime = this.player ? this.getTime() : 0
        this.create_player(seekTime)
        // Don't ignore promise rejection
        this.start().catch(startError => {
            this.emit('error', new GenericError(new Error(startError instanceof Error ? startError.message : String(startError ?? 'Failed to restart after error'))))
        })
    }

    secretbox_ready (): boolean {
        // Check connection status rigorously using VoiceConnection.Status enum
        return this.subscriptions.length > 0 && this.subscriptions[0].connection.state.status === VoiceConnection.Status.Ready
    }

    get_connection (): VoiceConnection {
        if (!this.subscriptions.length) {
            // Provide a more informative error
            throw new GenericError(new Error('TrackPlayer has no subscriptions, cannot get VoiceConnection'))
        }
        return this.subscriptions[0].connection
    }

    get_connection_data () {
        // Add checks to ensure state properties exist
        const state = this.get_connection().state
        // Check state status using VoiceConnection.Status enum
        if (state.status !== VoiceConnection.Status.Ready || !state.networking?.state?.connectionData) {
            throw new GenericError(new Error('Connection not ready or missing connection data'))
        }
        return state.networking.state.connectionData
    }

    get_connection_udp () {
        // Add checks to ensure state properties exist
        const state = this.get_connection().state
        // Check state status using VoiceConnection.Status enum
        if (state.status !== VoiceConnection.Status.Ready || !state.networking?.state?.udp) {
            throw new GenericError(new Error('Connection not ready or missing UDP information'))
        }
        return state.networking.state.udp
    }

    init_secretbox () {
        if (!this.external_encrypt || !this.player?.ffplayer) { return } // Check ffplayer exists
        if (this.secretbox_ready()) {
            try { // Wrap potential errors from get_connection_data/udp
                const connectionData = this.get_connection_data()
                const udp = this.get_connection_udp()
                let mode

                // Check encryptionMode exists
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

                // Ensure necessary properties exist on connectionData
                if (connectionData.secretKey === undefined || connectionData.ssrc === undefined || connectionData.sequence === undefined || connectionData.timestamp === undefined || connectionData.nonce === undefined) {
                    throw new Error('Missing required connection data properties for secret box')
                }

                this.player.ffplayer.setSecretBox(connectionData.secretKey, mode, connectionData.ssrc)
                this.player.ffplayer.updateSecretBox(connectionData.sequence, connectionData.timestamp, connectionData.nonce)

                // Check udp.remote properties exist
                if (this.external_packet_send) {
                    if (!udp?.remote?.ip || udp?.remote?.port === undefined) {
                        throw new Error('Missing UDP remote address or port')
                    }
                    this.player.ffplayer.pipe(udp.remote.ip, udp.remote.port)
                }
                // Set speaking needs to be handled carefully, might cause issues if called without audio
                // if (this.external_packet_send) { (this.get_connection() as any).setSpeaking(true); }
            } catch (e) {
                this.cleanup()
                // Wrap error
                this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Error setting secret box'))))
                return
            }

            return // Explicit return after successful setup
        }

        // Attempt to set empty secret box if not ready
        try {
            this.player.ffplayer.setSecretBox(new Uint8Array(32), EncryptionMode.NONE, 0) // Use NONE mode
        } catch (e) {
            this.cleanup()
            // Wrap error
            this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Error setting empty secret box'))))
        }

        // Stop piping if not ready
        if (this.external_packet_send && this.player?.ffplayer) {
            this.player.ffplayer.pipe()
        }
    }

    create_player (startTime?: number) {
        this.destroy_player() // Ensure previous player is stopped

        // @ts-expect-error - Runtime check for custom player property
        const CustomPlayer = this.track?.player // Get potential custom player constructor

        if (CustomPlayer && typeof CustomPlayer === 'function') {
            try {
                // eslint-disable-next-line new-cap
                this.player = new CustomPlayer(this.external_encrypt ? new Uint8Array(4096) : AUDIO_OUTPUT, false)
                if (typeof this.player?.setTrack !== 'function') {
                    throw new Error("Custom player instance missing 'setTrack' method")
                }
                this.player.setTrack(this.track) // Assuming setTrack exists
            } catch (e) {
                this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Failed to instantiate custom player'))))
                return
            }
        } else {
            try {
                // Ensure AudioPlayer constructor is valid
                if (typeof AudioPlayer !== 'function') {
                    throw new Error("'sange' AudioPlayer is not a constructor")
                }
                this.player = new AudioPlayer(this.external_encrypt ? new Uint8Array(4096) : AUDIO_OUTPUT, false)
            } catch (e) {
                this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Failed to instantiate sange AudioPlayer'))))
                return // Stop if player creation fails
            }
        }

        // Check if player and ffplayer were successfully created
        if (!this.player?.ffplayer) {
            this.emit('error', new GenericError(new Error('Failed to initialize ffplayer component')))
            this.player = undefined // Ensure player is undefined if ffplayer missing
            return
        }

        this.player.setOutput(2, 48000, 256000) // Assuming standard settings

        if (startTime && typeof startTime === 'number' && startTime > 0) {
            this.player.seek(startTime)
        }
        // Bind events safely
        this.player.ffplayer.onready = this.emit.bind(this, 'ready')
        this.player.ffplayer.onpacket = this.onpacket.bind(this)
        this.player.ffplayer.onfinish = this.onfinish.bind(this)
        this.player.ffplayer.onerror = this.onerror.bind(this)
        this.player.ffplayer.ondebug = this.emit.bind(this, 'debug')

        this.init_secretbox() // Initialize after setting up player
    }

    async load_streams (): Promise<boolean> { // Return boolean promise
        let streams; const playId = this.play_id

        // Ensure track and getStreams method exist
        if (!this.track?.getStreams) {
            this.emit('error', new GenericError(new Error('Current track is missing getStreams method')))
            return false
        }

        // Check streams exist and are not expired (if streams object has expired method)
        // Ensure streams object itself exists before checking expired()
        if (this.track.streams && typeof this.track.streams.expired === 'function' && !this.track.streams.expired()) {
            streams = this.track.streams
        } else {
            try {
                streams = await this.track.getStreams()
                if (this.play_id !== playId) { return false } // Check playId again after await
                // Validate streams object
                if (!streams || typeof streams !== 'object') {
                    throw new Error('getStreams returned invalid data')
                }
                this.track.streams = streams
            } catch (error) {
                if (this.play_id === playId) { // Emit only if still the same playback attempt
                    // Ensure error is an Error object
                    const err = error instanceof Error ? error : new Error(String(error ?? 'Failed to get streams'))
                    this.emit('error', err)
                }
                return false // Return false on error
            }
        }

        // Validate streams is an array-like structure before passing to get_best_stream
        if (!Array.isArray(streams)) {
            this.emit('error', new GenericError(new Error('Streams data is not an array')))
            return false
        }

        // FIX: Assign result which is StreamType | null
        this.stream = this.get_best_stream(streams)

        if (!this.stream) {
            this.emit('error', new UnplayableError('No suitable stream found'))
            return false
        }

        // If stream URL is missing, try to resolve it
        // (Check if stream is not null before accessing url)
        if (this.stream && !this.stream.url) {
            // Ensure stream and getUrl method exist
            if (!this.stream.getUrl || typeof this.stream.getUrl !== 'function') {
                this.emit('error', new GenericError(new Error('Stream object missing getUrl method')))
                return false
            }
            try {
                // Assign result of getUrl and coalesce null to undefined so that url is string or undefined
                const result = await this.stream.getUrl()
                this.stream.url = result ?? undefined
                if (this.play_id !== playId) { return false } // Check playId again after await
                // Validate the resolved URL
                if (typeof this.stream.url !== 'string') {
                    throw new Error('getUrl resolved to an invalid type or null')
                }
            } catch (error) {
                if (this.play_id === playId) {
                    const err = error instanceof Error ? error : new Error(String(error ?? 'Failed to get stream URL'))
                    this.emit('error', err)
                }
                // Invalidate the stream if URL resolution failed
                this.stream = null
                return false
            }
        }

        return true // Streams loaded successfully
    }

    send (buffer: Buffer | Uint8Array, frameSize: number, isSilence?: boolean) {
        const subscriptions = this.subscriptions

        for (const connection of subscriptions.map(sub => sub.connection)) { // Iterate over connections directly
            // Use VoiceConnection.Status enum
            if (connection.state.status !== VoiceConnection.Status.Ready) { continue }

            try {
                // Cast connection to any
                (connection as any).setSpeaking(true)
            } catch (speakError) {
                console.warn('Failed to set speaking state:', speakError)
            }

            const networking = connection.state.networking // Get networking object
            // Check if networking and its state exist
            if (!networking?.state) continue

            const connectionData = networking.state.connectionData
            const udp = networking.state.udp

            // Check connectionData and udp exist
            if (!connectionData || !udp) continue

            let mode = connectionData.encryption_mode

            if (this.external_encrypt && !isSilence) {
                // Ensure buffer is Buffer for udp.send if required
                const packetToSend = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
                udp.send(packetToSend)
                continue
            }

            // Determine encryption mode if not cached
            if (!mode) {
                // Ensure encryptionMode exists before switch
                if (typeof connectionData.encryptionMode !== 'string') continue

                switch (connectionData.encryptionMode) {
                    case 'xsalsa20_poly1305_lite': mode = EncryptionMode.LITE; break
                    case 'xsalsa20_poly1305_suffix': mode = EncryptionMode.SUFFIX; break
                    default: mode = EncryptionMode.DEFAULT; break
                }
                connectionData.encryption_mode = mode // Cache the mode
            }

            // Ensure required properties exist before proceeding
            if (connectionData.sequence === undefined || connectionData.timestamp === undefined || connectionData.ssrc === undefined || connectionData.secretKey === undefined) {
                console.warn('Missing connection data for packet encryption')
                continue
            }

            connectionData.sequence++
            connectionData.timestamp += frameSize

            // Handle wrap-around
            if (connectionData.sequence > 65535) { connectionData.sequence = 0 }
            if (connectionData.timestamp > 4294967295) { connectionData.timestamp = 0 }

            // Write header to AUDIO_BUFFER
            AUDIO_BUFFER.writeUInt16BE(connectionData.sequence, 2) // Use UInt16BE for sequence
            AUDIO_BUFFER.writeUInt32BE(connectionData.timestamp, 4)
            AUDIO_BUFFER.writeUInt32BE(connectionData.ssrc, 8)

            let len = 12 /* header length */
            const audioPayload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer) // Ensure payload is Buffer

            try { // Wrap crypto operations in try-catch
                switch (mode) {
                    case EncryptionMode.LITE:
                        connectionData.nonce = (connectionData.nonce ?? 0) + 1 // Initialize nonce if needed
                        if (connectionData.nonce > 4294967295) { connectionData.nonce = 0 }
                        CONNECTION_NONCE.writeUInt32BE(connectionData.nonce, 0)
                        // Use Buffer for output of crypto_secretbox_easy
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
                        // Ensure AUDIO_NONCE is correctly sized if needed, default assumes 24
                        AUDIO_BUFFER.copy(AUDIO_NONCE, 0, 0, 12) // Copy header part to nonce
                        len += sodium.crypto_secretbox_easy(AUDIO_BUFFER.subarray(12), audioPayload, AUDIO_NONCE, connectionData.secretKey)
                        break
                }
                udp.send(AUDIO_BUFFER.subarray(0, len))
            } catch (cryptoError) {
                console.error('Encryption/Send error:', cryptoError)
                // Handle error, maybe disconnect or emit error state
            }
        }
    }

    start_silence_frames () {
        if (!this.silence_frames_needed || this.silence_frames_interval) { return }
        this.silence_frames_needed = false

        // Check readiness before accessing connection data
        if (this.player && this.external_encrypt && this.secretbox_ready()) {
            try { // Wrap potential errors
                // Ensure ffplayer exists
                if (!this.player.ffplayer) throw new Error('ffplayer not available')
                const box = this.player.ffplayer.getSecretBox()
                const data = this.get_connection_data()
                // Ensure box properties exist
                if (box.nonce === undefined || box.timestamp === undefined || box.sequence === undefined) {
                    throw new Error('Invalid secret box state from player')
                }
                data.nonce = box.nonce
                data.timestamp = box.timestamp
                data.sequence = box.sequence
            } catch (e) {
                console.error('Error restoring secret box state:', e)
                // Decide how to handle this error - potentially stop silence frames
                return
            }
        }

        this.silence_frames_interval = setInterval(() => {
            this.silence_frames_left--

            this.send(SILENCE, 960, true) // Assuming 960 is correct frame size for silence

            // Check readiness before accessing connection data
            if (this.player && this.external_encrypt && this.secretbox_ready()) {
                try { // Wrap potential errors
                    // Ensure ffplayer exists
                    if (!this.player.ffplayer) throw new Error('ffplayer not available')
                    const data = this.get_connection_data()
                    // Ensure data properties exist
                    if (data.sequence === undefined || data.timestamp === undefined || data.nonce === undefined) {
                        throw new Error('Missing connection data for secret box update')
                    }
                    this.player.ffplayer.updateSecretBox(data.sequence, data.timestamp, data.nonce)
                } catch (e) {
                    console.error('Error updating secret box state:', e)
                    // Decide how to handle this error - potentially stop interval
                    if (this.silence_frames_interval) {
                        clearInterval(this.silence_frames_interval as NodeJS.Timeout) // Cast interval
                        this.silence_frames_interval = undefined
                    }
                    return // Stop this interval iteration
                }
            }

            if (!this.silence_frames_left) {
                if (this.silence_frames_interval) {
                    // Cast interval to NodeJS.Timeout
                    clearInterval(this.silence_frames_interval as NodeJS.Timeout)
                    this.silence_frames_interval = undefined
                }
            }
        }, 20) // 20ms interval
    }

    stop_silence_frames () {
        if (this.silence_frames_needed) { return } // Already stopping or stopped
        if (this.silence_frames_interval) {
            // Cast interval to NodeJS.Timeout
            clearInterval(this.silence_frames_interval as NodeJS.Timeout)
            this.silence_frames_interval = undefined
        }
        // Set state for needing silence frames only if not already set
        this.silence_frames_needed = true
        this.silence_frames_left = 5 // Reset count
    }

    error (error: any, retryable?: boolean): boolean { // Return boolean consistently
        // Check if retryable is explicitly false or if error interval exceeded
        if (retryable === false || (Date.now() - this.last_error < ERROR_INTERVAL)) {
            this.destroy_player() // Stop playback
            // Wrap error, ensure it's an Error object
            const err = error instanceof Error ? error : new Error(String(error ?? 'Unknown playback error'))
            // Pass the wrapped error to InternalError
            // FIX: Remove unused @ts-expect-error
            this.emit('error', new InternalError(err))

            return true // Indicate error was fatal/handled
        }

        this.last_error = Date.now()
        return false // Indicate error might be retryable
    }

    get_best_stream_one (streams: TrackStream[]): TrackStream | null { // Add type hint
        if (!Array.isArray(streams) || !streams.length) return null

        const opus: TrackStream[] = []
        const audio: TrackStream[] = []
        const other: TrackStream[] = []

        for (const stream of streams) {
            // Basic validation of stream object
            if (!stream || typeof stream !== 'object') continue

            if (stream.video) { // Assumes 'video' property exists
                other.push(stream)
                continue
            }

            // Check codecs property exists before comparison
            if (stream.codecs === 'opus') { opus.push(stream) } else { audio.push(stream) }
        }

        const candidates: TrackStream[] = opus.length ? opus : (audio.length ? audio : other)
        if (!candidates.length) { return null }

        // Ensure bitrate is a number for comparison, default to 0 if missing/invalid
        candidates.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        return candidates[0] // Return the highest bitrate
    }

    // Ensure streams parameter is correctly typed if possible (e.g., TrackStreams from './Track.js')
    get_best_stream (streams: TrackStream[]): StreamType | null { // Return type should match this.stream
        if (!Array.isArray(streams)) return null

        // Access volume safely, assuming it might be on the array object
        const volume = (streams as any).volume

        const audioStreams = streams.filter((stream) => stream?.audio) // Filter for audio streams safely
        // Access default_audio_track safely
        // FIX: Remove unused @ts-expect-error
        let result = this.get_best_stream_one(audioStreams.filter((stream) => (stream as any)?.default_audio_track))

        if (!result) { result = this.get_best_stream_one(audioStreams) }

        // Add volume back to the result if found and volume exists
        if (result && volume !== undefined) {
            // Use the added optional volume property (assuming fix in Track.ts was applied)
            result.volume = volume
        }
        // Cast result to StreamType before returning
        return result as StreamType | null
    }

    play (track: trackTypes) {
        this.play_id++
        if (this.play_id > MAX_PLAY_ID) { this.play_id = 0 } // Handle wrap-around

        this.last_error = 0
        this.stream = undefined // Reset stream to undefined
        this.track = track // Set new track

        this.create_player() // Create player for the new track
        // Start playback immediately after creating player
        this.start().catch(startError => {
            this.emit('error', new GenericError(new Error(startError instanceof Error ? startError.message : String(startError ?? `Failed to start playback for track ${track.id}`))))
        })
    }

    async start () {
        // Check if already destroyed or no track set
        if (!this.player || !this.track) { return }

        if (!await this.load_streams()) {
            // Error should have been emitted by load_streams
            console.log('load_streams failed, not starting player.') // Add log
            return
        }
        // Check again if destroyed during await or stream loading failed
        if (!this.player || !this.stream) {
            console.log('Player destroyed or stream missing after load_streams.') // Add log
            return
        }

        // Apply volume normalization if enabled and stream has volume info
        // Check stream exists and volume is number (using the added optional property)
        if (this.normalize_volume && this.stream && typeof this.stream.volume === 'number') {
            this.player.setVolume(this.stream.volume)
        }

        try {
            // Ensure stream URL and isFile are valid before passing
            const url = this.stream.url
            // Access isFile safely
            const isFile = !!this.stream.isFile // Coerce to boolean
            if (typeof url !== 'string' || !url) {
                throw new Error('Invalid stream URL provided to setURL')
            }
            this.player.setURL(url, isFile)
            await this.player.start()
        } catch (e) {
            // Wrap error
            this.emit('error', new GenericError(new Error(e instanceof Error ? e.message : String(e ?? 'Error starting player'))))
        }
    }

    check_destroyed () {
        // Use GenericError consistent with other throws
        if (!this.player) { throw new GenericError(new Error('Player was destroyed or nothing was playing')) }
    }

    hasPlayer (): boolean {
        return !!this.player // Use boolean coercion
    }

    isPaused (): boolean {
        this.check_destroyed()
        // Ensure player has isPaused method
        return typeof this.player?.isPaused === 'function' ? this.player.isPaused() : false
    }

    setPaused (paused = true): void { // Default to true
        this.check_destroyed()
        // Ensure player has setPaused method
        if (typeof this.player?.setPaused === 'function') {
            if (paused) { this.start_silence_frames() }
            this.player.setPaused(paused) // Pass boolean directly
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
            this.start_silence_frames() // Send silence before seeking
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
        // Check ffplayer exists before accessing its method
        return typeof this.player?.ffplayer?.isCodecCopy === 'function' ? this.player.ffplayer.isCodecCopy() : false
    }

    stop (): void {
        // Check player exists before calling stop
        if (this.player && typeof this.player.stop === 'function') {
            this.start_silence_frames() // Send silence frames before stopping
            this.player.stop()
        }
    }

    destroy_player () {
        if (this.player) {
            // Ensure stop method exists before calling
            if (typeof this.player.stop === 'function') {
                this.start_silence_frames() // Send silence before destroying
                this.player.stop() // Stop playback first
            }
            // Ensure destroy method exists
            if (typeof this.player.destroy === 'function') {
                this.player.destroy()
            }
            this.player = undefined // Use undefined instead of null for consistency
        }
    }

    cleanup () {
        this.destroy_player()
        // Add any other specific cleanup logic here
    }

    destroy () {
        this.unsubscribe_all() // Ensure all subscriptions are removed first
        this.destroy_player() // Destroy the player if it exists

        // Clear silence interval if it's running
        if (this.silence_frames_interval) {
            // Cast interval to NodeJS.Timeout
            clearInterval(this.silence_frames_interval as NodeJS.Timeout)
            this.silence_frames_interval = undefined
        }
        // Clean up event listeners on this emitter itself
        this.removeAllListeners()
    }
}

export default TrackPlayer
