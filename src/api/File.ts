import { Track, TrackStream, TrackStreams } from '../Track.js'
import { UnplayableError } from '../Error.js'
import { UnsupportedError } from 'js-common'

export class FileStream extends TrackStream {
    isFile: boolean = false
    constructor (url: string, isfile?: boolean) {
        super(url)

        this.isFile = !!isfile
        this.setTracks(true, true) /* we don't know what kind of tracks are in this file */
    }

    override equals (other: FileStream) {
        return !!(other instanceof FileStream && this.url && this.url === other.url)
    }
}

export class FileStreams extends TrackStreams {
    from (url: string, isfile?: boolean) {
        this.push(new FileStream(url, isfile))

        return this
    }
}

export class FileTrack extends Track {
    declare platform: 'File'
    stream_url: string
    isLocalFile: boolean
    constructor (url: string, isfile = false) {
        super('File')

        this.stream_url = url
        this.id = url
        this.isLocalFile = isfile
        this.setStreams(new FileStreams().from(url, isfile))
    }

    async getStreams () {
        throw new UnplayableError({ simpleMessage: 'Stream expired or not available' })
    }

    async fetch () {
        throw new UnsupportedError('Cannot fetch on a FileTrack')
    }

    get url () {
        return this.stream_url
    }
}

class File {
    Track = FileTrack
    async get (_url: string) {
        throw new UnsupportedError('get operation is not supported for FileTrack') // Added message
    }

    async get_streams (_url: string) {
        throw new UnsupportedError('get_streams operation is not supported for FileTrack') // Added message
    }

    async playlist (_url: string, _length: number) {
        throw new UnsupportedError('playlist operation is not supported for FileTrack') // Added message
    }

    create (url: string, isfile?: boolean) {
        return new FileTrack(url, isfile)
    }
}

export default new File()
