import { NotATrackError } from './Error.js'
// Assuming these imports work now, otherwise revert to '../api.js' and remove Album types
import YoutubeAPI, { YoutubeTrack, YoutubePlaylist, YoutubeResults } from './api/Youtube.js'
import SoundcloudAPI, { type SoundcloudTrack, SoundcloudPlaylist } from './api/Soundcloud'
import SpotifyAPI, { type SpotifyTrack, SpotifyPlaylist } from './api/Spotify'
// import SpotifyAlbum from './api/Spotify'
import AppleMusicAPI, { type AppleMusicTrack, AppleMusicPlaylist } from './api/AppleMusic'
import FileAPI, { type FileTrack } from './api/File'

import { Track, TrackPlaylist, TrackResults } from './Track.js'

// Define more specific match types
interface YoutubeMatch { id: string, list?: string }
type SoundcloudMatch = { soundcloud: string } | { shortlink: string }
type SpotifyMatch = { track: string } | { album: string } | { playlist: string }
type AppleMusicMatch = { track: string } | { album: string } | { playlist: string }
type GenericMatch = YoutubeMatch | SoundcloudMatch | SpotifyMatch | AppleMusicMatch

// Define combined return types
type PlaylistTypes = YoutubePlaylist | SoundcloudPlaylist | SpotifyPlaylist | AppleMusicPlaylist
type TrackTypes = YoutubeTrack | SoundcloudTrack | SpotifyTrack | AppleMusicTrack | FileTrack
type ResolveReturn = TrackTypes | PlaylistTypes | null

class YoutubeSource {
    readonly id_regex = /^([\w_-]{11})$/
    readonly platform = 'Youtube'
    readonly api = YoutubeAPI

    weak_match (id: string): YoutubeMatch | null {
        const regexMatch = this.id_regex.exec(id)
        if (regexMatch) { return { id: regexMatch[1] } }
        return null
    }

    match (content: string): YoutubeMatch | null {
        let url: URL
        try {
            url = new URL(content)
        } catch (e) {
            return this.weak_match(content)
        }

        let id: string | null = null
        let list: string | null = null

        // Example URL patterns - adjust if needed
        if (url.hostname === 'youtu.be' || url.hostname === 'youtu.be') { // Corrected duplicate hostname?
            id = url.pathname.substring(1)
        } else if ((url.hostname === 'www.youtube.com' || url.hostname === 'music.youtube.com' || url.hostname === 'youtube.com') && url.pathname === '/watch') {
            id = url.searchParams.get('v')
        } else if (url.hostname === 'youtu.be' && url.pathname.length > 1) {
            id = url.pathname.substring(1)
        }

        let matchResult: YoutubeMatch | null = id ? this.weak_match(id) : null

        list = url.searchParams.get('list')

        if (list) {
            if (/^[\w-]+$/.test(list)) {
                if (!matchResult) matchResult = { id: '' }
                matchResult.list = list
            }
        }
        return matchResult
    }

    async resolve (match: YoutubeMatch): Promise<YoutubeTrack | YoutubePlaylist | null> {
        let trackPromise: Promise<TrackTypes | null> | null = null
        let listPromise: Promise<PlaylistTypes | null> | null = null

        if (match.id && this.id_regex.test(match.id)) {
            trackPromise = this.api.get(match.id).catch(err => {
                console.warn(`YoutubeSource: Failed to get track ${match.id}:`, err)
                return null
            })
        }
        if (match.list) {
            listPromise = this.api.playlist_once(match.list).catch(err => {
                console.warn(`YoutubeSource: Failed to get playlist ${match.list}:`, err)
                return null
            })
        }

        const promisesToAwait = [trackPromise, listPromise].filter(p => p !== null)
        if (promisesToAwait.length === 0) return null

        const results = await Promise.allSettled(promisesToAwait)

        let track: Track | null = null
        let list: TrackPlaylist | null = null

        let resultIndex = 0
        if (trackPromise) {
            const trackResult = results[resultIndex++]
            if (trackResult.status === 'fulfilled' && trackResult.value) {
                track = trackResult.value as Track
            }
        }
        if (listPromise) {
            const listResult = results[resultIndex++]
            if (listResult.status === 'fulfilled' && listResult.value) {
                list = listResult.value as TrackPlaylist
            }
        }

        if (!track && !list) {
            return null
        }

        if (list instanceof TrackPlaylist && track instanceof Track) {
            list.setFirstTrack(track)
        }

        if (list) {
            return list as YoutubePlaylist
        }
        return track as YoutubeTrack | null
    }

    async weak_resolve (match: YoutubeMatch): Promise<ResolveReturn> {
        try {
            return await this.resolve(match)
        } catch (e) {
            console.warn(`YoutubeSource: Weak resolve failed for match ${JSON.stringify(match)}:`, e)
            return null
        }
    }

