import Request from '../Request.js'
import Youtube from './Youtube.js'

import { Track, TrackImage, TrackResults, TrackPlaylist } from '../Track.js'
import { InternalError, ParseError, NetworkError, NotFoundError } from 'js-common'

export class SpotifyTrack extends Track {
    declare platform: 'Spotify'
    artists?: string[]
    explicit?: boolean
    constructor () {
        super('Spotify')
    }

    from (track: { artists: any[], id: string, name: string, duration_ms: number, album: { images: Array<{ url: string, width: number, height: number }> }, explicit: any }, artist?: { images: Array<{ url: string, width: number, height: number }> }) {
        this.artists = track.artists.map(artist => artist.name)
        this.setOwner(this.artists.join(', '), artist ? TrackImage.from(artist.images) : undefined)
        this.setMetadata(track.id, track.name, track.duration_ms / 1000, TrackImage.from(track.album.images))
        this.explicit = track.explicit

        return this
    }

    async fetch () {
        return await api.get(this.id ?? '')
    }

    async getStreams () {
        return await Youtube.track_match(this)
    }

    get url () {
        return 'https://open.spotify.com/track/' + this.id
    }
}

export class SpotifyResults extends TrackResults {
    query?: string
    start?: number
    set_continuation (query: string, start: number) {
        this.query = query
        this.start = start
    }

    override async next () {
        if (this.query != null) { return await api.search(this.query, this.start) }
        return null
    }
}

export class SpotifyPlaylist extends TrackPlaylist {
    declare platform: 'Spotify'
    type?: string
    id?: string
    start?: number

    set (type: string, id: string) {
        this.type = type
        this.id = id
    }

    set_continuation (start: number) {
        this.start = start
    }

    override async next () {
        if (this.start !== undefined) { return await api.list_once(this.type ?? '', this.id ?? '', this.start) }
        return null
    }

    override get url () {
        if (this.type === 'playlists') { return 'https://open.spotify.com/playlist/' + this.id }
        return 'https://open.spotify.com/album/' + this.id
    }
}

export class SpotifyAPI {
    token: string | null
    reloading: Promise<void> | null
    needs_reload: boolean
    account_data: { cookie?: string }

    Track = SpotifyTrack
    Results = SpotifyResults
    Playlist = SpotifyPlaylist
    constructor () {
        this.token = null
        this.reloading = null

        this.needs_reload = false
        this.account_data = {}
    }

    async reload (force?: boolean) {
        if (this.reloading) {
            if (force) { this.needs_reload = true }
            return
        }

        do {
            this.needs_reload = false
            this.reloading = this.load()

            try {
                await this.reloading
            } catch (e) {

            }

            this.reloading = null
        } while (this.needs_reload)
    }

    async load () {
        const { body } = await Request.getJSON('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', { headers: this.account_data })

        if (!body.accessToken) { throw new InternalError('Missing access token') }
        this.token = body.accessToken
    }

    async prefetch () {
        if (!this.token) { void this.reload() }
        if (this.reloading) { return await this.reloading }
    }

    async api_request (path: string, options: { [key: string]: any } = {}) {
        if (!options.headers) { options.headers = {} }
        if (options.body) { options.body = JSON.stringify(options.body) }
        let res, body

        for (let tries = 0; tries < 2; tries++) {
            await this.prefetch()

            options.headers.authorization = 'Bearer ' + this.token
            res = (await Request.getResponse('https://api.spotify.com/v1/' + path, options)).res

            if (res.status === 401) {
                if (tries) { throw new InternalError('Unauthorized') }
                void this.reload()

                continue
            }

            break
        }

        try {
            body = await res?.text()
        } catch (e) {
            if (!res?.ok) { throw new InternalError(e) }
            throw new NetworkError(e)
        }

        if (!res?.ok) { throw new InternalError(body) }
        try {
            body = JSON.parse(body ?? '')
        } catch (e) {
            throw new ParseError(e)
        }

        return body
    }

