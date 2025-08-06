import crypto from 'node:crypto'
import Request from '../Request.js'

import { UnplayableError, ParseError, NotFoundError, InternalError, NetworkError } from '../Error.js'
import { Track, TrackImage, TrackResults, TrackPlaylist, TrackStream, TrackStreams } from '../Track.js'
import { genPlaylistContinuation, genSearchOptions, playlistNextOffset } from '../../proto/youtube.js'

function getProperty (array: any[], prop: string): any | null { // Added explicit return type
    if (!Array.isArray(array)) { return null }
    for (const item of array) {
        if (item?.[prop]) { return item[prop] }
    }
    return null
}

function text (txt?: { simpleText?: any, runs?: Array<{ text: any }> }): string {
    if (!txt) { return '' }
    if (txt.simpleText) { return txt.simpleText }
    if (txt.runs && txt.runs.length > 0 && txt.runs[0].text) { return txt.runs[0].text } // Check text exists
    return ''
}

function checkPlayable (st: { status: string, reason?: string } | undefined): void { // Allow reason to be optional, explicit void
    if (!st?.status) { return } // Use optional chaining

    const { status, reason } = st

    switch (status.toLowerCase()) {
        case 'ok':
            return
        case 'error':
            if (reason === 'Video unavailable') { throw new NotFoundError('Video unavailable') } // Pass arg
            break
        case 'unplayable':
            throw new UnplayableError(reason ?? status) // Use nullish coalescing, pass arg
        case 'login_required':
            throw new UnplayableError('Video is age restricted') // Pass arg
        case 'content_check_required':
            throw new UnplayableError('Content check required') // Pass arg
        case 'age_check_required':
            throw new UnplayableError('Age check required') // Pass arg
        default:
            throw new UnplayableError(reason ?? status) // Use nullish coalescing, pass arg
    }
}

function number (n: string | number): number {
    const parsed = parseInt(`${n}`, 10)
    if (Number.isFinite(parsed)) { return parsed }
    return 0
}

function parseTimestamp (str: string | undefined): number {
    if (!str) return -1
    const tokens = str.split(':').map(token => parseInt(token))
    const scale = [1, 60, 3600, 86400]
    let seconds = 0

    if (tokens.length > scale.length || tokens.some(isNaN)) { return -1 } // Added isNaN check

    for (let i = tokens.length - 1; i >= 0; i--) {
        seconds += tokens[i] * scale[Math.min(3, tokens.length - i - 1)]
    }

    return seconds
}

function youtubeThumbnails (videoId: string): TrackImage[] { // Added return type
    // Ensure TrackImage constructor matches its definition
    return [new TrackImage(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, 320, 180)]
}

export class YoutubeTrack extends Track {
    declare platform: 'Youtube'
    explicit = false
    constructor () {
        super('Youtube')
    }

    from (videoDetails: { videoId?: string, title?: string, lengthSeconds?: string | number }, author: { title?: { simpleText?: any, runs?: Array<{ text: any }> }, thumbnail?: { thumbnails: Array<{ url: string, width: number, height: number }> } } | undefined, streams: TrackStreams): this {
        const videoId = videoDetails?.videoId
        const title = videoDetails?.title ?? ''
        const lengthSeconds = videoDetails?.lengthSeconds ?? 0

        if (!videoId) {
            console.warn('YoutubeTrack.from: Missing videoId')
            return this
        }

        return this.setOwner(
            text(author?.title),
            author?.thumbnail?.thumbnails ? TrackImage.from(author.thumbnail.thumbnails) : undefined,
        ).setMetadata(
            videoId,
            title,
            number(lengthSeconds),
            youtubeThumbnails(videoId),
        ).setStreams(
            streams,
        )
    }

    from_search (track: any): this {
        let thumbnails
        if (track?.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails) {
            thumbnails = track.channelThumbnailSupportedRenderers.channelThumbnailWithLinkRenderer.thumbnail.thumbnails
        } else if (track?.channelThumbnail?.thumbnails) {
            thumbnails = track.channelThumbnail.thumbnails
        }

        const ownerName = text(track?.shortBylineText)
        const trackTitle = text(track?.title)
        const duration = parseTimestamp(track?.lengthText?.simpleText)
        const videoId = track?.videoId

        if (!videoId) {
            console.warn('Track missing videoId in from_search:', track)
            return this
        }

        return this.setOwner(
            ownerName,
            thumbnails ? TrackImage.from(thumbnails) : undefined,
        ).setMetadata(
            videoId, // Use non-null assertion as we checked above
            trackTitle,
            duration,
            youtubeThumbnails(videoId), // Use non-null assertion
        )
    }

