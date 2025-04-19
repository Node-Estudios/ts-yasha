import Request from '../Request.js'
// Import Response type from node-fetch
import { type Response } from 'node-fetch'

import { Track, TrackImage, TrackResults, TrackPlaylist, TrackStream, TrackStreams } from '../Track.js'
import { UnplayableError, NotATrackError } from '../Error.js'
import { InternalError, NetworkError, NotFoundError, ParseError } from 'js-common'

export class SoundcloudTrack extends Track {
    declare platform: 'Soundcloud'
    permalink_url?: string
    constructor () {
        super('Soundcloud')
    }

    // Adjusted signature slightly for consistency
    from (track: { permalink_url: any, user: { username: string, avatar_url: any }, id: string, title: string, duration: number, artwork_url?: any, media?: any }) {
        this.permalink_url = track.permalink_url

        const streams = new SoundcloudStreams().from(track)

        if (streams.length) { this.setStreams(streams) }
        return this.setOwner(
            track.user.username,
            // Pass object directly if avatar_url is the only icon source used here
            // Ensure URL is string and provide fallback
            [{ url: String(track.user.avatar_url || ''), width: 0, height: 0 }],
        ).setMetadata(
            String(track.id), // Ensure ID is string
            track.title,
            track.duration / 1000,
            // Pass the result of get_thumbnails directly
            TrackImage.from(this.get_thumbnails(track)), // Pass necessary parts of track object
        )
    }

    // Adjusted signature to only take necessary parts
    get_thumbnails (track: { artwork_url?: any, user?: { avatar_url?: any } }) {
        const sizes = [20, 50, 120, 200, 500]
        const visualSizes = [[1240, 260], [2480, 520]]

        // Ensure defaultThumbnail is treated as string, provide fallback
        const defaultThumbnail: string = String(track.artwork_url || track.user?.avatar_url || '')
        const multires = /^.*\/(\w+)-([-a-zA-Z0-9]+)-([a-z0-9]+)\.(jpg|png|gif).*$/i.exec(defaultThumbnail)

        // Explicitly type the array
        const thumbnails: Array<{ url: string, width: number, height: number }> = []

        if (multires) {
            const type = multires[1]
            const size = multires[3]

            if (type === 'visuals') {
                for (const sz of visualSizes) {
                    // Push correctly typed object
                    thumbnails.push({
                        width: sz[0],
                        height: sz[1],
                        // Ensure URL is string
                        url: defaultThumbnail.replace(size, 't' + sz[0] + 'x' + sz[1]),
                    })
                }
            } else {
                for (const sz of sizes) {
                    let rep
                    if (type === 'artworks' && sz === 20) { rep = 'tiny' } else { rep = 't' + sz + 'x' + sz }
                    // Push correctly typed object
                    thumbnails.push({
                        width: sz,
                        height: sz,
                        // Ensure URL is string
                        url: defaultThumbnail.replace(size, rep),
                    })
                }
            }
        } else if (defaultThumbnail) { // Only push if defaultThumbnail exists
            /* default image */
            // Push correctly typed object
            thumbnails.push({
                url: defaultThumbnail, // Already ensured it's a string
                width: 0,
                height: 0,
            })
        }

        return thumbnails
    }

    async fetch () {
        return await api.get(this.id ?? '')
    }

    async getStreams () {
        return await api.get_streams(this.id ?? '')
    }

    get url () {
        return this.permalink_url
    }
}

export class SoundcloudResults extends TrackResults {
    query?: string
    start?: number
    set_continuation (query: string, start: number) {
        this.query = query
        this.start = start
    }

    override async next () {
        // Use ?? 0 to ensure start is a number
        return await api.search(this.query ?? '', this.start ?? 0)
    }
}

export class SoundcloudPlaylist extends TrackPlaylist {
    declare platform: 'Soundcloud'
    permalink_url?: string
    id?: string
    start?: number
    from (list: { permalink_url: any, title: string, description: string }) {
        this.permalink_url = list.permalink_url
        this.setMetadata(list.title, list.description)

        return this
    }

