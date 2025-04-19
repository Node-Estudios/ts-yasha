import Request from '../Request.js'
import Youtube from './Youtube.js'

import { Track, TrackImage, TrackResults, TrackPlaylist } from '../Track.js'
import { InternalError, NetworkError, NotFoundError, ParseError } from 'js-common'

export class AppleMusicTrack extends Track {
    artists?: string[]
    explicit?: boolean
    declare platform: 'AppleMusic'
    constructor () {
        super('AppleMusic')
    }

    gen_image (url: { replaceAll: (arg0: string, arg1: number) => { (): any, new(): any, replaceAll: { (arg0: string, arg1: number): string, new(): any } } }, artist?: boolean) {
        const dim = artist ? 220 : 486

        return [new TrackImage(url.replaceAll('{w}', dim).replaceAll('{h}', dim).replaceAll('{c}', artist ? 'sr' : 'bb').replaceAll('{f}', 'webp'), dim, dim)]
    }

    from (track: { relationships: { artists: { data: any[] } }, id: string, attributes: { name: string, durationInMillis: number, artwork: { url: { replaceAll: (arg0: string, arg1: number) => { (): any, new(): any, replaceAll: { (arg0: string, arg1: number): string, new(): any } } } }, contentRating: string } }) {
        let icon

        for (const artist of track.relationships.artists.data) {
            if (artist.attributes.artwork) { icon = this.gen_image(artist.attributes.artwork.url, true) }
        }
        this.artists = track.relationships.artists.data.map(artist => artist.attributes.name)
        this.setOwner(this.artists.join(', '), icon)
        this.setMetadata(track.id, track.attributes.name, track.attributes.durationInMillis / 1000, this.gen_image(track.attributes.artwork.url))

        this.explicit = track.attributes.contentRating === 'explicit'

        return this
    }

    async fetch () {
        return await api.get(this.id ?? '')
    }

    async getStreams () {
        return await Youtube.track_match(this)
    }

    get url () {
        return 'https://music.apple.com/song/' + this.id
    }
}

export class AppleMusicResults extends TrackResults {
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

export class AppleMusicPlaylist extends TrackPlaylist {
    declare platform: 'AppleMusic'
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
        if (this.type === 'playlists') { return 'https://music.apple.com/playlist/' + this.id }
        return 'https://music.apple.com/album/' + this.id
    }
}

export class AppleMusicAPI {
    token: string | null
    reloading: Promise<void> | null
    needs_reload: boolean

    Track = AppleMusicTrack
    Results = AppleMusicResults
    Playlist = AppleMusicPlaylist
    constructor () {
        this.token = null
        this.reloading = null
        this.needs_reload = false
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
        const { body } = await Request.get('https://music.apple.com/us/browse')
        let config = /<meta name="desktop-music-app\/config\/environment" content="(.*?)">/.exec(body)

        if (!config) { throw new InternalError('Missing config') }
        try {
            config = JSON.parse(decodeURIComponent(config[1]))
        } catch (e) {
            throw new InternalError(e)
        }

        // @ts-expect-error
        if (!config?.MEDIA_API?.token) { throw new InternalError('Missing token') }
        // @ts-expect-error
        this.token = config.MEDIA_API.token
    }

    async prefetch () {
        if (!this.token) { void this.reload() }
        if (this.reloading) { return await this.reloading }
    }