    from_playlist (track: any): this {
        const ownerName = text(track?.shortBylineText)
        const trackTitle = text(track?.title)
        const videoId = track?.videoId
        const duration = number(track?.lengthSeconds)
        const playable = !!track?.isPlayable

        if (!videoId) {
            console.warn('Track missing videoId in from_playlist:', track)
            return this
        }

        return this.setOwner(
            ownerName,
            // icons are usually not available here, pass undefined
        ).setMetadata(
            videoId,
            trackTitle,
            duration,
            youtubeThumbnails(videoId),
        ).setPlayable(playable)
    }

    async fetch (): Promise<Track> {
        if (!this.id) throw new InternalError('Cannot fetch track without ID') // Add check
        return await api.get(this.id) as Track
    }

    async getStreams (): Promise<TrackStreams> {
        if (!this.id) throw new InternalError('Cannot get streams for track without ID') // Add check
        return await api.get_streams(this.id)
    }

    get url (): string {
        return 'https://https://www.youtube.com/watch?v=' + (this.id ?? '') // Handle potentially missing id
    }
}

export class YoutubeResults extends TrackResults {
    continuation?: string

    process (body: any[]): void { // Explicit void return
        if (!Array.isArray(body)) return

        for (const item of body) {
            if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
                this.set_continuation(item.continuationItemRenderer.continuationEndpoint.continuationCommand.token)
            } else if (item?.itemSectionRenderer?.contents) {
                this.extract_tracks(item.itemSectionRenderer.contents)
            }
        }
    }

    extract_tracks (list: any): void { // Explicit void return
        if (!Array.isArray(list)) return

        for (const video of list) {
            if (video?.videoRenderer) {
                const track = new YoutubeTrack().from_search(video.videoRenderer)
                if (track.id) {
                    this.push(track)
                }
            }
        }
    }

    set_continuation (cont: any): void { // Explicit void return
        if (typeof cont === 'string') {
            this.continuation = cont
        }
    }

    override async next (): Promise<TrackResults | null> {
        if (this.continuation) {
            return await api.search(null, this.continuation)
        }
        return null
    }
}

export class YoutubePlaylist extends TrackPlaylist {
    declare platform: 'Youtube'
    id?: string
    next_offset?: number
    declare firstTrack?: YoutubeTrack // More specific type

    process (id: string, data: any, _offset: number): void {
        this.id = id

        if (!Array.isArray(data)) return

        for (const item of data) {
            if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
                this.next_offset = playlistNextOffset(item.continuationItemRenderer.continuationEndpoint.continuationCommand.token)
            } else if (item?.playlistVideoRenderer) {
                const track = new YoutubeTrack().from_playlist(item.playlistVideoRenderer)
                if (track.id) {
                    this.push(track)
                }
            }
        }
    }

    override async next (): Promise<TrackPlaylist | null> {
        if (this.next_offset !== undefined && this.id) {
            return await api.playlist_once(this.id, this.next_offset)
        }
        return null
    }

    override get url (): string {
        // No need to cast if firstTrack is typed as YoutubeTrack above
        const firstTrackUrl = this.firstTrack?.url

        if (firstTrackUrl && this.id) {
            return firstTrackUrl + '&list=' + this.id
        }
        return 'https://https://www.youtube.com/playlist?list=' + (this.id ?? '') // Handle potentially missing id
    }
}

export class YoutubeStream extends TrackStream {
    itag: number
    default_audio_track?: boolean

    constructor (url: string, itag: any) {
        super(url)
        this.itag = Number(itag)
    }

    override equals (other: TrackStream): boolean {
        return !!(other instanceof YoutubeStream && this.itag && this.itag === other.itag)
    }
}

export class YoutubeStreams extends TrackStreams {
    expire?: number

