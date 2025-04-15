import crypto from 'node:crypto'
import Request from '../Request.js'

import { NetworkError, ParseError, InternalError, NotFoundError } from 'js-common'

import { Track, TrackImage, TrackResults, TrackPlaylist, TrackStream, TrackStreams } from '../Track.js'
import { genPlaylistContinuation, genSearchOptions, playlistNextOffset } from '../../proto/youtube'
import { UnplayableError } from '../Error.js'

import { type RequestInit } from 'node-fetch'

function getProperty (array: any[], prop: string) {
    if (!(array instanceof Array)) { return null }
    for (const item of array) {
        if (item?.[prop]) { return item[prop] }
    }
    return null
}

function text (txt?: { simpleText?: any, runs?: Array<{ text: any }> }) {
    if (!txt) { return null }
    if (txt.simpleText) { return txt.simpleText }
    if (txt.runs) { return txt.runs[0].text }
    return ''
}

function checkPlayable (st: { status: string, reason: string }) {
    if (!st) { return }
    const { status, reason } = st

    if (!status) { return }
    switch (status.toLowerCase()) {
        case 'ok':
            return
        case 'error':
            if (reason === 'Video unavailable') { throw new NotFoundError({ simpleMessage: 'Video not found' }) }
            break
        case 'unplayable':
            throw new UnplayableError(reason || status)
        case 'login_required':
            throw new UnplayableError('Video is age restricted')
        case 'content_check_required':
            throw new UnplayableError('Content check required')
        case 'age_check_required':
            throw new UnplayableError('Age check required')
        default:
            throw new UnplayableError(reason || status)
    }
}

function number (n: string | number) {
    n = parseInt(`${n}`, 10)

    if (Number.isFinite(n)) { return n }
    return 0
}

function parseTimestamp (str: string) {
    const tokens = str.split(':').map(token => parseInt(token))

    const scale = [1, 60, 3600, 86400]
    let seconds = 0

    if (tokens.length > scale.length) { return -1 }
    for (let i = tokens.length - 1; i >= 0; i--) {
        if (!Number.isInteger(tokens[i])) { return -1 }
        seconds += tokens[i] * scale[Math.min(3, tokens.length - i - 1)]
    }

    return seconds
}

function youtubeThumbnails (videoId: string) {
    return [new TrackImage(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, 320, 180)]
}

export class YoutubeTrack extends Track {
    declare platform: 'Youtube'
    explicit = false
    constructor () {
        super('Youtube')
    }

    from (videoDetails: { videoId: string, title: string, lengthSeconds: string | number }, author: { title?: { simpleText?: any, runs?: Array<{ text: any }> }, thumbnail: { thumbnails: Array<{ url: string, width: number, height: number }> } }, streams: TrackStreams) {
        return this.setOwner(
            text(author.title),
            TrackImage.from(author.thumbnail.thumbnails),
        ).setMetadata(
            videoDetails.videoId,
            videoDetails.title,
            number(videoDetails.lengthSeconds),
            youtubeThumbnails(videoDetails.videoId),
        ).setStreams(
            streams,
        )
    }

    from_search (track: any) {
        let thumbnails

        if (track.channelThumbnailSupportedRenderers) { thumbnails = track.channelThumbnailSupportedRenderers.channelThumbnailWithLinkRenderer.thumbnail.thumbnails } else if (track.channelThumbnail) { thumbnails = track.channelThumbnail.thumbnails }
        return this.setOwner(
            text(track.shortBylineText),
            TrackImage.from(thumbnails),
        ).setMetadata(
            track.videoId,
            text(track.title),
            track.lengthText ? parseTimestamp(track.lengthText.simpleText) : -1,
            youtubeThumbnails(track.videoId),
        )
    }

    from_playlist (track: any) {
        return this.setOwner(
            text(track.shortBylineText),
        ).setMetadata(
            track.videoId,
            text(track.title),
            number(track.lengthSeconds),
            youtubeThumbnails(track.videoId),
        ).setPlayable(!!track.isPlayable)
    }

    async fetch () {
        return await api.get(this.id as string)
    }

    async getStreams () {
        return await api.get_streams(this.id as string)
    }

    get url () {
        return 'https://www.youtube.com/watch?v=' + this.id
    }
}

export class YoutubeResults extends TrackResults {
    continuation?: any

    process (body: any[]) {
        for (const item of body) {
            if (item.continuationItemRenderer) { this.set_continuation(item.continuationItemRenderer.continuationEndpoint.continuationCommand.token) } else if (item.itemSectionRenderer) { this.extract_tracks(item.itemSectionRenderer.contents) }
        }
    }

