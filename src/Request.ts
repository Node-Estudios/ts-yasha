import { ParseError, InternalError, NetworkError } from './Error.js'
import { Agent } from 'https'
import nfetch, { RequestInfo, RequestInit } from 'node-fetch'

const httpsAgent = new Agent({ keepAlive: true })

async function fetch (url: RequestInfo, opts: RequestInit = {}) {
    opts.agent = httpsAgent

    return await nfetch(url, opts)
}

export default new class {
    async getResponse (url: RequestInfo, options?: RequestInit) {
        try {
            const res = await fetch(url, options)
            return { res }
        } catch (e) {
            throw new NetworkError(e)
        }
    }

    async get (url: RequestInfo, options?: RequestInit) {
        const { res } = await this.getResponse(url, options)

        let body

        try {
            body = await res.text()
        } catch (e) {
            if (!res.ok) { throw new InternalError(e) }
            throw new NetworkError(e)
        }

        if (!res.ok) { throw new InternalError(body) }
        return { res, body }
    }

    async getJSON (url: RequestInfo, options?: RequestInit) {
        const data = await this.get(url, options)

        try {
            data.body = JSON.parse(data.body)
            return data as unknown as { res: Response, body: any }
        } catch (e) {
            throw new ParseError(e)
        }
    }

    async getBuffer (url: RequestInfo, options?: RequestInit) {
        const { res } = await this.getResponse(url, options)

        let body

        try {
            body = await res.buffer()
        } catch (e) {
            if (!res.ok) { throw new InternalError(e) }
            throw new NetworkError(e)
        }

        if (!res.ok) { throw new InternalError(body.toString('utf8')) }
        return { res, body }
    }
}()