    from (start: number, playerResponse: any): this {
        let loudness = 0

        if (playerResponse?.playerConfig?.audioConfig?.loudnessDb) {
            loudness = playerResponse.playerConfig.audioConfig.loudnessDb
        }

        const streamingData = playerResponse?.streamingData ?? {}
        const { formats = [], adaptiveFormats = [], expiresInSeconds = '0' } = streamingData
        const isLive = playerResponse?.videoDetails?.isLive ?? false

        // Use optional chaining for this.live check
        if (!this?.live && Array.isArray(formats)) {
            this.extract_streams(formats, false)
        }
        if (Array.isArray(adaptiveFormats)) {
            this.extract_streams(adaptiveFormats, true)
        }
        this.expire = start + parseInt(expiresInSeconds, 10) * 1000
        this.set(Math.min(1, Math.pow(10, -loudness / 20)), isLive, start)

        return this
    }

    override expired (): boolean {
        return Date.now() > (this.expire ?? 0)
    }

    extract_streams (streams: any, adaptive: boolean): void {
        if (!Array.isArray(streams)) return

        for (const fmt of streams) {
            if (fmt.type === 'FORMAT_STREAM_TYPE_OTF' || !fmt.url || !fmt.itag) { continue }
            const stream = new YoutubeStream(fmt.url, fmt.itag)

            const approxDurationMs = parseInt(fmt.approxDurationMs, 10)
            const targetDurationSec = Number(fmt.targetDurationSec)

            if (this?.live && adaptive && !isNaN(targetDurationSec)) { // Use optional chaining
                stream.setDuration(targetDurationSec)
            } else if (!isNaN(approxDurationMs)) {
                stream.setDuration(approxDurationMs / 1000)
            }

            const mimeType = fmt.mimeType ?? ''
            const mime = /(video|audio)\/([a-zA-Z0-9]{3,4});(?:\+| )codecs="(.*?)"/.exec(mimeType)

            if (!mime) { continue }
            const [, mediaType, container, codecs] = mime

            if (!adaptive) { stream.setTracks(true, true) } else if (mediaType === 'video') { stream.setTracks(true, false) } else { stream.setTracks(false, true) }

            stream.setBitrate(Number(fmt.bitrate ?? -1))
            stream.setMetadata(container, codecs)
            stream.default_audio_track = !!fmt.audioTrack?.audioIsDefault

            this.push(stream)
        }
    }
}

export class YoutubeMusic {
    innertube_client: {
        clientName: string
        clientVersion: string
        gl: string
        hl: string
    }

    innertube_key: string
    constructor () {
        this.innertube_client = {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20220328.01.00',
            gl: 'US',
            hl: 'en',
        }

        this.innertube_key = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
    }

    get cookie () {
        return api.cookie
    }

    get sapisid () {
        return api.sapisid
    }

    async api_request (path: string, body?: { [key: string]: any }, query?: string): Promise<any> {
        // Fix: Remove await
        return api.api_request.call(this, path, body, query, 'music')
    }

    async search (search: string | null, continuation: string | null, params?: string): Promise<YoutubeMusicResults> {
        let query: string | undefined
        let requestBody: { [key: string]: any } | undefined

        if (continuation) {
            query = '&continuation=' + encodeURIComponent(continuation) + '&type=next'
        } else {
            requestBody = { query: search, params }
        }

        const responseBody = await this.api_request('search', requestBody, query)
        let processedBody: any

        if (continuation) {
            processedBody = responseBody?.continuationContents?.musicShelfContinuation
            if (!processedBody) { throw new NotFoundError('Search continuation token not found or invalid response structure') }
        } else {
            processedBody = responseBody?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
            if (!processedBody) { throw new InternalError('Invalid search response structure') }
            if (params) { processedBody = getProperty(processedBody, 'musicShelfRenderer') }
        }

        const results = new YoutubeMusicResults()

        try {
            results.process(processedBody)
        } catch (e) {
            throw new InternalError(e instanceof Error ? e.message : String(e))
        }

        return results
    }
}
const music = new YoutubeMusic()

export class YoutubeAPI {
    innertube_client: {
        clientName: string
        clientVersion: string
        gl: string
        hl: string
    }

    innertube_key: string
    cookie: string = ''
    sapisid: string = ''
    Music = music
    Track = YoutubeTrack
    YoutubeResults = YoutubeResults
    YoutubePlaylist = YoutubePlaylist