    extract_tracks (list: any) {
        for (const video of list) {
            if (video.videoRenderer) { this.push(new YoutubeTrack().from_search(video.videoRenderer)) }
        }
    }

    set_continuation (cont: any) {
        this.continuation = cont
    }

    override async next () {
        if (this.continuation) { return await api.search(null, this.continuation) }
        return null
    }
}

export class YoutubePlaylist extends TrackPlaylist {
    declare platform: 'Youtube'
    id?: string
    next_offset?: number
    declare firstTrack?: YoutubeTrack

    process (id: string, data: any, offset: number) {
        this.id = id

        for (const item of data) {
            if (item.continuationItemRenderer) { this.next_offset = playlistNextOffset(item.continuationItemRenderer.continuationEndpoint.continuationCommand.token) } else if (item.playlistVideoRenderer) { this.push(new YoutubeTrack().from_playlist(item.playlistVideoRenderer)) }
        }
    }

    override async next () {
        if (this.next_offset) { return await api.playlist_once(this.id as string, this.next_offset) }
        return null
    }

    override get url () {
        if (this.firstTrack) { return this.firstTrack.url + '&list=' + this.id }
        return 'https://www.youtube.com/playlist?list=' + this.id
    }
}

export class YoutubeStream extends TrackStream {
    itag: any
    default_audio_track?: any

    constructor (url: string, itag: any) {
        super(url)

        this.itag = itag
    }

    override equals (other: YoutubeStream) {
        return !!(other instanceof YoutubeStream && this.itag && this.itag === other.itag)
    }
}

export class YoutubeStreams extends TrackStreams {
    expire?: number

    from (start: number, playerResponse: any) {
        let loudness = 0

        if (playerResponse.playerConfig?.audioConfig?.loudnessDb) { loudness = playerResponse.playerConfig.audioConfig.loudnessDb }
        const { formats, adaptiveFormats, expiresInSeconds } = playerResponse.streamingData

        if (!this.live && formats) { this.extract_streams(formats, false) }
        if (adaptiveFormats) { this.extract_streams(adaptiveFormats, true) }
        this.expire = start + parseInt(expiresInSeconds, 10) * 1000
        this.set(Math.min(1, Math.pow(10, -loudness / 20)), playerResponse.videoDetails.isLive, start)

        return this
    }

    override expired () {
        return Date.now() > (this.expire ?? 0)
    }

