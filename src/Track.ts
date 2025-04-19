class TrackStream {
    url?: string
    video?: boolean
    audio?: boolean
    bitrate?: number
    duration?: number
    container: string | null
    codecs: string | null
    volume?: number

    constructor (url: string) {
        this.url = url
        this.video = false
        this.audio = false
        this.bitrate = -1
        this.duration = -1
        this.container = null
        this.codecs = null
    }

    setTracks (video: boolean, audio: boolean) {
        this.video = video
        this.audio = audio

        return this
    }

    setBitrate (bitrate: number) {
        this.bitrate = bitrate

        return this
    }

    setDuration (duration: number) {
        this.duration = duration

        return this
    }

    setMetadata (container: string, codecs: string) {
        this.container = container
        this.codecs = codecs

        return this
    }

    equals (other: this) {
        return this === other
    }

    async getUrl () {
        return null
    }
}

class TrackStreams extends Array {
    volume?: number
    live?: boolean
    time?: number

    set (volume: number, live: boolean, time: number) {
        this.volume = volume
        this.live = live
        this.time = time
    }

    expired () {
        return false
    }

    maybeExpired () {
        return false
    }
}

class Track {
    platform: string
    id?: string
    title?: string
    author?: string
    icons?: TrackImage[]
    thumbnails?: TrackImage[]
    streams?: TrackStreams
    playable = true
    duration = -1

    constructor (platform: string) {
        this.platform = platform
    }

    setOwner (name: string, icons?: TrackImage[]) {
        this.author = name
        this.icons = icons

        return this
    }

    setMetadata (id: string, title: string, duration: number, thumbnails: TrackImage[]) {
        this.id = id
        this.title = title
        this.duration = duration
        this.thumbnails = thumbnails

        return this
    }

    setStreams (streams: TrackStreams) {
        this.streams = streams

        return this
    }

    setPlayable (playable: boolean) {
        this.playable = playable

        return this
    }

    equals (other: Track | undefined) {
        return this === other || (this.platform === other?.platform && this.id != null && this.id === other?.id)
    }
}

class TrackResults extends Array<Track> {
    async next (): Promise<any> {
        return null
    }
}

class TrackPlaylist extends TrackResults {
    title?: string
    description?: string
    firstTrack?: Track

    setMetadata (title: string, description: string) {
        this.title = title
        this.description = description

        return this
    }

    setFirstTrack (track: Track) {
        this.firstTrack = track

        return this
    }

    async load () {
        let result

        result = await this.next()

        while (result?.length) {
            this.push(...result)

            result = await result.next()
        }

        if (this.firstTrack) {
            const index = this.findIndex(track => track.equals(this.firstTrack))

            if (index === -1) { this.unshift(this.firstTrack) } else { this.splice(0, index) }
        }

        return this
    }

    get url (): any {
        return null
    }
}

class TrackImage {
    url: string | null = null
    width: number = 0
    height: number = 0

    constructor (url?: string, width?: number, height?: number) {
        this.url = url ?? null
        this.width = width ?? 0
        this.height = height ?? 0
    }

    static from (array: Array<{ url: string, width: number, height: number }>) {
        const images = new Array<TrackImage>()
        for (let i = 0; i < array.length; i++) { images[i] = new TrackImage(array[i].url, array[i].width, array[i].height) }
        return images
    }
}

export {
    Track,
    TrackImage,
    TrackStream,
    TrackResults,
    TrackStreams,
    TrackPlaylist,
}