    constructor () {
        this.innertube_client = {
            clientName: 'WEB',
            clientVersion: '2.20220918',
            gl: 'US',
            hl: 'en',
        }
        this.innertube_key = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
    }

    async api_request (path: string, body: { [key: string]: any } = {}, query = '', origin = 'www'): Promise<any> {
        let time = Date.now()
        // Fix: Use Headers object API
        const headers = new Headers({ Origin: `https://${origin}.youtube.com` })
        const options: RequestInit = { headers }

        body.context = { client: { ...this.innertube_client } }
        options.method = 'POST'

        if (path === 'player') {
            body.params = '2AMBCgIQBg'
            body.contentCheckOk = true
            body.racyCheckOk = true
            body.context.client.clientName = 'ANDROID'
            body.context.client.clientVersion = '18.15.35'
            body.context.client.androidSdkVersion = 33
            headers.set('User-Agent', 'com.google.android.youtube/18.15.35') // Use headers.set
        }

        if (this.sapisid) {
            time = Math.floor(time / 1000)
            const hash = crypto.createHash('sha1').update(`${time} ${this.sapisid} https://${origin}.youtube.com`).digest('hex')
            headers.set('Authorization', 'SAPISIDHASH ' + time + '_' + hash) // Use headers.set
            headers.set('Cookie', this.cookie) // Use headers.set
        }

        options.body = JSON.stringify(body)

        const url = `https://${origin}.youtube.com/youtubei/v1/${path}?key=${this.innertube_key}${query}&prettyPrint=false` // Corrected base URL and path structure

        const { res } = await Request.getResponse(url, options)
        let responseBodyText: string

        try {
            responseBodyText = await res.text()
        } catch (e) {
            if (!res.ok) { throw new InternalError(e instanceof Error ? e.message : String(e)) }
            throw new NetworkError(e instanceof Error ? e.message : String(e))
        }

        if (res.status >= 400 && res.status < 500) { throw new NotFoundError(responseBodyText) }
        if (!res.ok) { throw new InternalError(responseBodyText) }

        try {
            const parsedBody = JSON.parse(responseBodyText)
            return parsedBody as { [key: string]: any }
        } catch (e) {
            throw new ParseError(e instanceof Error ? e.message : String(e))
        }
    }