    extract_streams (streams: any, adaptive: boolean) {
        for (const fmt of streams) {
            if (fmt.type === 'FORMAT_STREAM_TYPE_OTF') { continue }
            const stream = new YoutubeStream(fmt.url, fmt.itag)

            if (this.live && adaptive) { stream.setDuration(fmt.targetDurationSec) } else { stream.setDuration(parseInt(fmt.approxDurationMs, 10) / 1000) }
            const mime = /(video|audio)\/([a-zA-Z0-9]{3,4});(?:\+| )codecs="(.*?)"/.exec(fmt.mimeType)

            if (!mime) { continue }
            if (!adaptive) { stream.setTracks(true, true) } else if (mime[1] === 'video') { stream.setTracks(true, false) } else { stream.setTracks(false, true) }
            stream.setBitrate(fmt.bitrate)
            stream.setMetadata(mime[2], mime[3])
            stream.default_audio_track = fmt.audioTrack?.audioIsDefault

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

    async api_request (path: string, body?: { [key: string]: any }, query?: string) {
        return await api.api_request.call(this, path, body, query, 'music')
    }

    async search (search: string | null, continuation: string | null, params?: string) {
        let query, body

        if (continuation) { query = '&continuation=' + continuation + '&type=next' } else { body = { query: search, params } }
        body = await this.api_request('search', body, query)

        if (continuation) {
            if (!body.continuationContents) { throw new NotFoundError('Search continuation token not found') }
            try {
                body = body.continuationContents.musicShelfContinuation
            } catch (e) {
                throw new InternalError(e)
            }
        } else {
            try {
                body = body.contents.tabbedSearchResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents
            } catch (e) {
                throw new InternalError(e)
            }

            if (params) { body = getProperty(body, 'musicShelfRenderer') }
        }

        const results = new YoutubeMusicResults()

        try {
            results.process(body)
        } catch (e) {
            throw new InternalError(e)
        }

        return results
    }
}
const music = new YoutubeMusic()

/* api requests and headers to youtube.com */
export class YoutubeAPI {
    innertube_client: {
        clientName: string
        clientVersion: string
        gl: string
        hl: string
    }

    innertube_key: string
    cookie: string
    sapisid: string
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

        this.cookie = ''
        this.sapisid = ''
    }

    async api_request (path: string, body: { [key: string]: any } = {}, query = '', origin = 'www') {
        /* youtube v1 api */
        let time = Date.now()
        const options: RequestInit = { headers: { origin: `https://${origin}.youtube.com` } }

        body.context = { client: { ...this.innertube_client } }
        options.method = 'POST'

        if (path === 'player') {
            body.params = '2AMBCgIQBg'
            body.contentCheckOk = true
            body.racyCheckOk = true
            body.context.client.clientName = 'ANDROID'
            body.context.client.clientVersion = '18.15.35'
            body.context.client.androidSdkVersion = 33
            
            options.headers['User-Agent'] = 'com.google.android.youtube/18.15.35'
        }

        if (this.sapisid) {
            time = Math.floor(time / 1000)
            const hash = crypto.createHash('sha1').update(`${time} ${this.sapisid} https://${origin}.youtube.com`).digest('hex')

            
            options.headers.authorization = 'SAPISIDHASH ' + time + '_' + hash
            
            options.headers.cookie = this.cookie
        }

        options.body = JSON.stringify(body)

        const { res } = await Request.getResponse(`https://${origin}.youtube.com/youtubei/v1/${path}?key=${this.innertube_key}${query}&prettyPrint=false`, options)
        let nbody: string

        try {
            nbody = await res.text()
        } catch (e) {
            if (!res.ok) { throw new InternalError(e) }
            throw new NetworkError(e)
        }

        if (res.status >= 400 && res.status < 500) { throw new NotFoundError(nbody) }
        if (!res.ok) { throw new InternalError(nbody) }
        try {
            nbody = JSON.parse(nbody)
        } catch (e) {
            throw new ParseError(e)
        }

        return nbody as unknown as { [key: string]: any }
    }

    async get (id: string) {
        const start = Date.now()
        let responses: [any, any]

        try {
            responses = await Promise.all([
                this.api_request('next', { videoId: id }),
                this.api_request('player', { videoId: id }),
            ])
        } catch (e) {
            if (e instanceof NotFoundError) { throw new NotFoundError({ simpleMessage: 'Video not found', error: e }) }
            throw e
        }

        const [response, playerResponse] = responses

        if (!response || !playerResponse) { throw new InternalError('Missing data') }
        checkPlayable(playerResponse.playabilityStatus)

        const videoDetails = playerResponse.videoDetails

        try {
            const author = getProperty(response.contents.twoColumnWatchNextResults.results.results.contents, 'videoSecondaryInfoRenderer').owner.videoOwnerRenderer

            return new YoutubeTrack().from(videoDetails, author, new YoutubeStreams().from(start, playerResponse))
        } catch (e) {
            throw new InternalError(e)
        }
    }

    async get_streams (id: string) {
        const start = Date.now()
        const playerResponse = await this.api_request('player', { videoId: id })

        if (!playerResponse) { throw new InternalError('Missing data') }
        checkPlayable(playerResponse.playabilityStatus)

        try {
            return new YoutubeStreams().from(start, playerResponse)
        } catch (e) {
            throw new InternalError(e)
        }
    }

    async playlist_once (id: string, start = 0) {
        const results = new YoutubePlaylist()
        const data = await this.api_request('browse', { continuation: genPlaylistContinuation(id, start) })

        if (!data.sidebar) { throw new NotFoundError({ simpleMessage: 'Playlist not found' }) }
        if (!data.onResponseReceivedActions) { return results }
        try {
            const details = getProperty(data.sidebar.playlistSidebarRenderer.items, 'playlistSidebarPrimaryInfoRenderer')

            results.setMetadata(text(details.title), text(details.description))
            results.process(id, data.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems, start)
        } catch (e) {
            throw new InternalError(e)
        }

        return results
    }

    async playlist (id: string, limit?: number) {
        let list = null
        let offset = 0

        do {
            const result = await this.playlist_once(id, offset)

            if (!list) { list = result } else { list = list.concat(result) }
            offset = result.next_offset ?? 0
        // eslint-disable-next-line no-unmodified-loop-condition
        } while (offset && (!limit || list.length < limit))

        return list
    }

    async search (query: string | null, continuation?: any) {
        let body = await this.api_request('search', continuation
            ? { continuation }
            : {
                query,
                params: genSearchOptions({
                    type: 'video',
                    sort: 'relevance',
                    duration: 'short',
                }),
            })

        if (continuation) {
            if (!body.onResponseReceivedCommands) { throw new NotFoundError('Search continuation token not found') }
            try {
                body = body.onResponseReceivedCommands[0].appendContinuationItemsAction.continuationItems
            } catch (e) {
                throw new InternalError(e)
            }
        } else {
            try {
                body = body.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents
            } catch (e) {
                throw new InternalError(e)
            }
        }

        const results = new YoutubeResults()

        try {
            // @ts-expect-error
            results.process(body)
        } catch (e) {
            throw new InternalError(e)
        }

        return results
    }

    set_cookie (cookiestr?: string) {
        if (!cookiestr) {
            this.cookie = ''
            this.sapisid = ''

            return
        }

        const cookies = cookiestr.split(';')
        let sapisid = null

        for (let cookie of cookies) {
            // @ts-expect-error
            cookie = cookie.trim().split('=')

            if (cookie[0] === '__Secure-3PAPISID') { sapisid = cookie[1] } else if (cookie[0] === 'SAPISID') {
                sapisid = cookie[1]

                break
            }
        }

        if (!sapisid) { throw new InternalError('Invalid Cookie') }
        this.sapisid = sapisid
        this.cookie = cookiestr
    }

    string_word_match (big: string, small: string) {
        const boundary = (c: string) => /[^\p{L}\p{N}]/gu.test(c)

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

    track_match_score (track: { duration: number, artists: string, title: string }, result: { duration: number, artists: string, author: string, title: string }, rank: number) {
        let score = 0

        if (track.duration !== -1 && result.duration !== -1) {
            const diff = Math.abs(Math.ceil(track.duration) - result.duration)

            if (diff > 2) { return 0 }
            score += 40 * (1 - diff / 2)
        }

        const length = Math.max(track.artists.length, result.artists ? result.artists.length : 1)

        for (let artist of track.artists) {
            artist = artist.toLowerCase()

            if (!result.artists) {
                if (this.string_word_match(result.author, artist) > 0) {
                    score += 30 * (artist.length / result.author.length)

                    break
                }
            } else {
                for (const resultArtist of result.artists) {
                    if (resultArtist.toLowerCase() === artist) {
                        score += 30 / length

                        break
                    }
                }
            }
        }

        score += 10 * this.string_word_match(result.title, track.title) / result.title.length
        score += rank * 20

        return score / 100
    }

    track_match_best (results: any[], track: { duration: number, artists: string, title: string }, isYoutube?: boolean) {
        for (let i = 0; i < results.length; i++) {
            const rank = (results.length - i) / results.length

            results[i] = {
                score: this.track_match_score(track, results[i], rank),
                track: results[i],
            }
        }

        results = results.filter(match => match.score >= (isYoutube ? 1 / 3 : 1 / 2))
        results.sort((a, b) => b.score - a.score)

        return results.length ? results[0].track : null
    }

    track_match_best_result (results: any, track: { duration: number, artists: string, title: string }, isYoutube?: boolean) {
        const list = []

        if (results.top_result) { list.push(results.top_result) }
        if (results.songs) { list.push(...results.songs) }
        const result = this.track_match_best(list, track, isYoutube)

        if (result) { return result }
        return this.track_match_best(results, track, isYoutube)
    }

    async track_match_lookup (track: { artists: any, title: any, explicit?: any, duration?: number }) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        const title = `${track.artists.join(', ')} - ${track.title}`.toLowerCase()
        let results = await music.search(title, null, 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D')
        // TODO: check this
        // @ts-expect-error
        const expmatch = results.filter((t) => t.explicit === track.explicit)

        
        // @ts-expect-error
        if (results.top_result && results.top_result.explicit === track.explicit) { expmatch.top_result = results.top_result }
        // @ts-expect-error
        if (results.songs) { expmatch.songs = results.songs.filter((t) => t.explicit === track.explicit) }
        // @ts-expect-error
        let match = this.track_match_best_result(expmatch, track)

        if (match) { return match }
        // @ts-expect-error
        match = this.track_match_best_result(results, track)

        if (match) { return match }
        // @ts-expect-error
        results = await this.search(title)

        // @ts-expect-error
        return this.track_match_best_result(results, track, true)
    }

    async track_match (track: { youtube_id?: any, artists?: any, title?: any, explicit?: any, duration?: number }) {
        if (track.youtube_id) {
            try {
                return await this.get_streams(track.youtube_id)
            } catch (e) {
                /* continue */
            }
        }

        // @ts-expect-error
        let result = await this.track_match_lookup(track)

        if (result) {
            const id = result.id

            result = await result.getStreams()
            track.youtube_id = id

            return result
        }

        throw new UnplayableError({ simpleMessage: 'Could not fetch streams for this track' })
    }
}
const api = new YoutubeAPI()

export class YoutubeMusicTrack extends YoutubeTrack {
    type?: string
    artists?: string[]

    // constructor () {
    //     super('Youtube')
    // }

    parse_metadata (hasType: boolean, metadata: any[]) {
        let type; const artists = []; let duration
        let found = hasType ? 0 : 1

        for (let i = 0; i < metadata.length; i++) {
            const text = metadata[i].text

            if (text === ' • ') {
                found++

                continue
            }

            switch (found) {
                case 0: /* type */
                    type = text

                    break
                case 1: /* artists */
                    artists.push(text)

                    if (i + 1 < metadata.length && metadata[i + 1].text !== ' • ') { i++ }
                    break
                case 2: /* album */
                    break
                case 3: /* duration */
                    duration = parseTimestamp(text)

                    break
            }
        }

        return { type, artists, duration }
    }

    
    override from_search (track: { playlistItemData: { videoId: string }, flexColumns: Array<{ musicResponsiveListItemFlexColumnRenderer: { text?: { simpleText?: any, runs?: Array<{ text: any }> } } }>, badges: any }, hasType?: boolean) {
        if (!track.playlistItemData) { return }
        // TODO: check this
        
        let { type, artists, duration } = this.parse_metadata(!!hasType, track.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text?.runs)

        if (hasType) {
            type = type.toLowerCase()

            if (type !== 'video' && type !== 'song') { return }
            this.type = type
        } else {
            this.type = 'song'
        }

        this.explicit = false
        this.artists = artists

        if (track.badges) {
            for (const badge of track.badges) {
                if (badge.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE') {
                    this.explicit = true

                    break
                }
            }
        }

        return this.setOwner(
            artists.join(', '),
        ).setMetadata(
            track.playlistItemData.videoId,
            text(track.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text),
            duration ?? 0,
            youtubeThumbnails(track.playlistItemData.videoId),
        )
    }

    from_section (track: any) {
        return this.from_search(track, true)
    }
}

export class YoutubeMusicResults extends TrackResults {
    top_result?: any
    songs?: any
    continuation?: any
    browse?: any
    query?: any

    process (body: any) {
        if (body instanceof Array) {
            for (const section of body) {
                if (section.musicShelfRenderer) { this.process_section(section.musicShelfRenderer) } else if (section.musicCardShelfRenderer) { this.process_card(section.musicCardShelfRenderer) }
            }
            return
        }

        this.process_once(body)
    }

    process_card (card: { contents: any }) {
        if (!card.contents) { return }
        const tracks = this.from_section(card.contents)

        if (!tracks.length) { return }
        this.top_result = tracks[0]
        this.push(...tracks)
    }

    process_section (section: { title?: { simpleText?: any, runs?: Array<{ text: any }> }, bottomEndpoint: { searchEndpoint: { query: any, params: any } }, contents: any }) {
        let sectionName = text(section.title)

        if (!sectionName) { return }
        sectionName = sectionName.toLowerCase()

        switch (sectionName) {
            case 'songs':
                if (section.bottomEndpoint) { this.set_browse(section.bottomEndpoint.searchEndpoint.query, section.bottomEndpoint.searchEndpoint.params) }
            // eslint-disable-next-line no-fallthrough
            case 'top result':
            case 'videos': {
                const tracks = this.from_section(section.contents)

                if (sectionName === 'top result' && tracks.length) { this.top_result = tracks[0] }
                if (sectionName === 'songs') { this.songs = tracks }
                this.push(...tracks)

                break
            }
        }
    }

    from_section (list: any) {
        const tracks = []

        for (let video of list) {
            if (video.musicResponsiveListItemRenderer) {
                video = new YoutubeMusicTrack().from_section(video.musicResponsiveListItemRenderer)

                if (video) { tracks.push(video) }
            }
        }
        return tracks
    }

    process_once (body: { contents: any, continuations?: any[] }) {
        this.extract_tracks(body.contents)

        if (body.continuations?.length) { this.set_continuation(body.continuations[0].nextContinuationData.continuation) }
    }

    extract_tracks (list: any) {
        for (let video of list) {
            if (video.musicResponsiveListItemRenderer) {
                video = new YoutubeMusicTrack().from_search(video.musicResponsiveListItemRenderer)

                if (video) { this.push(video) }
            }
        }
    }

    set_continuation (cont: any) {
        this.continuation = cont
    }

    set_browse (query: any, params: any) {
        this.browse = params
        this.query = query
    }

    override async next () {
        if (this.browse) { return await music.search(this.query, null, this.browse) }
        if (this.continuation) { return await music.search(null, this.continuation) }
        return null
    }
}

export default api
