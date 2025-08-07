import { UnplayableError, NotFoundError, InternalError, NetworkError } from '../Error.js'
import { Track, TrackImage, TrackResults, TrackPlaylist, TrackStream, TrackStreams } from '../Track.js'
import { genPlaylistContinuation, genSearchOptions, playlistNextOffset } from '../../proto/youtube.js'
// Se elimina la importación estática de 'youtubei.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const CREDENTIALS_PATH = path.join(process.cwd(), 'youtube_credentials.json')

// ... (El resto de las funciones auxiliares como getProperty, text, etc., permanecen igual)

function getProperty (array: any[], prop: string): any | null {
    if (!Array.isArray(array)) { return null }
    for (const item of array) {
        if (item?.[prop]) { return item[prop] }
    }
    return null
}

function text (txt?: { simpleText?: any, runs?: Array<{ text: any }> }): string {
    if (!txt) { return '' }
    if (txt.simpleText) { return txt.simpleText }
    if (txt.runs && txt.runs.length > 0 && txt.runs[0].text) { return txt.runs[0].text }
    return ''
}

function checkPlayable (st: { status: string, reason?: string } | undefined): void {
    if (!st?.status) { return }

    const { status, reason } = st

    switch (status.toLowerCase()) {
        case 'ok':
            return
        case 'error':
            if (reason === 'Video unavailable') { throw new NotFoundError('Video unavailable') }
            break
        case 'unplayable':
            throw new UnplayableError(reason ?? status)
        case 'login_required':
            throw new UnplayableError('Video is age restricted')
        case 'content_check_required':
            throw new UnplayableError('Content check required')
        case 'age_check_required':
            throw new UnplayableError('Age check required')
        default:
            throw new UnplayableError(reason ?? status)
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

    if (tokens.length > scale.length || tokens.some(isNaN)) { return -1 }

    for (let i = tokens.length - 1; i >= 0; i--) {
        seconds += tokens[i] * scale[Math.min(3, tokens.length - i - 1)]
    }

    return seconds
}

function youtubeThumbnails (videoId: string): TrackImage[] {
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
            videoId,
            trackTitle,
            duration,
            youtubeThumbnails(videoId),
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
        ).setMetadata(
            videoId,
            trackTitle,
            duration,
            youtubeThumbnails(videoId),
        ).setPlayable(playable)
    }

    async fetch (): Promise<Track> {
        if (!this.id) throw new InternalError('Cannot fetch track without ID')
        return await api.get(this.id) as Track
    }

    async getStreams (): Promise<TrackStreams> {
        if (!this.id) throw new InternalError('Cannot get streams for track without ID')
        return await api.get_streams(this.id)
    }

    get url (): string {
        return 'https://https://www.youtube.com/watch?v=' + (this.id ?? '')
    }
}

export class YoutubeResults extends TrackResults {
    continuation?: string

    process (body: any[]): void {
        if (!Array.isArray(body)) return

        for (const item of body) {
            if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
                this.set_continuation(item.continuationItemRenderer.continuationEndpoint.continuationCommand.token)
            } else if (item?.itemSectionRenderer?.contents) {
                this.extract_tracks(item.itemSectionRenderer.contents)
            }
        }
    }

    extract_tracks (list: any): void {
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

    set_continuation (cont: any): void {
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
    declare firstTrack?: YoutubeTrack

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
        const firstTrackUrl = this.firstTrack?.url

        if (firstTrackUrl && this.id) {
            return firstTrackUrl + '&list=' + this.id
        }
        return 'https://https://www.youtube.com/playlist?list=' + (this.id ?? '')
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

            if (this?.live && adaptive && !isNaN(targetDurationSec)) {
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

export class YoutubeAPI {
    #yt_innertube?: any // Se mantiene el tipo 'any' para la instancia de Innertube

    Track = YoutubeTrack
    YoutubeResults = YoutubeResults
    YoutubePlaylist = YoutubePlaylist

    constructor () {
        void this.init_session()
    }

    async init_session() {
        try {
            // --- CAMBIO AQUÍ: Importación dinámica ---
            const { Innertube, UniversalCache } = await import('youtubei.js');
            this.#yt_innertube = await Innertube.create({ 
                cache: new UniversalCache(false),
                generate_session_locally: true 
            })
            
            const credentials = await fs.readFile(CREDENTIALS_PATH, 'utf-8')
            await this.#yt_innertube.session.signIn(JSON.parse(credentials))

            console.log('[Yasha-Auth] ¡Sesión de YouTube iniciada correctamente desde credenciales guardadas!')
            
        } catch (e) {
            console.log('[Yasha-Auth] No se encontraron credenciales válidas. El bot se ejecutará en modo no autenticado.')
        }
    }

    async login() {
        if (!this.#yt_innertube) {
             // --- CAMBIO AQUÍ: Importación dinámica ---
            const { Innertube, UniversalCache } = await import('youtubei.js');
            this.#yt_innertube = await Innertube.create({ cache: new UniversalCache(false), generate_session_locally: true })
        }

        let loginInfo: { verification_url: string, user_code: string } | undefined
        
        this.#yt_innertube!.session.on('auth-pending', (data: any) => {
            loginInfo = {
                verification_url: data.verification_url,
                user_code: data.user_code,
            }
        })

        this.#yt_innertube!.session.on('auth', async (data: any) => {
            await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(data.credentials), 'utf-8')
            console.log('[Yasha-Auth] ¡Credenciales guardadas correctamente!')
        })

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Timeout esperando el código de login de YouTube.")), 20000)
            
            this.#yt_innertube!.session.on('auth-pending', () => {
                clearTimeout(timeout)
                resolve()
            })

            this.#yt_innertube!.session.signIn().catch(reject)
        })

        if (!loginInfo) throw new Error("No se pudo obtener la información de login de YouTube.")
        
        return loginInfo
    }
    
    async api_request (path: string, body: { [key: string]: any } = {}): Promise<any> {
        if (!this.#yt_innertube) {
            console.warn('[Yasha-API] Se está realizando una petición sin una sesión de Innertube inicializada.')
             // --- CAMBIO AQUÍ: Importación dinámica ---
            const { Innertube } = await import('youtubei.js');
            this.#yt_innertube = await Innertube.create()
        }

        try {
            const response = await this.#yt_innertube.actions.execute(path, body)
            return response
        } catch (err: any) {
            throw new NetworkError(`[Yasha-Innertube] Error al ejecutar la acción '${path}': ${err.message}`)
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
                    list.next_offset = currentResult.next_offset
                }
                offset = currentResult?.next_offset
            } catch (e) {
                console.error(`Error fetching playlist page for ID ${id} at offset ${offset}:`, e)
                break
            }
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
    
    async track_match (track: Track): Promise<TrackStreams | null> {
        if (!track.title) {
            throw new InternalError('Track title is missing for Youtube.')
        }

        const query = `${track.author ?? ''} - ${track.title}`.trim()
        const searchResults = await this.search(query)

        if (!searchResults || searchResults.length === 0) {
            return null
        }

        const firstResult = searchResults[0]
        if (!firstResult.id) {
            return null
        }

        try {
            return await this.get_streams(firstResult.id)
        } catch (error) {
            console.error(`Failed to get streams for matched track ${firstResult.id}:`, error)
            return null
        }
    }
    
    set_cookie (cookiestr?: string): void {
        // Mantenido por si es necesario en el futuro
    }
}

const api = new YoutubeAPI()
export default api