    async api_request (path: string, query: { [key: string]: any } = {}, options: { [key: string]: any } = {}) {
        let res; let body; const queries = []; let q = ''

        // Line 147
        if (!res?.ok) { throw new InternalError(body ?? 'API request failed and returned no error body') }
        if (queries.length) { q = '?' + queries.join('&') } else { q = '' }
        if (!options.headers) { options.headers = {} }
        for (let tries = 0; tries < 2; tries++) {
            await this.prefetch()

            options.headers.authorization = `Bearer ${this.token ?? ''}`
            options.headers.origin = 'https://music.apple.com'
            res = (await Request.getResponse(`https://amp-api.music.apple.com/v1/catalog/us/${path}${q}`, options)).res

            if (res.status === 401) {
                if (tries) { throw new InternalError('Unauthorized') }
                await this.reload()

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

        if (res?.status === 404) { throw new NotFoundError('API resource not found') } // Added message
        if (!res?.ok) { throw new InternalError(body) }
        try {
            body = JSON.parse(body ?? '')
        } catch (e) {
            throw new ParseError(e)
        }

        return body
    }

    check_valid_id (id: string) {
        if (!/^[\d]+$/.test(id)) { throw new NotFoundError('Invalid Apple Music ID format') } // Added message
    }

    async get (id: string) {
        this.check_valid_id(id)

        const track = await this.api_request('songs/' + id, {
            'fields[artists]': 'url,name,artwork,hero',
            'include[songs]': 'artists',
            extend: 'artistUrl',
            'art[url]': 'c,f',
        })

        try {
            return new AppleMusicTrack().from(track.data[0])
        } catch (e) {
            throw new InternalError(e)
        }
    }

    async get_streams (id: string) {
        return await Youtube.track_match(await this.get(id))
    }

    get_next (url: string, param: string) {
        const purl = new URL(url, 'https://amp-api.music.apple.com')
        const num = parseInt(purl.searchParams.get(param) ?? '0')

        if (!Number.isFinite(num)) { throw new InternalError('Invalid next') }
        return num
    }

    async search (query: string, offset = 0, limit = 25) {
        const data = await this.api_request('search', {
            groups: 'song',
            offset,
            limit,
            l: 'en-US',
            term: query,
            platform: 'web',
            types: 'activities,albums,apple-curators,artists,curators,editorial-items,music-movies,music-videos,playlists,songs,stations,tv-episodes,uploaded-videos,record-labels',
            'include[songs]': 'artists',
            'relate[editorial-items]': 'contents',
            'include[editorial-items]': 'contents',
            'include[albums]': 'artists',
            extend: 'artistUrl',
            'fields[artists]': 'url,name,artwork,hero',
            'fields[albums]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,name,playParams,releaseDate,url',
            with: 'serverBubbles,lyricHighlights',
            'art[url]': 'c,f',
            'omit[resource]': 'autos',
        })

        const results = new AppleMusicResults()
        const song = data.results.song

        if (!song) { return results }
        try {
            if (song.next) { results.set_continuation(query, this.get_next(song.next, 'offset')) }
            for (const result of song.data) { results.push(new AppleMusicTrack().from(result)) }
        } catch (e) {
            throw new InternalError(e)
        }

        return results
    }

    async list_once (type: string, id: string, offset = 0, limit = 100) {
        this.check_valid_playlist_id(id)

        const result = new AppleMusicPlaylist()
        let playlist

        if (!offset) {
            playlist = await this.api_request(`${type}/${id}`, {
                l: 'en-us',
                platform: 'web',
                views: 'featured-artists,contributors',
                extend: 'artistUrl,trackCount,editorialVideo,editorialArtwork',
                include: 'tracks',
                'include[playlists]': 'curator',
                'include[songs]': 'artists',
                'fields[artists]': 'name,url,artwork',
                'art[url]': 'c,f',
            })

            playlist = playlist.data[0]
        } else {
            playlist = await this.api_request(`${type}/${id}/tracks`, {
                l: 'en-us',
                platform: 'web',
                offset,
                limit,
                'include[songs]': 'artists',
                'fields[artists]': 'name,url,artwork',
            })
        }

        result.set(type, id)

        try {
            if (!offset) {
                result.setMetadata(playlist.attributes.name, playlist.attributes.description?.standard)
                id = playlist.id
                playlist = playlist.relationships.tracks
            }

            for (const item of playlist.data) { result.push(new AppleMusicTrack().from(item)) }
            if (playlist.next) { result.set_continuation(this.get_next(playlist.next, 'offset')) }
        } catch (e) {
            throw new InternalError(e)
        }

        return result
    }

    check_valid_playlist_id (id: string) {
        // eslint-disable-next-line no-useless-escape
        if (!/^[\w\.-]+$/.test(id)) { throw new NotFoundError('Invalid Apple Music Playlist/Album ID format') } // Added message
    }

    async playlist_once (id: string, offset?: number, length?: number) {
        return await this.list_once('playlists', id, offset, length)
    }

    async album_once (id: string, offset: number, length: number) {
        return await this.list_once('albums', id, offset, length)
    }

    async list (type: string, id: string, limit: number) {
        let list: AppleMusicPlaylist | null = null
        let offset = 0

        do {
            const result = await this.list_once(type, id, offset)

            if (!list) {
                list = result
            } else {
                // Use push with spread syntax to append items
                list.push(...result)
                // Only update continuation if result.start is a valid number
                if (result.start !== undefined) {
                    list.set_continuation(result.start)
                }
            }
            // Use ?? 0 to ensure offset is always a number (or becomes 0 if undefined)
            offset = result.start ?? 0
            // eslint-disable-next-line no-unmodified-loop-condition
        } while (offset !== undefined && offset > 0 && (!limit || (list && list.length < limit)))

        return list
    }

    async playlist (id: string, length: number) {
        return await this.list('playlists', id, length)
    }

    async album (id: string, length: number) {
        return await this.list('albums', id, length)
    }
}
const api = new AppleMusicAPI()

export default api