    async get (id: string): Promise<YoutubeTrack> {
        const start = Date.now()
        let responses: [any, any]

        try {
            responses = await Promise.all([
                this.api_request('next', { videoId: id }),
                this.api_request('player', { videoId: id }),
            ])
        } catch (e) {
            // Make NotFoundError require an argument
            if (e instanceof NotFoundError) { throw new NotFoundError({ simpleMessage: 'Video not found', error: e }) }
            throw e
        }

        const [response, playerResponse] = responses

        if (!response || !playerResponse) { throw new InternalError('Missing data') }
        checkPlayable(playerResponse.playabilityStatus)

        const videoDetails = playerResponse?.videoDetails
        if (!videoDetails) throw new InternalError('Missing videoDetails')

        try {
            const ownerRenderer = getProperty(response?.contents?.twoColumnWatchNextResults?.results?.results?.contents, 'videoSecondaryInfoRenderer')?.owner?.videoOwnerRenderer
            if (!ownerRenderer) throw new InternalError('Could not extract author information')

            const streams = new YoutubeStreams().from(start, playerResponse)
            if (!streams) throw new InternalError('Could not extract streams')

            return new YoutubeTrack().from(videoDetails, ownerRenderer, streams)
        } catch (e) {
            throw new InternalError(`Error processing video details: ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    async get_streams (id: string): Promise<YoutubeStreams> {
        const start = Date.now()
        const playerResponse = await this.api_request('player', { videoId: id })

        if (!playerResponse) { throw new InternalError('Missing data') }
        checkPlayable(playerResponse.playabilityStatus)

        try {
            const streams = new YoutubeStreams().from(start, playerResponse)
            if (!streams) throw new InternalError('Could not extract streams')
            return streams
        } catch (e) {
            throw new InternalError(`Error processing streams: ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    async playlist_once (id: string, start = 0): Promise<YoutubePlaylist> {
        const results = new YoutubePlaylist()
        const data = await this.api_request('browse', { continuation: genPlaylistContinuation(id, start) })

        if (!data?.onResponseReceivedActions && !data?.contents) {
            if (start === 0) {
                const initialData = await this.api_request('browse', { browseId: `VL${id}` })
                if (initialData?.sidebar) {
                    const details = getProperty(initialData.sidebar.playlistSidebarRenderer.items, 'playlistSidebarPrimaryInfoRenderer')
                    results.setMetadata(text(details?.title), text(details?.description))
                    const initialItems = initialData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents
                    if (initialItems) {
                        results.process(id, initialItems, start)
                        const continuation = initialData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.continuations?.[0]?.nextContinuationData?.continuation
                        if (continuation) results.next_offset = playlistNextOffset(continuation)
                    }
                    return results
                }
            }
            // Make NotFoundError require an argument
            throw new NotFoundError('Playlist not found or invalid response')
        }

        try {
            const continuationItems = data?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems
            if (continuationItems) {
                const details = getProperty(data?.sidebar?.playlistSidebarRenderer?.items, 'playlistSidebarPrimaryInfoRenderer')
                if (details && start === 0) {
                    results.setMetadata(text(details.title), text(details.description))
                }
                results.process(id, continuationItems, start)
            } else if (start === 0 && data?.contents) {
                const initialItems = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents
                if (initialItems) {
                    results.process(id, initialItems, start)
                    const continuation = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.continuations?.[0]?.nextContinuationData?.continuation
                    if (continuation) results.next_offset = playlistNextOffset(continuation)
                }
            }
        } catch (e) {
            throw new InternalError(`Error processing playlist data: ${e instanceof Error ? e.message : String(e)}`)
        }

        return results
    }

    async playlist (id: string, limit?: number): Promise<YoutubePlaylist | null> {
        let list: YoutubePlaylist | null = null
        // Fix: Removed unused variable
        let currentResult: YoutubePlaylist | null = null
        let offset: number | undefined = 0

        do {
            try {
                if (offset === undefined) break
                currentResult = await this.playlist_once(id, offset)

                if (!list) {
                    list = currentResult
                } else if (currentResult?.length) {
                    list.push(...currentResult)
                    list.next_offset = currentResult.next_offset // Keep list object updated
                }
                offset = currentResult?.next_offset // Update offset from the latest result
            } catch (e) {
                console.error(`Error fetching playlist page for ID ${id} at offset ${offset}:`, e)
                // Fix: Ensure no code follows break;
                break // Stop pagination on error
            }
        // Fix: Ensure eslint disable comment is exactly on the line above while
        // eslint-disable-next-line no-unmodified-loop-condition
        } while (offset !== undefined && (!limit || (list && list.length < limit)))

        return list
    }

    async search (query: string | null, continuation?: any): Promise<YoutubeResults> {
        const responseBody = await this.api_request('search', continuation
            ? { continuation }
            : {
                query,
                params: genSearchOptions({
                    type: 'video',
                    sort: 'relevance',
                    duration: 'short',
                }),
            })

        let itemsToProcess: any

        if (continuation) {
            itemsToProcess = responseBody?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems
            if (!itemsToProcess) { throw new NotFoundError('Search continuation token not found or invalid response structure') }
        } else {
            itemsToProcess = responseBody?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents
            if (!itemsToProcess) { throw new InternalError('Invalid search response structure') }
        }

        const results = new YoutubeResults()

        try {
            results.process(itemsToProcess)
        } catch (e) {
            throw new InternalError(`Error processing search results: ${e instanceof Error ? e.message : String(e)}`)
        }

        return results
    }

    set_cookie (cookiestr?: string): void {
        if (!cookiestr) {
            this.cookie = ''
            this.sapisid = ''
            return
        }

        const cookies = cookiestr.split(';')
        let sapisid: string | null = null

        for (const cookie of cookies) {
            const parts = cookie.trim().split('=')
            if (parts.length >= 2) {
                const key = parts[0]
                const value = parts[1]
                if (key === '__Secure-3PAPISID' || key === 'SAPISID') {
                    sapisid = value
                    if (key === 'SAPISID') break
                }
            }
        }

        if (!sapisid) { throw new InternalError('Invalid Cookie: SAPISID or __Secure-3PAPISID not found') }
        this.sapisid = sapisid
        this.cookie = cookiestr
    }

    string_word_match (big: string, small: string): number {
        if (typeof big !== 'string' || typeof small !== 'string') return 0
        const boundary = (c: string): boolean => /[^\p{L}\p{N}]/gu.test(c) // Added explicit boolean return type

        big = big.toLowerCase()
        small = small.toLowerCase()

        if (!big.length || !small.length || boundary(small[0])) { return 0 }
        let l = 0; let r = small.length

        while (l < r) {
            const mid = (r + l + 1) >> 1
            if (big.includes(small.substring(0, mid))) { l = mid } else { r = mid - 1 }
        }

        if (l === small.length) { return l }
        for (let i = l - 1; i > 0; i--) {
            if (boundary(small[i])) { return i }
        }
        return 0
    }

    track_match_score (track: { duration?: number, artists?: string[], title?: string }, result: { duration?: number, artists?: string[], author?: string, title?: string }, rank: number): number {
        let score = 0

        if (track.duration !== undefined && track.duration !== -1 && result.duration !== undefined && result.duration !== -1) {
            const diff = Math.abs(Math.ceil(track.duration) - result.duration)
            if (diff > 5) { return 0 }
            score += 40 * (1 - diff / 5)
        }

        const trackArtists = Array.isArray(track.artists) ? track.artists : []
        const resultArtists = Array.isArray(result.artists) ? result.artists : []
        const resultAuthor = typeof result.author === 'string' ? result.author : ''
        const resultTitle = typeof result.title === 'string' ? result.title : ''
        const trackTitle = typeof track.title === 'string' ? track.title : ''

        const length = Math.max(trackArtists.length, resultArtists.length > 0 ? resultArtists.length : 1)

        for (let artist of trackArtists) {
            if (typeof artist !== 'string') continue
            artist = artist.toLowerCase()

            if (!resultArtists.length && resultAuthor) {
                if (this.string_word_match(resultAuthor, artist) > 0) {
                    score += Math.min(30, 30 * (artist.length / resultAuthor.length))
                    break
                }
            } else {
                for (const resultArtist of resultArtists) {
                    if (typeof resultArtist !== 'string') continue
                    if (resultArtist.toLowerCase() === artist) {
                        score += 30 / length
                        break
                    }
                }
            }
        }

        if (resultTitle.length > 0) {
            score += 10 * this.string_word_match(resultTitle, trackTitle) / resultTitle.length
        }
        score += rank * 20

        return Math.min(1, score / 100)
    }

    // Inside YoutubeAPI class

    // Add explicit types to filter/sort callbacks
    track_match_best (results: any[], track: { duration?: number, artists?: string[], title?: string }, isYoutube?: boolean): any | null {
        if (!Array.isArray(results)) return null

        const scoredResults: Array<{ score: number, track: any }> = [] // Keep explicit type
        for (let i = 0; i < results.length; i++) {
            if (!results[i] || typeof results[i] !== 'object') continue
            const rank = (results.length - i) / results.length
            scoredResults.push({
                score: this.track_match_score(track, results[i], rank),
                track: results[i],
            })
        }

        // Add types to filter/sort parameters
        const filteredResults = scoredResults.filter((match: { score: number }) => match.score >= (isYoutube ? 1 / 3 : 1 / 2))
        filteredResults.sort((a: { score: number }, b: { score: number }) => b.score - a.score)

        return filteredResults.length ? filteredResults[0].track : null
    }

    // Refine logic to ensure arrays are passed correctly
    track_match_best_result (results: any, track: { duration?: number, artists?: string[], title?: string }, isYoutube?: boolean): any | null {
        const list: any[] = [] // Initialize as any[]

        // Check if results is an object and has properties
        if (results && typeof results === 'object') {
            if (results.top_result) { list.push(results.top_result) }
            if (Array.isArray(results.songs)) { list.push(...results.songs) }

            // Match against the combined list first
            const listMatch = this.track_match_best(list, track, isYoutube)
            if (listMatch) { return listMatch }

            // If results itself is an array-like object passed directly (e.g., from search results)
            // Check if results is directly an array before attempting match
            if (Array.isArray(results)) {
                return this.track_match_best(results, track, isYoutube)
            }
            // If results is not an array but might contain tracks at top level (less likely based on structure)
            // Example: if results was { 0: track1, 1: track2, length: 2 }
            // This part might need adjustment based on actual data structure if the above fails
            if (typeof results.length === 'number') {
                const topLevelList = Array.from(results as ArrayLike<any>)
                if (topLevelList.length > 0) {
                    return this.track_match_best(topLevelList, track, isYoutube)
                }
            }
        } else if (Array.isArray(results)) {
            // If results was directly an array
            return this.track_match_best(results, track, isYoutube)
        }

        return null // Return null if no suitable array found to process
    }

    async track_match_lookup (track: { artists?: any, title?: any, explicit?: boolean, duration?: number }): Promise<any | null> {
        const artists = Array.isArray(track.artists) ? track.artists.join(', ') : ''
        const trackTitle = typeof track.title === 'string' ? track.title : ''
        if (!artists || !trackTitle) {
            throw new InternalError('Missing artist or title for track lookup')
        }

        const title = `${artists} - ${trackTitle}`.toLowerCase()
        // Assuming music.search returns YoutubeMusicResults which might be array-like or object
        const musicResults = await music.search(title, null, 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D')

        // Construct a potential explicit match list more carefully
        const expmatchList: any[] = []
        if (musicResults?.top_result?.explicit === track.explicit) {
            expmatchList.push(musicResults.top_result)
        }
        if (Array.isArray(musicResults?.songs)) {
            expmatchList.push(...musicResults.songs.filter((t: any) => t?.explicit === track.explicit))
        }

        // Try matching explicit list first
        let match = this.track_match_best(expmatchList, track) // Pass the constructed array
        if (match) { return match }

        // Then try matching the whole music results (use track_match_best_result which handles object/array)
        match = this.track_match_best_result(musicResults, track)
        if (match) { return match }

        // Fallback to regular YouTube search
        const youtubeResults = await this.search(title)
        // Pass youtubeResults (which should be YoutubeResults, likely array-like)
        return this.track_match_best_result(youtubeResults, track, true)
    }

    async track_match (track: { youtube_id?: any, artists?: any, title?: any, explicit?: any, duration?: number }): Promise<TrackStreams> {
        if (track.youtube_id) {
            try {
                return await this.get_streams(track.youtube_id)
            } catch (e) {
                console.warn(`Failed to get streams directly for YouTube ID ${track.youtube_id}:`, e)
            }
        }

        const result = await this.track_match_lookup(track)

        if (result?.id && typeof result.getStreams === 'function') {
            const id = result.id
            try {
                const streams = await result.getStreams()
                return streams
            } catch (e) {
                throw new UnplayableError({ simpleMessage: `Could not fetch streams for matched track (ID: ${id})`, error: e })
            }
        }

        throw new UnplayableError('Could not find a playable match for this track')
    }
}
const api = new YoutubeAPI()

export class YoutubeMusicTrack extends YoutubeTrack {
    type?: string
    artists?: string[]

    parse_metadata (hasType: boolean, metadata: any[]): { type?: string, artists: string[], duration?: number } {
        let type: string | undefined
        const artists: string[] = []
        let duration: number | undefined
        let found = hasType ? 0 : 1

        if (!Array.isArray(metadata)) {
            return { artists, duration }
        }

        for (let i = 0; i < metadata.length; i++) {
            const text = metadata[i]?.text
            if (typeof text !== 'string') continue

            if (text === ' • ') {
                found++
                continue
            }

            switch (found) {
                case 0: type = text; break
                case 1:
                    artists.push(text)
                    if (i + 1 < metadata.length && metadata[i + 1]?.text !== ' • ') {
                        i++
                    }
                    break
                case 2: break
                case 3: duration = parseTimestamp(text); break
            }
        }
        return { type, artists, duration }
    }

    override from_search (track: { playlistItemData?: { videoId: string }, flexColumns?: Array<{ musicResponsiveListItemFlexColumnRenderer: { text?: { simpleText?: any, runs?: Array<{ text: any }> } } }>, badges?: any }, hasType?: boolean): this {
        if (!track?.playlistItemData?.videoId || !Array.isArray(track.flexColumns)) {
            console.warn('YoutubeMusicTrack.from_search: Missing essential track data', track)
            return this
        }

        const videoId = track.playlistItemData.videoId
        const runs = track.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []
        let { type, artists, duration } = this.parse_metadata(!!hasType, runs)

        if (hasType) {
            type = typeof type === 'string' ? type.toLowerCase() : undefined
            if (type !== 'video' && type !== 'song') {
                console.warn(`Unknown track type "${type}" found.`)
                return this
            }
            this.type = type
        } else {
            this.type = 'song'
        }

        this.explicit = false
        this.artists = artists ?? []

        if (Array.isArray(track.badges)) {
            for (const badge of track.badges) {
                if (badge?.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE') {
                    this.explicit = true
                    break
                }
            }
        }

        const titleText = text(track.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text)

        if (this.artists.length === 0 || !titleText) {
            console.warn('YoutubeMusicTrack.from_search: Missing artist or title', track)
            return this
        }

        return this.setOwner(
            this.artists.join(', '),
        ).setMetadata(
            videoId,
            titleText,
            duration ?? -1,
            youtubeThumbnails(videoId),
        )
    }

    from_section (track: any): this {
        return this.from_search(track, true)
    }
}

export class YoutubeMusicResults extends TrackResults {
    top_result?: any
    songs?: any[]
    continuation?: string
    browse?: string
    query?: string

    process (body: any): void {
        if (Array.isArray(body)) {
            for (const section of body) {
                if (section?.musicShelfRenderer) { this.process_section(section.musicShelfRenderer) } else if (section?.musicCardShelfRenderer) { this.process_card(section.musicCardShelfRenderer) }
            }
            return
        }
        this.process_once(body)
    }

    process_card (card: { contents?: any }): void {
        if (!card?.contents) { return }
        const tracks = this.from_section(card.contents)
        if (!tracks.length) { return }
        this.top_result = tracks[0]
        this.push(...tracks)
    }

    process_section (section: { title?: any, bottomEndpoint?: { searchEndpoint?: { query?: any, params?: any } }, contents?: any }): void {
        let sectionName = text(section?.title)
        if (!sectionName) { return }
        sectionName = sectionName.toLowerCase()

        const query = section?.bottomEndpoint?.searchEndpoint?.query
        const params = section?.bottomEndpoint?.searchEndpoint?.params
        const contents = section?.contents

        switch (sectionName) {
            case 'songs':
                if (query !== undefined && params !== undefined) {
                    this.set_browse(query, params)
                }
            // eslint-disable-next-line no-fallthrough
            case 'top result':
            case 'videos': {
                const tracks = this.from_section(contents)
                if (sectionName === 'top result' && tracks.length > 0) { this.top_result = tracks[0] }
                if (sectionName === 'songs') { this.songs = tracks }
                if (tracks.length > 0) {
                    this.push(...tracks)
                }
                break
            }
        }
    }

    from_section (list: any): YoutubeMusicTrack[] {
        const tracks: YoutubeMusicTrack[] = []
        if (!Array.isArray(list)) return tracks

        for (const item of list) {
            if (item?.musicResponsiveListItemRenderer) {
                const track = new YoutubeMusicTrack().from_section(item.musicResponsiveListItemRenderer)
                if (track.id) {
                    tracks.push(track)
                }
            }
        }
        return tracks
    }

    process_once (body: { contents?: any, continuations?: any[] }): void {
        if (body?.contents) {
            this.extract_tracks(body.contents)
        }
        if (body?.continuations?.length && body.continuations[0]?.nextContinuationData?.continuation) {
            this.set_continuation(body.continuations[0].nextContinuationData.continuation)
        }
    }

    extract_tracks (list: any): void {
        if (!Array.isArray(list)) return

        for (const item of list) {
            if (item?.musicResponsiveListItemRenderer) {
                const track = new YoutubeMusicTrack().from_search(item.musicResponsiveListItemRenderer)
                if (track.id) {
                    this.push(track)
                }
            }
        }
    }

    set_continuation (cont: any): void {
        if (typeof cont === 'string') {
            this.continuation = cont
        }
    }

    set_browse (query: any, params: any): void {
        if (typeof query === 'string') {
            this.query = query
        }
        if (typeof params === 'string') {
            this.browse = params
        }
    }

    override async next (): Promise<YoutubeMusicResults | null> {
        if (this.browse) {
            return await music.search(this.query ?? null, null, this.browse)
        }
        if (this.continuation) { return await music.search(null, this.continuation) }
        return null
    }
}

export default api