    async search (query: string, continuation?: string | null): Promise<YoutubeResults | null> {
        try {
            return await this.api.search(query, continuation)
        } catch (e) {
            console.error('YouTube search error:', e)
            return null
        }
    }

    async playlistOnce (id: string, start?: number): Promise<YoutubePlaylist | null> {
        try {
            return await this.api.playlist_once(id, start)
        } catch (e) {
            console.error(`YouTube playlistOnce error for ID ${id}:`, e)
            return null
        }
    }

    setCookie (cookie: string): void {
        this.api.set_cookie(cookie)
    }
}

class SoundcloudSource {
    readonly platform = 'Soundcloud'
    readonly api = SoundcloudAPI

    match (content: string): SoundcloudMatch | null {
        let url: URL
        try {
            url = new URL(content)
        } catch (e) {
            return null
        }

        if (url.pathname.startsWith('/') && url.pathname.length > 1) {
            if (url.hostname === 'soundcloud.com') {
                return { soundcloud: url.href }
            } else if (url.hostname === 'on.soundcloud.com') {
                return { shortlink: url.pathname.substring(1) }
            }
        }
        return null
    }

    async resolve (match: SoundcloudMatch): Promise<SoundcloudTrack | SoundcloudPlaylist | null> {
        try {
            if ('shortlink' in match) {
                return await this.api.resolve_shortlink(match.shortlink)
            } else if ('soundcloud' in match) {
                return await this.api.resolve(match.soundcloud)
            }
            return null
        } catch (e) {
            if (e instanceof NotATrackError) { return null }
            console.error('Soundcloud resolve error:', e)
            return null
        }
    }

    async search (query: string, offset?: number, length?: number): Promise<TrackResults | null> {
        try {
            return await this.api.search(query, offset ?? 0, length ?? 10)
        } catch (e) {
            console.error('Soundcloud search error:', e)
            return null
        }
    }

    async playlistOnce (id: string, offset?: number, length?: number): Promise<SoundcloudPlaylist | null> {
        try {
            return await this.api.playlist_once(id, offset ?? 0, length ?? 50)
        } catch (e) {
            console.error(`Soundcloud playlistOnce error for ID ${id}:`, e)
            return null
        }
    }
}

class SpotifySource {
    readonly platform = 'Spotify'
    readonly api = SpotifyAPI

    match (content: string): SpotifyMatch | null {
        let url: URL
        try {
            url = new URL(content)
        } catch (e) {
            return null
        }

        if (url.hostname === 'open.spotify.com' && url.pathname.startsWith('/') && url.pathname.length > 1) {
            const data = url.pathname.substring(1).split('/')
            if (data.length === 2) {
                const type = data[0]
                const id = data[1]
                if (/^[a-zA-Z0-9]+$/.test(id)) {
                    switch (type) {
                        case 'track': return { track: id }
                        case 'album': return { album: id }
                        case 'playlist': return { playlist: id }
                    }
                }
            }
        }
        return null
    }

    // Fix: Return type might use SpotifyPlaylist as fallback if SpotifyAlbum import fails
    async resolve (match: SpotifyMatch): Promise<SpotifyTrack | SpotifyPlaylist | /* SpotifyAlbum | */ null | undefined> {
        try {
            if ('track' in match) { return await this.api.get(match.track) }
            // Fix: Call with default length explicitly if needed, or just 2 args
            if ('playlist' in match) { return await this.api.playlist_once(match.playlist, 0, 50) } // Pass 3 args
            if ('album' in match) { return await this.api.album_once(match.album, 0, 50) } // Pass 3 args
            return undefined
        } catch (e) {
            console.error(`Spotify resolve error for match ${JSON.stringify(match)}:`, e)
            return null
        }
    }

    async search (query: string, offset?: number, length?: number): Promise<TrackResults | null> {
        try {
            return await this.api.search(query, offset ?? 0, length ?? 10)
        } catch (e) {
            console.error('Spotify search error:', e)
            return null
        }
    }

    async playlistOnce (id: string, offset?: number, length?: number): Promise<SpotifyPlaylist | null> {
        try {
            return await this.api.playlist_once(id, offset ?? 0, length ?? 50)
        } catch (e) {
            console.error(`Spotify playlistOnce error for ID ${id}:`, e)
            return null
        }
    }

    // Fix: Return type uses SpotifyPlaylist as fallback if SpotifyAlbum fails
    async albumOnce (id: string, offset?: number, length?: number): Promise<SpotifyPlaylist | /* SpotifyAlbum | */ null> {
        try {
            // Fix: Ensure length is number
            return await this.api.album_once(id, offset ?? 0, length ?? 50)
        } catch (e) {
            console.error(`Spotify albumOnce error for ID ${id}:`, e)
            return null
        }
    }