    set_continuation (id?: string, start?: number) {
        this.id = id
        this.start = start
    }

    override get url () {
        return this.permalink_url
    }

    override async next () {
        if (this.id) { return await api.playlist_once(this.id, this.start) }
        return null
    }
}

export class SoundcloudStream extends TrackStream {
    stream_url: string
    constructor (url: string) {
        super(url)

        this.stream_url = url
    }

    override async getUrl () {
        const body = await api.request(this.stream_url)

        if (body?.url) { return body.url }
        throw new UnplayableError('No stream url found')
    }
}

export class SoundcloudStreams extends TrackStreams {
    // Adjusted signature
    from (track: { media?: { transcodings?: any[] } }) {
        if (track.media?.transcodings) {
            this.set(1, false, Date.now()) // Assuming default volume 1, not live
            this.extract_streams(track.media.transcodings)
        }

        return this
    }

    extract_streams (streams: Array<{ format: { mime_type: string }, url: string, duration: number }>) {
        for (const stream of streams) {
            // Provide default empty array for destructuring fallback
            const [, container, codecs] = /audio\/([a-zA-Z0-9]{3,4})(?:;(?:\+| )?codecs="(.*?)")?/.exec(stream.format.mime_type) ?? []
            const finalContainer = container
            let finalCodecs = codecs

            if (finalContainer === 'mpeg' && !finalCodecs) { finalCodecs = 'mp3' }

            // Ensure container and codecs are strings or null before passing
            this.push(
                new SoundcloudStream(stream.url)
                    .setDuration(stream.duration / 1000)
                    .setBitrate(-1) // Default bitrate
                    .setTracks(false, true) // Assuming audio only
                    .setMetadata(finalContainer ?? null, finalCodecs ?? null), // Pass null if undefined
            )
        }
    }

    override expired () {
        return false
    }

    override maybeExpired () {
        return false
    }
}

export class SoundcloudAPI {
    client_id: string

    Track = SoundcloudTrack
    Results = SoundcloudResults
    Playlist = SoundcloudPlaylist
    constructor () {
        // Consider making this configurable or fetching dynamically if possible
        this.client_id = 'YOUR_SOUNDCLOUD_CLIENT_ID' // Replace with actual ID
    }

    async request (path: string, query: { [key: string]: any } = {}) {
        // Type 'res' with the imported Response type
        let body: string | undefined
        let queries: string[] = []
        query.client_id = this.client_id
        queries = []
        for (const name in query) {
            // Ensure query values are properly encoded
            queries.push(encodeURIComponent(name) + '=' + encodeURIComponent(query[name]))
        }
        // Ensure Request.getResponse exists and handles potential errors
        const responseData = await Request.getResponse(path + '?' + queries.join('&'))
        const res: Response | undefined = responseData.res // Get Response object

        if (!res) {
            throw new NetworkError('Failed to get response object')
        }

        try {
            body = await res.text()
        } catch (e) {
            // Check res status before assuming InternalError vs NetworkError
            if (!res.ok) { throw new InternalError(e instanceof Error ? e.message : String(e)) }
            throw new NetworkError(e instanceof Error ? e.message : String(e))
        }

        // Added message for clarity
        if (res.status === 404) { throw new NotFoundError('Soundcloud resource not found') }
        if (!res.ok) {
            // Use ?? for safety when passing body to error
            throw new InternalError(body ?? 'Soundcloud request failed and returned no error body')
        }
        try {
            // Use ?? for safety when passing body to JSON.parse
            const parsedBody = JSON.parse(body ?? '')
            return parsedBody
        } catch (e) {
            throw new ParseError(e instanceof Error ? e.message : String(e))
        }
    }

    async api_request (path: string, query?: { [key: string]: any }) {
        return await this.request('https://api-v2.soundcloud.com/' + path, query)
    }

