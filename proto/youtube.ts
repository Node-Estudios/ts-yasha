// Added type alias for WithImplicitCoercion
import {
    search_continuation as SearchContinuation,
    playlist_params as PlaylistParams,
    playlist_offset as PlaylistOffset,
    search_filters as SearchFilters,
    search_options as SearchOptions,
    search_sort as searchSort,
    playlist as Playlist,
    search as Search,
} from './build/youtube.js'

// Assuming Buffer is available (requires @types/node)
import { Buffer } from 'node:buffer'

type WithImplicitCoercion<T> = T | { valueOf: () => T }

function binaryToB64NoPad (binary: WithImplicitCoercion<ArrayBuffer | SharedArrayBuffer>): string {
    // Use Buffer.from correctly with ArrayBufferLike types
    return Buffer.from(binary as ArrayBufferLike).toString('base64url')
}

// Removed unused function: binB64

function binaryToB64url (binary: WithImplicitCoercion<ArrayBuffer | SharedArrayBuffer>): string {
    // Use Buffer's base64url which is typically unpadded and URL-safe
    return Buffer.from(binary as ArrayBufferLike).toString('base64url')
}

function b64urlToBinary (input: string): Buffer {
    // Use Buffer's base64url decoding
    return Buffer.from(input, 'base64url')
}

export function playlistNextOffset (continuation: string): undefined | number {
    try {
        const p = Playlist.deserializeBinary(b64urlToBinary(continuation))

        if (!p?.continuation?.params) return undefined

        const pParams = PlaylistParams.deserializeBinary(b64urlToBinary(p.continuation.params))

        if (!pParams?.offset) return undefined

        const offsetStr = pParams.offset
        if (typeof offsetStr !== 'string' || !offsetStr.startsWith('PT:')) return undefined

        // Fix: Remove .buffer - deserializeBinary expects Uint8Array/Buffer
        return PlaylistOffset.deserializeBinary(b64urlToBinary(offsetStr.substring('PT:'.length))).offset
    } catch (e) {
        console.error('Error decoding playlist continuation:', e)
        return undefined
    }
}

export function genPlaylistContinuation (id: string, offset: number): string {
    const pOffset = new PlaylistOffset()
    const pParams = new PlaylistParams()
    // eslint-disable-next-line new-cap
    const pCont = new Playlist.playlist_continuation()
    const p = new Playlist()
    pOffset.offset = offset
    pParams.page = Math.floor(offset / 100)
    // Pass the .buffer to binaryToB64NoPad
    const pOffsetSerialized = offset ? binaryToB64NoPad(pOffset.serializeBinary().buffer) : 'CAA'
    pParams.offset = `PT:${pOffsetSerialized}`
    pCont.vlid = 'VL' + id
    // Pass the .buffer to binaryToB64url
    pCont.params = binaryToB64url(pParams.serializeBinary().buffer)
    pCont.id = id
    p.continuation = pCont

    // Pass the .buffer to binaryToB64url
    return binaryToB64url(p.serializeBinary().buffer)
}

export function genSearchContinuation (query: string, offset: number): string {
    const sCont = new SearchContinuation()
    // eslint-disable-next-line new-cap
    const sData = new SearchContinuation.search_data()
    const sFilters = new SearchFilters()
    const sOptions = new SearchOptions()
    // eslint-disable-next-line new-cap
    const sPosition = new SearchOptions.search_position()
    // eslint-disable-next-line new-cap
    const sOff = new SearchOptions.search_position.off()
    sOff.total = 0
    sOff.page = 1
    sPosition.offset = sOff
    sOptions.sort = searchSort.RELEVANCE
    sFilters.type = SearchFilters.Type.VIDEO
    sOptions.filters = sFilters
    sOptions.offset = offset
    sOptions.position = sPosition
    sData.query = query
    // Pass the .buffer to binaryToB64url
    sData.options = binaryToB64url(sOptions.serializeBinary().buffer)
    sCont.data = sData
    sCont.const = 52047873
    sCont.type = 'search-feed'

    // Pass the .buffer to binaryToB64url
    return binaryToB64url(sCont.serializeBinary().buffer)
}

export type SearchSortString = 'relevance' | 'rating' | 'upload_date' | 'view_count'
export type SearchTypeString = 'video' | 'channel' | 'playlist' | 'movie'
export type SearchDurationString = 'short' | 'medium' | 'long' | 'any'

export interface SearchOptionsType {
    sort?: SearchSortString
    type?: SearchTypeString
    duration?: SearchDurationString
    features?: {
        hd?: boolean
        cc?: boolean
        creativeCommons?: boolean
        is3d?: boolean
        live?: boolean
        purchased?: boolean
        is4k?: boolean
        is360?: boolean
        location?: boolean
        hdr?: boolean
        vr180?: boolean
    }
}
export function genSearchOptions (opts: SearchOptionsType): string {
    const options = new Search() // Review if this should be SearchOptions
    const filters = new SearchFilters()
    options.sort = searchSort[(opts.sort?.toUpperCase() ?? 'RELEVANCE') as keyof typeof searchSort]
    filters.type = SearchFilters.Type[(opts.type?.toUpperCase() ?? 'VIDEO') as keyof typeof SearchFilters.Type]
    filters.duration = SearchFilters.Duration[(opts.duration?.toUpperCase() ?? 'ANY') as keyof typeof SearchFilters.Duration]
    filters.is_hd = !!opts.features?.hd
    filters.has_cc = !!opts.features?.cc
    filters.creative_commons = !!opts.features?.creativeCommons
    filters.is_3d = !!opts.features?.is3d
    filters.is_live = !!opts.features?.live
    filters.purchased = !!opts.features?.purchased
    filters.is_4k = !!opts.features?.is4k
    filters.is_360 = !!opts.features?.is360
    filters.has_location = !!opts.features?.location
    filters.is_hdr = !!opts.features?.hdr
    filters.is_vr180 = !!opts.features?.vr180
    options.filters = filters

    // Pass the .buffer to binaryToB64url
    return binaryToB64url(options.serializeBinary().buffer)
}