    setCookie (cookie: string): void {
        this.api.set_cookie(cookie)
    }
}

class AppleMusicSource {
    readonly api = AppleMusicAPI
    readonly platform = 'AppleMusic'

    match (content: string | undefined): AppleMusicMatch | null {
        if (!content) return null
        let url: URL
        try {
            url = new URL(content)
        } catch (e) {
            return null
        }

        if (url.hostname === 'music.apple.com' && url.pathname.startsWith('/') && url.pathname.length > 1) {
            const path = url.pathname.substring(1).split('/')
            if (path.length >= 3) {
                const type = path[1]
                const id = path[path.length - 1]

                if (/^\d+$/.test(id)) {
                    switch (type) {
                        case 'playlist': return { playlist: id }
                        case 'album': {
                            const trackId = url.searchParams.get('i')
                            if (trackId && /^\d+$/.test(trackId)) {
                                return { track: trackId }
                            }
                            return { album: id }
                        }
                    }
                } else if (type === 'song' && path.length >= 2 && /^\d+$/.test(path[1])) {
                    return { track: path[1] }
                }
            }
        }
        return null
    }

    // Fix: Return type uses AppleMusicPlaylist as fallback if AppleMusicAlbum fails
    async resolve (match: AppleMusicMatch): Promise<AppleMusicTrack | AppleMusicPlaylist | /* AppleMusicAlbum | */ null | undefined> {
        try {
            if ('track' in match) { return await this.api.get(match.track) }
            if ('playlist' in match) { return await this.api.playlist_once(match.playlist, 0, undefined) }
            // Fix: Provide default length
            if ('album' in match) { return await this.api.album_once(match.album, 0, 50) }
            return undefined
        } catch (e) {
            console.error(`Apple Music resolve error for match ${JSON.stringify(match)}:`, e)
            return null
        }
    }

    async search (query: string, offset?: number, length?: number): Promise<TrackResults | null> {
        try {
            return await this.api.search(query, offset, length)
        } catch (e) {
            console.error('Apple Music search error:', e)
            return null
        }
    }

    async playlistOnce (id: string, offset?: number, length?: number): Promise<AppleMusicPlaylist | null> {
        try {
            return await this.api.playlist_once(id, offset, length)
        } catch (e) {
            console.error(`Apple Music playlistOnce error for ID ${id}:`, e)
            return null
        }
    }

    // Fix: Return type uses AppleMusicPlaylist as fallback if AppleMusicAlbum fails
    async albumOnce (id: string, offset?: number, length?: number): Promise<AppleMusicPlaylist | /* AppleMusicAlbum | */ null> {
        try {
            // Fix: Use offset ?? 0 and length ?? default
            return await this.api.album_once(id, offset ?? 0, length ?? 50)
        } catch (e) {
            console.error(`Apple Music albumOnce error for ID ${id}:`, e)
            return null
        }
    }
}

class FileSource {
    readonly api = FileAPI
    readonly platform = 'File'

    async resolve (content: string): Promise<FileTrack | null> {
        let url: URL
        try {
            url = new URL(content)
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                return this.api.create(content)
            }
            if (url.protocol === 'file:') {
                return this.api.create(content, true)
            }
            return null
        } catch (e) {
            try {
                return this.api.create(content, true)
            } catch (fileError) {
                console.warn(`FileSource: Could not resolve content "${content}" as URL or File:`, fileError)
                return null
            }
        }
    }
}

const youtube = new YoutubeSource()
const soundcloud = new SoundcloudSource()
const spotify = new SpotifySource()
const apple = new AppleMusicSource()
const file = new FileSource()

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class Source {
    static Youtube = youtube
    static Soundcloud = soundcloud
    static Spotify = spotify
    static AppleMusic = apple
    static File = file

    static async resolve (input: string | null, weak = true): Promise<ResolveReturn | undefined> {
        if (!input) return null

        const onlineSources = [youtube, soundcloud, spotify, apple]
        let match: GenericMatch | null

        for (const source of onlineSources) {
            match = source.match(input)
            if (match) {
                const resolvedResult = await source.resolve(match as any)
                if (resolvedResult !== undefined) return resolvedResult as ResolveReturn
            }
        }

        const resolvedFileMatch = await file.resolve(input)
        if (resolvedFileMatch) {
            return resolvedFileMatch
        }

        if (!weak) { return null }

        const ytWeakMatch = youtube.weak_match(input)
        if (ytWeakMatch) {
            return await youtube.weak_resolve(ytWeakMatch)
        }
        return null
    }
};

export default Source