    // Adjusted signature for limit type
    async resolve_playlist (list: { tracks?: any[], id?: any, permalink_url: any, title: string, description: string }, offset = 0, limit?: number | null) {
        let unresolvedIndex = -1
        const tracks = new SoundcloudPlaylist()

        // Check if list and list.tracks exist and are an array
        if (!list || typeof list !== 'object' || !Array.isArray(list.tracks)) { throw new InternalError('Invalid list structure received') }
        if (offset === 0) { tracks.from(list) }
        // Ensure offset is not out of bounds
        if (offset >= list.tracks.length) { return tracks } // Return tracks object if offset is beyond length (it might have metadata)

        try {
            // Use optional chaining for safety
            for (let i = offset; i < list.tracks.length; i++) {
                if (list.tracks[i]?.streamable === undefined) {
                    unresolvedIndex = i
                    break
                }
                // Ensure track data is valid before calling 'from'
                if (list.tracks[i]) {
                    tracks.push(new SoundcloudTrack().from(list.tracks[i]))
                }
            }
        } catch (e) {
            // FIX: Wrap message in new Error()
            const errMsg = e instanceof Error ? e.message : String(e)
            throw new InternalError(new Error(errMsg ?? 'Error resolving playlist tracks'))
        }

        // Define resolvedLimit carefully based on input limit and list length
        let resolvedLimit: number
        if (limit === undefined || limit === null || limit <= 0) {
            resolvedLimit = list.tracks.length // Fetch all if no limit
        } else {
            // Fetch up to 'limit' *additional* tracks starting from 'offset'
            resolvedLimit = Math.min(offset + limit, list.tracks.length)
        }

        while (unresolvedIndex !== -1 && unresolvedIndex < resolvedLimit) {
            // Fetch in batches of 50 or fewer if remaining count is less
            const batchSize = Math.min(50, resolvedLimit - unresolvedIndex)
            const ids = list.tracks.slice(unresolvedIndex, unresolvedIndex + batchSize)
                .map(track => track?.id) // Use optional chaining
                .filter(id => id !== undefined) // Filter out undefined IDs

            if (!ids.length) break // Stop if no valid IDs to fetch

            const body = await this.api_request('tracks', { ids: ids.join(',') })

            try {
                // Ensure body is an array before proceeding
                if (!Array.isArray(body)) { break }
                if (!body.length) { break }
                for (const track of body) {
                    // Ensure track data is valid before calling 'from'
                    if (track) {
                        tracks.push(new SoundcloudTrack().from(track))
                    }
                }
                unresolvedIndex += body.length // Increment by the number of tracks actually processed
            } catch (e) {
                // FIX: Wrap message in new Error()
                const errMsg = e instanceof Error ? e.message : String(e)
                throw new InternalError(new Error(errMsg ?? 'Error processing fetched playlist tracks'))
            }
        }
        // Set continuation based on the number of tracks *added* in this call relative to the initial offset
        const tracksAddedCount = tracks.length - (offset === 0 ? tracks.length : list.tracks.slice(0, offset).filter(t => t?.streamable !== undefined).length) // Count initially present tracks if offset > 0
        const nextOffset = offset + tracksAddedCount
        if (nextOffset < list.tracks.length && (unresolvedIndex === -1 || unresolvedIndex < list.tracks.length)) { // Only set continuation if more tracks exist
            tracks.set_continuation(list.id, nextOffset)
        }

        return tracks
    }

    async resolve (url: string) {
        const body = await this.api_request('resolve', { url: encodeURIComponent(url) })

        if (body.kind === 'track') {
            try {
                return new SoundcloudTrack().from(body)
            } catch (e) {
                throw new InternalError(e instanceof Error ? e.message : String(e))
            }
        } else if (body.kind === 'playlist') {
            // Pass a default limit or make it configurable
            return await this.resolve_playlist(body, 0, 50) // Example limit
        } else {
            throw new NotATrackError('Unsupported kind: ' + body.kind)
        }
    }

