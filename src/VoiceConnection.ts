// @ts-expect-error
import { VoiceConnectionStatus, VoiceConnectionDisconnectReason, VoiceConnection as VoiceConnectionBase, JoinConfig } from '@discordjs/voice'
import { GatewayVoiceStateUpdateDispatchData, Guild, VoiceChannel } from 'discord.js'
import { GenericError } from 'js-common'

export type YashaGuild = Guild & { voice_connection?: VoiceConnection }
export default class VoiceConnection extends VoiceConnectionBase {
    guild: YashaGuild
    timeout: NodeJS.Timeout | null = null
    connected: boolean = false
    promise: any
    promise_reject: any
    promise_resolve: any
    static Status = VoiceConnectionStatus

    constructor (channel: VoiceChannel, options: JoinConfig) {
        super({
            ...options,
            channelId: channel.id,
            guildId: channel.guild.id,
        }, { adapterCreator: channel.guild.voiceAdapterCreator })

        this.guild = channel.guild
        this.guild.voice_connection = this
        // this.connect_timeout = null
        // this.connected = false

        this.await_connection().catch(() => {})
        // @ts-expect-error
        this._state.status = VoiceConnectionStatus.Ready
        // @ts-expect-error
        if (super.rejoin()) { this._state.status = VoiceConnectionStatus.Signalling }
    }

    rejoin_id (channelId: string) {
        // @ts-expect-error
        if (this.joinConfig.channelId !== channelId) { super.rejoin({ channelId }) }
    }

    // @ts-expect-error
    override rejoin (channel: VoiceChannel) {
        if (channel.guild.id !== this.guild.id) { throw new GenericError('Channel is not in the same guild') }
        if (!channel.joinable) { throw new GenericError(channel.full ? 'Channel is full' : 'No permissions') }
        this.rejoin_id(channel.id)
    }

    static disconnect_reason (reason: VoiceConnectionDisconnectReason) {
        switch (reason) {
            case VoiceConnectionDisconnectReason.AdapterUnavailable:
                return 'Adapter unavailable'
            case VoiceConnectionDisconnectReason.EndpointRemoved:
                return 'Endpoint removed'
            case VoiceConnectionDisconnectReason.WebSocketClose:
                return 'WebSocket closed'
            case VoiceConnectionDisconnectReason.Manual:
                return 'Manual disconnect'
        }
    }

    ready () {
        return this.state.status === VoiceConnectionStatus.Ready
    }
    // @ts-expect-error
    override addStatePacket (packet: GatewayVoiceStateUpdateDispatchData) {

        if (!packet.channel_id) { this.destroy() } else { super.addStatePacket(packet) }
    }
    // @ts-expect-error
    override onNetworkingError (error: any) {
        if (this.promise) { this.promise_reject(error) } else {
            // @ts-expect-error
            this.emit('error', error)
            this.destroy()
        }
    }

    handle_state_change (state: { status: any, reason: VoiceConnectionDisconnectReason }) {
        switch (state.status) {
            case VoiceConnectionStatus.Destroyed:
                this.promise_reject(new GenericError('Connection destroyed'))

                break
            case VoiceConnectionStatus.Disconnected:
                this.promise_reject(new GenericError(VoiceConnection.disconnect_reason(state.reason)))

                break
            case VoiceConnectionStatus.Ready:
                this.promise_resolve()

                this.state.networking.state.ws.sendPacket({
                    op: 15, /* MEDIA_SINK_WANTS */
                    d: {
                        // @ts-expect-error
                        any: this.joinConfig.receiveAudio === false ? 0 : 100,
                    },
                })

                break
        }
    }

    // @ts-expect-error
    override set state (state) {
        if (state.status !== this.state.status) {
            if (this.promise) { this.handle_state_change(state) } else if (state.status === VoiceConnectionStatus.Disconnected) {
                if (state.reason === VoiceConnectionDisconnectReason.WebSocketClose) { void this.await_connection() } else { this.destroy(state.reason !== VoiceConnectionDisconnectReason.AdapterUnavailable) }
            }
        }

        super.state = state
    }
    // @ts-expect-error
    override get state () {
        // @ts-expect-error
        return this._state
    }
    // @ts-expect-error
    override destroy (adapterAvailable = true) {
        if (this.state.status === VoiceConnectionStatus.Destroyed) { return }
        if (adapterAvailable) {
            // @ts-expect-error
            this._state.status = VoiceConnectionStatus.Destroyed

            /* remove the subscription */
            this.state = {
                status: VoiceConnectionStatus.Destroyed,
                adapter: this.state.adapter,
            }

            // @ts-expect-error
            this._state.status = VoiceConnectionStatus.Disconnected

            super.disconnect()
        }

        if (this.guild.voice_connection === this) { this.guild.voice_connection = undefined } else { console.warn('Voice connection mismatch') }
        this.state = { status: VoiceConnectionStatus.Destroyed }
    }
    // @ts-expect-error
    override disconnect () {
        this.destroy()
        return true
    }

    async await_connection () {
        if (this.state.status === VoiceConnectionStatus.Ready || this.promise) { return }
        this.promise = new Promise((resolve, reject) => {
            this.promise_resolve = resolve
            this.promise_reject = reject
        })

        this.timeout = setTimeout(() => {
            this.timeout = null
            this.promise_reject(new GenericError('Connection timed out'))
        }, 15000)

        try {
            await this.promise

            this.connected = true
        } catch (e) {
            // @ts-expect-error
            if (this.connected) { this.emit('error', new GenericError(e)) }
            this.destroy()
        } finally {
            clearTimeout(this.timeout)

            this.timeout = null
            this.promise = null
            this.promise_resolve = null
            this.promise_reject = null
        }
    }

    static async connect (channel: VoiceChannel, options: Partial<JoinConfig> = {}) {
        if (!channel.joinable) { throw new GenericError(channel.full ? 'Channel is full' : 'No permissions') }
        let connection = (channel.guild as YashaGuild).voice_connection


        if (!connection) { connection = new VoiceConnection(channel, options) } else { connection.rejoin_id(channel.id) }
        if (connection.ready()) { return connection }
        void connection.await_connection()

        await connection.promise

        return connection
    }

    static get (guild: YashaGuild) {
        return guild.voice_connection
    }

    static disconnect (guild: YashaGuild, options: Partial<JoinConfig>) {
        if (guild.voice_connection) {
            guild.voice_connection.disconnect()

            return true
        }

        if (!guild.members.me?.voice.channel) { return false }
        const { rejoin, disconnect } = VoiceConnectionBase.prototype

        const dummy = {
            state: {
                status: VoiceConnectionStatus.Ready,
                adapter: guild.voiceAdapterCreator({
                    onVoiceServerUpdate () {},
                    onVoiceStateUpdate () {},
                    destroy () {},
                }),
            },

            joinConfig: {
                guildId: guild.id,
                channelId: guild.members.me.voice.channel.id,
                ...options,
            },
        }

        if (!rejoin.call(dummy)) { throw new GenericError(this.disconnect_reason(VoiceConnectionDisconnectReason.AdapterUnavailable)) }
        dummy.state.status = VoiceConnectionStatus.Ready

        if (!disconnect.call(dummy)) { throw new GenericError(this.disconnect_reason(VoiceConnectionDisconnectReason.AdapterUnavailable)) }
        return true
    }
}