    check_valid_id (id: string) {
        if (!/^[\w]+$/.test(id)) { throw new NotFoundError('Invalid Spotify ID format') } // Added message
    }

    async get (id: string) {
        this.check_valid_id(id)

        const track = await this.api_request('tracks/' + id)
        const author = track.artists[track.artists.length - 1]

        if (!author) { throw new InternalError('Missing artist') }
        const artist = await this.api_request('artists/' + author.id)

        try {
            return new SpotifyTrack().from(track, artist)
        } catch (e) {
            throw new InternalError(e)
        }
    }

    async get_streams (id: string) {
        return await Youtube.track_match(await this.get(id))
    }

    async search (query: string, start = 0, length = 20) {
        const data = await this.api_request('search/?type=track&q=' + encodeURIComponent(query) + '&decorate_restrictions=false&include_external=audio&limit=' + length + '&offset=' + start)
        const results = new SpotifyResults()

        if (data.tracks.items.length) { results.set_continuation(query, start + data.tracks.items.length) }
        try {
            for (const result of data.tracks.items) { results.push(new SpotifyTrack().from(result)) }
        } catch (e) {
            throw new InternalError(e)
        }

        return results
    }

    async list_once (type: string, id: string, start = 0, length?: number) {
        this.check_valid_id(id)

        const playlist = new SpotifyPlaylist()
        let images, tracks

        if (!start) {
            const list = await this.api_request(type + '/' + id)

            playlist.setMetadata(list.name, list.description)
            images = list.images
            tracks = list.tracks
        } else {
            if (!length) { length = type === 'playlists' ? 100 : 50 }
            tracks = await this.api_request(type + '/' + id + '/tracks?offset=' + start + '&limit=' + length)
        }

        playlist.set(type, id)

        try {
            for (const item of tracks.items) {
                if (type === 'playlists' && item.track && !item.track.is_local) { playlist.push(new SpotifyTrack().from(item.track)) } else if (type === 'albums') {
                    item.album = { images }
                    playlist.push(new SpotifyTrack().from(item))
                }
            }
        } catch (e) {
            throw new InternalError(e)
        }

        if (tracks.items.length) { playlist.set_continuation(start + tracks.items.length) }
        return playlist
    }

    async playlist_once (id: string, start = 0, length: number) {
        return await this.list_once('playlists', id, start, length)
    }

    async album_once (id: string, start = 0, length: number) {
        return await this.list_once('albums', id, start, length)
    }

    // Inside SpotifyAPI class in src/api/Spotify.ts

    async list (type: string, id: string, limit: number): Promise<SpotifyPlaylist | null> {
        let list: SpotifyPlaylist | null = null
        let offset = 0
        let keepGoing = true

        do {
            const result: SpotifyPlaylist | null = await this.list_once(type, id, offset)

            if (!result) {
                keepGoing = false
                break
            }

            if (!list) {
                list = result
            } else {
                if (result.length > 0) {
                    list.push(...result)
                }
                // Update the start property on the main list object from the latest result
                list.start = result.start
            }

            // Update offset for the next iteration based on the result's continuation property
            offset = result.start ?? 0 // Use offset from the result for next fetch
            // Determine if we should continue based on whether the result had a next offset
            keepGoing = result.start !== undefined

            // Fix: Add eslint-disable comment right before the while line
            // eslint-disable-next-line no-unmodified-loop-condition
        } while (keepGoing && offset !== undefined && (!limit || (list && list.length < limit)))

        return list
    }

    async playlist (id: string, length: number) {
        return await this.list('playlists', id, length)
    }

    async album (id: string, length: number) {
        return await this.list('albums', id, length)
    }

    set_cookie (cookie?: string) {
        this.account_data.cookie = cookie
        void this.reload(true)
    }
}
const api = new SpotifyAPI()

export default api