    async resolve_shortlink (id: string) {
        // Keep body/location as let, use const for res within loop scope
        let body: string | undefined, location: URL | string
        let url: string = 'https://on.soundcloud.com/' + encodeURIComponent(id)

        for (let redirects = 0; redirects < 5; redirects++) {
            const responseData = await Request.getResponse(url, { redirect: 'manual' })
            // Use const and the imported Response type
            const res: Response | undefined = responseData.res

            if (!res) {
                throw new NetworkError('Failed to get response for shortlink')
            }

            try {
                body = await res.text()
            } catch (e) {
                if (!res.ok) { throw new InternalError(e instanceof Error ? e.message : String(e)) }
                throw new NetworkError(e instanceof Error ? e.message : String(e))
            }

            // Added message
            if (res.status === 404) { throw new NotFoundError('Soundcloud shortlink resource not found') }
            // Use ?? on body for InternalError
            if (res.status !== 302 || !res.headers.has('Location')) { throw new InternalError(body ?? 'Shortlink redirect failed or missing Location header') }
            location = res.headers.get('Location') ?? ''

            try {
                // Ensure base URL is correct if location is relative
                location = new URL(location, url)
            } catch (e) {
                throw new ParseError('Invalid redirect URL: ' + String(location)) // Ensure location is stringified
            }

            url = location.href

            if (location.hostname === 'soundcloud.com' && location.pathname.startsWith('/') && location.pathname.length > 1) {
                return await this.resolve(url)
            }
        }

        throw new ParseError('Too many redirects')
    }

    check_valid_id (id: string) {
        // Added message
        if (!/^[\d]+$/.test(id)) { throw new NotFoundError('Invalid Soundcloud ID format') }
    }

    async get (id: string) {
        this.check_valid_id(id)

        const body = await this.api_request('tracks/' + id)

        let track

        try {
            track = new SoundcloudTrack().from(body)
        } catch (e) {
            throw new InternalError(e instanceof Error ? e.message : String(e))
        }

        // Check if streams were successfully added in 'from'
        if (!track.streams || track.streams.length === 0) { throw new UnplayableError('No streams found') }
        return track
    }

    async get_streams (id: string) {
        this.check_valid_id(id)

        const body = await this.api_request('tracks/' + id)

        let streams

        try {
            streams = new SoundcloudStreams().from(body)
        } catch (e) {
            throw new InternalError(e instanceof Error ? e.message : String(e))
        }

        if (!streams.length) { throw new UnplayableError('No streams found') }
        return streams
    }

    async search (query: string, offset: number, limit = 20) {
        const body = await this.api_request('search/tracks', { q: query, limit, offset }) // No need to double-encode query

        try {
            const results = new SoundcloudResults()

            // Ensure body.collection is an array
            if (!Array.isArray(body?.collection)) {
                return results // Return empty results if collection is missing/invalid
            }

            for (const item of body.collection) {
                // Ensure item is valid before processing
                if (item) {
                    results.push(new SoundcloudTrack().from(item))
                }
            }
            // Only set continuation if tracks were actually added and a full page likely returned
            if (results.length > 0 && body.collection.length === limit) {
                results.set_continuation(query, offset + results.length)
            }
            return results
        } catch (e) {
            throw new InternalError(e instanceof Error ? e.message : String(e))
        }
    }

    // Adjusted signature for limit type
    async playlist_once (id: string, offset = 0, limit?: number | null) {
        this.check_valid_id(id)

        // Sticking to original logic for now:
        const body = await this.api_request('playlists/' + id)

        // Pass the intended limit to resolve_playlist
        return await this.resolve_playlist(body, offset, limit ?? 50)
    }

    async playlist (id: string, limit?: number) {
        // Pass limit correctly
        return await this.playlist_once(id, 0, limit)
    }
}
const api = new SoundcloudAPI()

export default api
